# mobile/

Everything that turns the SillyTavern server into the bundle shipped inside the Android app. See the [root README](../README.md) for the full picture.

| File | Purpose |
|------|---------|
| `build-apk.mjs` | One-command build: fetch libnode, bundle the server, run Gradle |
| `fetch-libnode.mjs` | Downloads nodejs-mobile's `libnode.so` and prepares it for 16 KB page devices |
| `build-assets.mjs` | Stages the server, installs production deps, prebuilds `lib.js`, rewrites `\p{…}` regexes, packs `sillytavern.zip` |
| `start-mobile.js` | Server entry point on the device |
| `runtime/polyfills.js` | Node 18 / no-ICU compatibility layer (no-op on desktop Node) |
| `runtime/status.js` | Reports starting/ready/exited state and the last errors to the app |
| `runtime/mobile-config.js` | Creates `config.yaml` on first launch with `default/config.mobile.yaml` applied |
| `webpack-stub/` | Replaces webpack in the bundle; serves the prebuilt `lib.js` |
| `test/smoke-test.mjs` | Boots the staged bundle with a given Node binary and tests the main features |

Build output goes to `mobile/build/` (ignored by git). `mobile/build/stage` is the exact server tree that ends up in the APK, so you can run it on a computer:

```sh
node mobile/build/stage/mobile/start-mobile.js --configPath=/tmp/st/config.yaml --dataRoot=/tmp/st/data --port=8000
```
