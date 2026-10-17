package ai.sillytavern.app;

import android.Manifest;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * Receives downloads from the page (see assets/bridge.js) and saves them to
 * Download/SillyTavern. Files arrive base64-encoded in chunks so large backups don't have to
 * fit in a single JavaScript string.
 */
final class DownloadBridge {
    static final String JS_NAME = "SillyTavernAndroid";
    private static final String TAG = "SillyTavern:Download";
    private static final String SUBFOLDER = "SillyTavern";

    private final Activity activity;
    private final Map<Integer, PendingFile> pending = new HashMap<>();
    private int nextId = 1;

    private static final class PendingFile {
        final String displayName;
        final OutputStream stream;
        final Uri uri;
        final File file;

        PendingFile(String displayName, OutputStream stream, Uri uri, File file) {
            this.displayName = displayName;
            this.stream = stream;
            this.uri = uri;
            this.file = file;
        }
    }

    DownloadBridge(Activity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public synchronized int beginDownload(String fileName, String mimeType) {
        String name = sanitizeFileName(fileName);
        String mime = resolveMimeType(name, mimeType);
        try {
            PendingFile file = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? createMediaStoreFile(name, mime) : createLegacyFile(name);
            int id = nextId++;
            pending.put(id, file);
            return id;
        } catch (IOException | RuntimeException e) {
            Log.e(TAG, "Could not create " + name, e);
            toast(activity.getString(R.string.download_failed, name, e.getMessage()));
            return -1;
        }
    }

    @JavascriptInterface
    public synchronized boolean appendDownload(int id, String base64Chunk) {
        PendingFile file = pending.get(id);
        if (file == null) {
            return false;
        }
        try {
            file.stream.write(Base64.decode(base64Chunk, Base64.DEFAULT));
            return true;
        } catch (IOException | IllegalArgumentException e) {
            Log.e(TAG, "Write failed for " + file.displayName, e);
            discard(id, e.getMessage());
            return false;
        }
    }

    @JavascriptInterface
    public synchronized void finishDownload(int id) {
        PendingFile file = pending.remove(id);
        if (file == null) {
            return;
        }
        try {
            file.stream.close();
            if (file.uri != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.IS_PENDING, 0);
                activity.getContentResolver().update(file.uri, values, null, null);
            }
            String location = file.file != null ? file.file.getAbsolutePath() : Environment.DIRECTORY_DOWNLOADS + "/" + SUBFOLDER + "/" + file.displayName;
            toast(activity.getString(R.string.download_saved, location));
        } catch (IOException | RuntimeException e) {
            Log.e(TAG, "Could not finish " + file.displayName, e);
            toast(activity.getString(R.string.download_failed, file.displayName, e.getMessage()));
        }
    }

    @JavascriptInterface
    public synchronized void failDownload(int id, String error) {
        if (id >= 0) {
            discard(id, error);
        } else {
            toast(activity.getString(R.string.download_failed, "file", error));
        }
    }

    private void discard(int id, String error) {
        PendingFile file = pending.remove(id);
        if (file == null) {
            return;
        }
        try {
            file.stream.close();
        } catch (IOException ignored) {
            // already failing
        }
        if (file.uri != null) {
            activity.getContentResolver().delete(file.uri, null, null);
        } else if (file.file != null) {
            file.file.delete();
        }
        toast(activity.getString(R.string.download_failed, file.displayName, error));
    }

    private PendingFile createMediaStoreFile(String name, String mime) throws IOException {
        ContentResolver resolver = activity.getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.Downloads.DISPLAY_NAME, name);
        values.put(MediaStore.Downloads.MIME_TYPE, mime);
        values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/" + SUBFOLDER);
        values.put(MediaStore.Downloads.IS_PENDING, 1);
        Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) {
            throw new IOException("MediaStore refused the file");
        }
        OutputStream stream = resolver.openOutputStream(uri);
        if (stream == null) {
            resolver.delete(uri, null, null);
            throw new IOException("Could not open the file for writing");
        }
        return new PendingFile(name, stream, uri, null);
    }

    @SuppressWarnings("deprecation")
    private PendingFile createLegacyFile(String name) throws IOException {
        File dir;
        if (activity.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED) {
            dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), SUBFOLDER);
        } else {
            // Ask for next time; save to the app's own folder for now (no permission needed)
            activity.runOnUiThread(() -> activity.requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, MainActivity.REQUEST_STORAGE));
            dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            if (dir == null) {
                throw new IOException("Shared storage is not available");
            }
        }
        if (!dir.isDirectory() && !dir.mkdirs()) {
            throw new IOException("Could not create " + dir);
        }
        File file = uniqueFile(dir, name);
        return new PendingFile(file.getName(), new FileOutputStream(file), null, file);
    }

    private static File uniqueFile(File dir, String name) {
        File file = new File(dir, name);
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; file.exists(); i++) {
            file = new File(dir, base + " (" + i + ")" + ext);
        }
        return file;
    }

    static String sanitizeFileName(String fileName) {
        String name = fileName == null ? "" : fileName.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", "_").trim();
        while (name.startsWith(".")) {
            name = name.substring(1);
        }
        if (name.isEmpty()) {
            name = "download";
        }
        return name.length() > 120 ? name.substring(0, 120) : name;
    }

    /**
     * MediaStore appends an extension when the MIME type doesn't match the file name
     * (chat.jsonl sent as text/plain would become chat.jsonl.txt), so the type is derived
     * from the extension. Unknown extensions use octet-stream, which keeps the name as is.
     */
    private static String resolveMimeType(String name, String mimeType) {
        int dot = name.lastIndexOf('.');
        String extension = dot > 0 ? name.substring(dot + 1).toLowerCase(java.util.Locale.ROOT) : "";
        if (!extension.isEmpty()) {
            String guessed = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
            return guessed != null ? guessed : "application/octet-stream";
        }
        if (mimeType != null && !mimeType.trim().isEmpty()) {
            return mimeType.split(";")[0].trim();
        }
        return "application/octet-stream";
    }

    private void toast(String text) {
        activity.runOnUiThread(() -> Toast.makeText(activity, text, Toast.LENGTH_LONG).show());
    }
}
