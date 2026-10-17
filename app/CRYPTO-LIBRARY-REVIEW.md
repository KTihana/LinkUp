# Common encryption library review

Reviewed 13 October 2026. Select **OpenMLS 0.9.1 as the preferred migration candidate**, subject to a native/browser feasibility test and independent integration review. Keep `ts-mls` 1.6.4 confined to the current development prototype. No replacement engine, epoch rotation or production approval is implemented by this decision.

OpenMLS preserves Common's transport-independent MLS direction while offering stronger external review evidence. The alternative is a complete messaging stack such as Matrix if maintaining our own secure client integration proves impractical. This is an engineering selection, not a claim that one library makes the whole app secure.

## Candidate comparison

| Candidate | Review and maintenance evidence | Android and browser fit | Decision |
| --- | --- | --- | --- |
| [OpenMLS](https://github.com/openmls/openmls) | MIT; published SRLabs assessment of the protocol core | Rust native bridge plus Wasm; mobile/browser targets are built but not tested in upstream CI | Preferred candidate at patched 0.9.1; adapters and providers require review |
| [ts-mls](https://github.com/LukaJCB/ts-mls) | MIT; maintainer explicitly reports no formal security audit | Existing Common implementation works in Node tests; native crypto/phone integration remains unfinished | Development only; do not extend it into a claimed production secure messenger |
| [mls-rs](https://github.com/awslabs/mls-rs) | MIT or Apache-2.0; upstream reports no full third-party security audit | Rust/Wasm and configurable storage; Rust Crypto and Web Crypto providers marked experimental | Useful comparison/interoperability target; does not resolve the audit requirement |
| [Official libsignal](https://github.com/signalapp/libsignal) | AGPL-3.0; used by Signal, which does not support external use | Java/Swift bindings; TypeScript uses a Node native addon, requiring a separate browser approach | Reconsider if native Signal sessions become the priority; not a shared browser/Hermes replacement |
| [Matrix Rust crypto Wasm](https://github.com/matrix-org/matrix-sdk-crypto-wasm) | Apache-2.0 bindings; vodozemac has a [published 2022 audit](https://matrix.org/blog/2022/05/16/independent-public-audit-of-vodozemac-a-native-rust-reference-implementation-of-matrix-end-to-end-encryption/) | Browser crypto state machine; native needs a bridge | Alternative architecture requiring Matrix identity/session semantics; an old component audit does not cover current integration |

A licence review must cover the complete dependency graph and distribution method. No project licence change is made here. Ordinary phone networking and Wasm support do not constitute an audited React Native SDK.

## Exact candidate and current advisories

The official registry publishes `openmls` **0.9.1**, dated **7 October 2026**, requiring Rust **1.91.0**. The downloaded 676,062-byte crate archive matched its registry SHA-256:

`88ea97f8931047590bda498a9502e8fe6c9bb2bb04547a9a463618783481e0ec`

Its packaged VCS record identifies commit `1762090a4523cdd241f454b4058e91b64bbdc6de`. The review evidence is saved in [research/openmls-candidate.json](research/openmls-candidate.json). A checksum verifies agreement with registry metadata, not independent authenticity or absence of malicious code.

The [8 October recursion advisory](https://github.com/openmls/openmls/security/advisories/GHSA-gc79-23g3-8g52) affects 0.9.0 and releases before 0.8.2; upstream lists 0.9.1 and 0.8.2 as patched. It can terminate a process, with environment-dependent impact across Wasm/FFI. Do not pin the older 0.9.0 release merely because a release index or audit announcement mentions it.

The August advisories for [quadratic duplicate detection](https://github.com/openmls/openmls/security/advisories/GHSA-w62v-gv48-63rh) and [deserialization panics](https://github.com/openmls/openmls/security/advisories/GHSA-rrmv-c79f-cf5r) list 0.9.0 as patched. The [MAC validation advisory](https://github.com/openmls/openmls/security/advisories/GHSA-8x3w-qj7j-gqhf) lists 0.7.2 as patched. Check advisories and all resolved provider dependencies again before integrating or releasing; this list is a dated review, not a vulnerability-free certification.

## What the audit covers

The [SRLabs report](https://blog.openmls.tech/SRL-OpenMLS_security_assurance_assessment.pdf), finalized 3 March 2026, covers the MLS core, traits and basic credentials. Cryptographic/storage providers and example clients/delivery services were excluded. It predates 0.9.1 and Common's proposed adapters.

The report records eight findings, including one high severity MAC-validation issue marked mitigated. Storage/state desynchronization, S1-3, is recorded as acknowledged; unbounded allocation, S0-1, is recorded as risk accepted. These make transaction failure handling and resource bounds part of our integration work. The [May announcement](https://blog.phnx.im/openmls-independent-security-audit/) also notes a remaining low severity issue. Do not flatten this evidence into “everything was fixed” or “Common is audited.”

## Native and browser integration

Use one Rust core behind a narrow Android native interface and browser Wasm interface. Hermes needs a native bridge; browser Wasm bindings are not directly usable in Hermes. OpenMLS's [Wasm bindings describe themselves as an experiment](https://raw.githubusercontent.com/openmls/openmls/1762090a4523cdd241f454b4058e91b64bbdc6de/openmls-wasm/README.md), requiring custom persistence and credential integration.

Start the feasibility test with standard suite 1, the current Common suite. Review the cryptographic provider and secure random source for each target; audit coverage must not be inherited from the protocol core. Pin the Rust toolchain, crate versions, complete lockfile and bindings. Never build the shipping core with `--all-features`: the [published manifest](https://raw.githubusercontent.com/openmls/openmls/1762090a4523cdd241f454b4058e91b64bbdc6de/openmls/Cargo.toml) includes `crypto-debug` and `content-debug`. Disable those and `unchecked-conversions`, and leave draft/experimental protocol features off for the initial integration. Check resolved features across the whole build, not just direct flags.

Local feasibility has not been compiled: Cargo/Rust/rustup/wasm-pack are absent from the host PATH, with about 1.6 GiB free at review time. No Rust toolchain or crypto replacement was installed. The earlier complete Android build also requires disk capacity and hardware validation; JavaScript export is not evidence for this Rust bridge.

## Integration contract and key rotation

Common must validate exact accepted identities, signing keys, the two-member group and permitted capabilities after authenticated processing. [OpenMLS message processing](https://book.openmls.tech/user_manual/processing.html) separates cryptographic validation from application policy. Reject unexpected members, unsigned identity changes, foreign groups, unrequested external joins and unsupported protocol options.

Keep mutation inside the vault's serialized write boundary. Perform a mutation on a disposable restored provider/group snapshot. Persist the replacement provider state, exact ciphertext/control outbox, history and deduplication together before publishing or acknowledging. If persistence fails, discard every mutated object and reload the last committed snapshot. A memory/storage mismatch must stop the conversation rather than reuse ratchet keys or silently reset identity. Do not save Rust provider secrets to unencrypted SQLite or a debug export.

Rotation needs authenticated MLS Update/Commit processing, durable pending commits and bounded epoch retention. Encrypted control acknowledgements must distinguish a peer's durable epoch acceptance from relay storage. Delayed applications, missing commits and duplicate receipts require bounded buffering/retry. Simultaneous commits need a reviewed fork policy; detecting a conflict must stop sending until authenticated recovery. Never implement rotation by changing an epoch number or choosing the most recently received state.

Recovery after compromise requires a clean endpoint and fresh honest key updates accepted by its peers. A stolen long-term identity key needs identity revocation and renewed human verification; epoch rotation does not restore that trust. Saved history remains readable with its vault key. These are separate guarantees from network forward secrecy.

## Required feasibility tests

1. Android/native and browser/Wasm create a two-member group using accepted Common identities, exchange first-contact Welcome/application messages and reject a third member or replaced signing key.
2. Both sides restart from encrypted provider snapshots and exchange further messages; injected storage failures never publish, acknowledge or reuse mutated state.
3. A self-update advances both peers through an authenticated commit. Lost, duplicate and reordered control/application packets survive restart without silent forks or duplicate delivery.
4. Both peers initiate updates concurrently. Conflict handling, bounded resynchronization and sender cancellation preserve identities/history and refuse ambiguous state.
5. Obsolete secrets are retired under an explicit bounded offline-delivery policy; retained history and old backups are treated separately. Test recovery after removed compromise without claiming protection from an attacker still on the device.
6. Malformed nested extensions, overlarge inputs, unknown senders and known hostile peers fail within resource bounds. Validate the October advisory regression on Wasm/native builds.
7. Lock/background invalidates pending jobs and signing access. Resolved features, logs, crash reports, caches and exports contain no private keys/plaintext content.
8. After the engine test passes, run the same crash/reorder/receipt cases through mailbox, Wi-Fi and BLE. Require physical Android tests and independent integration review before production.

Existing `ts-mls` state cannot be assumed compatible with OpenMLS storage migration helpers. Preserve encrypted history and contacts; design explicit authenticated new sessions and delivery draining before any engine migration. Do not overwrite a user's current vault or automatically downgrade when a peer cannot use the new engine.
