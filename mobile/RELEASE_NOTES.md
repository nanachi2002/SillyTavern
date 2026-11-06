# SillyTavern for Android v1.19.0-android.1

Updated to SillyTavern 1.19.0.

## ⚠️ New app: read this if you have 1.18.0-android.2 or older
This version is a **new app** (`ai.sillytavern.android`, signed with a new key). It installs **next to** the old one instead of replacing it, and it starts empty: your old data stays in the old app and isn't copied over.
To keep something, export it from the **old** app first and import it in the new one: characters (character panel → Export, PNG or JSON), chats (chat menu → Export, `.jsonl`), presets and world info (their Export buttons). Files are saved to `Download/SillyTavern`. A full backup (User Settings → Backup) is worth keeping too, but SillyTavern can't restore it in one step.
Uninstall the old app once you don't need it anymore.

From this version on, updates install over the app normally and keep your data.

## Downloads
- `SillyTavern-1.19.0-android.1-arm64-v8a.apk`: almost all phones from the last few years
- `SillyTavern-1.19.0-android.1-armeabi-v7a.apk`: old 32-bit phones
- `SillyTavern-1.19.0-android.1-x86_64.apk`: x86_64 emulators

Not sure? Take arm64-v8a.
- `SHA256SUMS.txt`: checksums of the APKs

## What's new
- **SillyTavern 1.19.0.** All the new features and fixes of the upstream release.
- **Replies keep generating with the screen off.** While the server is working on a request (a streamed reply, image generation, a backup…), the app keeps the CPU awake, so the phone no longer falls asleep in the middle of a reply. It lets go as soon as the server is idle, and never holds on for more than 10 minutes without a new request.

## Fixes in this build
- Extensions installed "for all users" are no longer deleted when the app is updated.
- If the app was closed in the middle of an update, the next launch recovers the previous server files instead of discarding them.

## Notes
- The first launch after installing or updating unpacks about 200 MB and takes 10 to 60 seconds. Later launches take a few seconds.
- Your data is stored in app-private storage and is kept across updates. Uninstalling deletes it, so make a backup first (User Settings, then Backup).
- Android 15+ devices with 16 KB pages run `libnode.so` in compatibility mode.
- APKs are signed with the project's release key (certificate SHA-256 `44:67:a0:87:e8:cc:c2:3f:fb:0e:44:7f:18:47:e3:b6:d5:32:04:4f:16:69:55:e3:62:92:fa:cc:5c:f2:b1:13`).
- This app is not on Google Play. Android will ask you to allow installing apps from your browser or file manager.
