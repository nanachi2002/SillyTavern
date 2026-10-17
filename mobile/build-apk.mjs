#!/usr/bin/env node
/**
 * One-command Android build: fetches libnode.so, bundles the server and runs Gradle.
 *
 * Usage: node mobile/build-apk.mjs [debug|release] [--skip-install]
 *
 * Requires Node.js >= 20, JDK 17+ and the Android SDK (ANDROID_HOME or android/local.properties)
 * with the NDK and CMake 3.22.1 installed (Android Studio's SDK Manager can install them).
 * APKs end up in android/app/build/outputs/apk/<type>/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const mobileDir = path.dirname(fileURLToPath(import.meta.url));
const androidDir = path.resolve(mobileDir, '..', 'android');
const args = process.argv.slice(2);
const buildType = args.includes('release') ? 'release' : 'debug';
const isWindows = process.platform === 'win32';

function run(command, commandArgs, options = {}) {
    console.log(`\n\x1b[35m> ${command} ${commandArgs.join(' ')}\x1b[0m`);
    const result = spawnSync(command, commandArgs, { stdio: 'inherit', shell: isWindows, ...options });
    if (result.status !== 0) {
        console.error(`\x1b[31mFailed: ${command} ${commandArgs.join(' ')}\x1b[0m`);
        process.exit(result.status ?? 1);
    }
}

run(process.execPath, [path.join(mobileDir, 'fetch-libnode.mjs')]);
run(process.execPath, [path.join(mobileDir, 'build-assets.mjs'), ...args.filter(a => a === '--skip-install')]);

const gradlew = path.join(androidDir, isWindows ? 'gradlew.bat' : 'gradlew');
if (!isWindows) {
    fs.chmodSync(gradlew, 0o755);
}
const task = buildType === 'release' ? 'assembleRelease' : 'assembleDebug';
run(gradlew, [task], { cwd: androidDir });

const outputDir = path.join(androidDir, 'app', 'build', 'outputs', 'apk', buildType);
const apks = fs.existsSync(outputDir) ? fs.readdirSync(outputDir).filter(f => f.endsWith('.apk')) : [];
console.log('\n\x1b[32mBuild complete:\x1b[0m');
for (const apk of apks) {
    const size = fs.statSync(path.join(outputDir, apk)).size / 1048576;
    console.log(`  ${path.relative(process.cwd(), path.join(outputDir, apk))} (${size.toFixed(0)} MB)`);
}
