# SillyTavern for Android: downloads

**Version 1.18.0-android.2** (based on SillyTavern 1.18.0). The source code is on the [`android-port`](https://github.com/nanachi2002/SillyTavern/tree/android-port) branch.

| Your device | Download |
|---|---|
| Almost all phones from the last few years | [SillyTavern-1.18.0-android.2-arm64-v8a.apk](https://github.com/nanachi2002/SillyTavern/raw/apk/SillyTavern-1.18.0-android.2-arm64-v8a.apk) |
| Old 32-bit phones | [SillyTavern-1.18.0-android.2-armeabi-v7a.apk](https://github.com/nanachi2002/SillyTavern/raw/apk/SillyTavern-1.18.0-android.2-armeabi-v7a.apk) |
| x86_64 emulators | [SillyTavern-1.18.0-android.2-x86_64.apk](https://github.com/nanachi2002/SillyTavern/raw/apk/SillyTavern-1.18.0-android.2-x86_64.apk) |

Not sure which one you need? Take arm64-v8a. It's the right one for nearly every phone.

## Install

1. Download the APK on your phone and open it.
2. Android asks you to allow installs from your browser or file manager. Allow it (the app isn't on Google Play).
3. Open SillyTavern. The first launch unpacks the server, which takes 10 to 60 seconds. Later launches take a few seconds.

You still need an API key or endpoint for the AI service you want to use (OpenAI, Claude, OpenRouter, Gemini, KoboldCpp on your LAN, and others).

**Updating:** install the new APK over the old one. Your chats, characters and settings are kept.

**Uninstalling deletes your data.** Make a backup first: User Settings, then Backup. Backups and exports are saved to `Download/SillyTavern`.

## What's in this version

- The full SillyTavern 1.18.0 server runs on your phone. No PC, Termux or remote server needed.
- A server crash never closes the app, and **Retry** starts a fresh server.
- Generation keeps going in the background, with a notification and a **Stop** button.
- Import through the file picker. Exports and backups go to `Download/SillyTavern`.
- Voice input, links that open in your browser, in-app OpenRouter login, Android 15 edge-to-edge display, and a Back button that closes popups and panels.
- If the server fails to start, you see the error and log, with **Retry** and **Share log** buttons.
- On-device AI features work: classification and vector embeddings.

## Verify (optional)

`SHA256SUMS.txt` lists the SHA-256 checksum of each APK. They're all signed with the project's release key (certificate SHA-256 `73:2a:9a:98:3c:ef:a4:3a:ef:77:39:0c:fa:0a:08:e9:b7:fe:0e:77:fe:d8:9d:d5:78:f4:e5:93:5f:da:1d:d1`).

Licensed under AGPL-3.0, like SillyTavern.
