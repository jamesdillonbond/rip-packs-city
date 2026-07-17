# RPCTradeEscrow — Test Bundle

This bundle drops into your existing `cadence/` directory and provides
end-to-end coverage of the 12 audit scenarios from
`RPCTradeEscrow_DEPLOYMENT.md` §5, plus 5 bonus tests.

Suite last run green (16/16) on 2026-07-17 with a Cadence-1.0 Flow CLI
(cadence v1.10.x). Two latent contract fixes were required to make it
compile on current Cadence — see "Contract changes made for testability"
below.

## Files

```
cadence/
├── contracts/
│   ├── RPCTradeEscrow.cdc          (already in place)
│   └── imports/                    (gitignored — populated by
│       │                            scripts/fetch-cadence-escrow-test-deps.sh)
│       ├── NonFungibleToken.cdc
│       ├── MetadataViews.cdc
│       ├── ViewResolver.cdc
│       ├── FungibleToken.cdc
│       ├── FungibleTokenMetadataViews.cdc
│       ├── Burner.cdc
│       └── ExampleNFT.cdc
└── tests/
    ├── RPCTradeEscrow_test.cdc     ← test runner
    ├── contracts/
    │   └── ExampleNFT2.cdc         ← committed fixture: second NFT type
    │                                 for testTypeMismatchRejected
    ├── transactions/
    │   ├── admin_set_paused.cdc
    │   ├── cancel_trade.cdc
    │   ├── deposit_to_trade_example_nft.cdc
    │   ├── deposit_to_trade_example_nft_revocable.cdc
    │   ├── deposit_to_trade_example_nft2.cdc
    │   ├── execute_swap.cdc
    │   ├── mint_example_nft.cdc
    │   ├── mint_example_nft2.cdc
    │   ├── propose_trade.cdc
    │   ├── reclaim_expired.cdc
    │   ├── revoke_tagged_receiver_caps.cdc
    │   ├── setup_example_nft_collection.cdc
    │   └── setup_example_nft2_collection.cdc
    └── scripts/
        ├── audit_admin_surface.cdc
        ├── get_block_timestamp.cdc
        ├── get_example_nft_ids.cdc
        ├── get_example_nft2_ids.cdc
        ├── get_next_trade_id.cdc
        └── trade_id_exists.cdc
```

## Setup & run

Everything needed is committed except the standard-contract sources
(gitignored under `cadence/contracts/imports/`). From the repo root:

```bash
npm run test:cadence:escrow
# = bash scripts/fetch-cadence-escrow-test-deps.sh   (populate imports/, idempotent)
#   && flow test -f cadence/tests/flow.test.json cadence/tests/RPCTradeEscrow_test.cdc
```

Expected: **16 tests pass** (verified 2026-07-17). CI runs the same pair in
the `cadence-escrow-tests` job of `.github/workflows/ci.yml`
(`continue-on-error` until its first confirmed green run in Actions — flip
it to blocking after).

Config lives in the committed, secrets-free
[`cadence/tests/flow.test.json`](flow.test.json) (same convention as the
lint harness's `tests/cadence/flow.test.json`) — no edits to the
gitignored root `flow.json` are needed. The fetch script pins ExampleNFT
to flow-nft's `lib/go/contracts/v1.2.2` tag: master's ExampleNFT imports
CrossVMMetadataViews + EVM (absent from the test env), and flow-nft
≥v1.2.x changed `NFTMinter.mintNFT` to RETURN the NFT (no `recipient:`
argument) — `transactions/mint_example_nft.cdc` is written against that
v1.2.x shape.

## Contract changes made for testability (2026-07-17)

Both were required for RPCTradeEscrow.cdc to compile on current Cadence at
all — the suite predates them and had never actually been run:

1. **`Trade.execute()` → `Trade.settle()`** — `execute` is a hard keyword
   in Cadence ≥1.0; a function may not use it as a name. Internal
   `access(contract)` method, so nothing outside the contract changes; the
   public `executeSwap(tradeId:)` entry point is untouched.
2. **`import NonFungibleToken from 0x1d7e57aa55817448` → `import
   "NonFungibleToken"`** — a hardcoded address import cannot resolve in the
   `flow test` environment. The string import resolves through `flow.json`
   aliases to the exact same mainnet address, so deployment semantics are
   unchanged.

## What's covered

| # | Test | Audit scenario from §5 |
|---|---|---|
| 1 | `testHappyPathOneForOne` | 1 |
| 2 | `testHappyPathManyForMany` | 2 |
| 3 | `testWrongIdRejection` | 4 |
| 4 | `testPartialDepositRejection` | 5 |
| 5 | `testCancelReturnsDeposits` | 6 |
| 6 | `testNonPartyCancelRejected` | (extension of 6) |
| 7 | `testExpiryReclaim` | 7 |
| 8 | `testPrematureReclaimRejected` | (extension of 7) |
| 9 | `testReExecuteRejected` | 8 |
| 10 | `testRedepositRejected` | 9 |
| 11 | `testPausedContractBehavior` | 11 |
| 12 | `testInvalidExpiryRejected` | (extension of 5) |
| 13 | `testSamePartyTradeRejected` | (bonus) |
| 14 | `testTypeMismatchRejected` | 3 — via the ExampleNFT2 fixture; asserts the failure is the contract's "NFT type mismatch" message specifically |
| 15 | `testAdminCannotDrain` | 10 (security tripwire) |
| 16 | `testReceiverCapInvalidation` | 12 — the old "needs cap revocation primitive" caveat is obsolete: Cadence 1.0 capability controllers can be deleted (`controller.delete()`), which is exactly that primitive. Proves executeSwap fails atomically on a dead incoming receiver (both receivers borrow BEFORE any NFT moves) and cancel still refunds both sides via the separate refund caps |

All 12 §5 audit scenarios plus the bonus properties are now covered —
no test TODOs remain.

## Framework gotchas (found on the first real run, 2026-07-17)

- **Direct contract-state reads from the test file are stale.** The test
  script's imported contract instance (and its `getCurrentBlock()`)
  reflect import-time state; only `Test.executeScript` sees the live
  chain. All state reads in the suite therefore go through scripts
  (`get_next_trade_id.cdc`, `get_block_timestamp.cdc`, etc). If you add a
  test, do the same.
- **ExampleNFT is NOT pre-deployed** by the test framework (only the
  standard-library contracts at `0x0000000000000001` are). `setup()`
  deploys ExampleNFT, ExampleNFT2, and RPCTradeEscrow under `admin`
  (`0x0000000000000007`).
- The earlier note here about `Test.moveTime` / matcher-name drift turned
  out fine as written — no renames were needed.
