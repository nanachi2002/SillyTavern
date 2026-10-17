import fs from 'node:fs';
import path from 'node:path';

/**
 * Reports the server state to the Android app through a small JSON file.
 * The app polls it to drive the splash screen and to show startup errors.
 * The file path comes from SILLYTAVERN_MOBILE_STATUS_FILE; without it reporting is a no-op.
 */
const statusFile = process.env.SILLYTAVERN_MOBILE_STATUS_FILE || '';
const recentErrors = [];
let isReady = false;
const MAX_ERROR_LINES = 30;

/**
 * Writes the status file atomically.
 * @param {'starting'|'ready'|'exited'} state Server state
 * @param {object} [extra] Additional fields
 */
export function writeStatus(state, extra = {}) {
    if (state === 'ready') isReady = true;
    if (!statusFile) return;
    try {
        fs.mkdirSync(path.dirname(statusFile), { recursive: true });
        const tmp = `${statusFile}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ state, time: Date.now(), ...extra }));
        fs.renameSync(tmp, statusFile);
    } catch {
        // Nothing useful can be done if the status can't be written
    }
}

/**
 * Remembers the last error lines so they can be shown if the server dies.
 * @param {string} text Text written to stderr
 */
function rememberError(text) {
    // eslint-disable-next-line no-control-regex
    const clean = String(text).replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');
    for (const line of clean.split('\n')) {
        if (!line.trim()) continue;
        recentErrors.push(line);
        if (recentErrors.length > MAX_ERROR_LINES) recentErrors.shift();
    }
}

/**
 * @returns {string} The last error lines written to stderr
 */
export function getRecentErrors() {
    return recentErrors.join('\n');
}

/**
 * Hooks stderr, process.exit and fatal errors so that the app learns why the server stopped.
 * On Android, process.exit() terminates the whole server process, so the status has to be
 * written before that happens.
 */
export function installExitReporting() {
    const originalWrite = process.stderr.write.bind(process.stderr);
    // @ts-ignore
    process.stderr.write = (chunk, ...rest) => {
        rememberError(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
        return originalWrite(chunk, ...rest);
    };

    const originalExit = process.exit.bind(process);
    // @ts-ignore
    process.exit = (code) => {
        const exitCode = code ?? process.exitCode ?? 0;
        writeStatus('exited', { code: exitCode, message: getRecentErrors() });
        return originalExit(exitCode);
    };

    process.on('exit', (code) => {
        writeStatus('exited', { code, message: getRecentErrors() });
    });

    process.on('unhandledRejection', (reason) => {
        console.error('Unhandled promise rejection:', reason);
        // A rejection during startup means the server will never come up: fail loudly.
        // Once running, keep serving instead of taking the whole app down.
        if (!isReady) {
            process.exit(1);
        }
    });
}
