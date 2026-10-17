#!/usr/bin/env node
/**
 * Smoke test for the mobile server bundle.
 *
 * Starts mobile/build/stage/mobile/start-mobile.js with the given Node.js binary (ideally the
 * same major version as the Android runtime) and exercises the server features that rely on
 * WASM modules, image processing, archives and regexes.
 *
 * Usage: node mobile/test/smoke-test.mjs [path/to/node18] [--stage path/to/stage]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const mobileDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const stageIndex = argv.indexOf('--stage');
const stageDir = stageIndex >= 0 ? path.resolve(argv[stageIndex + 1]) : path.join(mobileDir, 'build', 'stage');
const nodeBinary = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--stage') ?? process.execPath;
const port = 18000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-mobile-smoke-'));
const statusFile = path.join(workDir, 'runtime', 'status.json');
const results = [];
let cookie = '';
let csrfToken = '';

async function request(method, url, { json, form, raw } = {}) {
    const headers = { 'x-csrf-token': csrfToken };
    if (cookie) headers.cookie = cookie;
    let body;
    if (json !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(json);
    } else if (form) {
        body = form;
    }
    const response = await fetch(baseUrl + url, { method, headers, body });
    const setCookie = response.headers.getSetCookie?.() ?? [];
    if (setCookie.length) {
        cookie = setCookie.map(c => c.split(';')[0]).join('; ');
    }
    if (!response.ok) {
        throw new Error(`${method} ${url} -> HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    if (raw) return response;
    const type = response.headers.get('content-type') ?? '';
    return type.includes('json') ? response.json() : response.text();
}

async function check(name, fn) {
    const started = Date.now();
    try {
        const detail = await fn();
        results.push({ name, ok: true, detail, ms: Date.now() - started });
        console.log(`  \x1b[32mPASS\x1b[0m ${name}${detail ? ` (${detail})` : ''}`);
    } catch (error) {
        results.push({ name, ok: false, detail: error.message });
        console.log(`  \x1b[31mFAIL\x1b[0m ${name}: ${error.message}`);
    }
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

async function waitForReady(child, logs) {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`Server exited with code ${child.exitCode}\n${logs.join('').slice(-4000)}`);
        }
        try {
            const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
            if (status.state === 'ready') return status;
            if (status.state === 'exited') throw new Error(`Server reported exit: ${status.message}`);
        } catch (error) {
            if (!(error instanceof SyntaxError) && error.code !== 'ENOENT') throw error;
        }
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error(`Server did not become ready\n${logs.join('').slice(-4000)}`);
}

async function main() {
    console.log(`Node: ${nodeBinary}\nStage: ${stageDir}\nWork dir: ${workDir}`);
    const logs = [];
    const child = spawn(nodeBinary, [
        path.join(stageDir, 'mobile', 'start-mobile.js'),
        `--configPath=${path.join(workDir, 'config', 'config.yaml')}`,
        `--dataRoot=${path.join(workDir, 'data')}`,
        `--port=${port}`,
        '--browserLaunchEnabled=false',
    ], {
        cwd: '/',
        env: { ...process.env, SILLYTAVERN_MOBILE_STATUS_FILE: statusFile, NODE_ENV: 'production' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', d => logs.push(d.toString()));
    child.stderr.on('data', d => logs.push(d.toString()));

    const startedAt = Date.now();
    try {
        await waitForReady(child, logs);
        console.log(`Server ready in ${Date.now() - startedAt} ms\n`);

        const versionOutput = await new Promise((resolve) => {
            const p = spawn(nodeBinary, ['-p', 'process.version + " intl=" + (typeof Intl !== "undefined")']);
            let out = '';
            p.stdout.on('data', d => out += d);
            p.on('close', () => resolve(out.trim()));
        });
        console.log(`Runtime: ${versionOutput}\n`);

        await check('csrf token + session cookie', async () => {
            const data = await request('GET', '/csrf-token');
            csrfToken = data.token;
            assert(csrfToken, 'no token');
            return csrfToken === 'disabled' ? 'CSRF disabled' : 'CSRF enabled';
        });
        await check('index.html', async () => {
            const html = await request('GET', '/');
            assert(html.includes('<html'), 'not html');
        });
        await check('prebuilt lib.js', async () => {
            const js = await request('GET', '/lib.js');
            assert(js.length > 100_000, `too small: ${js.length}`);
            return `${(js.length / 1024).toFixed(0)} KB`;
        });
        await check('version', async () => (await request('GET', '/version')).pkgVersion);
        await check('settings', async () => {
            const settings = await request('POST', '/api/settings/get', { json: {} });
            assert(settings.settings !== undefined, 'missing settings');
        });
        let character;
        await check('character list (default content)', async () => {
            const list = await request('POST', '/api/characters/all', { json: {} });
            assert(Array.isArray(list) && list.length > 0, 'no characters');
            character = list[0];
            return `${list.length} character(s): ${list.map(c => c.name).join(', ')}`;
        });
        await check('character details', async () => {
            const data = await request('POST', '/api/characters/get', { json: { avatar_url: character.avatar } });
            assert(data.name === character.name, 'name mismatch');
        });
        await check('thumbnail (jimp)', async () => {
            const response = await request('GET', `/thumbnail?type=avatar&file=${encodeURIComponent(character.avatar)}`, { raw: true });
            const bytes = Buffer.from(await response.arrayBuffer());
            assert(bytes.length > 1000, 'thumbnail too small');
            return `${response.headers.get('content-type')}, ${bytes.length} bytes`;
        });
        await check('character import (PNG card upload)', async () => {
            const png = fs.readFileSync(path.join(stageDir, 'default', 'content', 'default_Seraphina.png'));
            const form = new FormData();
            form.append('avatar', new Blob([png], { type: 'image/png' }), 'Imported.png');
            form.append('file_type', 'png');
            const result = await request('POST', '/api/characters/import', { form });
            assert(result.file_name, JSON.stringify(result));
            return result.file_name;
        });
        await check('character export (json)', async () => {
            const data = await request('POST', '/api/characters/export', { json: { avatar_url: character.avatar, format: 'json' } });
            const parsed = typeof data === 'string' ? JSON.parse(data) : data;
            assert(parsed.data?.name || parsed.name, 'bad export');
        });
        await check('chat save + load', async () => {
            const chat = [{ user_name: 'User', character_name: character.name, create_date: new Date().toISOString(), chat_metadata: {} },
                { name: 'User', is_user: true, mes: 'Héllo wörld — こんにちは 👋', send_date: new Date().toISOString() }];
            await request('POST', '/api/chats/save', { json: { avatar_url: character.avatar, file_name: 'smoke-test', chat } });
            const loaded = await request('POST', '/api/chats/get', { json: { avatar_url: character.avatar, file_name: 'smoke-test' } });
            assert(Array.isArray(loaded) && loaded[1]?.mes === chat[1].mes, 'chat mismatch (unicode round trip)');
        });
        const sample = 'Hello there! Ünïcödé text, 日本語のテキスト, emoji 🎉 and numbers 12345.';
        for (const tokenizer of ['llama', 'mistral', 'yi', 'gemma', 'jamba', 'nerdstash', 'gpt2', 'claude', 'llama3', 'qwen2', 'command-r', 'command-a', 'nemo', 'deepseek']) {
            await check(`tokenizer ${tokenizer}`, async () => {
                const encoded = await request('POST', `/api/tokenizers/${tokenizer}/encode`, { json: { text: sample } });
                assert(Array.isArray(encoded.ids) && encoded.count > 5, JSON.stringify(encoded).slice(0, 200));
                const decoded = await request('POST', `/api/tokenizers/${tokenizer}/decode`, { json: { ids: encoded.ids } });
                assert(typeof decoded.text === 'string' && decoded.text.includes('Hello'), `decode: ${JSON.stringify(decoded).slice(0, 200)}`);
                return `${encoded.count} tokens`;
            });
        }
        for (const model of ['gpt-4o', 'gpt-4', 'gpt-3.5-turbo', 'text-davinci-003']) {
            await check(`tiktoken ${model}`, async () => {
                const encoded = await request('POST', `/api/tokenizers/openai/encode?model=${model}`, { json: { text: sample } });
                assert(encoded.count > 5, JSON.stringify(encoded).slice(0, 200));
                const counted = await request('POST', `/api/tokenizers/openai/count?model=${model}`, { json: [{ role: 'user', content: sample }] });
                assert(counted.token_count > 5, JSON.stringify(counted));
                return `${encoded.count} tokens`;
            });
        }
        await check('extensions discover', async () => {
            const list = await request('GET', '/api/extensions/discover');
            assert(Array.isArray(list), 'not a list');
            return `${list.length} extension(s)`;
        });
        await check('full user data backup (zip)', async () => {
            const response = await request('POST', '/api/users/backup', { json: { handle: 'default-user' }, raw: true });
            const bytes = Buffer.from(await response.arrayBuffer());
            assert(bytes.subarray(0, 2).toString() === 'PK', 'not a zip');
            return `${(bytes.length / 1024).toFixed(0)} KB`;
        });
        await check('regex with unicode property escapes at runtime', async () => {
            // Exercises the same code path as minimatch/zod/transformers in the bundle
            const out = await new Promise((resolve, reject) => {
                const p = spawn(nodeBinary, ['--input-type=module', '-e',
                    `await import(${JSON.stringify(path.join(stageDir, 'mobile', 'runtime', 'polyfills.js'))});` +
                    'const r = new RegExp("^\\\\p{L}+$", "u"); console.log(r.test("Ünïcödé") && !r.test("123"));' +
                    'console.log(new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array([0xe2, 0x82, 0xac])));' +
                    'try { new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array([0xff])); console.log("no-throw"); } catch { console.log("throws"); }' +
                    'console.log(typeof Intl.Collator().compare, [3,1,2].toSorted().join(""));'], { stdio: ['ignore', 'pipe', 'pipe'] });
                let output = '';
                p.stdout.on('data', d => output += d);
                p.stderr.on('data', d => output += d);
                p.on('close', (code) => code === 0 ? resolve(output.trim()) : reject(new Error(output)));
            });
            assert(out === 'true\n€\nthrows\nfunction 123', JSON.stringify(out));
        });
    } finally {
        child.kill('SIGTERM');
        await new Promise(r => setTimeout(r, 500));
        if (child.exitCode === null) child.kill('SIGKILL');
        const serverErrors = logs.join('').split('\n').filter(l => /error|exception/i.test(l) && !/console logs for more information/.test(l));
        if (serverErrors.length) {
            console.log('\nServer log lines mentioning errors:');
            serverErrors.slice(0, 40).forEach(l => console.log('  ' + l));
        }
        fs.writeFileSync(path.join(workDir, 'server.log'), logs.join(''));
    }

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed. Server log: ${path.join(workDir, 'server.log')}`);
    process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
