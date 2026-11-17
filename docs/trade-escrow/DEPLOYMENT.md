# RPCTradeEscrow — Phase 1 Deployment Guide

Atomic NFT-for-NFT swap escrow for Rip Packs City. This document covers
deployment, the four canonical transaction templates, an audit checklist,
and the path from Phase 1 to Phase 2.

> **On-chain verification status (Wed May 13, 2026).** All five target
> NFT contracts inspected via `rest-mainnet.onflow.org`. All conform to
> `NonFungibleToken` standard. All five expose `NFT.id: UInt64`. Storage
> path conventions confirmed: TopShot uses literal paths, the other four
> expose `<Contract>.CollectionStoragePath` / `CollectionPublicPath`
> constants. `CompositeType(_ identifier: String): Type?` confirmed real
> in Cadence 1.0 (cadence-lang.org). One correction: Golazos address is
> `0x87ca73a41bb50ad5` (the prior draft had `0x87ca73a41bb50c5e` — a
> typo; the correct address has `ad5` at the end). Trevor's existing
> Supabase `collections` table corroborates.

---

## §1 — What you're deploying

A single Cadence contract, `RPCTradeEscrow.cdc`, generic over any NFT
contract implementing the standard `NonFungibleToken` interface. It works
unchanged for TopShot, AllDay, Pinnacle, Golazos, and UFC Strike. The
contract has no external dependencies other than the standard
`NonFungibleToken` interface at `0x1d7e57aa55817448` on mainnet.

The contract uses a deposit-then-execute pattern. Each user signs a
single transaction depositing their NFTs. Anyone (your backend hot wallet)
triggers execute once both sides are in. This avoids the multi-sig
envelope-relay complexity entirely.

---

## §2 — Deployment plan

**Step 1: create a dedicated contract account.**
Do not deploy to `0x3aa11c84d776838f` — separate blast radius. Use the hot
wallet to fund a new account paid for in FLOW. Save the account address
and the private key for the contract-deployer key in `1Password` or
equivalent. Suggested label: `rpc-escrow-contract-account`.

```bash
flow accounts create --network mainnet
# fund the new address with ~0.5 FLOW from the hot wallet
# enable a deployer key with weight 1000
```

**Step 2: testnet first.** Deploy and exercise the full lifecycle on
testnet against `ExampleNFT` before any mainnet deploy.

```bash
# in cadence/contracts/RPCTradeEscrow.cdc
# in flow.json:
{
  "contracts": {
    "RPCTradeEscrow": "./cadence/contracts/RPCTradeEscrow.cdc"
  },
  "deployments": {
    "testnet": {
      "rpc-escrow-testnet": ["RPCTradeEscrow"]
    },
    "mainnet": {
      "rpc-escrow-mainnet": ["RPCTradeEscrow"]
    }
  }
}

flow project deploy --network testnet
```

**Step 3: run the lifecycle test suite.** See §5 below — 8 scenarios that
must all pass before mainnet.

**Step 4: mainnet deploy.** Same command with `--network mainnet`.

**Step 5: store the address in Vercel env.**
```
RPC_TRADE_ESCROW_ADDRESS_MAINNET=0x...
RPC_TRADE_ESCROW_ADDRESS_TESTNET=0x...
```

**Step 6: smoke test on mainnet** with a $0.10 throwaway trade between
two of your own wallets before exposing to users.

---

## §3 — Transaction templates

These go in `cadence/transactions/`. Replace `0xRPCESCROW` with the
deployed contract address.

### 3a. propose_trade.cdc

Called by the RPC backend hot wallet, not by end users. Opens a trade slot.

```cadence
import RPCTradeEscrow from 0xRPCESCROW

transaction(
    partyA: Address,
    partyB: Address,
    partyA_nftTypeIdentifier: String,
    partyB_nftTypeIdentifier: String,
    partyA_expectedIds: [UInt64],
    partyB_expectedIds: [UInt64],
    expiresAt: UFix64
) {
    prepare(proposer: auth(BorrowValue) &Account) {
        let aType = CompositeType(partyA_nftTypeIdentifier)
            ?? panic("Invalid A type identifier")
        let bType = CompositeType(partyB_nftTypeIdentifier)
            ?? panic("Invalid B type identifier")

        let tradeId = RPCTradeEscrow.proposeTrade(
            partyA: partyA,
            partyB: partyB,
            partyA_nftType: aType,
            partyB_nftType: bType,
            partyA_expectedIds: partyA_expectedIds,
            partyB_expectedIds: partyB_expectedIds,
            expiresAt: expiresAt,
            proposedBy: proposer.address
        )
        log("Proposed trade id ".concat(tradeId.toString()))
    }
}
```

Type identifiers for your 5 collections (mainnet):
- TopShot: `A.0b2a3299cc857e29.TopShot.NFT`
- AllDay: `A.e4cf4bdc1751c65d.AllDay.NFT`
- Pinnacle: `A.edf9df96c92f4595.Pinnacle.NFT`
- Golazos: `A.87ca73a41bb50ad5.Golazos.NFT`
- UFC Strike: `A.329feb3ab062d289.UFC_NFT.NFT`

### 3b. deposit_to_trade_topshot.cdc

Signed by the depositor's wallet. One per supported collection — they
differ only in imports and storage paths. Below is the TopShot variant.

```cadence
import NonFungibleToken from 0x1d7e57aa55817448
import TopShot from 0x0b2a3299cc857e29
import RPCTradeEscrow from 0xRPCESCROW

transaction(
    tradeId: UInt64,
    nftIds: [UInt64],
    incomingNftStoragePath: StoragePath,
    incomingNftPublicPath: PublicPath
) {
    prepare(signer: auth(BorrowValue, IssueStorageCapabilityController, PublishCapability) &Account) {

        // 1. Withdraw the depositor's NFTs from their TopShot collection.
        let provider = signer.storage.borrow<auth(NonFungibleToken.Withdraw) &TopShot.Collection>(
            from: /storage/MomentCollection
        ) ?? panic("Could not borrow TopShot MomentCollection with Withdraw entitlement")

        let withdrawn: @[{NonFungibleToken.NFT}] <- []
        for id in nftIds {
            withdrawn.append(<- provider.withdraw(withdrawID: id))
        }

        // 2. Build refund receiver — back to the same TopShot collection.
        let refundCap = signer.capabilities.get<&{NonFungibleToken.Receiver}>(
            /public/MomentCollection
        )
        if !refundCap.check() {
            // Re-publish if missing (defensive; should exist for any holder).
            let issued = signer.capabilities.storage
                .issue<&{NonFungibleToken.Receiver}>(/storage/MomentCollection)
            signer.capabilities.publish(issued, at: /public/MomentCollection)
        }
        let refundReceiver = signer.capabilities.get<&{NonFungibleToken.Receiver}>(
            /public/MomentCollection
        )
        assert(refundReceiver.check(), message: "Refund receiver invalid")

        // 3. Build incoming receiver — for the OTHER party's NFT type.
        // Ensure the depositor has a collection set up for that type;
        // for cross-collection trades this is the user's responsibility
        // to have configured (the dApp pre-checks before allowing the trade).
        let incomingReceiver = signer.capabilities.get<&{NonFungibleToken.Receiver}>(
            incomingNftPublicPath
        )
        assert(
            incomingReceiver.check(),
            message: "Incoming receiver not configured at ".concat(incomingNftPublicPath.toString())
        )

        // 4. Submit to escrow.
        RPCTradeEscrow.depositToTrade(
            tradeId: tradeId,
            depositor: signer.address,
            nfts: <- withdrawn,
            refundReceiver: refundReceiver,
            incomingReceiver: incomingReceiver
        )
    }
}
```

The `incomingNftStoragePath` parameter is passed in but unused in this
specific template — kept in the signature for forward-compat where you
might want to auto-set up a collection. Drop it if you don't need it.

You'll need one of these per collection. **All paths and id types below
were verified against on-chain source on Wed May 13, 2026.** Pattern
differs by collection — TopShot uses literal paths, the other four expose
contract-level constants.

| Collection | Import | Storage Path (use in tx) | Public Path (use in tx) |
|---|---|---|---|
| TopShot | `TopShot from 0x0b2a3299cc857e29` | `/storage/MomentCollection` (literal — no contract constant exists) | `/public/MomentCollection` |
| AllDay | `AllDay from 0xe4cf4bdc1751c65d` | `AllDay.CollectionStoragePath` | `AllDay.CollectionPublicPath` |
| Pinnacle | `Pinnacle from 0xedf9df96c92f4595` | `Pinnacle.CollectionStoragePath` | `Pinnacle.CollectionPublicPath` |
| Golazos | `Golazos from 0x87ca73a41bb50ad5` | `Golazos.CollectionStoragePath` | `Golazos.CollectionPublicPath` |
| UFC Strike | `UFC_NFT from 0x329feb3ab062d289` | `UFC_NFT.CollectionStoragePath` | `UFC_NFT.CollectionPublicPath` |

All five collections expose `NFT.id: UInt64` via the standard
`NonFungibleToken.NFT` interface — including Pinnacle, where the existing
"uses Int" reference was about `editionID/setID/variantID` fields, not
`id`. The escrow contract's `UInt64` typing works unchanged across all
five.

The on-chain verification used `https://rest-mainnet.onflow.org/v1/accounts/<addr>?expand=contracts`
and parsed the base64-decoded contract source for `let id: <type>` on the
NFT resource and `<X>StoragePath: StoragePath` declarations. Rerun
if you suspect drift before any mainnet deploy.

### 3c. execute_swap.cdc

Called by the RPC backend hot wallet. Anyone can technically call this;
your backend does it so users don't need to pay fees.

```cadence
import RPCTradeEscrow from 0xRPCESCROW

transaction(tradeId: UInt64) {
    prepare(signer: &Account) {
        // no auth needed — anyone can execute a ready trade
    }
    execute {
        RPCTradeEscrow.executeSwap(tradeId: tradeId)
    }
}
```

### 3d. cancel_trade.cdc

Signed by either party.

```cadence
import RPCTradeEscrow from 0xRPCESCROW

transaction(tradeId: UInt64, reason: String) {
    prepare(signer: &Account) {
        RPCTradeEscrow.cancelTrade(
            tradeId: tradeId,
            cancelledBy: signer.address,
            reason: reason
        )
    }
}
```

### 3e. reclaim_expired.cdc

Called by the RPC backend hot wallet as a janitor. Cron at `*/5 * * * *`
hits an API route that queries open expired trades and reclaims them.

```cadence
import RPCTradeEscrow from 0xRPCESCROW

transaction(tradeId: UInt64) {
    prepare(signer: &Account) {}
    execute {
        RPCTradeEscrow.reclaimExpired(tradeId: tradeId)
    }
}
```

---

## §4 — Database schema additions

Drop into a migration. Builds on the existing `user_trade_offers` and
`trade_matches` tables.

```sql
-- Tracks the on-chain trade lifecycle for a given trade_match.
create table public.trade_chain_state (
  id                    uuid primary key default gen_random_uuid(),
  trade_match_id        uuid not null references public.trade_matches(id) on delete cascade,
  chain_trade_id        bigint,                          -- assigned at proposeTrade
  partyA_address        text not null,
  partyB_address        text not null,
  partyA_nft_type       text not null,                   -- type identifier string
  partyB_nft_type       text not null,
  partyA_expected_ids   bigint[] not null,
  partyB_expected_ids   bigint[] not null,
  expires_at            timestamptz not null,
  propose_tx_id         text,
  partyA_deposit_tx_id  text,
  partyB_deposit_tx_id  text,
  execute_tx_id         text,
  cancel_tx_id          text,
  status                text not null check (status in (
    'proposed', 'partial_a', 'partial_b', 'ready',
    'executed', 'cancelled', 'expired', 'failed'
  )),
  failure_reason        text,
  created_at            timestamptz default now(),
  updated_at            timestamptz default now(),
  unique(trade_match_id)
);

create index idx_trade_chain_state_status
  on public.trade_chain_state(status, expires_at)
  where status in ('proposed','partial_a','partial_b','ready');

create index idx_trade_chain_state_chain_id
  on public.trade_chain_state(chain_trade_id)
  where chain_trade_id is not null;
```

You'll want a simple state machine in `/api/trade-chain/` routes:
- `POST /api/trade-chain/propose` — backend signs proposeTrade
- `POST /api/trade-chain/deposit-callback` — frontend reports tx id after user signs deposit; backend confirms via Flow REST and updates status
- `POST /api/trade-chain/execute` — once status=ready, backend triggers executeSwap
- `POST /api/admin/reclaim-expired-trades` — cron-job.org janitor

An event listener (extending your existing event ingest workers) parses
`TradeExecuted`, `TradeCancelled`, `TradeDeposited` and updates state.

---

## §5 — Pre-mainnet audit checklist

Run all of these on testnet against `ExampleNFT` before mainnet. Each is
a Cadence test or scripted scenario.

1. **Happy path 1:1.** Propose, both deposit, execute. Verify both NFTs
   end up in the correct receivers and Trade resource is destroyed.

2. **Happy path N:M.** Same with multiple NFTs per side. Verify all
   transfer atomically.

3. **Type mismatch rejection.** Try to deposit a Golazos NFT into a
   TopShot side. Expect panic.

4. **Wrong id rejection.** Deposit an NFT whose id is not in
   `expectedIds`. Expect panic.

5. **Partial deposit rejection.** Deposit 2 of 3 expected NFTs in one
   tx. Expect panic on "Partial deposit: missing id ...".

6. **Cancel path.** Party A deposits, Party A cancels. Verify A's NFTs
   return to refund receiver. Trade destroyed.

7. **Expiry reclaim.** Party A deposits, expiry passes, third party
   calls `reclaimExpired`. Verify A's NFTs return.

8. **Re-execute attempt.** Execute a trade, then attempt to execute the
   same tradeId. Expect panic "Trade not found".

9. **Re-deposit attempt.** Party A deposits, then tries to deposit again
   on same side without cancel. Expect panic.

10. **Drain attempt.** Verify there is no path for Admin to withdraw
    NFTs from any active Trade. Grep contract source for any function
    that returns `@{NonFungibleToken.NFT}` accessible by Admin — there
    should be none.

11. **Paused contract.** Set paused=true. Verify proposeTrade and
    depositToTrade reject. Verify cancelTrade and reclaimExpired still
    work.

12. **Receiver capability invalidation.** Deposit with a valid receiver,
    then revoke the receiver capability before execute. Execute should
    panic on `receiver no longer valid`. Cancel should refund correctly.

For 1-12 you can write a single Cadence test file using the Flow Testing
Framework (`flow test`). The hybrid-custody repo has a good test
structure to copy.

---

## §6 — Known limitations of Phase 1

These are deliberate punts to ship sooner; addressing them is Phase 2 scope.

**Hybrid Custody not supported.** A user with TopShot moments in a
Dapper-custodied child account cannot deposit. Workaround: they move
the moment to their parent wallet first (single tx via the HC manager).
Phase 2 adds a `deposit_to_trade_from_child.cdc` transaction that takes
both parent and child as signers and withdraws via the HC manager. The
escrow contract itself does not change.

**Type identifier parsing.** Cadence's `CompositeType(_ identifier: String): Type?`
is a documented Cadence 1.0 builtin that returns `nil` for unresolvable
identifiers (verified against cadence-lang.org/docs/language/run-time-types
on May 13, 2026). The propose-tx template's `?? panic(...)` fallback is
the correct pattern. Universal-propose design is sound; no need for
per-collection variants.

**No partial fills.** A trade either fully completes or fully cancels.
No "I'll accept just one of the three moments" mechanics. Reasonable for
v1.

**No price-sweetener side.** Pure NFT-for-NFT only. Adding "and 50 FLOW
from partyA" requires a `FungibleToken` capability alongside the NFT
caps. Doable but not v1.

**Backend hot wallet pays all fees.** Both deposits (signed by users)
and the execute (signed by backend). With current FLOW prices this is
< $0.001/swap so total cost stays trivial.

**Event-only indexing.** Trade state lives in the contract; off-chain
state in `trade_chain_state` table is built from events. If your event
listener falls behind, the UI lags. The contract is the source of truth.

---

## §7 — From Phase 1 to Phase 2

Phase 2 changes are mostly off-chain and additive. The escrow contract
itself stays the same.

1. **Hybrid Custody wrapper transactions** for each collection. Signed
   by the parent (with HC `Manage` entitlement) and the child account
   (delegated). Withdraws from child, deposits to escrow as before.

2. **Multi-collection swap UX** — already supported by the contract;
   just needs the trade-match UI to surface cross-collection options.

3. **Sweetener support** — add a `FlowToken.Vault` field to the Trade
   resource and a `FungibleToken.Provider` cap to the deposit signature.
   Contract upgrade required.

4. **Per-user reputation** — derived from `TradeExecuted` and
   `TradeCancelled` events. Pure off-chain, no contract changes.

5. **Migrate to multi-sig envelope** — only if escrow approach proves
   limiting. Most projects find the deposit-then-execute pattern
   sufficient at any volume.

---

## §8 — Estimated cost & timeline

**Contract:** done (file alongside this one). 1-2 days for Trevor to
read, internalize, ask questions, run on emulator.

**Cadence test suite:** ~1 day to write the 12 scenarios above.

**Transaction templates:** 0.5 day. 1 propose + 5 deposit variants + 1
execute + 1 cancel + 1 reclaim = 9 short files.

**DB schema + API routes:** ~1 day. Schema is small, 4 routes are
mostly bookkeeping around tx submission and Flow REST polling.

**Frontend UI on existing `/dashboard/trade-hub`:** ~2 days. Trade
proposal flow, deposit signing UX with FCL, status polling, cancel
button, success / failure surfaces.

**Testnet exercise:** ~1 day end-to-end with throwaway accounts.

**Mainnet deploy + smoke test:** ~0.5 day.

**Total Phase 1: ~7 days of focused work**, distributed across Cadence,
backend, and frontend. Each piece is independent and parallelizable.
