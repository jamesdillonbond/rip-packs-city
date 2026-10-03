# Hybrid Custody test fixtures

`HybridCustody.cdc`, `CapabilityFactory.cdc`, `CapabilityDelegator.cdc` and `CapabilityFilter.cdc` are copied from
[onflow/hybrid-custody](https://github.com/onflow/hybrid-custody) `main` (`contracts/`, fetched 2026-10-03) so
`RPCGiveawayPacks_test.cdc` can link accounts for real (publish + redeem) instead of stubbing the check.

⚠ **Not byte-identical to mainnet** (`0xd8a7e05a7ac670c0`). Measured 2026-10-03, ignoring import lines:
HybridCustody, CapabilityFactory and CapabilityFilter have the same line counts, and the differing lines are
refactors and comments (`if let` vs nil checks, doc typos). CapabilityDelegator has six more lines on `main`. The one
surface `RPCGiveawayPacks` depends on, `OwnedAccountPublic.getRedeemedStatus(addr:)` read from
`OwnedAccountPublicPath`, was checked against the MAINNET source, and a live mainnet call returned `true` for both of
Trevor's linked Flow Wallets and nothing for an unrelated address. Re-check that before any deploy.
