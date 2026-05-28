# SillyTavern Android

Run [SillyTavern](https://github.com/SillyTavern/SillyTavern) natively on Android — no server, no cloud, no remote hosting required.

The app bundles a Node.js runtime and the full SillyTavern server inside the APK. On launch, it starts the server on `localhost:8000` and loads the web UI in a WebView. You still need API keys for your preferred AI service (OpenAI, Claude, Kobold, etc.).

Based on [SillyTavern](https://github.com/SillyTavern/SillyTavern) release branch.

---

## Screenshots

> *Coming soon — SillyTavern running on Android with full UI*

## How It Works

1. **Node.js on Android** — Uses [nodejs-mobile](https://github.com/nicandris/nodejs-mobile) `libnode.so` (v18.20.4) loaded via JNI. A C++ bridge calls `node::Start()` on a background thread, passing the mobile entry script and CLI args.

2. **Asset Extraction** — On first run, ~300MB of server files are extracted from the APK's `assets/` directory to internal storage. A `.version` marker ensures re-extraction only on app updates.

3. **Server Startup** — The Node.js server compiles webpack and starts listening on `127.0.0.1:8000`. A Java-side socket poll waits for the server to be ready before loading the WebView.

4. **WebView** — Once the server is confirmed reachable, a WebView loads `http://localhost:8000/` with JavaScript, DOM storage, and mobile-friendly settings.

5. **Mobile Config** — `default/config.mobile.yaml` provides optimized defaults: localhost-only binding, CSRF disabled, whitelist disabled, CORS enabled, lazy loading, 50MB cache.

## Architecture

```
APK
├── lib/arm64-v8a/
│   ├── libnode.so              ← Node.js runtime (nodejs-mobile v18.20.4)
│   └── libsillytavern-node.so  ← C++ JNI bridge
├── assets/sillytavern/
│   ├── mobile/start-mobile.js  ← Mobile entry point
│   ├── src/                    ← Server source (ESM)
│   ├── node_modules/           ← Dependencies (patched for Node 18)
│   ├── default/                ← Default configs & content
│   └── public/                 ← Frontend static files
└── java/ai/sillytavern/app/
    ├── MainActivity.java       ← Activity: splash screen → server poll → WebView
    └── NodeRuntime.java        ← Asset extraction + Node.js lifecycle
```

### Startup Flow

```
App Launch
  ├── Show splash screen "Starting SillyTavern..."
  ├── NodeRuntime.start()
  │   ├── prepareAppFiles() — extract assets if version changed
  │   ├── prepareDataDirectory() — create user data dirs
  │   └── startNodeWithArguments() — JNI → C++ → node::Start()
  ├── pollServer() — socket connect to 127.0.0.1:8000 every 1s
  └── setupWebView() — load http://localhost:8000/ in WebView
```

## Building

### Prerequisites

- **Android Studio** with NDK 27.x
- **JDK 21** (Android Studio's JBR)
- **Python 3** + Pillow (for app icon generation)
- **Node.js 20+** (for asset preparation script)

### Step 1: Download libnode.so

```powershell
cd android
.\download-libnode.ps1
```

This downloads `libnode.so` (~60MB per arch) from nodejs-mobile releases for `arm64-v8a` and `x86_64`.

### Step 2: Prepare APK assets

```powershell
cd ..
powershell mobile/prepare-assets.ps1
```

This copies SillyTavern server files into the APK assets directory and applies Node 18 compatibility patches (see below).

### Step 3: Build

```powershell
cd android
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
$env:ANDROID_HOME = "C:\Users\<you>\AppData\Local\Android\Sdk"
.\gradlew.bat assembleRelease
```

Output: `android/app/build/outputs/apk/release/app-release.apk` (~191MB)

### Step 4: Install

```powershell
adb install -r app/build/outputs/apk/release/app-release.apk
```

## Node 18 Compatibility Patches

SillyTavern requires Node.js >= 20, but nodejs-mobile only provides v18.20.4. Node 18 lacks full Unicode property escape support in regex (`\p{L}`, `\p{N}`, `\p{Cc}`, etc.) and full ICU data. The `prepare-assets.ps1` script automatically patches these modules:

| Module | Issue | Fix |
|--------|-------|-----|
| `webpack/lib/RuntimeTemplate.js` | `\p{L}` in regex | Replace with `a-zA-Z\u0080-\uffff` |
| `webpack/lib/library/AssignLibraryPlugin.js` | `\p{L}` in regex | Replace with `a-zA-Z\u0080-\uffff` |
| `gpt-3-encoder/Encoder.js` | `\p{L}`, `\p{N}` with `/gu` | Replace with ASCII ranges |
| `sillytavern-transformers` | `\p{Cc}\|\p{Cf}\|\p{Co}\|\p{Cs}` | Replace with hex char ranges |
| `tiktoken/encoders/*.js` | Various `\p{}` patterns | Replace with ASCII ranges |
| `protobufjs/marked/*.js` | `\p{Cc}` etc. | Replace with hex ranges |
| `minimatch/brace-expressions.js` | Unicode posix classes | Replace with ASCII ranges |
| `isomorphic-git/index.js` | `TextDecoder({fatal: true})` | Strip fatal option |

Additionally, `start-mobile.js` monkey-patches `TextDecoder` to strip `{fatal: true}` since nodejs-mobile's small-ICU build doesn't support it, and pre-seeds `settings.json` and `user.css` from `default/content/` to the user data directory.

## Key Configuration

### `default/config.mobile.yaml`

```yaml
port: 8000
listen: localhost
enableCors: true
autoStartup: false
skipContentCheck: true
whitelistMode: false
disableCsrf: true
browserLaunchEnabled: false
lazyStartup: true
cacheSize: 50
```

### Android Permissions

- `INTERNET` — API connections
- `WAKE_LOCK` — Keep screen on during use
- Cleartext traffic — Allowed only to `localhost` / `127.0.0.1` via `network_security_config.xml`

## Known Limitations

| Limitation | Details |
|-----------|---------|
| **Node.js 18** | nodejs-mobile only has v18.20.4. Building Node 20+ from NDK source would fix all regex/ICU issues |
| **~191MB APK** | Bundled server files + libnode.so are large |
| **16KB page alignment** | `libnode.so` not aligned for Android 15+ devices. Workaround: `targetSdk=34` |
| **~20s first launch** | Asset extraction on first run. Subsequent launches ~5s |
| **No background service** | Server stops when app is closed |

## Tested On

- Pixel 7 (arm64-v8a, Android 14) — SillyTavern 1.18.0 loads and functions correctly

## Future Improvements

- [ ] Build Node.js 20+ for Android ARM64 using NDK — eliminates all regex/ICU patches
- [ ] Pre-compile webpack bundle before APK packaging — faster startup
- [ ] 16KB page-align `libnode.so` for Android 15+ support
- [ ] Android App Bundle (AAB) — smaller downloads via dynamic delivery
- [ ] Background service with persistent notification
- [ ] Reduce APK size — trim unused node_modules, compress assets

## Resources

- **Original SillyTavern**: <https://github.com/SillyTavern/SillyTavern>
- **nodejs-mobile**: <https://github.com/nicandris/nodejs-mobile>
- **SillyTavern Docs**: <https://docs.sillytavern.app/>
- **Discord**: <https://discord.gg/sillytavern>

## License

Same as SillyTavern — see [LICENSE](./LICENSE) file in the upstream repository.
