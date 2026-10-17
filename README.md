# SillyTavern for Android

Run [SillyTavern](https://github.com/SillyTavern/SillyTavern) entirely on your phone: no PC, no Termux, no remote server.

The app contains a Node.js runtime and the complete, unmodified SillyTavern server. It starts the server on the device (only reachable from the device itself) and shows the regular SillyTavern UI. You still need an API key or endpoint for the AI service you want to use (OpenAI, Claude, OpenRouter, Gemini, KoboldCpp on your LAN, …).

Based on SillyTavern 1.18.0 (release branch).

## Features

- The full SillyTavern feature set: characters, group chats, world info, extensions, presets, personas, tokenizers, vector storage, image thumbnails, backups.
- **Import and export:** importing character cards, chats and backgrounds uses the Android file picker. Exports, backups and other downloads are saved to `Download/SillyTavern`.
- **Background generation:** a notification keeps the server running while you switch apps. Tap **Stop** in the notification, or swipe the app away, to shut it down.
- **Back button:** closes the open popup, editor, menu or panel. When nothing is open, it sends the app to the background.
- **Voice input:** the microphone is available to speech recognition extensions (Android asks for permission the first time).
- **Crash handling:** if the server fails to start or crashes, the app shows the error and the server log, with **Retry** and **Share log** buttons.
- Links open in your browser. OpenRouter's OAuth login stays in the app so the key is saved.
- Works on Android 8.0+ (arm64, 32-bit ARM and x86_64 emulators), including Android 15's edge-to-edge display and on-screen keyboard handling.

## Install

Download the APK on your phone and open it (allow installing from your browser or file manager when Android asks):

- **[arm64-v8a](https://github.com/nanachi2002/SillyTavern/raw/apk/SillyTavern-1.18.0-android.2-arm64-v8a.apk)** for almost all phones from the last few years (take this one if you're unsure)
- [armeabi-v7a](https://github.com/nanachi2002/SillyTavern/raw/apk/SillyTavern-1.18.0-android.2-armeabi-v7a.apk) for old 32-bit phones
- [x86_64](https://github.com/nanachi2002/SillyTavern/raw/apk/SillyTavern-1.18.0-android.2-x86_64.apk) for emulators

All downloads, checksums and release notes are on the [`apk` branch](https://github.com/nanachi2002/SillyTavern/tree/apk). To update, install the new APK over the old one: your data is kept.

The first launch unpacks the server (about 200 MB), which takes 10–60 seconds. Later launches only start the server (a few seconds).

## Your data

| What | Where (app-private storage) |
|------|------|
| Characters, chats, settings, extensions | `files/sillytavern-data/` |
| `config.yaml` | `files/sillytavern-config/config.yaml` |
| Server files (replaced on every update) | `files/sillytavern/` |
| Server log | `files/runtime/server.log` |

App updates never touch your data or `config.yaml`. To move data between devices, use SillyTavern's own backup feature (User Settings → Backup). The backup ZIP lands in `Download/SillyTavern`.

Uninstalling the app **deletes all data**. Make a backup first.

## How it works

```
┌─────────────── UI process ───────────────┐      ┌───────────── :server process ─────────────┐
│ MainActivity                             │      │ ServerService                             │
│  ├─ splash / progress / error screen     │ IPC  │  ├─ AssetInstaller: unzip sillytavern.zip │
│  ├─ WebView ── http://127.0.0.1:8000 ────┼──────┼─►│   (only after install/update)          │
│  ├─ bridge.js: downloads, back button    │      │  └─ NodeBridge (JNI) ─► libnode.so        │
│  └─ file picker, mic, external links     │      │        └─ mobile/start-mobile.js          │
│ KeepAliveService (notification)          │      │             └─ SillyTavern server         │
└──────────────────────────────────────────┘      └───────────────────────────────────────────┘
```

- **Node.js:** [nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile) `libnode.so` (Node 18.20.4), started through a small JNI bridge (`android/app/src/main/cpp/native-lib.cpp`). Its output goes to logcat and `server.log`.
- **Separate server process:** Node.js can only start once per process, and `process.exit()` ends the whole process. Running it in `:server` means a server crash never closes the UI, and **Retry** simply starts a fresh process.
- **Compatibility layer:** SillyTavern targets Node 20+ with ICU, but nodejs-mobile is Node 18 built without ICU. `mobile/runtime/polyfills.js` adds what's missing (`Intl`, `TextDecoder` with `fatal`, regex `\p{…}` escapes built at runtime, newer built-ins). The bundler rewrites `\p{…}` regex literals in advance, because V8 rejects them when the file loads. The polyfills do nothing on a normal desktop Node.
- **Prebuilt frontend:** `public/lib.js` is compiled by webpack on the build machine. Inside the APK, webpack is replaced by a stub that serves the prebuilt file, so the phone never runs webpack.
- **Config:** on first launch, `config.yaml` is created from `default/config.yaml` with the overrides in `default/config.mobile.yaml`. The server only listens on `127.0.0.1`, and CSRF protection stays enabled so websites open in your phone's browser can't call the local server.

## Building

Requirements: Node.js 20+, JDK 17+, and the Android SDK with NDK and CMake 3.22.1 (install them from Android Studio's SDK Manager). Set `ANDROID_HOME`, or open `android/` once in Android Studio so it writes `local.properties`.

One command (Linux, macOS or Windows):

```sh
node mobile/build-apk.mjs          # debug build
node mobile/build-apk.mjs release  # release build
```

Or step by step:

```sh
node mobile/fetch-libnode.mjs      # 1. Node.js runtime -> android/app/libnode/bin/<abi>/libnode.so
node mobile/build-assets.mjs       # 2. Server bundle   -> android/app/src/main/assets/sillytavern.zip
cd android && ./gradlew assembleDebug   # 3. APKs -> android/app/build/outputs/apk/debug/
```

After changing server or frontend code, re-run step 2 (`--skip-install` reuses `node_modules`). After changing only the Android app, step 3 is enough.

**Release signing:** set `ST_KEYSTORE`, `ST_KEYSTORE_PASSWORD`, `ST_KEY_ALIAS` and `ST_KEY_PASSWORD` (as environment variables or Gradle properties), or place `release.keystore` next to the repository folder. Without a keystore, release builds are signed with the debug key. Always sign public releases with the same key, otherwise users can't update.

**Publishing a release:** bump `mobileRevision` in `android/app/build.gradle` (or update SillyTavern) and update `mobile/RELEASE_NOTES.md`. Build signed APKs locally with `node mobile/build-apk.mjs release` and the `ST_KEYSTORE*` variables set. Then replace the files on the `apk` branch (APKs, `SHA256SUMS.txt`, download links in its README) and push it. GitHub rejects files over 100 MB, so the universal APK isn't published there. When GitHub Actions is available, pushing a tag such as `v1.18.0-android.3` runs `.github/workflows/android-release.yml` instead. That workflow builds, signs and publishes a GitHub release, and needs the repository secrets `ST_KEYSTORE_BASE64`, `ST_KEYSTORE_PASSWORD`, `ST_KEY_ALIAS` and `ST_KEY_PASSWORD`.

**Testing the bundle on a computer:** `node mobile/test/smoke-test.mjs /path/to/node18` boots `mobile/build/stage` with the given Node binary and checks the main server features (tokenizers, thumbnails, card import/export, chats, backups, ONNX runtime). CI runs it with Node 18.20.4 on every push (`.github/workflows/android.yml`), then builds and uploads the APKs.

## Known limitations

- **APK size:** about 100 MB per ABI (server bundle about 83 MB, plus `libnode.so`).
- **16 KB page devices:** `fetch-libnode.mjs` makes `libnode.so` 16 KB page compatible when that's possible without relinking. If the downloaded library's memory segments share 16 KB pages, it warns and leaves the library unchanged. It then works on regular devices, and Android 15+ devices with 16 KB pages fall back to compatibility mode.
- **Server plugins** that need native modules or a `git` binary don't work. UI extensions install through the built-in Git implementation.
- Web notifications aren't supported by Android's WebView.

## License

AGPL-3.0, same as SillyTavern. See [LICENSE](./LICENSE).
