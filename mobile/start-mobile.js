#!/usr/bin/env node
import { CommandLineParser } from '../src/command-line.js';
import { serverDirectory } from '../src/server-directory.js';
import { existsSync, copyFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const MOBILE_CONFIG = join(serverDirectory, 'default', 'config.mobile.yaml');

process.env.NODE_ENV = 'production';
process.env.SILLYTAVERN_BROWSERLAUNCH_ENABLED = 'false';
process.env.SILLYTAVERN_WHITELISTMODE = 'false';
process.env.SILLYTAVERN_DISABLECSRF = 'true';

const cliArgs = new CommandLineParser().parse(process.argv);

if (!cliArgs.dataRoot) {
    const dataDir = join(serverDirectory, 'data');
    if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true });
    }
    globalThis.DATA_ROOT = dataDir;
} else {
    globalThis.DATA_ROOT = cliArgs.dataRoot;
}

globalThis.COMMAND_LINE_ARGS = cliArgs;
process.chdir(serverDirectory);

try {
    await import('../src/server-main.js');
} catch (error) {
    console.error('A critical error has occurred while starting the server:', error);
    if (process.platform === 'android') {
        process.exit(1);
    }
}
