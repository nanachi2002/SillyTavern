import http from 'node:http';

/**
 * Tells the Android app when the server is working on requests, so it can keep the CPU awake
 * (a partial wake lock) while the screen is off. Without it, the phone may suspend in the
 * middle of a long streamed generation, image generation or backup.
 *
 * Every incoming HTTP request is counted until its response is finished or aborted, which
 * for streamed generations means until the last token. Short bursts (page loads, settings
 * saves) are filtered out by the start delay, and the stop delay avoids flapping between
 * back-to-back requests.
 */
const START_DELAY_MS = 500;
const STOP_DELAY_MS = 1500;

let activeRequests = 0;
let busy = false;
let timer = null;

/**
 * @param {(busy: boolean) => void} onChange Called when the busy state changes
 */
export function installActivityTracking(onChange) {
    const setBusy = (value) => {
        if (busy !== value) {
            busy = value;
            onChange(value);
        }
    };

    const update = () => {
        clearTimeout(timer);
        if (activeRequests > 0 && !busy) {
            timer = setTimeout(() => activeRequests > 0 && setBusy(true), START_DELAY_MS);
        } else if (activeRequests === 0 && busy) {
            timer = setTimeout(() => activeRequests === 0 && setBusy(false), STOP_DELAY_MS);
        }
        timer?.unref?.();
    };

    const originalEmit = http.Server.prototype.emit;
    http.Server.prototype.emit = function (event, request, response) {
        if (event === 'request' && response) {
            activeRequests++;
            let done = false;
            response.once('close', () => {
                if (done) return;
                done = true;
                activeRequests--;
                update();
            });
            update();
        }
        // eslint-disable-next-line prefer-rest-params
        return originalEmit.apply(this, arguments);
    };
}
