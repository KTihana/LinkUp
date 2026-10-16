# LinkUp

An experimental free-software messenger for Android. Modern chat screens, editable profiles, QR/link invitations, emojis, stickers, and custom light/dark appearance.

## Download

[Download the Android APK from Releases](https://github.com/KTihana/LinkUp/releases/latest). Android 7 or newer on a 64-bit ARM phone is required. Install over the previous build without uninstalling to retain its data.

New identities start as **Anon**. Tap your initial vault key to copy it. Appearance changes use explicit **Save appearance** and **Cancel**. **You → Updates** checks this repository for publisher-signed APK updates; automatic checks wait for unlock and respect Nearby only. Android asks you to approve installation.

## Source and licence

Tiho is **GPL-3.0-only**. The complete, buildable source is provided as `tiho-0.1.1-source.zip` in this repository and with every release. Extract it and follow `app/ANDROID-TESTING.md` to build. It contains the Android module, app, self-hostable mailbox, tests, lockfiles and documentation. Private signing keys, user data and generated build caches are excluded.

See `app/UPDATES.md` inside the source archive for publishing future updates. Contributions and issue reports are welcome; include the affected file and reproduction steps.

## Current limits

This is a test build, not an independently audited messenger. Encrypted text, bundled emojis/stickers and local vault storage are implemented. Nearby Wi-Fi/hotspot/Bluetooth still need physical two-phone testing. Calls, arbitrary files, group messaging, backup recovery and iPhone delivery are unfinished. No public message server is included. Profile photos are local and are not automatically shared with friends.
