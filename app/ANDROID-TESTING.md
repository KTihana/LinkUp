# LinkUp 0.3.0 security and private network test candidate

Install the signed 0.3.0/code 9 build over the previous app on both Android phones, preserving account and history. Do not uninstall. Reconnect each existing chat from Chat options on both phones to upgrade its encryption session. The relay must also be updated before internet messaging: old relay versions do not support friend permissions and fail closed.

New sessions renew keys after 64 chat events or 24 hours of active sync. The chat displays a key-refresh status while waiting for its peer; queued messages should resume after both devices acknowledge the update. Force-close/reopen either app during an update and confirm that messages are neither duplicated nor lost. Removing a friend stops local communication and cancels queued messages; server revocation requires a successful mailbox connection.

For Wi-Fi or Bluetooth, follow the previous two-phone instructions below. For **Private network**, use [the self-hosted server guide](../deploy/vpn/README.md). The prototype requires Android 9+, explicit Android VPN consent, a reachable hub and matching enrolled phones. It is foreground messaging only; private-network calls and mailbox fallback are disabled. Check tunnel loss, revocation, account reset, screen lock and enrollment expiry. A tunnel-up indicator alone does not prove message delivery.

The new Android screen-protection flag should block screenshots, recordings and recents previews of app content. Verify on each supported phone. App PIN and optional background messaging still need their separate hardware and notification checks. This remains an unaudited test build.

## Previous LinkUp 0.2.5 — test with a friend

Both people install **the same 0.2.5 APK**. It is a standalone Android test build with the blue Quiet design. Install over the existing app; do not uninstall or clear storage. A fresh account defaults to Anon and uses a six-digit app PIN on Android 8+, with a longer-password alternative. Creating a new account permanently deletes previous local account data after confirmation.

## Pair the two phones

1. Keep LinkUp open and unlocked on both phones. Under **You → Edit profile**, set different names so you can recognize each other.
2. Under **You → Invite a friend**, choose **Create my invitation**. On the other phone open **Friends → Add friend**, scan the invitation, review it and tap **Add friend**. Reverse roles and repeat: both people must have added the other.
3. Under **You → Connection**, run **Check device encryption** on both phones. Report an error here before testing delivery. This checks disposable cryptographic clients, not real radio interoperability.

## First test: Wi-Fi

1. Put both phones on the same normal Wi-Fi network. Guest networks or router client isolation may block phone-to-phone traffic.
2. On phone A, open **You → Connection → Wi-Fi & hotspot**, select your friend and choose **Host on this Wi-Fi**. Keep its nearby QR visible.
3. On phone B, open the Wi-Fi connection screen, choose **Scan a nearby code**, scan phone A's QR, review it and choose **Join nearby Wi-Fi**. Phone B does not start a second host session.
4. Once the link is ready, return to Chats/Friends without leaving LinkUp. Send a short message, reply, then try emojis and a bundled sticker. **Stored** means the encrypted packet was accepted; **Delivered** requires the recipient's encrypted receipt. It does not mean read.

## Second test: Bluetooth without internet

1. Choose **Stop nearby** on both phones. Turn off Wi-Fi and mobile data on both, and turn Bluetooth on. Airplane mode with Bluetooth re-enabled is an alternative. On Android 11 or earlier, scanning may also require system Location services enabled, alongside the requested location permission.
2. On phone A, open **You → Connection → Bluetooth**, select your friend and tap **Start Bluetooth**. Allow Nearby devices permissions and keep its nearby QR visible.
3. On phone B, open Bluetooth in Connection, tap **Scan a nearby code**, scan phone A's QR, review it and tap **Find friend over Bluetooth**. Choose **Connect Nearby phone 1** if that is the only phone found. Phone B does not press Start Bluetooth first. Discovery labels are intentionally anonymous; signed messages check the selected friend's identity.
4. When the link is ready, return to the conversation and exchange messages in both directions. Then send from both phones at about the same time. Bluetooth connection alone is not a pass: require decrypted messages and Delivered receipts on both phones.
5. Stop both nearby sessions and repeat the QR/join sequence. Confirm old messages remain and do not appear twice. Nearby sessions deliberately stop on background/lock or after ten minutes; after returning, unlock and establish a new session. Automatic background Bluetooth reconnect is not included.

Bluetooth messages do not need a server, SIM or internet once this setup succeeds. Bluetooth does not carry calls. Foreground calls can be tried separately over Wi-Fi after message delivery passes. This build has no default public internet mailbox or push service, so it is not an internet/background-notification readiness test.

## Record the result

Note both phone models, Android versions, LinkUp version, Wi-Fi/Bluetooth, the last successful step and the exact error shown. Test a short message and simultaneous sends first; large message bursts can take longer over Bluetooth. Report permission denial, missing discovery, connection failure, stuck Stored/Queued or duplicate messages separately. Do not include your PIN, invitation links or raw keys in the report.

## What changed for this build

Nearby now serializes outgoing packets per connection, including signed replies. A deterministic test reproduced competing Bluetooth sends before the fix; the single-packet transport checks now cover simultaneous publications, real MLS text/sticker/receipt delivery, cancellation and replacement of a connection. Queue length is bounded; no vault transaction is held while waiting for native sends. Physical-phone results remain pending.

## Previous 0.2.4 account and design validation

Install as an update; do not uninstall. Test new six-digit PIN and long-password signup: neither should report a LinkUpPhoneUnlock.disable bridge rejection. Lock and reopen with the same credential. Change PIN under You → App lock and confirm identity/history remain the same. Native crypto/bridge unit tests run against the shared completion helper.

On a disposable test account only, choose Create a new account, review the deletion warning and select Delete data and continue. Confirm old chats, contacts, settings, private image caches, notification replies and earlier archives are removed. Confirm a new account starts as Anon with a new friend code without asking for the old PIN. Test interruption/process restart during cleanup and retry after a storage failure. A phone left on the 0.2.3 welcome screen after failed signup should also remove leftover archives when the next signup succeeds. This is app-data deletion, not a claim of forensic flash overwriting or remote deletion. Physical-phone checks remain pending.

Visually inspect chats, conversation, profile, settings, welcome/PIN and light/dark modes. Check custom colors survive upgrade, large text, smaller screens, masked digits and backspace/cancel. The Figma review is in the existing LinkUp file at node 42:504.

## Earlier validation notes (historical behavior)

# App PIN update — 0.2.3

Install the signed APK as an update; do not uninstall or clear app data. For a fresh Android 8+ account choose Create account, enter six numbers on the pop-up keypad, Continue, repeat them, then Save PIN. Lock/reopen and use Enter PIN. Test backspace, mismatched confirmation, cancellation and leading zeroes. Under You → App lock, change PIN and confirm the same identity/history remains. For an existing account, open it once with its original method, then Set up PIN. Keep old protection until the PIN has been tested. A missing old encryption key cannot be reconstructed by a new PIN.

On a dedicated test account, verify five wrong attempts cause a 30-second wait, further failures increase it, process restart and wall-clock changes do not skip it, and reboot retains the penalty from boot. Correct entry after the wait should preserve all messages. Verify normal PIN setup/unlock never shows a phone screen-lock credential prompt. Check small screens, screen reader labels, large text, background relock and a compatible APK update. These physical-device checks are pending.

# Android test build

LinkUp's local APK is a standalone **experimental test build** for 64-bit ARM Android phones running Android 7/API 24 or later. It bundles JavaScript, Hermes and native modules; Expo Go and a running Metro server are unnecessary. It is not an independently audited release.

## Build and signing

Install a supported JDK and Android SDK first. Set `JAVA_HOME` and `ANDROID_HOME` to those installations, then run `npm run build:apk` from `app/`.

The script generates Android sources using Expo CNG, assembles the release variant for `arm64-v8a`, replaces the template signature with a private local signing certificate, verifies the resulting APK, and writes:

- `artifacts/tiho-0.2.2-arm64.apk`
- `artifacts/tiho-0.2.2-arm64.apk.sha256`
- `artifacts/tiho-0.2.2-source.zip`

The source archive excludes signing material, generated projects, local relay/vault data and dependency caches. Install dependencies from the lockfile to rebuild. The EAS `preview` profile is also configured for a standalone APK, if an owner later chooses cloud builds.

Keep both `.signing/common-local.p12` and `.signing/password` private and backed up. These files are ignored by Git and restricted to the current filesystem user. They sign compatible future updates; losing the signing key requires a different installation identity. Neither belongs in the download folder. The generated `android/app/.../app-release.apk` retains the template signature and **must not be distributed**; use the re-signed artifact above.

The build also writes `artifacts/tiho-update-v1.json`, signed by the private release key `.signing/update-ed25519.key`. Keep that key private too. See [UPDATES.md](UPDATES.md) for GitHub Releases publishing and in-app updates.

## Transfer and install

Transfer the APK to the phone by USB, or run `npm run serve:apk`. This defaults to the current computer only. To download over a trusted local Wi-Fi network, set `COMMON_DOWNLOAD_HOST` to this computer's private IPv4 address and run the same command. The download page presents `linkup-<version>-arm64.apk`; the signed-update asset retains its legacy name for compatibility. Open port 8084 in the phone's browser, or scan the displayed download QR code. Both devices must be on the same reachable network. The server exposes only the named APK, checksum, licence and source archive; Ctrl+C stops it. It refuses wildcard/public interface binds.

Open the downloaded APK on Android and allow installation from that browser/file manager when Android asks. This is a local test installation, not a Play Store release. Verify the APK checksum against the supplied SHA-256 file if transferring through another service. The phone does not need USB debugging for ordinary installation.

## First use

1. Create your account with protected phone unlock or a normal password. Android 11+ supports your existing fingerprint/screen-lock credential; older biometric adapters remain available where supported. No raw recovery-key copy is required. Add an optional password in **You → App lock**. For a locked older account with no usable saved method, choose **Create a new account** and review the local archive step. See ACCOUNT-ACCESS.md before testing resets or old-account migration.
2. Edit your profile and exchange signed friend invitation codes. Add the friend on both devices. There is no public directory.
3. In **You → Connection**, use **Check device encryption**. This checks cryptographic primitives and the actual MLS message/reply/authentication adapters with disposable in-memory peers. It creates no user vault and makes no network requests. A passing result checks compatibility, not the overall security of LinkUp.
4. For nearby delivery, one friend hosts Wi-Fi/hotspot or Bluetooth. The other explicitly joins using the signed nearby offer. For hotspot delivery, join that network in Android's Wi-Fi settings first. Permission requests occur when the relevant action is selected.
5. For mailbox delivery, both friends configure a reachable HTTPS mailbox. No default public mailbox is supplied. A computer's loopback address cannot be used by a separate phone. Plain HTTP LAN mailboxes are rejected.
6. Let one friend send the first message. **Stored** means the transport accepted the encrypted packet; **Delivered** requires the other client's encrypted receipt. It does not indicate that a person read the message.

## Required two-phone checks

Record the phone model and Android version. Verify invitations, text/emoji/sticker messages and replies, lock/restart with queued delivery, Wi-Fi and hotspot reconnects, Bluetooth roles/permissions/MTU limits, and any existing system VPN. Emulators cannot establish physical radio interoperability. Foreground voice/video calls are experimental in 0.2.0: test accept/decline, microphone/camera permissions, mute, speaker, hangup, interruption and network handover on both phones. Public TURN and real media capture still require verification. Voice notes, arbitrary attachments, groups, backup recovery, background calls and iPhone nearby delivery remain future work. See [TESTING.md](TESTING.md) for the detailed call checks.

Android automatic app backup and screen-overlay permission are disabled. Microphone/camera permissions are declared for calling and requested when starting or accepting the relevant call; scanning a QR code does not request microphone permission. A vault key cannot recover an uninstalled or deleted vault. Preserve test data when installing updates; do not uninstall a vault you need to retain.

See [VALIDATION.md](VALIDATION.md) for completed checks and outstanding limitations, and [SECURITY.md](SECURITY.md) for the threat model and security-review blockers.

## Invitations received before installation

Use a newly generated QR code. Scan it with a second phone's normal camera without LinkUp installed. It must open the public LinkUp installation page, stay on that page, and offer the Android download. After installing and setting up the app, return to the same browser tab and choose **Open invitation in LinkUp**. Review the sender and add them explicitly. Also test opening an invitation before account setup: finishing setup must return to its review with the same sender. Verify old app-only invitations and scanning the new public QR inside **Friends → Add a friend**. iPhone visitors must see that Android is currently required. Never use real identity tokens in test logs.
