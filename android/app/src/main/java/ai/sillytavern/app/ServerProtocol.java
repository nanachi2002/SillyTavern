package ai.sillytavern.app;

import android.content.Context;

import java.io.File;

/**
 * Messages and file locations shared by the UI process (MainActivity, KeepAliveService)
 * and the server process (ServerService).
 */
final class ServerProtocol {
    private ServerProtocol() {
    }

    /** Ask the server to start. arg1 = 1 to retry after a failure. */
    static final int MSG_START = 1;
    /** Ask for the current status; the reply carries a status Bundle. */
    static final int MSG_STATUS = 2;

    static final String KEY_STATE = "state";
    static final String KEY_MESSAGE = "message";
    static final String KEY_PROGRESS = "progress";
    static final String KEY_PORT = "port";

    /** Nothing started yet in this process. */
    static final String STATE_IDLE = "idle";
    /** Unpacking the server files from the APK. */
    static final String STATE_INSTALLING = "installing";
    /** Node.js is running but the server isn't listening yet. */
    static final String STATE_STARTING = "starting";
    /** The server is listening on KEY_PORT. */
    static final String STATE_READY = "ready";
    /** Startup failed or the server stopped; KEY_MESSAGE explains why. */
    static final String STATE_FAILED = "failed";
    /** A retry was requested and the server process is restarting. */
    static final String STATE_RESTARTING = "restarting";

    static File runtimeDir(Context context) {
        return new File(context.getFilesDir(), "runtime");
    }

    /** Written by mobile/runtime/status.js inside Node.js. */
    static File statusFile(Context context) {
        return new File(runtimeDir(context), "status.json");
    }

    /** Node.js stdout/stderr, written by the native bridge. */
    static File logFile(Context context) {
        return new File(runtimeDir(context), "server.log");
    }

    /** Server files unpacked from the APK; replaced on app updates. */
    static File appDir(Context context) {
        return new File(context.getFilesDir(), "sillytavern");
    }

    /** User data (characters, chats, settings). Never touched by updates. */
    static File dataDir(Context context) {
        return new File(context.getFilesDir(), "sillytavern-data");
    }

    /** config.yaml lives outside appDir so it survives updates. */
    static File configFile(Context context) {
        return new File(new File(context.getFilesDir(), "sillytavern-config"), "config.yaml");
    }
}
