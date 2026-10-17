package ai.sillytavern.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ComponentName;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;
import android.os.RemoteException;
import android.os.SystemClock;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.MimeTypeMap;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Shows the startup progress, then the SillyTavern UI in a WebView once the local server
 * (ServerService) is ready. Also provides what the WebView lacks on its own: file uploads,
 * downloads, microphone access, external links and the back button.
 */
public class MainActivity extends Activity {
    static final String ACTION_STOP = "ai.sillytavern.app.action.STOP";
    static final int REQUEST_STORAGE = 3;
    private static final String TAG = "SillyTavern";
    private static final int REQUEST_FILE = 1;
    private static final int REQUEST_AUDIO = 2;
    private static final int REQUEST_NOTIFICATIONS = 4;
    private static final long POLL_STARTING_MS = 300;
    private static final long POLL_READY_MS = 2000;
    private static final int BACKGROUND_COLOR = Color.rgb(23, 23, 23);
    private static final int LOG_TAIL_BYTES = 96 * 1024;
    /** Terminal colors (CSI) and window title (OSC) sequences in the server output. */
    private static final String ANSI_ESCAPES = "\u001B\\[[0-9;?]*[A-Za-z]|\u001B\\][^\u0007\u001B]*(\u0007|\u001B\\\\)";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Messenger replyMessenger = new Messenger(new Handler(Looper.getMainLooper(), this::onServerReply));

    private FrameLayout root;
    private LinearLayout splashView;
    private TextView splashText;
    private ProgressBar splashProgress;
    private ScrollView errorView;
    private TextView errorMessage;
    private TextView errorLog;
    private WebView webView;

    private Messenger serverMessenger;
    private boolean bound;
    private boolean retryOnConnect;
    private boolean polling;
    private boolean stopping;
    private String lastState = "";
    private String lastErrorMessage = "";
    private int serverPort;
    private int loadedPort;
    private long startingSince;
    private String bridgeScript;

    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest pendingPermission;
    private DownloadBridge downloadBridge;

    private final ServiceConnection connection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder service) {
            serverMessenger = new Messenger(service);
            sendToServer(ServerProtocol.MSG_START, retryOnConnect ? 1 : 0);
            retryOnConnect = false;
            schedulePoll(0);
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            // The server process died. The system recreates it because we're still bound,
            // and onServiceConnected starts it again (or reports why it crashed).
            serverMessenger = null;
            if (!stopping) {
                showSplash(getString(R.string.status_reconnecting), -1);
            }
        }
    };

    private final Runnable pollRunnable = new Runnable() {
        @Override
        public void run() {
            if (!polling) {
                return;
            }
            sendToServer(ServerProtocol.MSG_STATUS, 0);
            long delay = ServerProtocol.STATE_READY.equals(lastState) && webView != null ? POLL_READY_MS : POLL_STARTING_MS;
            handler.postDelayed(this, delay);
        }
    };

    // ---------------------------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------------------------

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (ACTION_STOP.equals(getIntent().getAction())) {
            stopEverything();
            return;
        }

        setupWindow();
        buildViews();
        downloadBridge = new DownloadBridge(this);
        requestNotificationPermissionOnce();

        KeepAliveService.start(this);
        // A fresh launch retries even if the previous run failed; reconnects don't.
        retryOnConnect = true;
        bound = bindService(new Intent(this, ServerService.class), connection, BIND_AUTO_CREATE | BIND_IMPORTANT);
        if (!bound) {
            showError(getString(R.string.error_service));
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (ACTION_STOP.equals(intent.getAction())) {
            stopEverything();
        }
    }

    @Override
    protected void onStart() {
        super.onStart();
        polling = true;
        schedulePoll(0);
    }

    @Override
    protected void onStop() {
        polling = false;
        handler.removeCallbacks(pollRunnable);
        CookieManager.getInstance().flush();
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        polling = false;
        handler.removeCallbacksAndMessages(null);
        if (bound) {
            unbindService(connection);
            bound = false;
        }
        destroyWebView();
        super.onDestroy();
    }

    /** "Stop" from the notification: end the server and close the app. */
    private void stopEverything() {
        stopping = true;
        polling = false;
        handler.removeCallbacksAndMessages(null);
        if (bound) {
            unbindService(connection);
            bound = false;
        }
        KeepAliveService.stop(this);
        destroyWebView();
        finishAndRemoveTask();
    }

    // ---------------------------------------------------------------------------------------
    // Window and views
    // ---------------------------------------------------------------------------------------

    @SuppressWarnings("deprecation")
    private void setupWindow() {
        Window window = getWindow();
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        window.getDecorView().setBackgroundColor(BACKGROUND_COLOR);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // Draw edge-to-edge (mandatory from Android 15) and pad the content by the
            // system bar, cutout and keyboard insets ourselves (see buildViews).
            window.setDecorFitsSystemWindows(false);
            window.setStatusBarColor(Color.TRANSPARENT);
            window.setNavigationBarColor(Color.TRANSPARENT);
            WindowInsetsController controller = window.getInsetsController();
            if (controller != null) {
                controller.setSystemBarsAppearance(0, WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
            }
        } else {
            window.setStatusBarColor(BACKGROUND_COLOR);
            window.setNavigationBarColor(BACKGROUND_COLOR);
        }
    }

    private void buildViews() {
        root = new FrameLayout(this);
        root.setBackgroundColor(BACKGROUND_COLOR);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return WindowInsets.CONSUMED;
            });
        }

        // Splash: logo, status line and progress
        splashView = new LinearLayout(this);
        splashView.setOrientation(LinearLayout.VERTICAL);
        splashView.setGravity(Gravity.CENTER);
        splashView.setPadding(dp(32), dp(32), dp(32), dp(32));
        ImageView logo = new ImageView(this);
        logo.setImageResource(R.drawable.splash);
        logo.setAdjustViewBounds(true);
        splashView.addView(logo, new LinearLayout.LayoutParams(dp(160), dp(160)));
        splashText = new TextView(this);
        splashText.setTextColor(Color.rgb(220, 220, 210));
        splashText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        splashText.setGravity(Gravity.CENTER);
        splashText.setPadding(0, dp(24), 0, dp(16));
        splashView.addView(splashText, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        splashProgress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        splashProgress.setMax(1000);
        splashView.addView(splashProgress, new LinearLayout.LayoutParams(dp(240), ViewGroup.LayoutParams.WRAP_CONTENT));

        // Error screen: message, buttons and the end of the server log
        errorView = new ScrollView(this);
        errorView.setFillViewport(true);
        LinearLayout errorContent = new LinearLayout(this);
        errorContent.setOrientation(LinearLayout.VERTICAL);
        errorContent.setPadding(dp(20), dp(24), dp(20), dp(24));
        TextView errorTitle = new TextView(this);
        errorTitle.setText(R.string.error_title);
        errorTitle.setTextColor(Color.rgb(230, 120, 110));
        errorTitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        errorContent.addView(errorTitle);
        errorMessage = new TextView(this);
        errorMessage.setTextColor(Color.rgb(220, 220, 210));
        errorMessage.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        errorMessage.setPadding(0, dp(12), 0, dp(12));
        errorMessage.setTextIsSelectable(true);
        errorContent.addView(errorMessage);
        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        buttons.addView(makeButton(R.string.action_retry, v -> retry()));
        buttons.addView(makeButton(R.string.action_share_log, v -> shareLog()));
        buttons.addView(makeButton(R.string.action_close, v -> stopEverything()));
        errorContent.addView(buttons);
        TextView logTitle = new TextView(this);
        logTitle.setText(R.string.error_log_title);
        logTitle.setTextColor(Color.rgb(160, 160, 150));
        logTitle.setPadding(0, dp(16), 0, dp(4));
        errorContent.addView(logTitle);
        errorLog = new TextView(this);
        errorLog.setTypeface(Typeface.MONOSPACE);
        errorLog.setTextColor(Color.rgb(180, 180, 170));
        errorLog.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        errorLog.setTextIsSelectable(true);
        errorContent.addView(errorLog);
        errorView.addView(errorContent);
        errorView.setVisibility(View.GONE);

        root.addView(splashView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(errorView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        showSplash(getString(R.string.status_starting), -1);
    }

    private Button makeButton(int text, View.OnClickListener listener) {
        Button button = new Button(this);
        button.setText(text);
        button.setOnClickListener(listener);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        params.setMarginEnd(dp(8));
        button.setLayoutParams(params);
        return button;
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics()));
    }

    private void showSplash(String text, float progress) {
        splashText.setText(text);
        if (progress >= 0) {
            splashProgress.setIndeterminate(false);
            splashProgress.setProgress(Math.round(progress * 1000));
        } else {
            splashProgress.setIndeterminate(true);
        }
        splashView.setVisibility(View.VISIBLE);
        errorView.setVisibility(View.GONE);
        if (webView != null) {
            webView.setVisibility(View.GONE);
        }
    }

    private void showError(String message) {
        errorMessage.setText(message);
        errorLog.setText(readLogTail(LOG_TAIL_BYTES / 4));
        errorView.setVisibility(View.VISIBLE);
        splashView.setVisibility(View.GONE);
        if (webView != null) {
            webView.setVisibility(View.GONE);
        }
        errorView.post(() -> errorView.scrollTo(0, 0));
    }

    private void showWebView() {
        splashView.setVisibility(View.GONE);
        errorView.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
    }

    // ---------------------------------------------------------------------------------------
    // Server communication
    // ---------------------------------------------------------------------------------------

    private void schedulePoll(long delay) {
        handler.removeCallbacks(pollRunnable);
        if (polling) {
            handler.postDelayed(pollRunnable, delay);
        }
    }

    private void sendToServer(int what, int arg1) {
        if (serverMessenger == null) {
            return;
        }
        Message message = Message.obtain(null, what, arg1, 0);
        message.replyTo = replyMessenger;
        try {
            serverMessenger.send(message);
        } catch (RemoteException e) {
            Log.w(TAG, "Server process is gone", e);
        }
    }

    private boolean onServerReply(Message message) {
        if (stopping) {
            return true;
        }
        Bundle status = message.getData();
        String state = status.getString(ServerProtocol.KEY_STATE, ServerProtocol.STATE_IDLE);
        String text = status.getString(ServerProtocol.KEY_MESSAGE, "");
        float progress = status.getFloat(ServerProtocol.KEY_PROGRESS, -1f);
        int port = status.getInt(ServerProtocol.KEY_PORT, 0);

        if (!state.equals(lastState) && ServerProtocol.STATE_STARTING.equals(state)) {
            startingSince = SystemClock.elapsedRealtime();
        }
        lastState = state;

        switch (state) {
            case ServerProtocol.STATE_IDLE:
                // A recreated server process that hasn't been told to start yet
                sendToServer(ServerProtocol.MSG_START, 0);
                showSplash(getString(R.string.status_starting), -1);
                break;
            case ServerProtocol.STATE_INSTALLING:
                showSplash(progress >= 0
                    ? getString(R.string.status_installing_progress, Math.round(progress * 100))
                    : getString(R.string.status_installing), progress);
                break;
            case ServerProtocol.STATE_STARTING:
                long seconds = (SystemClock.elapsedRealtime() - startingSince) / 1000;
                showSplash(seconds >= 20
                    ? getString(R.string.status_starting_slow, seconds)
                    : getString(R.string.status_starting), -1);
                break;
            case ServerProtocol.STATE_RESTARTING:
                showSplash(getString(R.string.status_restarting), -1);
                break;
            case ServerProtocol.STATE_READY:
                serverPort = port;
                onServerReady();
                break;
            case ServerProtocol.STATE_FAILED:
            default:
                if (errorView.getVisibility() != View.VISIBLE || !text.equals(lastErrorMessage)) {
                    lastErrorMessage = text;
                    showError(text.isEmpty() ? getString(R.string.error_unknown) : text);
                }
                break;
        }
        return true;
    }

    private void onServerReady() {
        if (webView == null) {
            createWebView();
        }
        if (loadedPort != serverPort) {
            loadedPort = serverPort;
            webView.loadUrl(baseUrl());
        } else if (webView.getVisibility() != View.VISIBLE) {
            // Back from a server restart: the old page talks to a dead session
            webView.reload();
        }
        showWebView();
    }

    private void retry() {
        lastErrorMessage = "";
        showSplash(getString(R.string.status_starting), -1);
        if (serverMessenger != null) {
            sendToServer(ServerProtocol.MSG_START, 1);
        } else {
            retryOnConnect = true;
        }
        schedulePoll(POLL_STARTING_MS);
    }

    private String baseUrl() {
        return "http://127.0.0.1:" + serverPort + "/";
    }

    private boolean isServerUrl(Uri uri) {
        if (uri == null || !"http".equals(uri.getScheme())) {
            return false;
        }
        String host = uri.getHost();
        return ("127.0.0.1".equals(host) || "localhost".equals(host)) && uri.getPort() == serverPort;
    }

    // ---------------------------------------------------------------------------------------
    // WebView
    // ---------------------------------------------------------------------------------------

    @SuppressLint("SetJavaScriptEnabled")
    private void createWebView() {
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        WebView.setWebContentsDebuggingEnabled(debuggable);

        webView = new WebView(this);
        webView.setBackgroundColor(BACKGROUND_COLOR);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setSupportMultipleWindows(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setSupportZoom(true);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        settings.setUserAgentString(settings.getUserAgentString() + " SillyTavernAndroid/" + getVersionName());

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        webView.addJavascriptInterface(downloadBridge, DownloadBridge.JS_NAME);
        webView.setWebViewClient(new AppWebViewClient());
        webView.setWebChromeClient(new AppWebChromeClient());
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            Uri uri = Uri.parse(url);
            if (url.startsWith("blob:") || url.startsWith("data:") || isServerUrl(uri)) {
                String name = URLUtil.guessFileName(url, contentDisposition, mimeType);
                webView.evaluateJavascript("window.__stAndroid && window.__stAndroid.saveUrl("
                    + JSONObject.quote(url) + "," + JSONObject.quote(name) + "," + JSONObject.quote(mimeType) + ")", null);
            } else {
                openExternal(uri);
            }
        });
        webView.setVisibility(View.GONE);
        root.addView(webView, 0, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void destroyWebView() {
        if (webView != null) {
            root.removeView(webView);
            webView.destroy();
            webView = null;
            loadedPort = 0;
        }
    }

    private void injectBridge(WebView view) {
        if (bridgeScript == null) {
            try (InputStream in = getAssets().open("bridge.js")) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                int read;
                while ((read = in.read(buffer)) > 0) {
                    out.write(buffer, 0, read);
                }
                bridgeScript = out.toString(StandardCharsets.UTF_8.name());
            } catch (IOException e) {
                Log.e(TAG, "Could not read bridge.js", e);
                return;
            }
        }
        view.evaluateJavascript(bridgeScript, null);
    }

    private void openExternal(Uri uri) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            startActivity(intent);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, getString(R.string.error_no_app, uri.toString()), Toast.LENGTH_LONG).show();
        }
    }

    private class AppWebViewClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (isServerUrl(uri)) {
                return false;
            }
            // OpenRouter's OAuth flow redirects back to the local server, so it has to stay in the app
            String host = uri.getHost();
            if ("https".equals(uri.getScheme()) && host != null && (host.equals("openrouter.ai") || host.endsWith(".openrouter.ai"))) {
                return false;
            }
            openExternal(uri);
            return true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (isServerUrl(Uri.parse(url))) {
                injectBridge(view);
            }
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame() && isServerUrl(request.getUrl())) {
                Log.w(TAG, "Page load failed: " + error.getDescription());
                // Most likely the server died; the status poll shows what happened
                showSplash(getString(R.string.status_reconnecting), -1);
                loadedPort = 0;
                schedulePoll(0);
            }
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            Log.w(TAG, "WebView renderer gone (crashed: " + detail.didCrash() + "), recreating");
            if (view == webView) {
                destroyWebView();
                if (ServerProtocol.STATE_READY.equals(lastState)) {
                    onServerReady();
                }
            }
            return true;
        }
    }

    private class AppWebChromeClient extends WebChromeClient {
        @Override
        public boolean onConsoleMessage(ConsoleMessage message) {
            if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                Log.w(TAG, "JS: " + message.message() + " (" + message.sourceId() + ":" + message.lineNumber() + ")");
            }
            return true;
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) {
                fileCallback.onReceiveValue(null);
            }
            fileCallback = callback;
            Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            String[] mimeTypes = chooserMimeTypes(params.getAcceptTypes());
            if (mimeTypes.length == 1) {
                intent.setType(mimeTypes[0]);
            } else {
                intent.setType("*/*");
                if (mimeTypes.length > 1) {
                    intent.putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes);
                }
            }
            if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            }
            try {
                startActivityForResult(intent, REQUEST_FILE);
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                callback.onReceiveValue(null);
                Toast.makeText(MainActivity.this, R.string.error_no_file_picker, Toast.LENGTH_LONG).show();
            }
            return true;
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            boolean wantsAudio = false;
            for (String resource : request.getResources()) {
                if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                    wantsAudio = true;
                }
            }
            if (!wantsAudio || !isServerUrl(request.getOrigin())) {
                request.deny();
                return;
            }
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            } else {
                if (pendingPermission != null) {
                    pendingPermission.deny();
                }
                pendingPermission = request;
                requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQUEST_AUDIO);
            }
        }

        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
            // target="_blank" links and window.open(): find out where they go, then open
            // them in the browser (or in the app if they point to the local server)
            WebView probe = new WebView(MainActivity.this);
            probe.setWebViewClient(new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView probeView, WebResourceRequest request) {
                    Uri uri = request.getUrl();
                    if (isServerUrl(uri) && webView != null) {
                        webView.loadUrl(uri.toString());
                    } else {
                        openExternal(uri);
                    }
                    probeView.post(probeView::destroy);
                    return true;
                }
            });
            WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
            transport.setWebView(probe);
            resultMsg.sendToTarget();
            return true;
        }
    }

    /**
     * Converts accept="..." values to MIME types for the system picker. Filtering is only
     * applied to media types: many file managers don't know types like .json or .charx and
     * would hide the files the user is looking for.
     */
    private static String[] chooserMimeTypes(String[] acceptTypes) {
        Set<String> result = new LinkedHashSet<>();
        if (acceptTypes != null) {
            for (String entry : acceptTypes) {
                if (entry == null) {
                    continue;
                }
                for (String raw : entry.split(",")) {
                    String token = raw.trim().toLowerCase(Locale.ROOT);
                    if (token.isEmpty()) {
                        continue;
                    }
                    String mime = token.startsWith(".")
                        ? MimeTypeMap.getSingleton().getMimeTypeFromExtension(token.substring(1))
                        : token;
                    if (mime == null || !(mime.startsWith("image/") || mime.startsWith("audio/") || mime.startsWith("video/"))) {
                        return new String[0];
                    }
                    result.add(mime);
                }
            }
        }
        return result.toArray(new String[0]);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_FILE || fileCallback == null) {
            return;
        }
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            List<Uri> uris = new ArrayList<>();
            ClipData clip = data.getClipData();
            if (clip != null) {
                for (int i = 0; i < clip.getItemCount(); i++) {
                    uris.add(clip.getItemAt(i).getUri());
                }
            } else if (data.getData() != null) {
                uris.add(data.getData());
            }
            result = uris.toArray(new Uri[0]);
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQUEST_AUDIO && pendingPermission != null) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                pendingPermission.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            } else {
                pendingPermission.deny();
            }
            pendingPermission = null;
        }
    }

    private void requestNotificationPermissionOnce() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return;
        }
        SharedPreferences prefs = getSharedPreferences("ui", MODE_PRIVATE);
        if (prefs.getBoolean("askedNotifications", false)
            || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            return;
        }
        prefs.edit().putBoolean("askedNotifications", true).apply();
        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQUEST_NOTIFICATIONS);
    }

    // ---------------------------------------------------------------------------------------
    // Back button
    // ---------------------------------------------------------------------------------------

    /** Android 12L and older; newer versions use the OnBackInvokedCallback from onCreate. */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        handleBack();
    }

    /**
     * Closes whatever is open in the UI (popup, editor, panel). When nothing is, the app goes
     * to the background instead of closing, so the server keeps running.
     */
    private void handleBack() {
        if (webView == null || webView.getVisibility() != View.VISIBLE) {
            moveTaskToBack(true);
            return;
        }
        if (webView.canGoBack() && !isServerUrl(Uri.parse(String.valueOf(webView.getUrl())))) {
            webView.goBack();
            return;
        }
        webView.evaluateJavascript("(window.__stAndroid && window.__stAndroid.handleBack()) === true", value -> {
            if (!"true".equals(value)) {
                moveTaskToBack(true);
            }
        });
    }

    // ---------------------------------------------------------------------------------------
    // Logs
    // ---------------------------------------------------------------------------------------

    private String readLogTail(int maxBytes) {
        File log = ServerProtocol.logFile(this);
        if (!log.isFile()) {
            return getString(R.string.error_no_log);
        }
        try (RandomAccessFile file = new RandomAccessFile(log, "r")) {
            long length = file.length();
            long start = Math.max(0, length - maxBytes);
            byte[] bytes = new byte[(int) (length - start)];
            file.seek(start);
            file.readFully(bytes);
            String text = new String(bytes, StandardCharsets.UTF_8).replaceAll(ANSI_ESCAPES, "");
            return start > 0 ? "…" + text.substring(Math.max(0, text.indexOf('\n') + 1)) : text;
        } catch (IOException e) {
            return getString(R.string.error_no_log);
        }
    }

    private void shareLog() {
        String text = "SillyTavern Android " + getVersionName() + " (Android " + Build.VERSION.RELEASE + ", " + Build.MODEL + ", " + Build.SUPPORTED_ABIS[0] + ")\n\n"
            + errorMessage.getText() + "\n\n--- server.log ---\n" + readLogTail(LOG_TAIL_BYTES);
        Intent intent = new Intent(Intent.ACTION_SEND);
        intent.setType("text/plain");
        intent.putExtra(Intent.EXTRA_SUBJECT, "SillyTavern server log");
        intent.putExtra(Intent.EXTRA_TEXT, text);
        try {
            startActivity(Intent.createChooser(intent, getString(R.string.action_share_log)));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, R.string.error_no_share, Toast.LENGTH_LONG).show();
        }
    }

    private String getVersionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (PackageManager.NameNotFoundException e) {
            return "?";
        }
    }
}
