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
│   └── imports/                    (gitignored — pull per "One-time setup")
│       ├── NonFungibleToken.cdc
│       ├── MetadataViews.cdc
│       ├── ViewResolver.cdc
│       ├── FungibleToken.cdc
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

## One-time setup

### 1. Pull the import sources (gitignored)

```bash
mkdir -p cadence/contracts/imports
# flow-nft — pin ExampleNFT to the lib/go/contracts/v1.2.2 tag: master's
# ExampleNFT now imports CrossVMMetadataViews + EVM, which don't exist in
# the test env.
for c in NonFungibleToken MetadataViews ViewResolver; do
  curl -fsSL "https://raw.githubusercontent.com/onflow/flow-nft/master/contracts/$c.cdc" \
    -o "cadence/contracts/imports/$c.cdc"
done
curl -fsSL "https://raw.githubusercontent.com/onflow/flow-nft/lib/go/contracts/v1.2.2/contracts/ExampleNFT.cdc" \
  -o cadence/contracts/imports/ExampleNFT.cdc
curl -fsSL "https://raw.githubusercontent.com/onflow/flow-ft/master/contracts/FungibleToken.cdc" \
  -o cadence/contracts/imports/FungibleToken.cdc
curl -fsSL "https://raw.githubusercontent.com/onflow/flow-ft/master/contracts/utility/Burner.cdc" \
  -o cadence/contracts/imports/Burner.cdc
```

NOTE: the ExampleNFT pin matters twice over — besides the EVM imports,
flow-nft ≥v1.2.x changed `NFTMinter.mintNFT` to RETURN the NFT (no
`recipient:` argument); `transactions/mint_example_nft.cdc` is written
against that v1.2.x shape.

### 2. flow.json additions

Register the imports in the (gitignored) `flow.json`. The test runner uses
quoted string imports (`import "RPCTradeEscrow"`) which Flow CLI resolves
via `flow.json`'s `contracts` block. The `testing` network entry under
`networks` is required or the CLI rejects the `testing` aliases.

```jsonc
{
  "contracts": {
    "RPCTradeEscrow": {
      "source": "./cadence/contracts/RPCTradeEscrow.cdc",
      "aliases": { "testing": "0000000000000007" }
    },
    "ExampleNFT2": {
      "source": "./cadence/tests/contracts/ExampleNFT2.cdc",
      "aliases": { "testing": "0000000000000007" }
    },
    "ExampleNFT": {
      "source": "./cadence/contracts/imports/ExampleNFT.cdc",
      "aliases": { "testing": "0000000000000007" }
    },
    "NonFungibleToken": {
      "source": "./cadence/contracts/imports/NonFungibleToken.cdc",
      "aliases": {
        "emulator": "f8d6e0586b0a20c7",
        "testing":  "0000000000000001",
        "testnet":  "631e88ae7f1d7c20",
        "mainnet":  "1d7e57aa55817448"
      }
    },
    "MetadataViews": {
      "source": "./cadence/contracts/imports/MetadataViews.cdc",
      "aliases": {
        "emulator": "f8d6e0586b0a20c7",
        "testing":  "0000000000000001",
        "testnet":  "631e88ae7f1d7c20",
        "mainnet":  "1d7e57aa55817448"
      }
    },
    "ViewResolver": {
      "source": "./cadence/contracts/imports/ViewResolver.cdc",
      "aliases": {
        "emulator": "f8d6e0586b0a20c7",
        "testing":  "0000000000000001",
        "testnet":  "631e88ae7f1d7c20",
        "mainnet":  "1d7e57aa55817448"
      }
    },
    "FungibleToken": {
      "source": "./cadence/contracts/imports/FungibleToken.cdc",
      "aliases": {
        "emulator": "ee82856bf20e2aa6",
        "testing":  "0000000000000002",
        "testnet":  "9a0766d93b6608b7",
        "mainnet":  "f233dcee88fe0abe"
      }
    },
    "Burner": {
      "source": "./cadence/contracts/imports/Burner.cdc",
      "aliases": {
        "emulator": "f8d6e0586b0a20c7",
        "testing":  "0000000000000001",
        "testnet":  "9a0766d93b6608b7",
        "mainnet":  "f233dcee88fe0abe"
      }
    }
  },
  "networks": {
    "emulator": "127.0.0.1:3569",
    "testing":  "127.0.0.1:3569",
    "mainnet":  "access.mainnet.nodes.onflow.org:9000",
    "testnet":  "access.devnet.nodes.onflow.org:9000"
  }
}
```

## Run

```bash
flow test cadence/tests/RPCTradeEscrow_test.cdc
```

Expected: **16 tests pass** (verified 2026-07-17).

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
