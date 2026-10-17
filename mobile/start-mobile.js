#!/usr/bin/env node
// Entry point of the SillyTavern server inside the Android app (nodejs-mobile).
// The polyfills must be the first import: later modules rely on them at load time.
import './runtime/polyfills.js';
import path from 'node:path';
import { writeStatus, installExitReporting, getRecentErrors } from './runtime/status.js';
import { seedMobileConfig } from './runtime/mobile-config.js';
import { serverDirectory } from '../src/server-directory.js';

installExitReporting();
writeStatus('starting');

process.env.NODE_ENV ??= 'production';
// Relative paths in the server (./config.yaml, public/, default/) are resolved against the
// working directory, which is "/" for an Android app process.
process.chdir(serverDirectory);

/**
 * Reads a --name=value or --name value argument.
 * @param {string} name Argument name
 * @returns {string|undefined} Argument value
 */
function getArgument(name) {
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        if (args[i] === `--${name}`) return args[i + 1];
        if (args[i].startsWith(`--${name}=`)) return args[i].slice(name.length + 3);
    }
    return undefined;
}

try {
    const configPath = getArgument('configPath');
    if (configPath) {
        seedMobileConfig(serverDirectory, path.resolve(configPath));
    }

    const { CommandLineParser } = await import('../src/command-line.js');
    const { serverEvents, EVENT_NAMES } = await import('../src/server-events.js');

    const cliArgs = new CommandLineParser().parse(process.argv);
    globalThis.DATA_ROOT = cliArgs.dataRoot;
    globalThis.COMMAND_LINE_ARGS = cliArgs;

    console.log(`Node version: ${process.version} (${process.platform}/${process.arch}). Server directory: ${serverDirectory}`);

    serverEvents.once(EVENT_NAMES.SERVER_STARTED, ({ url }) => {
        writeStatus('ready', { url: String(url), port: cliArgs.port });
    });

    await import('../src/server-main.js');
} catch (error) {
    console.error('A critical error has occurred while starting the server:', error);
    writeStatus('exited', { code: 1, message: getRecentErrors() });
    process.exit(1);
}
