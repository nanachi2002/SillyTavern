package ai.sillytavern.app;

import android.util.Log;

/**
 * JNI bridge to the embedded Node.js runtime (libnode.so from nodejs-mobile).
 * Node.js can only be started once per process, which is why the server runs in its own
 * process (see ServerService).
 */
final class NodeBridge {
    private static final String TAG = "SillyTavern:Node";

    interface ExitListener {
        void onNodeExit(int exitCode);
    }

    private static volatile ExitListener exitListener;
    private static boolean libraryLoaded;

    private NodeBridge() {
    }

    /**
     * Starts Node.js on a background thread.
     *
     * @param args     argv, starting with "node"
     * @param env      environment variables as KEY=VALUE
     * @param logPath  file that receives stdout/stderr (also mirrored to logcat)
     * @param listener called when node::Start returns
     * @throws IllegalStateException if the native library can't be loaded or Node was already started
     */
    static synchronized void start(String[] args, String[] env, String logPath, ExitListener listener) {
        if (!libraryLoaded) {
            try {
                // libnode.so is loaded automatically as a dependency of the bridge
                System.loadLibrary("sillytavern-node");
                libraryLoaded = true;
            } catch (UnsatisfiedLinkError e) {
                Log.e(TAG, "Failed to load the Node.js runtime", e);
                throw new IllegalStateException("The Node.js runtime could not be loaded on this device: " + e.getMessage(), e);
            }
        }
        exitListener = listener;
        if (!nativeStart(args, env, logPath)) {
            throw new IllegalStateException("Node.js was already started in this process");
        }
    }

    private static native boolean nativeStart(String[] args, String[] env, String logPath);

    /** Called from the native Node.js thread when node::Start returns. */
    @SuppressWarnings("unused")
    private static void onNodeExit(int exitCode) {
        Log.w(TAG, "Node.js exited with code " + exitCode);
        ExitListener listener = exitListener;
        if (listener != null) {
            listener.onNodeExit(exitCode);
        }
    }
}
