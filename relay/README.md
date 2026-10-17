# LinkUp mailbox relay

A small, self-hostable GPL-3.0-only service for holding **opaque encrypted messages** until the recipient connects. Node.js 22 or newer; run `npm ci --ignore-scripts` before starting. The pinned `web-push` dependency handles optional encrypted wakeups. This service does not decrypt chat messages, establish a secure messaging session, provide direct P2P connections, or search for users. Clients must implement and validate their messaging protocol themselves.

From this directory:

```sh
npm test
npm start
```

Defaults: `127.0.0.1:8787`, data in `./data`, browser origins `http://127.0.0.1:8081` and `http://localhost:8081`. `HOST`, `PORT`, `DATA_DIR`, and comma-separated `ALLOWED_ORIGINS` override these. An empty `ALLOWED_ORIGINS` permits no browser origins. Native clients have no Origin header and still need signed authentication.

Binding to another address requires `ALLOW_PUBLIC_BIND=true`. That switch only permits the binding; it does not make the prototype suitable for the internet. Use an HTTPS reverse proxy, upstream abuse controls, monitored storage, and a protocol/integration review before public deployment. This server ignores forwarded IP headers; limits behind a proxy apply to the proxy's source address. The included rate limits are intended for a small development deployment.

For testing physical phones on a trusted local network, put the relay behind an HTTPS reverse proxy with a certificate trusted by those devices. Use development identities and point the apps to that HTTPS address, rather than their own `127.0.0.1`. The client permits plain HTTP only for literal loopback development addresses. Bind the relay to loopback behind the proxy when they share a computer; another bind address requires explicit `ALLOW_PUBLIC_BIND=true`.

## Signed HTTP API

`GET /health` returns `{ "ok": true, "version": 1 }` when the store is available. Every other endpoint uses POST with `Content-Type: application/json`. Errors have a non-2xx status and `{ "error": "code" }`; clients must not treat a failed response as a delivery acknowledgement. JSON timestamps are integer milliseconds since the Unix epoch. Public keys are 32-byte Ed25519 keys in lowercase hex; signatures are 64-byte Ed25519 signatures in lowercase hex; IDs are 16 random bytes in lowercase hex.

Obtain a challenge with:

```json
{ "publicKey": "64 lowercase hex characters", "action": "receive" }
```

`POST /v1/challenge` returns `{ "challenge": "48 hex characters", "expiresAt": 123 }`. Valid actions: `publish`, `receive`, `ack`, `keys-publish`, `keys-claim`, `keys-status`, `keys-retire`, `admission-set`, `wait`, `call-config`, `push-config`, `push-register`, `push-unregister`. A challenge expires after 30 seconds, is bound to that key and action, and is consumed on its first authentication attempt. Challenges are held in memory and disappear on restart.

An authenticated `POST /v1/{action}` has this shape:

```json
{
  "publicKey": "64 lowercase hex characters",
  "challenge": "48 lowercase hex characters",
  "signature": "128 lowercase hex characters",
  "payload": "{\"limit\":10}"
}
```

`payload` is the **exact JSON string** signed by the client. Sign these UTF-8 bytes with Ed25519 (without any extra external prehash):

```text
common/mailbox-request/v1\n{path}\n{challenge}\n{sha256(payload) as lowercase hex}
```

Here `\n` means a newline, and `{path}` is exactly `/v1/` followed by the requested action from the list above. The exported `requestBytes`, `envelopeBytes`, and `packageBytes` in `protocol.mjs` are executable framing references. Requests contain neither private keys nor plaintext message contents. This framing authenticates requests; the messaging protocol must provide message encryption separately.

### Recipient-controlled admission

The relay denies publication to a recipient and consumption of their public key packages until that recipient has explicitly authorized the caller. Authentication as an arbitrary new identity is insufficient. The same check happens before duplicate publication handling, key-package lookup, and destructive key-package consumption.

Admission-set payload: `{ "peers": ["accepted friend public key", "…"], "revision": 1 }`. Only the authenticated owner can set its own list; no owner selector is accepted. The list is a complete replacement, sorted lexicographically, contains at most 100 distinct 64-character lowercase hex public keys, and excludes the owner. An empty list revokes everyone. The positive safe-integer revision must increase when the list changes. An identical list/revision retry is idempotent; older revisions and conflicting contents at the same revision return 409. After durable storage the response is `{ "accepted": true, "revision": 1 }`.

Clients must allocate revisions durably inside the same encrypted-vault transaction that tracks the contact list. All foreground and background workers share that sequence. This prevents delayed requests from overwriting newer revocations. Sync permissions before mailbox messaging, and confirm revocation on the server before representing it as completed. Restoring an older vault may require explicit permission-state recovery; do not silently overwrite a 409 with an unreviewed old list. A relay that lacks this action is incompatible and must not receive a fallback that bypasses permission synchronization.

Removing a peer atomically tombstones their pending ciphertext and stops its retrieval. Previously retrieved ciphertext cannot be recalled. Tombstones remain until the original expiry, so reaccepting the same peer or retrying the old envelope cannot resurrect revoked mail. Both people must accept each other and connect once before the normal two-way messaging flow works. Later offline delivery uses those stored grants.

This authorization protects honest relay storage and recipient queues from strangers. It does not hide accepted-friend relationships from the relay: permission public keys are additional routing metadata stored with the snapshot. An authorized malicious friend can still misuse its own permission within configured quotas. Relay operators can still drop messages or ignore permissions; clients continue verifying identities, accepted contacts, signatures and encryption independently.

### Envelopes

Publish payload: `{ "envelope": { "version": 1, "id": "…", "sender": "…", "recipient": "…", "createdAt": 123, "expiresAt": 456, "ciphertext": "canonical padded base64", "signature": "…" } }`.

The publisher must authenticate as `sender`. The envelope signature is over UTF-8 `common/mailbox-envelope/v1\n` followed by `JSON.stringify([1,id,sender,recipient,createdAt,expiresAt,ciphertext])`. The envelope signature travels with the ciphertext so recipients can independently verify it. Ciphertext is opaque, non-empty, and at most 64 KiB after base64 decoding. Expiry must be in the future, at most seven days after creation; creation may be at most 60 seconds ahead of the relay clock. Sender and recipient must differ.

Publish returns `{ "accepted": true, "duplicate": false }` after a durable write. Repeating the same sender/ID/content returns `duplicate: true`; changing signed contents under the same sender/ID returns 409. Relay acceptance means stored for retrieval, not read by the recipient.

Receive payload: `{ "limit": 10 }`, where limit is 1–50. Returns `{ "envelopes": [ ... ] }` for the authenticated recipient only. Fetching does not delete anything. Clients must verify, decrypt, and durably save messages **before** acknowledgement.

Ack payload: `{ "messages": [{ "sender": "64 hex characters", "id": "32 hex characters" }] }`, with 1–50 distinct sender/ID pairs. Returns `{ "acknowledged": 2 }`. Only those exact messages addressed to the authenticated key are removed; two senders choosing the same ID cannot acknowledge each other's envelopes. Client deduplication should bind sender, recipient and ID together. Acknowledged records retain bounded deduplication tombstones until the original expiry so retrying a sent envelope does not resurrect it.

### Public key packages

These are optional **public protocol setup material** for starting sessions while a contact is offline. They must never contain secret prekeys or identity seeds.

Keys-publish payload: `{ "packages": [{ "id": "…", "owner": "…", "createdAt": 123, "expiresAt": 456, "data": "protocol public material", "signature": "…" }] }`. Batches contain 1–10 distinct package IDs. The authenticated key must equal every owner. Each package signs UTF-8 `common/key-package/v1\n` followed by `JSON.stringify([1,id,owner,createdAt,expiresAt,data])`. `data` is a non-empty string of at most 16 KiB in UTF-8. The same creation/expiry rules apply. Returns `{ "added": 2 }`; repeated packages do not become claimable again.

Keys-claim payload: `{ "owner": "known contact public key" }`. An authenticated identity different from the owner, and present in that owner's admission list, receives `{ "package": { ... } }` or `{ "package": null }`. Other callers receive 403 without inspecting or consuming the pool. The claim is durably consumed before responding, and concurrent authorized claimants cannot receive the same package. A lost response may waste a public package; clients should replenish their packages. Validate owner, package signature, expiry, and the protocol's public material before using a returned package.

Keys-status payload: `{}`. Returns `{ "available": [ "32 hex characters", "…" ] }` listing only the authenticated owner's unexpired, unclaimed public package IDs (at most 100). No owner selector or extra fields are accepted. The result is serialized with claims and publications; it exposes no other owner's packages or private material. Clients can replenish their available public pool while retaining already claimed private packages until their valid Welcome window ends.

Keys-retire payload: `{ "ids": ["32 hex characters", "…"] }`, with 1–100 distinct IDs. It retires only the authenticated owner's matching, still-available public packages, returning `{ "retired": 2 }` after durable storage. Other owners' IDs and already retired/claimed IDs are unchanged. Tombstones keep the original fingerprint and expiry, preventing a delayed publication from reviving deprecated material. Clients use this when upgrading their setup protocol and retain local private material until outstanding old Welcomes expire. The server never receives or deletes private keys.

### Mail arrival and call relay credentials

Wait payload: `{}`. Returns `{ "ready": true }` when ciphertext is already waiting or arrives for the authenticated owner; `{ "ready": false }` after 20 seconds or during graceful shutdown. It never consumes messages. One pending wait is allowed per owner, at most 64 globally. A wait releases the short-request quota and does not hold the storage serializer. Clients reconnect with backoff on failure and perform normal signed receive/ack operations when awakened.

Call-config payload: `{}`. Returns `{ "expiresAt": 123, "iceServers": [...] }`. With `TURN_URLS` and `TURN_SECRET` configured, it issues coturn REST credentials expiring in 10 minutes, using a random username unrelated to the identity. The shared server secret never leaves the server. Each identity may request once per 10 seconds; source/global request limits also apply. Without TURN configured, the list is empty and expires after one minute. Clients may try a direct connection, but internet call reliability requires a tested TURN deployment. Calls use encrypted MLS signaling and peer-to-peer DTLS-SRTP media. See [deployment setup](../deploy/README.md).

## Persistence and limits

Only a single process may own a data directory. The service creates a `writer.lock`; a stale lock after an unclean shutdown must be removed by the operator **after checking that no writer remains**. Corrupt, oversized, or symlinked snapshots fail startup rather than reset data. Client-supplied IDs never become filesystem paths.

Each successful mutation writes a new 0600 snapshot, syncs its contents, atomically renames it to `mailbox-v1.json`, and syncs the containing directory. The filename is retained for upgrades; its current internal schema is version 2. A failed write never reports success; a failed filesystem sync stops further writes. This implementation targets local POSIX filesystems supporting directory fsync, such as the macOS/Linux development machines used here. It is not a distributed database. The parent data directory is set to 0700. Back up the snapshot using normal filesystem backup tools while the server is stopped. The snapshot contains public identities, admission relationships, timing, sizes, signatures, public packages and ciphertext; disk encryption remains an operator concern.

**Upgrade behavior:** version-1 snapshots have no proof of recipient permission. On first startup they migrate durably to version 2 with empty admission lists. Existing queued envelopes become tombstones and will not be delivered, even after permission synchronization; old ciphertext is not grandfathered in. Already claimed package tombstones remain spent, while unclaimed packages remain available once the owner grants permission. Clients must synchronize accepted friends again. Back up before upgrading and communicate this pending-message migration to testers. Downgrading to the old server is unsupported.

Defaults: 32 MiB total snapshot, 10,000 unexpired envelope records including tombstones, 10,000 public package records including claimed tombstones, 256 pending envelopes per sender and recipient, 100 unclaimed packages per owner, and 1,024 admission owners with at most 100 peers each. Admission revisions, including empty lists, do not expire: retaining them prevents stale grants from returning. Expired envelopes and packages become inaccessible immediately, and are pruned during operations, startup, and a 60-second sweep. No unlimited envelope/package tombstone history remains. Crash leftovers named `.snapshot-{32 hex characters}.tmp` can be removed while the server is stopped; filesystem quotas are recommended for deployment.

HTTP limits: 256 KiB body, 192 KiB signed payload, 8 KiB headers, 128 connections, 16 active short responses plus 64 waits, bounded challenge/rate maps, 15-second body/socket and 10-second header timeouts (an authenticated wait gets 25 seconds). Default rates are 180 requests per source address and 2,400 globally per minute. The challenge pool is bounded globally, not by the unauthenticated public key in a challenge request: an attacker must not be able to reserve a victim's identity-specific quota. Public identities can still be generated cheaply: recipient admission prevents stranger access to a specific mailbox but does not solve global registration/storage exhaustion or prevent a malicious relay from dropping messages. Public deployment still needs operator admission and upstream abuse controls.

## Validation

`npm test` exercises real HTTP signatures, replay and domain binding, offline persistence/restart, sender and recipient authorization, stranger claim/publication rejection, revisioned revocation, delayed grant rejection, safe legacy migration, failed durable revocation, TTL, retries, quota failures, public package ownership/claim concurrency/restart and owner-only status, input limits, origins, corruption and writer exclusion. The service has not received an independent security audit.

Implementation references: [Node crypto](https://nodejs.org/api/crypto.html), [Node HTTP](https://nodejs.org/api/http.html), and [Node filesystem](https://nodejs.org/api/fs.html).

## Optional UnifiedPush / Web Push wakeups

Push is disabled by default. An operator can permit specific provider origins in its private environment file:

```dotenv
PUSH_ORIGINS=https://ntfy.sh
```

Use the exact HTTPS origins of the distributors you support, with port 443. Never use wildcard origins. Destination DNS is checked at connection time and rejects private/reserved IPs; redirects are not followed. A self-hosted distributor must have a publicly routable HTTPS endpoint. Provider registration sends capability URLs and Web Push public/auth keys to this mailbox; protect its storage and backups as private metadata. Provider keys do not decrypt MLS chats.

For a provider requiring VAPID, generate keys locally with the pinned `web-push` package and configure `PUSH_VAPID_PUBLIC_KEY`, `PUSH_VAPID_PRIVATE_KEY` and `PUSH_VAPID_SUBJECT` (a real `mailto:` or HTTPS contact). Keep the private key in the operator's private env file. The signed `push-config` API exposes only the public key and allowed origins to clients. Do not put secrets in the app or a source archive.

The identity-signed APIs are:

- `push-config`, payload `{}` → `{enabled, origins, publicKey}`.
- `push-register`, payload `{subscription:{endpoint,keys:{p256dh,auth}}}` → `{registered:true,expiresAt}`. The authenticated identity owns exactly one subscription, renewed for 30 days.
- `push-unregister`, payload `{}` → `{removed:true}`. It removes only that identity's registration.

A successful mailbox publish durably marks a registered recipient for wakeup. The dispatcher encrypts a content-free `mailbox-wake` hint using RFC 8291 Web Push. It coalesces rapid publishes, bounds concurrency, retries failures with backoff and removes 404/410 endpoints. A revision prevents mail arriving during an in-flight push from losing its next wakeup. Startup recovers pending ciphertext/subscription wakeups. A successful provider response means the wakeup was accepted by that provider; it does not mean the phone received or read a chat.

Group messages use the same opaque pairwise envelopes. Group names, rosters and text are inside MLS application messages; the mailbox sees their individual routing recipients and timing. See `app/NOTIFICATIONS.md` in the source tree for the Android opt-in/security model and real-device checks.
