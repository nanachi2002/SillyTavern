import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';

/**
 * Collects the leaf paths of a plain object (arrays count as leaves).
 * @param {object} obj Object to walk
 * @param {string[]} prefix Current key path
 * @returns {{ keyPath: string[], value: any }[]} Leaves
 */
function getLeaves(obj, prefix = []) {
    return Object.entries(obj).flatMap(([key, value]) => {
        const keyPath = [...prefix, key];
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            return getLeaves(value, keyPath);
        }
        return [{ keyPath, value }];
    });
}

/**
 * Creates config.yaml for the Android app on first launch: the regular default config
 * (keeping its comments) with the mobile overrides from default/config.mobile.yaml applied.
 * An existing config is never touched, so user edits survive app updates.
 * @param {string} serverDirectory Server root directory
 * @param {string} configPath Path of the config.yaml to create
 */
export function seedMobileConfig(serverDirectory, configPath) {
    if (fs.existsSync(configPath)) {
        return;
    }

    const defaultConfigPath = path.join(serverDirectory, 'default', 'config.yaml');
    const overridesPath = path.join(serverDirectory, 'default', 'config.mobile.yaml');
    const document = yaml.parseDocument(fs.readFileSync(defaultConfigPath, 'utf8'));

    if (fs.existsSync(overridesPath)) {
        const overrides = yaml.parse(fs.readFileSync(overridesPath, 'utf8')) ?? {};
        for (const { keyPath, value } of getLeaves(overrides)) {
            document.setIn(keyPath, value);
        }
    }

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, document.toString(), 'utf8');
    console.log(`Created mobile config at ${configPath}`);
}
