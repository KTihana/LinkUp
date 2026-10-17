# LinkUp

An experimental free-software messenger with encrypted chats, calls, groups, and QR invitations.

**[Download LinkUp 0.3.0 for Android](https://github.com/KTihana/LinkUp/releases/latest)** · Android 7+ · ARM64

Install over the existing app to keep your account and chats. New invitation QR codes open an install page for friends who do not have LinkUp yet.

## Development

Use Node.js 24+. From `app/`:

```sh
npm ci
npm run web
```

See [Android builds and testing](app/ANDROID-TESTING.md), [mailbox setup](relay/README.md), and [release publishing](app/UPDATES.md). Mailbox delivery requires a configured server; no public server is included.

This is a test build. Physical two-phone testing and independent security review remain pending. iPhone support is unfinished.

GPL-3.0-only. Source, dependency notices, and build instructions are included here and with the release.
