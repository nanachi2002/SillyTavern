package ai.sillytavern.app;

import android.content.Context;
import android.content.res.AssetManager;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Unpacks the server bundle (assets/sillytavern.zip, produced by mobile/build-assets.mjs)
 * into internal storage. The bundle is only unpacked again when its build id changes, and
 * a new version is unpacked next to the old one and swapped in when complete, so an
 * interrupted install never leaves broken files behind.
 */
final class AssetInstaller {
    private static final String TAG = "SillyTavern:Install";
    private static final String BUNDLE_ASSET = "sillytavern.zip";
    private static final String BUILD_INFO_ASSET = "sillytavern-build.json";
    private static final String MARKER_FILE = ".build-id";
    private static final String ENTRY_SCRIPT = "mobile/start-mobile.js";
    /**
     * User files that SillyTavern stores inside the server directory instead of the data
     * directory. They are carried over to every new version (see carryOverUserFiles).
     * Everything else that belongs to the user (chats, characters, presets, settings,
     * user extensions, caches) lives in the data directory and config.yaml in its own
     * directory, which installs never touch.
     */
    private static final String[] USER_PATHS = {
        // Extensions installed "for all users" (src/constants.js, globalExtensions)
        "public/scripts/extensions/third-party",
    };

    interface ProgressListener {
        void onProgress(float fraction);
    }

    private AssetInstaller() {
    }

    /**
     * Makes sure the current server bundle is unpacked.
     *
     * @return the directory that contains the server files
     */
    static File ensureInstalled(Context context, ProgressListener listener) throws IOException {
        File appDir = ServerProtocol.appDir(context);
        JSONObject buildInfo = readBuildInfo(context.getAssets());
        String buildId = buildInfo.optString("buildId", "");
        long totalBytes = buildInfo.optLong("totalBytes", 0);
        File parent = context.getFilesDir();
        File tempDir = new File(parent, "sillytavern.installing");
        File oldDir = new File(parent, "sillytavern.old");

        // An earlier install was interrupted between the two renames of the swap below: the
        // previous server files (and the user files inside them) are still in oldDir.
        if (!appDir.exists() && oldDir.isDirectory()) {
            Log.w(TAG, "Recovering the server files of an interrupted install");
            if (!oldDir.renameTo(appDir)) {
                throw new IOException("Could not recover the previous server files from " + oldDir);
            }
        }

        File marker = new File(appDir, MARKER_FILE);
        if (marker.isFile() && buildId.equals(readText(marker)) && new File(appDir, ENTRY_SCRIPT).isFile()) {
            Log.i(TAG, "Server files are up to date (build " + buildId + ")");
            return appDir;
        }

        Log.i(TAG, "Installing server files, build " + buildId);
        deleteRecursively(tempDir);
        deleteRecursively(oldDir);

        long required = totalBytes + 64L * 1024 * 1024;
        long available = parent.getUsableSpace();
        if (totalBytes > 0 && available < required) {
            throw new IOException(String.format(
                "Not enough free storage: SillyTavern needs %d MB to install, but only %d MB are available.",
                required / (1024 * 1024), available / (1024 * 1024)));
        }

        unzip(context.getAssets(), tempDir, totalBytes, listener);
        carryOverUserFiles(appDir, tempDir);
        writeText(new File(tempDir, MARKER_FILE), buildId);

        if (appDir.exists() && !appDir.renameTo(oldDir)) {
            deleteRecursively(appDir);
        }
        if (!tempDir.renameTo(appDir)) {
            throw new IOException("Could not move the server files into place");
        }
        deleteRecursively(oldDir);
        Log.i(TAG, "Server files installed");
        return appDir;
    }

    private static JSONObject readBuildInfo(AssetManager assets) throws IOException {
        try (InputStream in = assets.open(BUILD_INFO_ASSET)) {
            return new JSONObject(new String(readAll(in), StandardCharsets.UTF_8));
        } catch (JSONException e) {
            throw new IOException("Invalid " + BUILD_INFO_ASSET, e);
        } catch (IOException e) {
            throw new IOException("The server bundle is missing from this APK. Build it with mobile/build-assets.mjs before building the app.", e);
        }
    }

    private static void unzip(AssetManager assets, File targetDir, long totalBytes, ProgressListener listener) throws IOException {
        if (!targetDir.mkdirs() && !targetDir.isDirectory()) {
            throw new IOException("Could not create " + targetDir);
        }
        String canonicalTarget = targetDir.getCanonicalPath() + File.separator;
        byte[] buffer = new byte[256 * 1024];
        long written = 0;
        float lastReported = -1;

        try (ZipInputStream zip = new ZipInputStream(new BufferedInputStream(assets.open(BUNDLE_ASSET), 256 * 1024))) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                File file = new File(targetDir, entry.getName());
                if (!file.getCanonicalPath().startsWith(canonicalTarget)) {
                    throw new IOException("Invalid entry in server bundle: " + entry.getName());
                }
                if (entry.isDirectory()) {
                    file.mkdirs();
                    continue;
                }
                File dir = file.getParentFile();
                if (dir != null && !dir.isDirectory() && !dir.mkdirs()) {
                    throw new IOException("Could not create " + dir);
                }
                try (OutputStream out = new FileOutputStream(file)) {
                    int read;
                    while ((read = zip.read(buffer)) > 0) {
                        out.write(buffer, 0, read);
                        written += read;
                    }
                }
                if (listener != null && totalBytes > 0) {
                    float fraction = Math.min(1f, (float) written / totalBytes);
                    if (fraction - lastReported >= 0.01f) {
                        lastReported = fraction;
                        listener.onProgress(fraction);
                    }
                }
            }
        }
    }

    /**
     * Copies the user files that SillyTavern keeps inside the server directory into the new
     * version. They are copied, not moved, so the old directory stays complete until the swap:
     * an install interrupted at any point never loses them.
     */
    private static void carryOverUserFiles(File oldAppDir, File newAppDir) throws IOException {
        for (String relativePath : USER_PATHS) {
            File source = new File(oldAppDir, relativePath);
            if (!source.exists()) {
                continue;
            }
            File target = new File(newAppDir, relativePath);
            deleteRecursively(target);
            Log.i(TAG, "Keeping " + relativePath);
            copyRecursively(source, target);
        }
    }

    private static void copyRecursively(File source, File target) throws IOException {
        if (source.isDirectory()) {
            if (!target.isDirectory() && !target.mkdirs()) {
                throw new IOException("Could not create " + target);
            }
            File[] children = source.listFiles();
            if (children == null) {
                throw new IOException("Could not list " + source);
            }
            for (File child : children) {
                copyRecursively(child, new File(target, child.getName()));
            }
            return;
        }
        File dir = target.getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs()) {
            throw new IOException("Could not create " + dir);
        }
        byte[] buffer = new byte[64 * 1024];
        try (InputStream in = new java.io.FileInputStream(source); OutputStream out = new FileOutputStream(target)) {
            int read;
            while ((read = in.read(buffer)) > 0) {
                out.write(buffer, 0, read);
            }
        }
        target.setLastModified(source.lastModified());
    }

    static void deleteRecursively(File file) {
        if (file == null || !file.exists()) {
            return;
        }
        File[] children = file.isDirectory() ? file.listFiles() : null;
        if (children != null) {
            for (File child : children) {
                deleteRecursively(child);
            }
        }
        if (!file.delete()) {
            Log.w(TAG, "Could not delete " + file);
        }
    }

    static String readText(File file) {
        try (InputStream in = new java.io.FileInputStream(file)) {
            return new String(readAll(in), StandardCharsets.UTF_8).trim();
        } catch (IOException e) {
            return "";
        }
    }

    private static void writeText(File file, String text) throws IOException {
        try (OutputStream out = new FileOutputStream(file)) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
        }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int read;
        while ((read = in.read(buffer)) > 0) {
            out.write(buffer, 0, read);
        }
        return out.toByteArray();
    }
}
