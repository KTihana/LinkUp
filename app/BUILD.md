# Build LinkUp

## Run the app

Install Node.js 24 or newer, then run from `app/`:

```sh
npm ci
npm run web
```

Use `npm start` for the Expo development server. Native modules require a development build.

## Build the Android APK

Install a supported JDK, Android SDK/NDK and Go. Set `JAVA_HOME` and `ANDROID_HOME`, then run from `app/`:

```sh
npm run build:apk
```

The script generates the Android project, builds the required native libraries, signs the APK and packages the source. Output is written to `app/artifacts/`:

- `tiho-<version>-arm64.apk`
- `tiho-<version>-arm64.apk.sha256`
- `tiho-<version>-source.zip`
- `tiho-update-v1.json`

The legacy `tiho` filenames remain part of the signed update protocol. The installed app is named LinkUp. The APK supports Android 7+ on ARM64 phones.

Keep `app/.signing/` private and backed up. Official updates require the existing APK signing key and update-signing key. Do not replace them. Forks need their own package identity and trust keys.

## Install and connect

Download the APK from GitHub Releases and open it on Android. Update without uninstalling to retain the account and chats.

Create an account, then exchange invitations from **Friends**. Both people must add each other. Nearby connections are configured under **You → Connection**. Internet delivery requires a configured HTTPS mailbox; no public server is included.

To share a local APK, run `npm run serve:apk`. For another phone on your Wi-Fi, set `COMMON_DOWNLOAD_HOST` to this computer's private IPv4 address. The server uses port 8084; stop it with Ctrl+C.

For a self-hosted mailbox and calling relay, use [server setup](../deploy/README.md). [Notification setup](NOTIFICATIONS.md) describes the optional UnifiedPush configuration.

## Desktop web

Open [LinkUp in your browser](https://ktihana.github.io/LinkUp/web/).
The desktop web app is exported by `.github/workflows/pages.yml` when app or site files change on `main`. GitHub Pages serves it under `/LinkUp/web/` and keeps the invitation page at `/LinkUp/`.

For a matching local export, run from `app/`:

```sh
LINKUP_WEB_BASE_URL=/LinkUp/web npm run build:web -- --output-dir ../docs/web
```

The base path applies only to this web build. Nearby Wi-Fi, hotspot and Bluetooth connections require the Android app. Internet messaging uses your configured mailbox.
