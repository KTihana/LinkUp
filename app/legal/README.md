# Calling dependency notices — collection in progress

These files preserve the notices collected for react-native-webrtc 155.0.0 and the WebRTC v155.0.0 release source. `sources.json` records their origin, immutable release revision and hashes. Do not replace these with a statement that Tiho's GPL license applies to all dependencies.

The Android runtime is pinned to `org.jitsi:webrtc:155.0.0`. Its downloaded AAR does not include the complete native third-party notice bundle. The root WebRTC license and patent grant here do **not** replace those dependency notices.

Before public distribution:

- Obtain the native `LICENSE.md` generated for the actual Android AAR build by upstream `tools_webrtc/libs/generate_licenses.py`, or reproduce its dependency analysis from the matching GN build targets.
- Verify the AAR/source provenance. The release tag `v155.0.0` resolves to `9edb2100fc29f847b5d01def716a979daf397901`; the moving M155 branch currently differs and must not be treated as the released source.
- Collect the other JavaScript and Android runtime dependency notices, then ship the complete notice bundle with the APK and expose it in the app.
- Keep corresponding Tiho source, build instructions and license available with each distributed release.

The files in this directory are a partial collection. The production release notice gate remains open in `../../READINESS.md`.

The interface uses Manrope. `manrope-font-OFL.txt` preserves the font's SIL Open Font License; `manrope-package-MIT.txt` preserves the font package wrapper's separate MIT notice. Fonts are bundled locally and are not fetched from a third-party font service at runtime.

## Notification dependencies (0.2.1)

`unifiedpush` contains the Apache-2.0 license and immutable Maven metadata/checksums for connector 3.3.5. Native notification delivery also introduces WorkManager 2.11.0 and the connector's Tink 1.23.0 dependency. Their complete runtime/transitive notices and native provenance still require collection before public release; this directory does not claim that gate is closed. The relay's pinned `web-push` and server-side npm notices are preserved under `relay/legal`, separately from the Android runtime.
