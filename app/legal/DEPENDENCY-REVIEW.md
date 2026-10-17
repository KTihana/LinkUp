# Dependency review, 15 October 2026

`npm audit --omit=dev --json` reports 20 high-severity entries, zero critical. These 20 entries propagate from two root advisories, rather than representing 20 independently identified flaws:

- `braces` stack exhaustion from deeply nested patterns: https://github.com/advisories/GHSA-vfj7-8cjw-p6xm (affected range reported by the audit: <=3.0.3).
- `node-forge` RSA PKCS#1 v1.5 signature verification: https://github.com/advisories/GHSA-86w9-cpqp-85rv (affected range reported by the audit: <=1.4.0).

`npm ls braces node-forge` traces them to Expo CLI / certificate tooling and Metro / file matching; the other reported package entries inherit these findings. Tiho's application source does not directly import either package; its message encryption uses separate libraries. That observation is not a complete reachability assessment or security clearance.

The audit's proposed automatic fixes include downgrading Expo 57 to 44 and React Native 0.86 to 0.72. Those changes are incompatible with this project and were not applied. Review upstream patches and actual build/runtime exposure, update compatible dependencies, and rerun protocol/native checks before closing this release gate. The independent review of Tiho's protocol and storage design is also still outstanding.
