# Cadence Test API Reconciliation — Sat May 16, 2026

Reconciled `cadence/tests/RPCTradeEscrow_test.cdc` against the canonical
Cadence Testing Framework documentation at
https://cadence-lang.org/docs/testing-framework.

## Changes

**1. Removed `import BlockchainHelpers`.** This module does not exist in
the canonical Test framework. Originally pulled in for `tickClock` /
similar helpers — none of which are needed. The built-in `Test` module
and Cadence's `getCurrentBlock()` cover everything.

**2. Rewrote `mintExampleNFT()` event extraction.** The original tried
`evt.type == Type<ExampleNFT.Deposit>()` plus a force-downcast, which is
not a documented API. The canonical pattern is `Test.eventsOfType(typ)`
filtered by a `CompositeType("...")` string. Since none of the live
collections have a stable event type identifier we'd want to hard-code
in the test, the simpler approach is **set-difference on collection IDs
before/after the mint** — always returns the new id, no event parsing
required.

**3. Rewrote `proposeTrade()` tradeId extraction.** Same issue. The
contract already exposes `RPCTradeEscrow.getNextTradeId()` as a public
view function, so the test now reads the next-id *before* propose
(predicts the value), submits, then verifies the counter advanced
exactly by one. Cleaner than event parsing and doubles as a sanity
check on counter monotonicity.

**4. Fixed `Test.moveTime(by: 700.0)` → `Test.moveTime(by: Fix64(700.0))`.**
The canonical signature is `moveTime(by delta: Fix64)` — Fix64 is
signed, not UFix64. The bare `700.0` literal would have inferred
UFix64 and failed to compile. Explicit cast.

**5. Bumped 600.0 expirySeconds to 601.0 in `testExpiryReclaim`** and to
3600.0 in `testPausedContractBehavior`. The original 600.0 sat exactly
on the `MIN_EXPIRY_SECONDS = 600.0` boundary, where `expiresAt >= now + MIN`
could fail due to sub-second block-time jitter. The reclaim test
genuinely needs to be near-min so the moveTime can carry past expiry
quickly; +1s margin is the safe answer. The paused test had no reason
to ride the boundary — bumped to a comfortable hour.

## What was already correct

- `Test.executeTransaction(_ tx: Transaction)` signature
- `Test.Transaction(code, authorizers, signers, arguments)` constructor
- `Test.deployContract(name, path, arguments)` — using `path`, not `code`
- `Test.createAccount()` / `Test.getAccount(address)`
- `Test.executeScript(_ script: String, _ arguments)`
- `Test.readFile(_ path: String)`
- `Test.beSucceeded()` / `Test.beFailed()` / `Test.beNil()`
- `Test.expect(value, matcher)` / `Test.assertEqual(expected, actual)`
- `Test.TestAccount` type name
- `getCurrentBlock().timestamp` usage in helpers
- `Type<@ExampleNFT.NFT>().identifier` for type strings
- `setup()` / `beforeEach()` lifecycle hooks
- The `0x0000000000000007` testing alias for contract deployment

## flow.json contracts block — required entries

For the test framework to resolve `import "RPCTradeEscrow"` etc:

```json
{
  "contracts": {
    "RPCTradeEscrow": {
      "source": "./cadence/contracts/RPCTradeEscrow.cdc",
      "aliases": {
        "testing": "0x0000000000000007"
      }
    },
    "NonFungibleToken": {
      "source": "./cadence/contracts/imports/NonFungibleToken.cdc",
      "aliases": {
        "testing": "0x0000000000000001"
      }
    },
    "MetadataViews": {
      "source": "./cadence/contracts/imports/MetadataViews.cdc",
      "aliases": {
        "testing": "0x0000000000000001"
      }
    },
    "ExampleNFT": {
      "source": "./cadence/contracts/imports/ExampleNFT.cdc",
      "aliases": {
        "testing": "0x0000000000000007"
      }
    }
  }
}
```

Note that ExampleNFT and RPCTradeEscrow share the `0x0000000000000007`
alias — both get deployed there in the test environment, since the
testing framework only provides addresses 0x05, 0x06, 0x07 for user
contracts. NonFungibleToken and MetadataViews are pre-deployed by the
emulator at the service account `0x0000000000000001` and just need
declaration so imports resolve.

## What's still unverified

The corrected test file has not been run against `flow test` yet. The
changes above are mechanical reconciliations against canonical docs.
Three things could still trip on first run:

1. **ExampleNFT's exact API.** The `mintNFT` fixture transaction
   assumes a `(recipient, name, description, thumbnail, royalties)`
   signature. The flow-nft master ExampleNFT might use a different
   minter shape (e.g. recipient + AnyResource metadata). Easy fix at
   first compile error.
2. **`Type<@ExampleNFT.NFT>().identifier` resolution timing.** If
   ExampleNFT hasn't been "registered" via flow.json before the test
   imports run, the identifier might be incomplete. Workaround: hard-
   code the identifier string (`A.0000000000000007.ExampleNFT.NFT`).
3. **`Fix64(700.0)` cast syntax.** I believe this is the right syntax
   per Cadence 1.0 number literals, but if it errors, the alternative
   is to declare `let delta: Fix64 = 700.0` first.

Each is a < 5 minute fix at the relevant compile error line.
