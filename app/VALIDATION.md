# Interface foundation validation — October 13, 2026

This log records successive milestones. The latest section describes the current build; earlier limitations refer to those earlier snapshots.

- TypeScript strict typecheck passed.
- Expo lint passed.
- Web production export passed.
- Android JavaScript/Hermes export passed.
- Browser preview served successfully on loopback; inspected at 364px viewport width.
- Verified display-name editing and saving, validation of an empty name, photo selection from a real file chooser, photo removal, online-status preference on/off, chat navigation, local message composition, and sticker insertion.
- Rechecked navigation after dependency overrides and the final web rebuild.
- Captured the running preview in `../design/common-first-build.png`.
- npm audit after overrides: 18 high reported entries, zero moderate/critical. Many entries are dependents of the affected tooling packages. See SECURITY.md. This is a release blocker, not evidence of a secure product.
- No Android hardware/emulator or iPhone testing has been performed. Native JavaScript export is not an installable APK and does not validate native permissions, camera behavior, or safe-area/keyboard behavior on hardware.

## Appearance and artwork update
- Typecheck, lint, and web export passed after the changes.
- Verified Dark/Ocean/Navy choices survive a reload and Light/Dark switching updates the interface.
- Checked 288 palette/text/background combinations against a 4.5:1 contrast threshold.
- Verified bundled cat stickers render in dark mode and can be selected; emoji picker uses local Twemoji PNGs.
- Profile editor no longer shows helper lines below Display name or About.
- Figma asset sheet contains editable vectors and attribution; original profile board retained in its original position.

## Custom color wheel update
- Light/Dark only; removed Rose from selectable themes.
- Verified pointer selection on the color wheel changes the hex value.
- Verified independent custom accent/text colors persist after reload.
- Invalid hex disables Apply; Cancel preserves the saved selection.
- Checked HSV/hex round trips, black/white and bright-color contrast handling, and legacy Rose migration.
- Typecheck, lint, web export, and Android JavaScript export passed.

## Local identity and encrypted profile storage
- Typecheck, lint, web production export, and Android JavaScript/Hermes export passed.
- Six security-core tests passed: authenticated encryption round trips, wrong-key and tamper rejection, Ed25519 public-key agreement with Node crypto, fresh nonces, strict input validation, persistence, stale-write protection, and failed-write preservation.
- Browser-tested profile photo upload and saving. The stored draft image rendered as a 384 × 384 JPEG data URI; the original file URI is not retained as the profile photo.
- Inspected the local vault introduction in the running browser and captured `../design/common-local-vault.png`.
- Actual browser vault setup/unlock has not been exercised end to end. The tests use a mock record store; Web Locks and React lifecycle behavior still need integration testing.
- Native SecureStore behavior and temporary photo-file cleanup require Android hardware testing.
- This milestone encrypts saved profile data and the identity seed. It does not implement encrypted network messaging, conversation persistence, backups, or device pairing. See THREAT-MODEL.md for its limits.

## Signed invitations and encrypted contacts
- 28 tests pass: nine invitation tests, 18 vault/controller tests, and one QR decoder test covering six native/web links with Unicode and maximum-length names.
- Invitations are independently checked with Node Ed25519; malformed, altered, expired/future, ambiguous, noncanonical and mixed-torsion identities are refused.
- The real shared vault controller is tested with injected stores and deferred operations, including signed contact acceptance, encrypted persistence/restart, legacy records, duplicate/self rejection, expiry rechecking after lock wait, stale writes, setup cancellation, and lock/teardown races.
- Typecheck and uncached ESLint pass. Source includes now exclude generated export folders, preventing typecheck/export races.
- Web production and Android JavaScript/Hermes exports pass. Native config introspection confirms the `common` scheme, combined camera-use explanation, no iOS microphone usage declaration, and removal of Android RECORD_AUDIO permission.
- Browser-tested a direct `/invite?token=…` URL, valid signed identity review before setup, malformed/expired errors, and preservation of an incoming invite across navigation to setup and back. Screenshot: `../design/common-friend-invitation.png`; the pictured Mia identity is a throwaway public test fixture.
- QR matrices decode to the exact signed links through independent jsQR decoding. Actual camera scanning, clipboard copying, native deep links, real-device SecureStore behavior and complete browser vault activation/acceptance remain integration checks.
- Web hosting needs SPA fallback for direct `/invite` links. Loopback invitation links are computer-local. Contact acceptance does not notify the other person or establish network messaging.

## Experimental encrypted mailbox messaging

- All 63 application tests and 18 real-HTTP relay tests pass. Coverage includes MLS interoperability, credential/signing-key binding, unauthorized-member rejection, authentication failures, reordered delivery, replay rejection, durable outbox/state writes, failed persistence, lock/Pause races, lost key-package claims, mailbox backpressure, expiry, explicit reconnection and stale-session backlog draining.
- `npm run demo:messaging` passes using two real encrypted VaultControllers and a temporary HTTP relay. Alice sends while Bob is offline; Bob restarts and unlocks his encrypted disk record, receives the message and returns an authenticated encrypted receipt; a reply also succeeds. The demo checks ciphertext on disk and in transit and cleans up its temporary records.
- TypeScript strict typecheck and uncached full-project ESLint pass. Expo Doctor passes all 21 checks after adding the SDK-compatible expo-font native peer dependency.
- Final web production and Android JavaScript/Hermes exports pass. These exports do not produce an installable APK or verify native execution.
- Native config introspection includes the `common` scheme, QuickCrypto and font plugins, combined camera explanation, no iOS microphone usage declaration and explicit removal of Android RECORD_AUDIO. This is development-build configuration; production network/permission settings still need review.
- Browser-inspected the new Connection screen and profile entry at 364px width; rechecked chat navigation, preview text/emoji composition and the bundled sticker picker. Captured `../design/common-message-delivery.png`.
- Complete browser vault activation/network delivery, browser WebCrypto probes, Android native crypto/SecureStore, camera, deep links and hardware UI behavior remain integration checks. The Node two-client demo does not establish that phone execution works.
- The current transport is a self-hostable encrypted mailbox. Direct P2P transport is not implemented. No public/default mailbox is deployed.
- Encryption uses the pinned, unaudited ts-mls 1.6.4 development implementation with exactly two members and a fixed epoch; ongoing epoch updates/post-compromise recovery are not implemented. Independent security review and resolving the 19 reported high-severity dependency audit entries remain release blockers. See SECURITY.md, MESSAGING-PROTOCOL.md and THREAT-MODEL.md.

## Experimental Android nearby transport

- The full application suite passes all 87 tests. New coverage includes 11 Nearby protocol tests, ten native-session lifecycle tests and three signed-offer/independent QR tests. Final focused checks also pass after the incoming-notification, link selection and UI changes.
- The Nearby tests use actual MLS cryptography and real encrypted VaultControllers across restart/unlock. They verify no-HTTP first contact, text/emoji/stickers, authenticated receipts, durable receiver storage and one-use claims, failed writes, retries/dedup, signed-response forgery, contact/recipient enforcement, route-separated key pools, absent-peer fairness and cancellation of an active HTTP challenge when Nearby only is selected.
- Native-session tests inject deferred native operations around real encrypted storage. They cover Stop during authorization/startup, overlapping starts, stale failures, foreground loss, Bluetooth/Wi-Fi expiry rechecks and forwarding the exact signed TLS pin. They are lifecycle tests, not radio tests.
- `npm run demo:nearby` passes with two actual encrypted temporary disk vaults, an in-process packet channel, an out-of-range queue, reconnection, recipient restart, receipts and a sticker reply. It records zero HTTP calls and cleans up its temporary data. The channel does not simulate radio performance or permissions.
- Android Wi-Fi and BLE helper source compiles against the actual Android SDK 36 with Kotlin. Ten JVM tests pass: two private-address-policy checks and eight BLE fragmentation/reassembly, UTF-8, size/order/transfer, deadline and backpressure cases. These do not compile or exercise the complete Expo wrapper.
- Expo autolinking discovers CommonNearby and isolated CNG generation passes. Config introspection includes the native plugin, action-specific Wi-Fi/Bluetooth permissions, legacy SDK bounds and explicit microphone removal. The installed Expo57 API declarations were used to check wrapper signatures.
- Full Gradle/APK compilation remains unverified: the attempt exhausted host disk space before the Expo wrapper compiled. Attempt-owned generated project/toolchain/cache files were removed, restoring available space. No APK was produced or installed.
- Typecheck, full-project uncached ESLint, all 21 Expo Doctor checks and final web/Android JavaScript/Hermes exports pass. Native bundle export is not native compilation or phone execution.
- Browser-inspected Connection navigation and the Nearby card, disabled Android-only controls, accepted identity gate and retained preview behavior. Screenshot: `../design/common-nearby-connections.png`. Complete browser vault activation and native camera/QR scanning remain pending.
- No physical Wi-Fi/hotspot/Bluetooth session or system-VPN route has been tested. Hardware permissions, TLS/Android keystore operation, AP interface discovery, BLE role/MTU interoperability, actual packet timing and two-phone UI behavior remain required checks. iPhone nearby support, Wi-Fi Direct and direct internet P2P are not implemented.
- Nearby only blocks Common mailbox delivery/fallback and aborts outstanding HTTP. It does not assert that the operating system or an existing VPN makes no internet connections. BLE protects message contents with MLS but does not conceal routing/traffic metadata. The cryptographic library/integration still require independent review.

## Privacy hardening and legal research — October 13, 2026

- All 98 application tests pass. Eleven additional tests cover encrypted/ephemeral appearance, ordered patches, invalid input, atomic legacy migration and cleanup, foreground/signature gates, delayed unlock/setup/write cancellation, browser hidden/pagehide events, native deadline enforcement even when timers were paused, bounded picker returns and active HTTP cancellation with queued-message recovery.
- Startup on native/web now remains locked even when a device key is available. Restart fixtures explicitly unlock; encrypted mailbox and nearby restart/receipt tests still pass. Returning to the foreground never automatically unlocks.
- Browser visibility/pagehide locks immediately. Native uses a 30-second background/inactive deadline; private operations are foreground gated and network work cancels immediately. Native timer scheduling, OS suspension, image picker/permission transitions and app-switcher exposure still need phone integration tests.
- Appearance writes use the encrypted vault; preview choices remain in memory. Existing plaintext choices migrate after unlock, with deletion only after successful encrypted persistence. Tests simulate failed writes and verify that newer encrypted choices survive migration. Deletion is not forensic erasure and cannot remove old backups.
- Typecheck and full-project uncached ESLint pass. Web production and Android JavaScript/Hermes exports pass; these do not build an APK or test native execution. Browser navigation/profile/vault rendering was inspected without creating or unlocking a personal identity.
- Direct Noble/scure dependencies are pinned to installed 2.4.0 versions, matching package/lock/installed metadata. Current npm audit still reports 19 high entries, zero moderate/critical, from the braces/node-forge advisory chains. No forced Expo downgrade was applied.
- Reviewed primary RFC 9420/Signal/OWASP/NIST guidance and Croatian/EU legal sources. Croatia is confirmed by the user. Requirements prohibit intentional backdoors, master decryption keys, key escrow and silent downgrades; public operating model/interception/notification obligations need qualified Croatian legal review. Research is not legal clearance or an independent security audit.
- Remaining release blockers include unaudited MLS/integration, fixed epoch with no post-compromise recovery, dependency findings, native full-build/hardware testing, media/backup/device management and reviewed web/release delivery. No public service was deployed.

## Encryption library review and Croatian counsel brief

- Compared OpenMLS, ts-mls, mls-rs, official libsignal and Matrix Rust crypto using upstream documentation, licence information, audit scope and advisories. OpenMLS 0.9.1 is the preferred migration candidate; the app runtime remains ts-mls 1.6.4.
- Confirmed OpenMLS 0.9.1 exists and is not yanked in the official registry, with a 7 October 2026 publication date and Rust 1.91.0 requirement. Downloaded the 676,062-byte crate into memory, verified its SHA-256 against registry metadata, and inspected its packaged manifest, README and VCS commit. Evidence is in `research/openmls-candidate.json`; this is not compilation, provenance certification or an audit of the candidate's complete dependency graph.
- Checked the 8 October recursion advisory and selected its patched version rather than vulnerable 0.9.0. Recorded earlier advisories, excluded audit components, acknowledged storage/state risk and prohibited shipping debug/unchecked features. Android/Wasm adapters and epoch/fork/transaction failure tests remain future implementation work.
- Local Rust/Cargo/rustup/wasm-pack are absent from PATH. No toolchain, native bridge or new encryption library was installed, and no current encrypted state was migrated. App/API behavior and package dependencies were not changed during this documentation/research task.
- Prepared `../LEGAL-BRIEF.md` for the owner's review, separating software publication, project-operated mailboxes, independent hosting and local nearby use. Explicitly included Article 52(13) on paid/unpaid service provision, retention/disclosure, HAKOM notification, privacy and distribution questions. The brief is not a legal opinion and was not sent externally.
- Local Markdown links, evidence JSON and candidate/runtime status agree. Typecheck and full-project uncached ESLint pass. Functional tests/build exports were not repeated for this documentation-only change; the prior 98-test/exports result remains the latest runtime validation.

## Two-client browser test bench (14 October)

- Added `npm run demo:browser`: serves the unchanged web export on loopback port 8082, with separate localhost/127.0.0.1 client origins and a loopback mailbox on port 8787. Existing port-8081 preview storage remains separate.
- Browser-inspected both real application frames on the vault setup screen. Both stay visible during live testing; explicit close/reopen controls support offline/restart tests without disabling the app's visibility locking.
- Relay health and SPA `/invite` fallback respond successfully. Launcher syntax, application typecheck and uncached lint pass.
- The owner must handle private vault-key creation/retention. No identity was seeded, no private key was read or logged, and browser message exchange has not yet been verified. The two-client messaging test is pending this handoff.

## Standalone Android APK (14 October)

- Full Gradle release build succeeds for arm64-v8a, API 24 minimum/API 36 target. The complete CommonNearby Expo wrapper compiles. Fixed its ambiguous zero-argument Bluetooth coroutine using an explicit empty parameter list. All ten native tests pass through Gradle.
- Recovered the corrupted shared cache journal by preserving it and regenerating the index. Bounded Ninja compilation to two jobs and Gradle to one worker, resolving memory pressure on the 8 GB host. Generated Android projects remain CNG output; source changes live in app configuration, native module source and build scripts.
- Produced `artifacts/common-0.1.0-arm64.apk` (~64 MB), signed with a private local RSA-3072 key. Android signature v2/v3 verification passes. Certificate SHA-256: `6f4af2135a28222c587ac309b5c46bb6862fdb11b5c265505403db2df0f5441b`. Signing key/password have owner-only permissions and are excluded from Git/source/downloads.
- Inspected the actual APK: JavaScript bundle and Hermes native library are embedded; release debugging is disabled; automatic backup is disabled; microphone and screen-overlay permissions are absent. No Metro server or Expo Go is needed.
- Installed the signed APK on the dedicated Android 16/API 36 ARM64 emulator successfully. Cold launch returns Status ok; React Native starts and the app remains running. Native self-test passes under Hermes, covering SHA-256, Ed25519, X25519, HKDF/HMAC, AES-GCM authentication and actual MLS messages/replies/tamper rejection using disposable in-memory peers. No user identity/vault is created or read by this test.
- All 98 application tests pass, as do typecheck and uncached ESLint. The additional engine self-test also passes on Node. Native first launch opens identity setup; Connection exposes a device-encryption check.
- Local Wi-Fi download page responds successfully and includes download QR, source and checksum. Downloaded APK SHA-256 matches `3042bd406754ace618403395c8d4b55824b966adbfdcc6ad248c1e504aec011c`. Unknown routes (including signing paths) return 404. Source ZIP inspection confirms signing files, dependency caches, local test data and generated builds are excluded.
- No real phone was connected. Two-phone UI/QR/radio/VPN checks remain pending; browser UI messaging still requires the owner’s private-key setup handoff. No public/default mailbox, cloud build or independently audited release was produced. Calls, media, groups, backup and device pairing remain future work.


## Tiho 0.1.1 (14 October)

- Final release build passes; APK version 0.1.1/code 2, package org.commonchat.app, API 24 minimum/API 36 target, arm64-v8a. Same signing certificate as 0.1.0; v2/v3 signatures verify.
- 102 application tests and all 13 native JVM tests pass. Final lint/typecheck pass. Web export passes. Browser checks at 360×800 confirm Anon, draft-only appearance, Save applying it, Cancel preserving saved choices and preview bubbles doing nothing.
- Final embedded Hermes bundle/source map contain Anon, Android copy-key touch handling, GitHub default KTihana/Tiho, and automatic-check gating on unlocked, hydrated delivery preferences. Nearby only pauses automatic checks.
- Upgrade installation over 0.1.0 succeeds on the Android 16 emulator. Original firstInstallTime and ceDataInode are unchanged. Cold startup returns Status ok; native update-service API and actual encryption/MLS self-tests pass. No personal vault was created or read.
- APK SHA-256: d1dd60c9834445464386b5102ee40db0851e7f20a26d52fba93e69a44d4fafae. Signed release metadata and corresponding source archive are prepared; signing material is excluded. Public repository KTihana/Tiho contains the complete source snapshot and GPL licence.
- Physical phone touch/clipboard behavior, actual newer-release download/installer handoff, and two-phone radios still need real-device QA. GitHub release v0.1.1 is published. The app’s actual latestRelease verifier successfully fetched and authenticated the live public feed, exact package/version/asset, and APK SHA-256. Full newer-APK download/installer approval on a phone remains pending.

## Invitation installation flow — 2026-10-16

- Friend QR codes and copied links now use the public `https://ktihana.github.io/LinkUp/#…` installation page, including when created from a loopback web preview. The signed invitation stays in the fragment; it is not part of the hosting request. The page has no automatic app redirects, keeps installation separate from opening the invitation, and offers a copy/paste fallback compatible with older app-only invitation links. iPhone visitors see the current Android-only availability.
- Account setup retains the pending invitation and return screen in route parameters, across account-generation remounts. Received invitations are reviewed on entry; accepting a contact remains explicit.
- 15 invitation, navigation, landing-page and independent QR-decoder checks pass. All 21 vault checks pass, including accepting the public invitation URL and preserving the encrypted contact through restart. Lint, TypeScript and web export pass.
- Browser verified at 390px: the live public page stays open, has separate install/open actions, and opens downloads in another tab without a referrer. A disposable signed invitation opens its sender review in the actual app; entering setup retains its token and return destination. No real account or contact token was used. Completing installation and reopening from a phone camera still needs a two-phone check.
- Public page source: GitHub commit `f2b574fabb39e299a40b8544cd206da08cf5e26d`, GitHub Pages built from `main:/docs`.
