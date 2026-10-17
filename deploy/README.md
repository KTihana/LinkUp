# Tiho mailbox and call relay

This prepares a small Linux deployment for encrypted offline messages and WebRTC calls. It has not been deployed or validated against a public domain. No hosting purchase or DNS change has been made.

## Requirements

- A Linux server with Docker Compose and a public IPv4 address, plus two DNS names pointing to it (for example `mailbox.example.org` and `turn.example.org`).
- Open inbound TCP 80/443 for automatic mailbox HTTPS; TCP 5349 and UDP 49160–49200 for TURN/TLS and relayed encrypted media. Restrictive networks may require TURN/TLS on a dedicated public IP's port 443.
- A valid, automatically renewed TLS certificate for the TURN hostname. After preparation, install its complete certificate chain as `deploy/.private/certificates/fullchain.pem` and its private key as `deploy/.private/certificates/privkey.pem`. Keep both parent directories at mode `0700` and the two files at `0444`: the private parents protect host access while individual read-only mounts let coturn's unprivileged container user read them. These files and generated secrets are ignored by Git and excluded from distributable source archives. Replace the files and recreate the TURN container after certificate renewal so it receives the new bind mounts.

## Prepare and start

From the repository root, substituting the real hostnames and public address:

```sh
node deploy/prepare.mjs mailbox.example.org turn.example.org 203.0.113.20
# Install the real TURN certificate and key at the paths above before continuing.
cd deploy
docker compose config --quiet
docker compose up -d --build
```

The example IP is documentation-only; use the actual server address. The optional fourth argument to `prepare.mjs` is the exact HTTPS origin of a deployed web client. Without it, browser origins are denied; native Android clients still authenticate using signed requests. Never commit `.private`, `.env`, or certificates. Preparation refuses to overwrite existing secrets. Keep a private operator backup. Missing certificate files cause startup to fail; Compose must not create empty directories in their place.

Enter `https://mailbox.example.org` in Tiho's Connection settings on each phone. The client obtains temporary TURN credentials through an identity-signed request. The long-term TURN authentication secret stays on the server. A TURN relay forwards DTLS-SRTP media and cannot decrypt the peer-to-peer call; call descriptions and certificate fingerprints travel inside the encrypted messaging channel.

## Validate before sharing

1. Confirm HTTPS health returns `{"ok":true,"version":1}` with a device-trusted certificate.
2. Use two test phones on different networks: exchange invitations, send each direction, force-close/reopen the recipient and confirm queued delivery.
3. Place and accept voice/video calls, verify two-way audio, mute, speaker, camera controls, decline, hangup, denied permissions, and disconnect cleanup.
4. Force a relayed connection using a test configuration and confirm media flows through TURN. Repeat with one phone on cellular, then a VPN. Do not infer TURN success from a same-Wi-Fi test.
5. Test certificate renewal, service restart, disk-full handling, and restoration from the ciphertext snapshot backup.

The mailbox snapshots are durable, bounded, and contain encrypted envelopes plus routing metadata. Do not copy or delete a live writer lock; stop the mailbox before snapshot restoration. Caddy access logging is not enabled. TURN packet/user logging is disabled. Docker/host logs still require an operator retention policy. Default quotas are for a small community; monitor capacity before expanding.

Calls currently require both apps open; background ringing and Android telecom integration are still readiness gates. The current MLS adapter remains experimental and unaudited. Deployment does not establish production security.

Pinned service tags were checked against the upstream releases on 2026-10-15: [Caddy 2.11.7](https://github.com/caddyserver/caddy/releases/tag/v2.11.7) and [coturn 4.18.0-r0](https://github.com/coturn/coturn/releases/tag/docker/4.18.0-r0). Node uses the maintained 24-alpine image. Pin tested image digests in an actual deployment and review upstream security updates.

## Enable Android notifications

After preparing the private configuration, add `PUSH_ORIGINS=https://ntfy.sh` (or the exact public HTTPS origins of the UnifiedPush services you operate/support) to `.private/mailbox.env`, then rebuild/recreate the mailbox container. Optional VAPID settings are documented in `../relay/README.md`. The Dockerfile now installs the locked server dependencies and includes `push.mjs`.

The phone needs its own configured UnifiedPush distributor plus LinkUp's explicit background-key opt-in. Use the steps and checks in `../app/NOTIFICATIONS.md`. This repository has not deployed a public mailbox, configured a real phone's distributor or verified Doze/battery behavior. Calls still require the app open.
