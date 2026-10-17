# LinkUp

An experimental free-software messenger with encrypted chats, calls, groups, and QR invitations.

**[Download LinkUp 0.3.0 for Android](https://github.com/KTihana/LinkUp/releases/latest)** · Android 7+ · ARM64

Update LinkUp without uninstalling it to keep your chats. Friends can scan your QR code to download the app.

## Development

Use Node.js 24+. From `app/`:

```sh
npm ci
npm run web
```

See [Android builds and testing](app/ANDROID-TESTING.md), [mailbox setup](relay/README.md), and [release publishing](app/UPDATES.md). Mailbox delivery requires a configured server; no public server is included.

This is a test build. Physical two-phone testing and independent security review remain pending. iPhone support is unfinished.

GPL-3.0-only. Source, dependency notices, and build instructions are included here and with the release.
