#!/usr/bin/env node
/**
 * Builds the SillyTavern server bundle that ships inside the Android APK.
 *
 * Usage: node mobile/build-assets.mjs [--skip-install]
 *   --skip-install  reuse node_modules from the previous run (faster rebuilds)
 *
 * Steps:
 *  1. Stage the server files (src, public, default, ...) into mobile/build/stage
 *  2. Install production dependencies with `npm ci --omit=dev`
 *  3. Pre-compile the frontend library bundle (public/lib.js) with webpack and
 *     replace webpack in the bundle with a tiny stub that serves the prebuilt file
 *  4. Rewrite regex Unicode property escapes (\p{...}) that nodejs-mobile
 *     (Node 18 built without ICU) cannot parse
 *  5. Prune files that are not needed at runtime
 *  6. Pack everything into android/app/src/main/assets/sillytavern.zip
 *
 * Requires Node.js >= 20 and npm on the build machine. Works on Linux, macOS and Windows.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const mobileDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(mobileDir, '..');
const buildDir = path.join(mobileDir, 'build');
const stageDir = path.join(buildDir, 'stage');
const toolsDir = path.join(buildDir, 'tools');
const assetsDir = path.join(repoRoot, 'android', 'app', 'src', 'main', 'assets');
const zipPath = path.join(assetsDir, 'sillytavern.zip');
const buildInfoPath = path.join(assetsDir, 'sillytavern-build.json');

const args = new Set(process.argv.slice(2));
const isWindows = process.platform === 'win32';
const npmCommand = isWindows ? 'npm.cmd' : 'npm';

/** Top-level entries of the repository that are needed at runtime. */
const INCLUDE = ['src', 'public', 'default', 'plugins', 'webpack.config.js', 'package.json', 'package-lock.json', 'LICENSE'];
/** Paths (relative to the repo root, forward slashes) that are never shipped. */
const EXCLUDE = ['src/electron', 'public/scripts/extensions/third-party'];
/** Mobile runtime files copied into the stage under mobile/. */
const MOBILE_FILES = ['start-mobile.js', 'runtime'];
/** Tools used only on the build machine. */
const TOOL_PACKAGES = ['acorn@8.15.0', 'regexpu-core@6.2.0', 'archiver@7.0.1'];
/** Runtime packages added to the bundle for the Node 18 compatibility layer. */
const RUNTIME_PACKAGES = ['regexpu-core@6.2.0'];

function log(message) {
    console.log(`\x1b[36m[build-assets]\x1b[0m ${message}`);
}

function run(command, commandArgs, options = {}) {
    const result = spawnSync(command, commandArgs, { stdio: 'inherit', shell: isWindows, ...options });
    if (result.status !== 0) {
        throw new Error(`Command failed (${result.status}): ${command} ${commandArgs.join(' ')}`);
    }
}

function toPosix(p) {
    return p.split(path.sep).join('/');
}

function isExcluded(relPath) {
    const posix = toPosix(relPath);
    return EXCLUDE.some(e => posix === e || posix.startsWith(e + '/'));
}

/**
 * Lists the repository files to ship. Uses git to skip untracked user content
 * (characters, chats, config.yaml, ...) when available.
 * @returns {string[]} Relative file paths
 */
function listSourceFiles() {
    const git = spawnSync('git', ['ls-files', '-z', '--', ...INCLUDE], { cwd: repoRoot, encoding: 'utf8' });
    if (git.status === 0 && git.stdout) {
        return git.stdout.split('\0').filter(Boolean).filter(f => !isExcluded(f) && fs.existsSync(path.join(repoRoot, f)));
    }

    log('git is not available, copying directories as-is (make sure they contain no personal data)');
    const files = [];
    const walk = (rel) => {
        const abs = path.join(repoRoot, rel);
        if (!fs.existsSync(abs) || isExcluded(rel)) return;
        const stat = fs.lstatSync(abs);
        if (stat.isDirectory()) {
            for (const entry of fs.readdirSync(abs)) walk(path.join(rel, entry));
        } else if (stat.isFile()) {
            files.push(rel);
        }
    };
    INCLUDE.forEach(walk);
    return files;
}

function copyFile(src, dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
}

function copyRecursive(src, dest) {
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(src)) copyRecursive(path.join(src, entry), path.join(dest, entry));
    } else {
        copyFile(src, dest);
    }
}

function* walkFiles(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            yield* walkFiles(full);
        } else if (entry.isFile()) {
            yield full;
        }
    }
}

function stageFiles() {
    log(`Staging server files into ${path.relative(repoRoot, stageDir)}`);
    const keepModules = args.has('--skip-install') && fs.existsSync(path.join(stageDir, 'node_modules'));
    if (fs.existsSync(stageDir)) {
        for (const entry of fs.readdirSync(stageDir)) {
            if (keepModules && entry === 'node_modules') continue;
            fs.rmSync(path.join(stageDir, entry), { recursive: true, force: true });
        }
    }
    fs.mkdirSync(stageDir, { recursive: true });

    const files = listSourceFiles();
    for (const file of files) {
        copyFile(path.join(repoRoot, file), path.join(stageDir, file));
    }
    for (const file of MOBILE_FILES) {
        copyRecursive(path.join(mobileDir, file), path.join(stageDir, 'mobile', file));
    }
    log(`Staged ${files.length} repository files`);
}

function installDependencies() {
    const realWebpackBackup = path.join(buildDir, 'webpack-real');
    if (args.has('--skip-install') && fs.existsSync(path.join(stageDir, 'node_modules')) && fs.existsSync(realWebpackBackup)) {
        log('Skipping npm ci (--skip-install)');
        // The previous run replaced webpack with the stub; put the real one back for the prebuild
        const webpackDir = path.join(stageDir, 'node_modules', 'webpack');
        fs.rmSync(webpackDir, { recursive: true, force: true });
        copyRecursive(realWebpackBackup, webpackDir);
    } else {
        log('Installing production dependencies (npm ci --omit=dev)');
        run(npmCommand, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stageDir });
        fs.rmSync(realWebpackBackup, { recursive: true, force: true });
        copyRecursive(path.join(stageDir, 'node_modules', 'webpack'), realWebpackBackup);
    }

    log(`Installing runtime compatibility packages: ${RUNTIME_PACKAGES.join(', ')}`);
    const runtimeDir = path.join(stageDir, 'mobile', 'runtime');
    fs.writeFileSync(path.join(runtimeDir, 'package.json'), JSON.stringify({ name: 'sillytavern-mobile-runtime', private: true, type: 'module' }, null, 4));
    run(npmCommand, ['install', '--no-audit', '--no-fund', '--no-package-lock', '--ignore-scripts', ...RUNTIME_PACKAGES], { cwd: runtimeDir });
}

function installTools() {
    const marker = path.join(toolsDir, '.installed');
    const wanted = TOOL_PACKAGES.join(' ');
    if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === wanted) {
        return;
    }
    log(`Installing build tools: ${wanted}`);
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(path.join(toolsDir, 'package.json'), JSON.stringify({ name: 'sillytavern-mobile-build-tools', private: true }, null, 4));
    run(npmCommand, ['install', '--no-audit', '--no-fund', '--no-package-lock', '--ignore-scripts', ...TOOL_PACKAGES], { cwd: toolsDir });
    fs.writeFileSync(marker, wanted);
}

/**
 * Compiles public/lib.js with the real webpack, then swaps webpack for a stub.
 * Compiling on the phone would take a long time on every launch.
 */
function prebuildFrontendLibs() {
    const prebuiltDir = path.join(stageDir, 'mobile', 'prebuilt');
    const webpackDir = path.join(stageDir, 'node_modules', 'webpack');
    const webpackVersion = JSON.parse(fs.readFileSync(path.join(webpackDir, 'package.json'), 'utf8')).version;

    // The bundle only depends on these inputs. Reusing it also keeps --skip-install builds
    // identical: their node_modules were already rewritten and pruned by the previous run.
    const cacheKey = crypto.createHash('sha256');
    for (const input of ['package-lock.json', 'public/lib.js', 'webpack.config.js']) {
        cacheKey.update(fs.readFileSync(path.join(stageDir, input)));
    }
    const cachedFile = path.join(buildDir, 'lib-cache', `${cacheKey.digest('hex').slice(0, 16)}.js`);

    fs.mkdirSync(prebuiltDir, { recursive: true });
    if (args.has('--skip-install') && fs.existsSync(cachedFile)) {
        fs.copyFileSync(cachedFile, path.join(prebuiltDir, 'lib.js'));
        log('Reusing the prebuilt lib.js from the previous build');
    } else {
        compileFrontendLibs(prebuiltDir, cachedFile);
    }
    installWebpackStub(webpackDir, webpackVersion);
}

function compileFrontendLibs(prebuiltDir, cachedFile) {
    log('Pre-compiling frontend libraries with webpack');
    const tmpDataRoot = path.join(buildDir, 'webpack-data');
    fs.rmSync(tmpDataRoot, { recursive: true, force: true });
    fs.mkdirSync(tmpDataRoot, { recursive: true });

    const script = [
        `globalThis.DATA_ROOT = ${JSON.stringify(tmpDataRoot)};`,
        'const { default: getConfig } = await import("./webpack.config.js");',
        'const { default: getMiddleware } = await import("./src/middleware/webpack-serve.js");',
        'await getMiddleware().runWebpackCompiler();',
        'const config = getConfig();',
        'console.log("WEBPACK_OUTPUT=" + JSON.stringify({ dir: config.output.path, file: config.output.filename }));',
    ].join('\n');
    // GIT_CEILING_DIRECTORIES keeps the server's version check from picking up this repository,
    // so the cache version matches what the phone computes (no git there).
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: stageDir,
        encoding: 'utf8',
        env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(stageDir), NODE_ENV: 'production' },
    });
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    const match = /WEBPACK_OUTPUT=(.+)/.exec(result.stdout ?? '');
    if (result.status !== 0 || !match) {
        throw new Error('Webpack pre-compilation failed');
    }
    const { dir, file } = JSON.parse(match[1]);
    const builtFile = path.join(dir, file);
    if (!fs.existsSync(builtFile) || fs.statSync(builtFile).size < 1024) {
        throw new Error(`Webpack did not produce ${builtFile}`);
    }

    fs.copyFileSync(builtFile, path.join(prebuiltDir, file));
    fs.mkdirSync(path.dirname(cachedFile), { recursive: true });
    fs.copyFileSync(builtFile, cachedFile);
    fs.rmSync(tmpDataRoot, { recursive: true, force: true });
    log(`Prebuilt ${file} (${(fs.statSync(path.join(prebuiltDir, file)).size / 1024).toFixed(0)} KB)`);
}

function installWebpackStub(webpackDir, webpackVersion) {
    fs.rmSync(webpackDir, { recursive: true, force: true });
    copyRecursive(path.join(mobileDir, 'webpack-stub'), webpackDir);
    const stubPackagePath = path.join(webpackDir, 'package.json');
    const stubPackage = JSON.parse(fs.readFileSync(stubPackagePath, 'utf8'));
    stubPackage.version = webpackVersion;
    fs.writeFileSync(stubPackagePath, JSON.stringify(stubPackage, null, 4));
    log(`webpack ${webpackVersion} replaced with the stub`);
}

/**
 * Rewrites regular expressions that use Unicode property escapes (\p{L}) or the
 * `v` flag into equivalent explicit character ranges. nodejs-mobile is built
 * without ICU, so V8 throws a SyntaxError when such a regex is parsed - for
 * regex literals that happens at module load time and breaks the whole import.
 */
function transformUnicodeRegexes() {
    log('Rewriting Unicode property escapes for Node.js without ICU');
    const require = createRequire(path.join(toolsDir, 'package.json'));
    const acorn = require('acorn');
    const rewritePattern = require('regexpu-core');
    const needsTransform = (pattern, flags) => /\\[pP]\{/.test(pattern) || flags.includes('v');
    const rewriteOptions = (flags) => ({
        unicodePropertyEscapes: 'transform',
        unicodeSetsFlag: flags.includes('v') ? 'transform' : false,
    });

    /**
     * @param {string} pattern
     * @param {string} flags
     * @returns {{ pattern: string, flags: string }}
     */
    const rewrite = (pattern, flags) => {
        const newPattern = rewritePattern(pattern, flags, rewriteOptions(flags));
        const newFlags = flags.includes('v') ? flags.replace('v', 'u') : flags;
        return { pattern: newPattern, flags: newFlags };
    };

    const candidates = [];
    // Not mobile/: the runtime polyfills feature-detect \p{...} support and must stay as written
    for (const root of ['src', 'node_modules']) {
        const dir = path.join(stageDir, root);
        if (!fs.existsSync(dir)) continue;
        for (const file of walkFiles(dir)) {
            if (!/\.(c|m)?js$/.test(file)) continue;
            candidates.push(file);
        }
    }

    let changedFiles = 0;
    let changedRegexes = 0;
    const failures = [];
    for (const file of candidates) {
        const code = fs.readFileSync(file, 'utf8');
        if (!/\\[pP]\{|\/[dgimsuy]*v[dgimsuy]*\b/.test(code)) continue;

        let ast;
        for (const sourceType of ['module', 'script']) {
            try {
                ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType, allowHashBang: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true });
                break;
            } catch {
                // try the next source type
            }
        }
        if (!ast) {
            if (/\\[pP]\{/.test(code)) failures.push(`${toPosix(path.relative(stageDir, file))}: could not parse`);
            continue;
        }

        /** @type {{ start: number, end: number, text: string }[]} */
        const edits = [];
        const visit = (node) => {
            if (!node || typeof node.type !== 'string') return;
            if (node.type === 'Literal' && node.regex && needsTransform(node.regex.pattern, node.regex.flags)) {
                try {
                    const { pattern, flags } = rewrite(node.regex.pattern, node.regex.flags);
                    edits.push({ start: node.start, end: node.end, text: `/${pattern}/${flags}` });
                } catch (error) {
                    failures.push(`${toPosix(path.relative(stageDir, file))}:${node.start}: ${error.message}`);
                }
            }
            // new RegExp('\\p{L}', 'u') / RegExp('...', 'u') with literal arguments
            if ((node.type === 'NewExpression' || node.type === 'CallExpression') &&
                node.callee.type === 'Identifier' && node.callee.name === 'RegExp' &&
                node.arguments[0]?.type === 'Literal' && typeof node.arguments[0].value === 'string' &&
                (node.arguments.length < 2 || (node.arguments[1].type === 'Literal' && typeof node.arguments[1].value === 'string'))) {
                const flags = node.arguments[1]?.value ?? '';
                const source = node.arguments[0].value;
                if ((flags.includes('u') || flags.includes('v')) && needsTransform(source, flags)) {
                    try {
                        const { pattern, flags: newFlags } = rewrite(source, flags);
                        edits.push({ start: node.arguments[0].start, end: node.arguments[0].end, text: JSON.stringify(pattern) });
                        if (newFlags !== flags) {
                            edits.push({ start: node.arguments[1].start, end: node.arguments[1].end, text: JSON.stringify(newFlags) });
                        }
                    } catch (error) {
                        failures.push(`${toPosix(path.relative(stageDir, file))}:${node.start}: ${error.message}`);
                    }
                }
            }
            for (const key of Object.keys(node)) {
                const value = node[key];
                if (Array.isArray(value)) {
                    value.forEach(visit);
                } else if (value && typeof value === 'object' && typeof value.type === 'string') {
                    visit(value);
                }
            }
        };
        visit(ast);

        if (edits.length === 0) continue;
        edits.sort((a, b) => b.start - a.start);
        let output = code;
        for (const edit of edits) {
            output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
        }
        fs.writeFileSync(file, output);
        changedFiles++;
        changedRegexes += edits.length;
    }

    log(`Rewrote ${changedRegexes} regular expressions in ${changedFiles} files`);
    if (failures.length) {
        console.warn('Some regular expressions could not be rewritten (the runtime fallback will handle dynamic ones):');
        failures.forEach(f => console.warn(`  - ${f}`));
    }
}

/**
 * Removes documentation, type declarations, source maps and tests from node_modules.
 */
function pruneNodeModules() {
    const nodeModules = path.join(stageDir, 'node_modules');
    const removableDirs = new Set(['.github', 'test', 'tests', '__tests__', 'example', 'examples', '.bin', 'coverage', '.nyc_output']);
    const removableFile = /(\.md|\.markdown|\.map|\.d\.ts|\.d\.mts|\.d\.cts|\.tsbuildinfo|\.flow)$|^(\.eslintrc.*|\.prettierrc.*|\.editorconfig|\.travis\.yml|\.npmignore|tsconfig\.json|Makefile|Gruntfile\.js|gulpfile\.js)$/i;
    let removed = 0;
    const walk = (dir, depth) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isSymbolicLink()) {
                fs.rmSync(full, { force: true });
                removed++;
            } else if (entry.isDirectory()) {
                // Only prune test/example directories inside packages, never package names themselves
                if (removableDirs.has(entry.name) && depth > 0 && path.basename(dir) !== 'node_modules') {
                    fs.rmSync(full, { recursive: true, force: true });
                    removed++;
                } else {
                    walk(full, depth + 1);
                }
            } else if (removableFile.test(entry.name)) {
                fs.rmSync(full, { force: true });
                removed++;
            }
        }
    };
    for (const dir of [nodeModules, path.join(stageDir, 'mobile', 'runtime', 'node_modules')]) {
        if (fs.existsSync(dir)) walk(dir, 0);
    }
    log(`Pruned ${removed} unneeded files/directories from node_modules`);
}

async function createZip() {
    log(`Packing ${path.relative(repoRoot, zipPath)}`);
    const require = createRequire(path.join(toolsDir, 'package.json'));
    const archiver = require('archiver');
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.rmSync(zipPath, { force: true });

    // Legacy layout from older builds: assets/sillytavern/ (thousands of loose files)
    fs.rmSync(path.join(assetsDir, 'sillytavern'), { recursive: true, force: true });

    let fileCount = 0;
    let totalBytes = 0;
    const hash = crypto.createHash('sha256');
    const files = [...walkFiles(stageDir)].map(f => toPosix(path.relative(stageDir, f))).sort();

    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    const done = new Promise((resolve, reject) => {
        output.on('close', resolve);
        archive.on('error', reject);
        archive.on('warning', (err) => console.warn(err));
    });
    archive.pipe(output);
    for (const rel of files) {
        const abs = path.join(stageDir, rel);
        const stat = fs.statSync(abs);
        fileCount++;
        totalBytes += stat.size;
        hash.update(rel).update('\0').update(fs.readFileSync(abs));
        archive.file(abs, { name: rel, date: new Date(0) });
    }
    await archive.finalize();
    await done;

    const packageJson = JSON.parse(fs.readFileSync(path.join(stageDir, 'package.json'), 'utf8'));
    const buildInfo = {
        version: packageJson.version,
        buildId: hash.digest('hex').slice(0, 16),
        fileCount,
        totalBytes,
        zipBytes: fs.statSync(zipPath).size,
        builtAt: new Date().toISOString(),
    };
    fs.writeFileSync(buildInfoPath, JSON.stringify(buildInfo, null, 4));
    log(`Packed ${fileCount} files (${(totalBytes / 1048576).toFixed(1)} MB) into ${(buildInfo.zipBytes / 1048576).toFixed(1)} MB, build ${buildInfo.buildId}`);
}

async function main() {
    const [major] = process.versions.node.split('.').map(Number);
    if (major < 20) {
        throw new Error(`Node.js >= 20 is required on the build machine (found ${process.version})`);
    }
    installTools();
    stageFiles();
    installDependencies();
    prebuildFrontendLibs();
    transformUnicodeRegexes();
    pruneNodeModules();
    await createZip();
    log('Done. The staged bundle stays in mobile/build/stage for inspection; it is safe to delete.');
}

// Allow importing helpers in tests without running the build
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    main().catch((error) => {
        console.error(`\x1b[31m[build-assets] ${error.message}\x1b[0m`);
        process.exit(1);
    });
}
