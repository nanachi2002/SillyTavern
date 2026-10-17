# SillyTavern for Android v1.18.0-android.2

A rebuilt Android port based on SillyTavern 1.18.0. It builds from a clean clone and runs the full SillyTavern server on your phone.

## Downloads
- `SillyTavern-1.18.0-android.2-arm64-v8a.apk`: almost all phones from the last few years
- `SillyTavern-1.18.0-android.2-armeabi-v7a.apk`: old 32-bit phones
- `SillyTavern-1.18.0-android.2-x86_64.apk`: x86_64 emulators
- `SillyTavern-1.18.0-android.2-universal.apk`: if you're unsure (bigger)
- `SHA256SUMS.txt`: checksums of the APKs
## What's new
- **Rebuilt port.** The app no longer uses Capacitor or AndroidX (plain Android framework only). It builds from a clean checkout.
- **Separate server process.** A server crash or `process.exit()` can no longer close the UI, and **Retry** starts a fresh server.
- **Reliable first launch.** The server bundle is unpacked atomically, with progress and a disk space check.
- **Background generation.** A foreground notification keeps the server running, with a **Stop** action.
- **Import and export.** File picker uploads work. Downloads, exports and backups are saved to `Download/SillyTavern`.
- **WebView improvements.**
  - Voice input works through the microphone.
  - Links open in your browser, and OpenRouter OAuth stays in the app.
  - Android 15 edge-to-edge display and keyboard insets are handled.
  - **Back** closes popups and panels.
  - The app recovers from WebView renderer crashes.
- **Error screen.** If the server fails to start, you get the error and server log, with **Retry** and **Share log** buttons.
- **Mobile config fixed.** `config.mobile.yaml` overrides are now applied. The server listens on `127.0.0.1` only, and CSRF protection stays on.
- **Frontend prebuilt.** `lib.js` is compiled at build time, so the phone never runs webpack.

## Fixes in this build
- Fixed `Intl.Collator()` (and other Intl constructors) crashing when called without `new`, which broke the Stable Diffusion endpoint.
- Fixed the `\p{...}` regex fallback never being installed on Node 18 without ICU.
- Fixed quick rebuilds (`--skip-install`) dropping runtime packages.
- APKs are about 20 MB smaller (unused ONNX Runtime WebAssembly builds and build-only tools removed). On-device AI features (classification, vector embeddings) are tested on every build.

## Notes
- The first launch unpacks about 200 MB and takes 10 to 60 seconds. Later launches take a few seconds.
- Your data is stored in app-private storage and is kept across updates. Uninstalling deletes it, so make a backup first (User Settings, then Backup).
- Android 15+ devices with 16 KB pages run `libnode.so` in compatibility mode.
- APKs are signed with the project's release key (certificate SHA-256 `73:2a:9a:98:3c:ef:a4:3a:ef:77:39:0c:fa:0a:08:e9:b7:fe:0e:77:fe:d8:9d:d5:78:f4:e5:93:5f:da:1d:d1`).
- This app is not on Google Play. Android will ask you to allow installing apps from your browser or file manager.
