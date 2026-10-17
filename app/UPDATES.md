# LinkUp updates through GitHub Releases

The official release source is `KTihana/LinkUp`. Existing saved `KTihana/Tiho` sources follow the rename automatically; custom sources and automatic-check preferences are preserved. Android users open **You → Updates**, set the public `owner/repository`, and save. Automatic checks run after unlocking and loading the encrypted delivery preference, when the app opens or returns to the foreground, at most every 12 hours per app process. They can be disabled. Nearby only pauses automatic checks; choosing Check for updates explicitly contacts GitHub. GitHub receives ordinary HTTPS requests (including the connection's IP address); no vault key, profile, contact or message is sent. No check occurs until a repository is configured. Private repositories and GitHub tokens are not supported in the client.

The client verifies a publisher-signed Ed25519 manifest before offering an update. It downloads the exact APK over HTTPS, checks SHA-256 and byte count, checks Android package/signing-certificate identity and a strictly newer version code, then asks Android to install it. It checks the cached APK again immediately before installation. Android performs its own APK signature validation and requires the user's installation confirmation. No remote JavaScript updates or automatic installation are enabled.

The first upgrade from Common 0.1.0 to Tiho 0.1.1 must be installed from the new APK. Version 0.1.0 did not include an updater. Keep the same package `org.commonchat.app` and signing key so Android can retain the installed vault. Do not uninstall to upgrade.

The setup key copy uses Android’s sensitive-clipboard flag and attempts to clear its own clip after one minute without clearing later copies. Clipboard behavior still depends on Android version and app/process lifecycle.

## Publisher workflow

1. Create/select a public GitHub repository and keep its name stable. Run `node scripts/prepare-release.mjs --init --repository KTihana/LinkUp` before the first published build to embed the default source for all new installations. Initialize a new repository with a README so it has a default branch for release tags. GitHub Releases must be public so clients can fetch them without an account.
2. Update `expo.version` and increment `expo.android.versionCode` in `app.json`. Match the version in `package.json` and its lockfile. Update the release notes in `scripts/prepare-release.mjs` before building.
3. Set `JAVA_HOME` and `ANDROID_HOME`, then run `npm run build:apk`. This initializes release trust if necessary, builds/re-signs the APK, creates a signed `tiho-update-v1.json`, and packages the corresponding GPL source.
4. Run `node scripts/publish-release.mjs KTihana/LinkUp --prepare` to verify that all local release files are ready. After signing in to the official GitHub CLI, run the same command without `--prepare` to upload a **draft** release.
5. Review the draft in GitHub, then publish it. Use a stable tag `v0.1.1` (or the matching later version), not a prerelease. Include all four generated files: APK, checksum, source ZIP, and `tiho-update-v1.json`.
6. Test **Check for updates → Download update → Install update** on an Android phone running the previous Tiho build. Check that its existing vault and messages survive.

Keep `.signing/common-local.p12`, `.signing/password`, and `.signing/update-ed25519.key` private, owner-only and backed up securely. Never commit them, upload them, or put them in a release. The public release-verification key in `src/updates/releaseTrust.json` belongs in source. Losing either private signing key prevents compatible trusted updates; the scripts refuse to silently substitute a new release key when public trust already exists.

Editing the repository in the client cannot change its trusted publisher key. A fork must use its own keys/package and build its own client. Key rotation, multiple architectures, release rollout/rollback policy and iOS distribution are not implemented. Version-code downgrade installation is refused. GitHub availability/rate limits affect checks. An attacker who controls both publisher keys can publish malicious updates; protect the signing machine and review source before release.

Live download/installer testing requires a published release and a physical phone. Unit tests cover tampered manifests, foreign publisher keys, unsupported fields, hostile URLs, certificate mismatch and downgrade rules. This updater is part of an experimental, unaudited messenger.
