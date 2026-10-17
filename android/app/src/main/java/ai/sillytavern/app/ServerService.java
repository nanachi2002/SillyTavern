package ai.sillytavern.app;

import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;
import android.os.Process;
import android.os.RemoteException;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.util.ArrayList;
import java.util.List;
import java.util.TimeZone;

/**
 * Hosts the SillyTavern Node.js server. Runs in the separate ":server" process because
 * Node.js can only be started once per process and process.exit() ends the whole process:
 * keeping it apart from the UI means a server crash never takes the app down, and a
 * restart is just a new process.
 *
 * Clients bind to it and talk through a Messenger (see ServerProtocol). The service lives as
 * long as something is bound; when the last client unbinds the process exits, which stops
 * the server.
 */
public class ServerService extends Service {
    private static final String TAG = "SillyTavern:Server";
    private static final int DEFAULT_PORT = 8000;
    private static final int PORT_RANGE = 100;
    private static final long STATUS_POLL_MS = 250;

    private final Object lock = new Object();
    private String state = ServerProtocol.STATE_IDLE;
    private String message = "";
    private float progress = -1f;
    private int port = 0;
    private boolean nodeLaunched = false;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Messenger messenger = new Messenger(new Handler(Looper.getMainLooper(), this::handleMessage));

    @Override
    public void onCreate() {
        super.onCreate();
        // If the previous server process ended with a fatal error, report it instead of
        // silently starting over. A retry from the UI clears it.
        JSONObject previous = readNodeStatus();
        if (previous != null && "exited".equals(previous.optString("state"))) {
            setState(ServerProtocol.STATE_FAILED, describeExit(previous), -1f);
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return messenger.getBinder();
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        // All clients are gone (app closed or stopped from the notification).
        // Node.js can't be stopped gracefully from here, so end the process.
        Log.i(TAG, "Server service destroyed, ending the server process");
        Process.killProcess(Process.myPid());
    }

    private boolean handleMessage(Message msg) {
        switch (msg.what) {
            case ServerProtocol.MSG_START:
                handleStart(msg.arg1 == 1);
                reply(msg);
                return true;
            case ServerProtocol.MSG_STATUS:
                reply(msg);
                return true;
            default:
                return false;
        }
    }

    private void reply(Message request) {
        if (request.replyTo == null) {
            return;
        }
        Message response = Message.obtain(null, request.what);
        response.setData(getStatus());
        try {
            request.replyTo.send(response);
        } catch (RemoteException e) {
            Log.w(TAG, "Client went away", e);
        }
    }

    private Bundle getStatus() {
        Bundle bundle = new Bundle();
        synchronized (lock) {
            bundle.putString(ServerProtocol.KEY_STATE, state);
            bundle.putString(ServerProtocol.KEY_MESSAGE, message);
            bundle.putFloat(ServerProtocol.KEY_PROGRESS, progress);
            bundle.putInt(ServerProtocol.KEY_PORT, port);
        }
        return bundle;
    }

    private void setState(String newState, String newMessage, float newProgress) {
        synchronized (lock) {
            state = newState;
            message = newMessage == null ? "" : newMessage;
            progress = newProgress;
        }
    }

    private void handleStart(boolean retry) {
        synchronized (lock) {
            boolean failed = ServerProtocol.STATE_FAILED.equals(state);
            if (nodeLaunched) {
                if (failed && retry) {
                    // Node.js can't run twice in one process: start over in a fresh one.
                    // Clients rebind automatically and send MSG_START again.
                    Log.i(TAG, "Restarting the server process");
                    deleteNodeStatus();
                    state = ServerProtocol.STATE_RESTARTING;
                    mainHandler.postDelayed(() -> Process.killProcess(Process.myPid()), 200);
                }
                return;
            }
            if (ServerProtocol.STATE_INSTALLING.equals(state) || ServerProtocol.STATE_STARTING.equals(state)) {
                return;
            }
            if (failed && !retry) {
                return;
            }
            state = ServerProtocol.STATE_INSTALLING;
            message = "";
            progress = -1f;
        }
        deleteNodeStatus();
        new Thread(this::launch, "SillyTavern-Launcher").start();
    }

    private void launch() {
        File appDir;
        try {
            appDir = AssetInstaller.ensureInstalled(this, fraction -> {
                synchronized (lock) {
                    progress = fraction;
                }
            });
        } catch (IOException e) {
            Log.e(TAG, "Installation failed", e);
            setState(ServerProtocol.STATE_FAILED, "Could not unpack the SillyTavern server files.\n\n" + e.getMessage(), -1f);
            return;
        }

        int selectedPort = choosePort();
        File runtimeDir = ServerProtocol.runtimeDir(this);
        File dataDir = ServerProtocol.dataDir(this);
        File tmpDir = new File(getCacheDir(), "tmp");
        runtimeDir.mkdirs();
        dataDir.mkdirs();
        tmpDir.mkdirs();
        rotateLog();

        String[] args = {
            "node",
            new File(appDir, "mobile/start-mobile.js").getAbsolutePath(),
            "--configPath=" + ServerProtocol.configFile(this).getAbsolutePath(),
            "--dataRoot=" + dataDir.getAbsolutePath(),
            "--port=" + selectedPort,
            "--browserLaunchEnabled=false",
        };
        List<String> env = new ArrayList<>();
        env.add("NODE_ENV=production");
        env.add("HOME=" + getFilesDir().getAbsolutePath());
        env.add("TMPDIR=" + tmpDir.getAbsolutePath());
        env.add("TZ=" + TimeZone.getDefault().getID());
        env.add("SILLYTAVERN_MOBILE_STATUS_FILE=" + ServerProtocol.statusFile(this).getAbsolutePath());

        synchronized (lock) {
            port = selectedPort;
            state = ServerProtocol.STATE_STARTING;
            progress = -1f;
            nodeLaunched = true;
        }
        Log.i(TAG, "Starting Node.js on port " + selectedPort);

        try {
            NodeBridge.start(args, env.toArray(new String[0]), ServerProtocol.logFile(this).getAbsolutePath(), this::onNodeExit);
        } catch (IllegalStateException e) {
            setState(ServerProtocol.STATE_FAILED, e.getMessage(), -1f);
            return;
        }
        monitorNodeStatus();
    }

    /** Follows the status file written by mobile/runtime/status.js. */
    private void monitorNodeStatus() {
        while (true) {
            JSONObject status = readNodeStatus();
            String nodeState = status == null ? "" : status.optString("state");
            synchronized (lock) {
                if (ServerProtocol.STATE_FAILED.equals(state)) {
                    return;
                }
                if ("ready".equals(nodeState) && !ServerProtocol.STATE_READY.equals(state)) {
                    Log.i(TAG, "Server is ready on port " + port);
                    state = ServerProtocol.STATE_READY;
                } else if ("exited".equals(nodeState)) {
                    state = ServerProtocol.STATE_FAILED;
                    message = describeExit(status);
                    return;
                }
            }
            try {
                Thread.sleep(STATUS_POLL_MS);
            } catch (InterruptedException e) {
                return;
            }
        }
    }

    private void onNodeExit(int exitCode) {
        JSONObject status = readNodeStatus();
        String reason = status != null && "exited".equals(status.optString("state"))
            ? describeExit(status)
            : "The server stopped unexpectedly (exit code " + exitCode + ").";
        setState(ServerProtocol.STATE_FAILED, reason, -1f);
    }

    private String describeExit(JSONObject status) {
        String details = status.optString("message", "").trim();
        int code = status.optInt("code", 0);
        StringBuilder text = new StringBuilder("The server stopped");
        text.append(code != 0 ? " with an error (exit code " + code + ")." : ".");
        if (!details.isEmpty()) {
            text.append("\n\n").append(details);
        }
        return text.toString();
    }

    private JSONObject readNodeStatus() {
        File file = ServerProtocol.statusFile(this);
        if (!file.isFile()) {
            return null;
        }
        try {
            return new JSONObject(AssetInstaller.readText(file));
        } catch (Exception e) {
            return null;
        }
    }

    private void deleteNodeStatus() {
        File file = ServerProtocol.statusFile(this);
        if (file.exists() && !file.delete()) {
            Log.w(TAG, "Could not delete " + file);
        }
    }

    private void rotateLog() {
        File log = ServerProtocol.logFile(this);
        if (log.exists()) {
            File previous = new File(log.getParentFile(), log.getName() + ".1");
            if (previous.exists()) {
                previous.delete();
            }
            log.renameTo(previous);
        }
    }

    /**
     * Uses the last port if possible so the page origin (and its local storage) stays stable,
     * otherwise the first free port after the default one.
     */
    private int choosePort() {
        SharedPreferences prefs = getSharedPreferences("server", MODE_PRIVATE);
        int last = prefs.getInt("port", DEFAULT_PORT);
        int chosen = isPortFree(last) ? last : -1;
        for (int candidate = DEFAULT_PORT; chosen < 0 && candidate < DEFAULT_PORT + PORT_RANGE; candidate++) {
            if (isPortFree(candidate)) {
                chosen = candidate;
            }
        }
        if (chosen < 0) {
            chosen = last;
        }
        if (chosen != last) {
            Log.w(TAG, "Port " + last + " is in use, switching to " + chosen);
        }
        prefs.edit().putInt("port", chosen).apply();
        return chosen;
    }

    private static boolean isPortFree(int port) {
        try (ServerSocket socket = new ServerSocket()) {
            socket.setReuseAddress(true);
            socket.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port));
            return true;
        } catch (IOException e) {
            return false;
        }
    }
}
