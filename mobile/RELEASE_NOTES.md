# SillyTavern for Android v1.19.0-android.1

Updated to SillyTavern 1.19.0. Install it over the previous version: your chats, characters, presets, settings and extensions are kept.

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
- APKs are signed with the project's release key (certificate SHA-256 `73:2a:9a:98:3c:ef:a4:3a:ef:77:39:0c:fa:0a:08:e9:b7:fe:0e:77:fe:d8:9d:d5:78:f4:e5:93:5f:da:1d:d1`).
- This app is not on Google Play. Android will ask you to allow installing apps from your browser or file manager.
