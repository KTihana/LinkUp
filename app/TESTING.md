# LinkUp Android test build

The working 0.2.0 build adds foreground voice/video calls and connection recovery. It is not a production release. Keep the existing vault key and signing identity; do not uninstall an existing installation just to update it.

## Two-phone check

1. Install the signed APK on two ARM64 Android phones. On a phone with 0.1.1, install over it and confirm the profile, identity, contacts, appearance and message history survive. Record the Android versions and phone models.
2. Create or unlock each local vault. Save each vault key privately. Exchange QR invitations and accept each other as friends.
3. Under Connection, establish a local Wi-Fi or hotspot connection with the other phone. Send a message in each direction, then send at the same time. Confirm each appears once and delivery status changes correctly.
4. From a conversation, start a voice call. Confirm the recipient rings without opening the microphone. Decline once, then call again and accept. Check audio in both directions, mute, earpiece/speaker, and hangup from each side. Repeat with camera permission denied, then with video accepted and camera toggled off.
5. Keep LinkUp open during calls. Check a Bluetooth headset separately; Bluetooth **message transport** is not a call transport. Record any routing failures rather than treating successful signaling as successful audio.
6. For internet testing, configure the prepared public HTTPS mailbox and TURN service. Put one phone on cellular and the other on Wi-Fi. Verify voice/video both ways, then switch Wi-Fi off and back on during the call. Check that the same call reconnects and old capture/connection resources are released. Run a call for at least 25 minutes to cross multiple relay credential renewals.
7. Test app switching, screen lock, revoked microphone/camera permission and airplane mode. The current vault/background behavior ends calls; background ringing and background calls are not yet supported.
8. Test message delivery after an offline period and app restart. Verify that duplicate delivery does not duplicate chat history and that queued messages remain encrypted locally.

Never copy vault keys, private identity material, camera images or message contents into test logs. Record build version, device/OS, route, observed result and failure timing. Use throwaway test identities for network diagnostics.

## Automated checks

From `app/`: `npm test`, `npm run typecheck`, and `npm run lint`.

From the repository root: `node app/scripts/call-browser-test.mjs`, then open the loopback URL and run the browser check. It exercises the production call controller and media adapter using synthetic audio/video, including simultaneous connection recovery. It does not verify physical microphones, cameras, Bluetooth, cellular routing or a public TURN server.

See `../READINESS.md` for evidence and remaining release gates. Native runtime notices and independent security review remain requirements before a public production release.

## Biometric unlock hardware checks

Use disposable identities. Confirm that opt-in is off after setup, unlock using the recovery key, then enable biometric unlock in Local vault. Enrollment must show system authentication and succeed only after a protected read-back. Lock/restart should show the explicit biometric button; cancel, a failed scan, device lockout and backgrounding during a delayed scan must leave private state hidden. Repeat with supported face unlock where available.

Verify recovery-key fallback, disabling the shortcut, loss/change of enrolled fingerprints or face settings, and successful re-enrollment after recovery. Confirm profile, identity, contacts, preferences, queued messages and history survive. No diagnostic output may contain recovery keys or private data. Repeat on physical iOS before claiming Face ID/Touch ID support is validated. Emulators and mocked SecureStore tests do not establish native biometric enforcement.

## Notifications and groups (0.2.1)

Follow `NOTIFICATIONS.md` on two physical phones and a push-enabled HTTPS mailbox. Verify standard Android Reply actions, preview privacy, separate phone/vault locks, process death, reboot, Doze, denied permission, push-provider failure and the duplicate-reply/route-revocation cases. No real-phone success is inferred from a Kotlin build or mocked key access.

With three updated clients, have every participant exchange friend invitations. Create a group with two friends, review and accept each invitation, then exchange text/stickers with one participant offline. Confirm sender labels, stored/delivered state, durable restart, independent direct chats and Leave/Decline. A non-member's authenticated friend identity must not be accepted as a group sender. Current limits are five groups, eight members, ten pairwise sessions and 500 raw history rows shared across direct chats and group fanout; storage work remains necessary before larger groups/history.
