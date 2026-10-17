# Android notifications and quick replies

Android 9+, a secure screen lock, a UnifiedPush distributor and a configured HTTPS mailbox are required.

## Set up

1. Install and configure a [UnifiedPush distributor](https://unifiedpush.org/users/distributors/) on the phone, for example ntfy. This build does not include Google Play Services or an embedded FCM distributor. An external distributor is required for closed-app wakeups.
2. Configure the operator's public HTTPS mailbox with `PUSH_ORIGINS`, as described in `../relay/README.md`. Connect that mailbox in LinkUp → You → Connection. Nearby only mode intentionally blocks this route.
3. Unlock the local vault. Open You → Notifications → Enable background messages & replies. Grant Android's notification permission, then select the installed distributor. A successful endpoint callback registers its encrypted Web Push subscription with the identity-authenticated mailbox. The status changes to Registered only after server confirmation.
4. Send a new message from a second identity. The push contains only an encrypted `mailbox-wake` hint. Android WorkManager starts the headless task, which retrieves and independently authenticates the real MLS envelopes. Tap Reply in the Android notification shade; Android may ask to unlock the phone first.

## Key-access choice

Background messaging needs to decrypt messages and encrypt replies without waiting for the app's biometric prompt. Opt-in stores an additional vault-key copy encrypted by an Android Keystore AES-GCM key with `unlockedDeviceRequired`. This copy does not require biometric authentication. Android's screen lock is therefore the security boundary for background access; enabling this mode changes the protection compared with biometric-only access. The setup screen states this before enabling it. The in-app vault can still lock independently.

Turning background access off first deletes its local key material and disables all worker access, then unregisters the provider and attempts server deregistration. A server outage cannot keep local access enabled. This does not change the recovery key or the separate authenticated biometric-unlock entry. JS strings/native copies cannot be guaranteed erased immediately; owned key/seed arrays are wiped at task completion.

Previews are off by default. The push provider never receives chat text or message-encryption keys. Notifications identify the friend/group so the Reply destination is clear. Optional previews also put message text into Android's notification system; Android/user lock-screen settings govern their visibility. No plaintext quick-reply text is persisted in preferences. Pending replies have stable IDs and an encrypted, bounded queue. A retry after process death reuses the same message ID; the reply is removed only after transport storage is confirmed. Queued is not a delivered/read acknowledgement. Unsent replies remain available to copy or discard in Notifications settings; turning background access off deletes this queue. An invalid or departed-group destination cannot block other replies or incoming messages.

The background engine and UI share one JS runtime and a write serializer. Every background transaction opens the newest encrypted vault and rechecks delivery policy. Native synchronous revocation also prevents retained signing callbacks from continuing after Nearby only, Pause, Disable or device lock. Foreground native edits merge the latest same-identity encrypted record; web retains its existing stale-write refusal and cross-tab lock policy.

Android force-stop prevents delivery until the app is reopened. Background call ringing, group calls, iOS push and browser push are not included.
