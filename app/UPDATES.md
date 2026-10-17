# Publish LinkUp updates

The app checks `KTihana/LinkUp` under **You → Updates**. Downloads are verified against the publisher-signed manifest, APK checksum, Android package and signing certificate. Android asks the user to approve installation.

## Publish

1. Update the version in `app.json`, `package.json` and the lockfile. Increase Android `versionCode`.
2. Build with `npm run build:apk` from `app/`. Preserve the existing private signing keys.
3. Run `node scripts/publish-release.mjs KTihana/LinkUp --prepare` to verify the files.
4. Run the same command without `--prepare` to upload a draft. Publish it with the matching `v<version>` tag.

Keep the APK, SHA-256 checksum, corresponding source ZIP and `tiho-update-v1.json` together. These legacy filenames support installed clients. Keep private keys out of GitHub, source archives and release assets.

Automatic checks can be disabled in the app. Nearby only mode pauses them. No update installs without Android confirmation.
