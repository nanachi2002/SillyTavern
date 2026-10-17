'use strict';
/**
 * Stand-in for webpack inside the Android bundle.
 *
 * public/lib.js is compiled on the build machine (mobile/build-assets.mjs) and stored in
 * mobile/prebuilt/. Running the real webpack on a phone would add a long compile step to
 * every launch, so this stub just copies the prebuilt file to the output path the server
 * expects. The version field of package.json is set to the real webpack version so the
 * server's cache key stays the same.
 */
const fs = require('node:fs');
const path = require('node:path');

const prebuiltDir = path.resolve(__dirname, '..', '..', 'mobile', 'prebuilt');

function webpack(config) {
    return {
        run(callback) {
            try {
                const fileName = config.output.filename;
                const source = path.join(prebuiltDir, fileName);
                const target = path.join(config.output.path, fileName);
                const sourceStat = fs.statSync(source);
                const targetStat = fs.existsSync(target) ? fs.statSync(target) : null;
                if (!targetStat || targetStat.size !== sourceStat.size || targetStat.mtimeMs < sourceStat.mtimeMs) {
                    fs.mkdirSync(config.output.path, { recursive: true });
                    fs.copyFileSync(source, target);
                }
                callback(null, { toString: () => `Using prebuilt ${fileName}`, hasErrors: () => false });
            } catch (error) {
                console.error('Failed to install the prebuilt frontend libraries:', error);
                callback(error, { toString: () => String(error), hasErrors: () => true });
            }
        },
        close(callback) {
            callback && callback();
        },
    };
}

module.exports = webpack;
module.exports.default = webpack;
module.exports.version = require('./package.json').version;
