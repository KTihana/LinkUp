# Account access — LinkUp 0.2.4

Android 8+ uses an app-specific six-digit LinkUp PIN, with a masked number-pad popup, confirmation, backspace and cancel. It never uses the phone’s existing screen-lock PIN for normal PIN setup/unlock. You → App lock can change it while the account is open. Optional 12–256-character passwords remain available, and web/older Android use that longer-password flow. Existing phone/biometric/key methods still open their original accounts during migration.

## Starting a new account deletes the old data

Create a new account → Delete data and continue permanently removes the previous LinkUp profile, conversations, contacts, encryption/session state, password/PIN/phone-unlock records, notification keys and pending replies, appearance/settings, private image/download caches, and old local account archives. There is no automatic archive or archive restore. The new identity has a new friend code and starts as Anon. The app shows the deletion warning before the action.

Fresh signup also cleans archives and other residue left by earlier failed signup attempts, even when there is no active vault. Account creation validates the proposed credential before that cleanup, and still saves a usable new unlock method before committing the new encrypted vault. It never overwrites a currently active vault.

Deletion intent is stored and verified before cleanup begins. An interrupted deletion resumes on startup; an incomplete cleanup blocks access/new setup until it finishes. Background signing is revoked before an explicit account reset takes the shared vault write lock. Background transactions also check durable deletion intent before opening the vault or issuing a signer, covering restarted jobs with stale native permission. Data and protected key references are removed rather than preserved under another name. Cleanup does not ask for the forgotten account’s PIN or phone credential.

Deletion concerns LinkUp’s own local data. It does not remove originals from the gallery, files exported outside LinkUp, or copies on other people’s devices. Flash storage/OS backups and malicious or rooted devices prevent promising forensic overwriting. The app does not erase another person’s messages remotely.

## Native cleanup fix

0.2.3’s LinkUpPhoneUnlock.disable lambda returned a KeyStore object, causing Expo to reject its result before PIN/password signup could proceed. 0.2.4 uses an explicitly Unit-returning completion wrapper; both disable and full-erasure methods return no Android objects to JavaScript. A JVM regression test executes a cleanup returning a KeyStore and verifies the public completion result is Unit; cleanup errors still propagate.

## Cryptographic limits

The random 256-bit vault key and XChaCha20-Poly1305 format are unchanged. Android PIN protection combines a non-exportable per-setup Keystore HMAC-SHA256 key with the PIN, derives a wrapping key with PBKDF2-HMAC-SHA256 (600,000 iterations, independent 128-bit salt), and wraps the vault key with AES-256-GCM (random 96-bit nonce and an authenticated domain). PIN changes preserve the account identity and conversation ciphertext.

Native code persists an attempt reservation before decrypting. Five wrong/interrupted attempts cause a 30-second delay; further failures double it up to one hour. Correct entry resets the counter. Monotonic time/boot count prevent bypass by changing the wall clock, and reboot retains the applicable penalty from boot. No messages are deleted after wrong guesses.

These retry limits are software enforcement, not hardware anti-rollback. Keystore hardware backing varies. Root/OS/app compromise and private-state rollback can bypass app-enforced limits. A short PIN does not offer the same independent offline-guessing resistance as a strong long password. Long passwords use scrypt N=32768, r=8, p=3 and XChaCha20-Poly1305 wrapping. Web does not imitate native short-PIN security with browser-only storage.

Existing optional background reply access remains a separate explicit key-access opt-in that can open the vault without the app PIN while the phone is unlocked; see NOTIFICATIONS.md. No developer key, server reset or key escrow has been added. Missing encryption secrets cannot be reconstructed.

## Validation

Controller tests exercise clean signup, migration, incorrect credentials, cancellation, full deletion including old/orphan archives, failed deletion intent, interruption/restart, storage failures, revocation and creation without an old credential. Native tests cover the bridge completion regression, PIN/device binding, ciphertext authentication and retry policy. Exact test/build/package results are recorded in READINESS.md. Physical-phone PIN/Keystore and full deletion checks remain pending; these checks are not an independent security audit.
