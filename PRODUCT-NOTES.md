# P2P messenger — product direction

App name: **LinkUp** (renamed from Tiho on October 15, 2026). The selected identity is the interlocking-conversations mark, rebuilt as vector artwork in `app/assets/brand/`.

## Mobile design — October 13, 2026
- Deliver both a phone app and a website companion.
- Use a familiar modern chatting interface; keep technical P2P terminology out of the main flows.
- Mobile concept: soft violet accent, neutral surfaces, rounded bubbles, bottom navigation, sticker drawer, QR invitation screen.
- Figma: https://www.figma.com/design/W0hKVemGYe2SUMKpuxgpbA?node-id=1-854
- Four editable visual screens: Chats, Conversation, Stickers, Add a friend. Buttons are not wired; QR is a visual placeholder.
- Imported as editable text/vector groups through the Figma editor after the Starter-plan MCP quota blocked API editing. No reusable component library or auto-layout system has been created yet.

## Appearance and artwork update
- Appearance lives on the profile: Light/Dark, with accent/text color wheels and hex entry. Choices now save inside the encrypted vault; preview choices remain ephemeral. Rose was removed.
- Remove helper explanations under Display name and About.
- Bundle licensed Twemoji picker artwork and original Figma cat stickers. Figma artwork sheet: https://www.figma.com/design/W0hKVemGYe2SUMKpuxgpbA?node-id=5-2

## Confirmed preferences
- Confirmed audience: friends and anyone who wants to use it. Android first, iPhone next, web available. Full requested feature scope includes voice notes, voice calls, and video calls.
- Use QR/invite links only for discovery. Online presence is opt-in and defaults off. Keep the approved violet Figma styling.
- Default encrypted offline mailbox with self-hosted/configurable alternatives; one identity across devices. Recovery key remains a provisional assumption.
- Editable display names and user-uploaded profile photos. Display name changes must not change the cryptographic identity or contacts.
- Profile design added in Figma: https://www.figma.com/design/W0hKVemGYe2SUMKpuxgpbA?node-id=1-1280 . Includes Your profile, Edit profile, and Change photo. Illustrated avatar is a placeholder; upload is a design concept.
- Planned photo flow: upload or take a photo, crop to a square/circular preview, save or remove. Strip image location metadata and re-encode images; restrict size and formats. Default to sharing profiles with accepted contacts. Optional About field is a design proposal.
- A modern website, built as free software with a documented open protocol.
- Flexible offline delivery through optional user-selected encrypted mailboxes.
- End-to-end encryption for messages, attachments, stickers, and synchronized private data; encrypted local storage and backups; HTTPS for web delivery.
- Contact invitations using QR codes; invitations contain public identity/invitation data, never private keys.
- Basic emoji support and user-imported sticker packs.

## Offline delivery proposal
Prefer direct connections when possible. If a recipient is unavailable, queue locally and optionally store ciphertext at one or more selected mailboxes. Allow home-hosted and community-operated mailboxes with quotas, expiry, acknowledgements, duplicate detection, and retries. Mailbox storage confirmation is distinct from recipient delivery. Prevent a mailbox from silently changing contact keys. Delivery depends on an available mailbox and a later recipient connection; a closed browser cannot be relied on as an always-on peer.

## Security direction
Use established messaging cryptography with forward secrecy and authenticated device keys; do not invent a cipher. Separate message encryption from transport encryption. Minimize routing metadata; do not claim that encryption hides IP addresses, timing, or message sizes. Address script injection, malicious dependencies, compromised web updates, device compromise, and mailbox abuse. Use a strict Content Security Policy, safe text rendering, restricted media formats, dependency review, and independent security testing before production. A website serving malicious client code can defeat end-to-end encryption, so reviewable releases and optional independently installed clients should be explored.

October 13 confirmation: the project operates from Croatia. Lawful operation and no intentional backdoors are requirements. No master decryption key, key escrow, hidden recovery account or silent encryption downgrade. Public operation requires Croatian/EU legal classification, including Article 52 operator obligations and relevant HAKOM notification rules; current research is not legal clearance. See `app/SECURITY.md` for sources and unresolved questions. Strong security is a review/testing objective; never promise impossible-to-crack software.

The library review selects OpenMLS 0.9.1 as the preferred migration candidate after checking the recent recursion advisory and verifying the published archive. It is not integrated; native/browser bindings, provider/storage handling and epoch/fork tests come next. `LEGAL-BRIEF.md` records the technical facts and model-specific questions for Croatian counsel, including Article 52(13) on paid/unpaid service provision. No lawyer or regulator has been contacted.

Sticker packs should contain passive media only, with size/dimension limits and licensing metadata. Avoid executable HTML/SVG sticker content and third-party tracking URLs.

## Confirmed direction: VPN and nearby communication — October 13, 2026

- Support Common running through the user's existing system VPN. Preserve application end-to-end encryption and HTTPS. Test routing, reconnects, split tunnels and VPNs that block local-network access. VPN compatibility has not yet been tested on phones.
- Optional private networks across the internet can use an existing WireGuard-based VPN. A self-hosted mesh control service such as Headscale is an option to investigate; no particular provider or proprietary account should be mandatory. A VPN needs an underlying network path; it does not create offline radio connectivity.
- Add native **Nearby** messaging without internet. Start with two phones on the same Wi-Fi or a temporary Android-created local hotspot. Offer Create nearby network / Join nearby network, with QR-based connection details and authenticated friend acceptance. Wi-Fi Direct is a later Android-to-Android adapter.
- **Bluetooth is a requested feature**, beginning with foreground, one-to-one BLE text/emoji/bundled-sticker messages. Larger media should prefer Wi-Fi. Native central and peripheral/GATT support, device capability checks, permissions and Android/iPhone interoperability must be tested; background/closed-app reception is not promised.
- Nearby discovery is opt-in and advertises temporary session identifiers, never a public list of names or permanent friend keys. Use QR/invite verification before accepting a peer. Proposed connection choices are Automatic and Nearby only; Nearby only must prevent internet/mailbox fallback.
- Reuse encrypted history, durable queues, exact ciphertext retries and authenticated receipts across connections. First contact must also work without a mailbox: exchange authenticated public MLS packages and Welcomes locally. Out-of-range messages remain queued until a usable connection returns. Multi-hop forwarding is a separate future feature requiring consent and abuse controls.
- These are native-app features first. The web companion retains internet/VPN networking; Web Bluetooth's limited peripheral-client API cannot provide general browser-to-browser nearby chat. Android Wi-Fi/hotspot and Bluetooth source adapters are now integrated experimentally; full native build/phone QA and VPN routing tests remain outstanding.

Primary references: [WireGuard](https://www.wireguard.com/), [Headscale](https://headscale.net/stable/), [Android local-only hotspot](https://developer.android.com/develop/connectivity/wifi/localonlyhotspot), [Android BLE](https://developer.android.com/develop/connectivity/bluetooth/ble/ble-overview), [Web Bluetooth](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API).

## Integrated private network — October 16, 2026

Status: **Android prototype implemented; server and two-phone verification pending**. The self-hosted generator and setup are in `deploy/vpn`. Calls are intentionally disabled in private-network mode until media routing is verified. The design rationale below describes implemented boundaries and remaining topology work. The user confirmed **LinkUp traffic and private friend networks** on October 16. Whole-phone internet routing is outside this scope. The existing encrypted messaging protocol remains mandatory inside any VPN. Bluetooth continues as its own local message transport; a VPN still needs an underlying IP connection.

Use the official [WireGuard Android tunnel library](https://www.wireguard.com/embedding/) (`com.wireguard.android:tunnel`) behind a native Expo module. Preserve LinkUp's interface and self-hosting choices without designing a new VPN cipher. Upstream publishes the tunnel library as Apache-2.0; inspect the exact pinned artifact and all bundled native components/notices before distribution ([upstream build declaration](https://git.zx2c4.com/wireguard-android/tree/tunnel/build.gradle.kts)). The Android Java backend is pinned to 1.0.20260102. Its older bundled Go engine is replaced by a separately pinned, rebuilt native engine; see `app/legal/wireguard` for exact provenance.

### First feasible prototype

Use a self-hosted WireGuard hub with a reachable UDP endpoint. Each phone receives a separate tunnel identity and narrowly scoped private address. The hub forwards only between explicitly authorized friends, with default-deny forwarding and no internet exit/NAT service. This solves reachability for a first prototype without pretending that every phone can accept an unsolicited internet connection.

This topology terminates each VPN tunnel at the hub. Its operator can inspect inner IP packets and routing metadata; MLS and authenticated DTLS-SRTP must still protect messages and calls between phones. It is a private network with a server, not direct P2P or anonymity. The current HTTPS mailbox remains the offline store; the tunnel cannot deliver to a phone with no working network or power. No server is provisioned here.

For direct phone-to-phone tunnels later, add authenticated endpoint rendezvous, NAT traversal, network-change handling and a relay carrying opaque end-to-end WireGuard packets when direct UDP fails. A normal WireGuard forwarding hub is not that opaque relay. Evaluate existing maintained overlay components before implementing a custom coordination/relay protocol. Persistent keepalive can preserve a NAT mapping; it cannot make all NAT combinations reachable. Enable it only when needed and measure battery cost ([WireGuard guidance](https://www.wireguard.com/quickstart/)).

### Integration boundaries

1. **Android service:** wrap the upstream `GoBackend` through a small native module and configuration plugin. Obtain Android's VPN consent, show foreground status, support Stop and revoke, and tear down on account reset. Android permits one active VPN per user/profile; starting ours replaces an existing VPN. Keep the current system-VPN option available and explain that conflict before activation. Per-app routing can include only LinkUp ([Android VPN documentation](https://developer.android.com/develop/connectivity/vpn)).
2. **Keys and admission:** generate independent WireGuard keys; never convert/reuse the account seed, vault key or MLS key. Store them encrypted with a separate Keystore wrapping key; WireGuard still needs private key material in native process memory while running. Bind each public tunnel key/address/expiry to the accepted LinkUp identity using a reviewed, domain-separated signed enrollment record. A control server must not silently substitute friends, keys or routes. Removal/reset revokes peer access and rotates affected credentials. Never export private keys in QR codes, logs or JS status events.
3. **Routing:** generate configuration locally from approved peers, accepting only exact assigned peer addresses (`/32` or `/128`) in a non-conflicting private range. Reject default routes, arbitrary imported DNS settings and peers' requests to access other LANs. Scope listeners/firewall rules to the intended app protocol. The upstream backend supports included applications and routes, but its split-route configuration is not a universal kill switch ([GoBackend source](https://git.zx2c4.com/wireguard-android/tree/tunnel/src/main/java/com/wireguard/android/backend/GoBackend.java)).
4. **App transport:** implement a separate adapter alongside `deliveryTransport.ts`; preserve identity verification, MLS, ciphertext retry/dedup and receipts. Do not equate tunnel-up with authenticated friend delivery. A “Private network required” mode must pause/queue on tunnel loss and disable mailbox, public ICE and direct-route fallback. Ordinary update/coordination traffic outside those routes must be disclosed; split routing does not protect all LinkUp network activity.
5. **Calls:** extend `CallNetwork` with an explicit route policy. For the private network mode, advertise and accept only assigned overlay addresses and verify actual media routing. VPN detection alone does not establish this. When hiding a peer's IP is the goal, use a separately tested relay-only call option; direct connections reveal network metadata ([RFC 8828](https://www.rfc-editor.org/rfc/rfc8828.html)).

### Gates before shipping

First complete the messaging security work in `app/SECURITY.md`: reviewed epoch evolution, recipient authorization and device-key boundaries. Then prototype tunnel lifecycle with disposable identities and a private test server. Validate two physical phones across Wi-Fi/cellular, CGNAT, IPv4/IPv6, blocked UDP, sleep/reboot, service revocation and conflicting VPNs. Capture test traffic to prove no protected payload/ICE/DNS fallback after tunnel loss; test malicious route/key substitutions and revoked friends. Check battery/MTU behavior, upgrade/deletion, dependency licences and independent security review. A web page cannot host Android's VPN service; web can use an OS VPN. A future iPhone implementation needs a separate native integration and platform review.

## Interface concepts
- Quiet: a spacious, familiar messenger with a conversation sidebar.
- Commons: community navigation, channels, and a conversation area.
- Pocket: a focused mobile-first chat with compact contact navigation.

Current prototypes simulate interactions only. They do not implement networking, encryption, real invitations, or persistent message storage.

## Custom color update
- Removed Rose; Light and Dark remain.
- Replace preset accent/text palettes with a color wheel, brightness control, and hex entry. Apply/cancel choices; preserve them locally.
- Migrate old appearance choices, including Rose → Light.
- Adapt foreground colors for readability while keeping the chosen raw colors saved.

## Local vault foundation
- Added optional encrypted profile/presence storage and stable Ed25519 identity under You → Local vault.
- A random user-held vault key unlocks browser records; Android uses protected device key storage. No passwords or network identities are registered with a service.
- Profile photo output is bounded and stored inside the encrypted record.
- This is development storage functionality; messaging, device pairing, portable recovery backups and security review are still pending.

## Implemented invitation foundation — October 13, 2026

- Signed seven-day QR and link invitations, with public name/identity only.
- Paste/scan, review the full identity code, then explicitly add a friend.
- Saved contacts live in the encrypted local vault; no public directory or search.
- Incoming invitations can be reviewed before setting up the local identity.
- Adding a friend is local; two-device messaging and mutual acceptance still need implementation.

## Experimental messaging and offline delivery — October 13, 2026

- Real accepted contacts open encrypted text/emoji/bundled-sticker chats; preview sample chats remain separate.
- The profile's Connection screen enables a user-chosen encrypted mailbox, manual message checks and pausing delivery.
- Queued = encrypted local save; Stored = ciphertext accepted by mailbox; Delivered = authenticated peer-app receipt.
- The first self-hostable Node relay persists opaque envelopes across downtime/restart and handles signed one-use key packages. No hosted default community mailbox has been deployed yet.
- Send saves without waiting for a network poll; failures preserve queued data/ciphertext and avoid duplicate history. Unknown senders do not create friends. Missing keys/full mailboxes for one friend do not block other conversations or incoming messages.
- First setup has a bounded key-package expiry. Explicit Reconnect on both devices recovers expired or simultaneous setup, preserving visible history and cancelling old queued jobs. One person sends first after recovery.
- MLS is the chosen standard for the development spike. Its TypeScript implementation and this integration are unaudited. Direct P2P, phone execution, epoch updates, files/photos/custom sticker delivery, push/background delivery, device sync and independent review remain future milestones.
- Android requires a development build for native crypto; its APK profile is configured, but no native build or physical-device test has run.

## Experimental nearby implementation — October 13, 2026

- Connection now includes Automatic/Nearby only, same-Wi-Fi hosting, local-hotspot creation, signed QR review/join and BLE discovery/join. Nearby controls are gated to the Android development build and accepted friends.
- The nearby delivery service starts MLS conversations without a mailbox, keeps its inbox and one-use public package claims in the encrypted vault, confirms durable storage and shares receipts/dedup with mailbox delivery. Switching to Nearby only aborts outstanding mailbox requests; stopping Nearby preserves that preference.
- Native Wi-Fi uses exact per-session TLS certificate pinning; BLE provides bounded fragment/reassembly, write/indication backpressure and lifecycle cleanup. Application encryption and signed peer responses apply to both. Nearby QR codes can carry temporary hotspot credentials, but no identity or TLS private keys.
- Foreground sessions end after ten minutes or on background/Lock/Stop. Wi-Fi idle closure has a manual reconnect path. Nearby-only means no Common mailbox fallback; operating-system/VPN network traffic is outside that guarantee.
- The packet-channel demo passes with actual encrypted vaults and zero HTTP calls. SDK36 helper compilation and ten native framing/address tests pass; full Expo wrapper/Gradle/APK and two-phone radio/VPN testing remain unfinished after the local build hit a disk-space limit. iPhone nearby, Wi-Fi Direct and multi-hop forwarding are future work.

## October 15 — LinkUp unlock convenience

- Added optional phone fingerprint/face unlock backed by authenticated native storage. Recovery keys remain random and unchanged; biometric enrollment is off by default and enabled from Local vault after unlocking. No automatic background unlock or plaintext key cache is introduced.
- A shorter numeric PIN is not used as the vault encryption key. A future browser/device passphrase option should wrap the existing random key with a reviewed memory-hard derivation and a clear recovery story; it is not implemented in this revision.
- Physical biometric prompts, enrollment changes, OS lockout and recovery still need phone testing.

## 16 October 2026 — new-account policy and Quiet redesign

Starting a new account must delete previous LinkUp data from the phone, including old archives; no automatic archive is retained. Show an irreversible-deletion warning in the app. Resume interrupted cleanup before new setup. Keep the app-specific six-digit PIN rather than using the existing phone PIN. Fix the native cleanup rejection that prevented signup. The new visual direction uses neutral surfaces, a blue accent, clearer chat hierarchy, compact navigation, less card decoration and matching light/dark screens. Preserve custom colors when upgrading an existing account.
