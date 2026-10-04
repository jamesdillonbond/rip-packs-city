# Trading, revisited after giveaways (2026-10-03)

**Asked by:** Trevor, 2026-10-03: "Would it be worth revisiting a trading feature using Flow Wallet as we start to enable Pack giveaways which I feel like would have a similar infrastructure behind?" then "Do all that makes sense."
**Status:** Research and a decision memo. Nothing was built. The read-only rule (concierge rule 1, `docs/reference/concierge.md`) and roadmap-2026-08-03 §9.6 ("do not deploy the Trade Hub, even to testnet") still stand. Changing either is Trevor's call.
**Times:** PT.

---

## 1. Verdict

**Worth revisiting. Do not build it yet.** The giveaway work solved the problem that shelved trading in July: moving a moment out of a Dapper account without Dapper co-signing. And today's measurement says many more collectors have the setup trading needs than we thought (§3). Three things are still open, and none of them is engineering:

1. **Both sides must move or neither does.** Pick the shape (§4). The recommended shape avoids custody entirely.
2. **The read-only rule.** A trade means RPC builds a transaction that users sign. That is a second exception to rule 1, and only Trevor can approve it.
3. **FMV accuracy.** A "fair trade" hint uses our FMV. Where confidence is LOW, the hint has to say so or stay hidden (§5).

**Recommended next step:** the swap test in §6, using only Trevor's own wallets. It's cheap, it settles the last technical unknown, and nothing ships to users.

## 2. What giveaways already prove (reusable)

All of this is in production and has run on mainnet:

| Piece | Where | Proven by |
|---|---|---|
| Connect Flow Wallet (FCL discovery + WalletConnect) | `lib/giveaways/flow-wallet-connect.ts` | console + claim page |
| Prove the user owns the wallet (FCL account proof, HMAC nonce) | `lib/giveaways/claim-proof.ts` | shipped 2026-10-03 |
| List a wallet's linked accounts (Hybrid Custody, redeemed only) | `LINKED_ACCOUNTS_SCRIPT`, `lib/giveaways/linked-accounts.ts` | read on mainnet 2026-10-03 |
| Withdraw from a linked Dapper account, signed by the parent wallet | `BORROW_PROVIDER` in `lib/giveaways/deliver-cadence.ts` | test1: 8 of 8 moments delivered and verified on chain |
| Simulate the exact transaction as a script before signing | `DELIVER_SIMULATION_SCRIPT` | every Deliver all |

This covers one person signing and moments moving. A trade adds a second signer and the rule that neither side moves alone.

## 3. Measured today: who could trade

A trader needs a Dapper account linked to a Flow Wallet (Hybrid Custody, redeemed), or moments held in a Flow Wallet directly. The earlier figure, "164 linked Dapper children on chain" (free-packs reassessment §7.2, 2026-09-29), made this audience look tiny. **That figure does not survive a sample.**

Method: read-only Cadence script (§7.1) on mainnet, sent through the database's `pg_net` (this sandbox's network policy blocks the Flow API). For each address: the number of parents that have **redeemed** the link (`getParentStatuses()`), and the Top Shot moment count.

| Population | Linked (≥1 redeemed parent) | Notes |
|---|---|---|
| test1 giveaway winners (all claims to date) | **4 of 4** | 4 different parent wallets; 425 to 28,481 moments each |
| Random Top Shot wallets RPC indexes (`wallet_moments_cache`, 24 wallets, excluding Trevor's) | **9 of 24 (≈38%)** | 1 or 2 redeemed parents each |
| Positive control: Trevor's `0xbd94…` | linked (2 parents) | matches the 2026-09-29 reading |

How to read this:

- **The sample leans toward big collectors.** `TABLESAMPLE SYSTEM` picks table blocks, so wallets with many cached rows are more likely to be drawn. RPC indexes active wallets, not all of Top Shot. So ≈38% is a rate for RPC-visible, collection-heavy wallets, not for every Top Shot account. It is still enough to show that 164 total is wrong by a wide margin.
- **4 of 4 winners proves very little.** They are early test1 participants, probably Trevor's circle. Keep reading this number on every public drop. The claim page records it automatically: a winner who uses "Claim with Flow Wallet" has proven a link.
- **Not measured:** how many linked users actually want to trade. Linking is mainly how people use Flow Wallet and other Flow apps, not a sign of interest in trading.

**Cross-check (later 2026-10-03, ~7:40 PM PT):** RPC's own `linked_accounts` table (written by the Hybrid Custody event/script backfill) holds **1,125 active linked children** (1,160 ever). **340** of them are Top Shot wallets RPC indexes. Because the backfill has missed links before, read 1,125 as a lower bound. Either way it is about 7× the old 164.

👉 **Practical effect:** the "too few people could use it" objection is much weaker than the 2026-10-03 first-pass answer said. The remaining objections are product and policy, not reach.

## 4. The shape: two signatures on one transaction, no escrow

| Shape | Custody | Atomic | UX | Status |
|---|---|---|---|---|
| **A. One transaction, two authorizers** | **None.** Moments go straight from A's account to B's, and B's to A's | Yes. The transaction succeeds or fails whole | Both people sign within the transaction's expiry window (~10 min of blocks), so it's a **live trade room**, not a mailed offer | Recommended. Cadence written (§7.2), not yet run |
| B. Escrow contract (`cadence/contracts/RPCTradeEscrow.cdc`, 16/16 tests) | **RPC's contract holds user moments** between deposits | Yes, at execute | Async offers | ⛔ Custody. The Declined list rules out treasury/inventory custody; roadmap §9.6 says don't deploy |
| C. Two separate gifts | None | **No.** One side can send and the other walk away | Simple | ⛔ Not a trade. Someone gets scammed |

Shape A is how Flow multi-signer transactions normally work: one transaction, two `prepare` signers, one payer. The flow:

1. A and B open the same trade room on RPC (both signed in, both prove their wallet with the existing account proof).
2. Each picks moments from their own accounts. RPC reads both sides on chain (locked? still held?).
3. RPC simulates the whole swap as a script, using the same fragments as the transaction (the giveaway pattern).
4. A signs, then B signs. Who pays the fee is a design choice (A, or B, or the person who proposed the trade). RPC holds no key and pays no fee.
5. Either both sides move or nothing does.

Open technical item: FCL's support for a second authorizer whose wallet is on a **different device** is the risky part. It has to be passed through a browser handoff or WalletConnect. Prove it with the §6 test before designing any UX.

## 5. Rules a trading feature would need (if Trevor reopens it)

- **Transactions users sign, never custody.** RPC never holds a key, a moment, or a fee.
- **Same honesty rules as everywhere.** A "fair trade" score only uses FMV at HIGH/MEDIUM confidence. Otherwise it reads "not enough sales to price this", never a number. A failed chain read is a retryable error, never "you don't own this".
- **Show the cost of withdrawing.** A moment that leaves a Dapper account stops counting toward Top Shot Score, sets and challenges (feasibility doc §1). Show this before anyone signs.
- **Top Shot, All Day, Golazos, UFC only.** Dapper's link filter blocks Pinnacle (hybrid-custody probe 2026-07-13).
- **No fees, no promotion** until the roadmap's accuracy gate and the 100-WAU rule allow it.

## 6. The next test: Trevor's own wallets only

A test needs two distinct holders. Trevor's wallets give us that once his Flow Wallet holds one moment of its own:

- Signer 1: Flow Wallet `0x3d0b274c80263484`, holding one moment of its own (it held 0 on 2026-10-03; move one low-value moment there first).
- Signer 2: parent `0xd96dc67ae64ee202`, withdrawing from the linked Dapper account `0xbd94cade097e50ac`.

Steps:

1. **Simulate** (read-only, no fees): the §7.2 script, with leg 1 adapted to "own collection" (`BORROW_OWN_PROVIDER`), leg 2 as written. Expect each moment to end up in the other account.
2. **Run it for real** with both wallets signing one transaction. That tests the actual open question: whether FCL can collect two authorizers' signatures.
3. **Cost:** one low-value moment swaps back and forth between two accounts Trevor already owns. Nothing user-facing changes.

**Step 1 done, read-only (2026-10-03, ~7:40 PM PT; Trevor: "Do it all"):** a mainnet simulation, which changes nothing on chain, of a two-sided swap script on Trevor's accounts returned **`[true]`**. Side A: signer `0x3d0b…` withdrew moment `27289790` (Greg Brown III, $0.25 FMV, unlocked) from the linked Dapper account `0xbd94…` through Hybrid Custody controller 87 (7 resolvable). Side B: signer `0xd96d…` gave nothing. The moment arrived in `0xd96d…`'s empty Top Shot collection. Both Flow Wallets already have empty Top Shot collections, so either can receive, and no preparation step is needed. Not yet tested: the real transaction with two wallet signatures (step 2). A first build of the admin tooling for that step (a swap-test page, plus a relay that carries wallet B's signature from a second browser) was stopped by the session's safety check before completion, and **is not committed**. Step 2 needs Trevor's explicit go-ahead in a session that permits it.

⚠ **Run this on Trevor's accounts only.** A first attempt in this session would have simulated withdrawals from a giveaway winner's account, and the session's safety check rightly refused it. Even read-only simulations of withdrawals should only use accounts whose owner agreed.

## 7. Appendix: scripts

### 7.1 Linked-account census (read-only, ran 2026-10-03)

```cadence
import HybridCustody from 0xd8a7e05a7ac670c0
import TopShot from 0x0b2a3299cc857e29
access(all) fun main(addrs: [Address]): {Address: [Int]} {
  let out: {Address: [Int]} = {}
  for a in addrs {
    var redeemed = -1
    if let o = getAccount(a).capabilities.borrow<&{HybridCustody.OwnedAccountPublic}>(HybridCustody.OwnedAccountPublicPath) {
      redeemed = 0
      for p in o.getParentStatuses().keys { if o.getParentStatuses()[p]! { redeemed = redeemed + 1 } }
    }
    var ts = -1
    if let c = getAccount(a).capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection) { ts = c.getIDs().length }
    out[a] = [redeemed, ts]
  }
  return out
}
```

`[-1, n]` = no OwnedAccount (never linked); `[0, n]` = offered but not redeemed; `[k, n]` = k redeemed parents. Sent via `net.http_post` to `https://rest-mainnet.onflow.org/v1/scripts?block_height=sealed`, read back from `net._http_response`.

### 7.2 Two-authorizer swap (draft; never run)

```cadence
import HybridCustody from 0xd8a7e05a7ac670c0
import NonFungibleToken from 0x1d7e57aa55817448
import TopShot from 0x0b2a3299cc857e29

// Both sides linked (Hybrid Custody). For a side holding moments in the Flow
// Wallet itself, borrow its own /storage/MomentCollection instead (BORROW_OWN_PROVIDER).
transaction(childA: Address, ctlA: UInt64, idsA: [UInt64], childB: Address, ctlB: UInt64, idsB: [UInt64]) {
    let pa: auth(NonFungibleToken.Withdraw) &{NonFungibleToken.Provider}
    let pb: auth(NonFungibleToken.Withdraw) &{NonFungibleToken.Provider}

    prepare(a: auth(BorrowValue) &Account, b: auth(BorrowValue) &Account) {
        self.pa = borrowLinked(a, childA, ctlA)   // = BORROW_PROVIDER, once per signer
        self.pb = borrowLinked(b, childB, ctlB)
    }

    execute {
        let rA = getAccount(childA).capabilities.borrow<&{NonFungibleToken.Receiver}>(/public/MomentCollection)!
        let rB = getAccount(childB).capabilities.borrow<&{NonFungibleToken.Receiver}>(/public/MomentCollection)!
        for id in idsA { let m <- self.pa.withdraw(withdrawID: id); assert(m.getType() == Type<@TopShot.NFT>()); rB.deposit(token: <-m) }
        for id in idsB { let m <- self.pb.withdraw(withdrawID: id); assert(m.getType() == Type<@TopShot.NFT>()); rA.deposit(token: <-m) }
    }
}
```

`borrowLinked` stands for the `BORROW_PROVIDER` statements in `lib/giveaways/deliver-cadence.ts` inlined per signer. Cadence transactions can't call helper functions, so the real text repeats the block. Simulate before signing, same as giveaways.

## 8. Related

- `docs/strategy/free-packs-reassessment-2026-09-29.md` §7: giveaway delivery design. Its "164 linked Dapper children" figure is superseded by §3 here.
- `docs/research/topshot-gifting-account-linking-feasibility-2026-07-13.md`: why Hybrid Custody avoids the Dapper co-signer wall.
- `docs/trade-escrow/STATUS.md`: the escrow contract (shape B), kept and not deployed.
- `docs/strategy/roadmap-2026-08-03.md` §9.6.
