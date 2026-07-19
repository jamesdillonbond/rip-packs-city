# RPC Packs — Addendum to the June Scope Doc

**Date:** 2026-07-18
**Base doc:** [repack-drops-feature-scope-2026-06-19.md](repack-drops-feature-scope-2026-06-19.md) — **read that first.** It reverse-engineers the Vaultopolis contract, specs `RPCPacks`, and estimates ~3–4 focused weeks + inventory capital + a security review. That spec still stands.
**Status:** Still scoping only. Nothing built.

This addendum covers three things the base doc doesn't: **what changed in the intervening month**, **multi-collection packs**, and **multi-chain packs** — plus a sharpened read on the legal exposure, which has moved materially since June.

---

## 1. Deltas since 2026-06-19

### 1.1 The base doc's one measured weakness is now fixed

§10.2 flagged that RPC's edition-level FMV priced the base edition, not the parallel — so RPC **undervalued the single most valuable card** in the live Vaultopolis drop (Wemby parallel, ~$23 actual vs ~$2.66 RPC). That gap is closed. Measured live 2026-07-18:

- **3,597** `::subID` parallel editions cataloged
- **3,574** of them carry an FMV computed in the last 7 days = **99.4% coverage**

Shape A (the intelligence board) is now strictly better than when it was scoped, and RPC's pool valuation would beat Vaultopolis's by more than the 19% measured in June.

### 1.2 Pack EV got materially more honest

Two 07-16 changes are directly load-bearing for a pack product:

- **Pool-completeness guard** — EV is refused (`pool_incomplete`) unless the slot pool `sum(drop_weight) >= 1`. No fabricated EV on chase-biased pools.
- **Actual EV (weighted mean) vs Typical Pull EV (weighted median)** — the gap between them *is* the lottery-shape signal. Mean overstates a pack whose value is concentrated in one grail.

This matters more than it looks: **the mean-vs-median split is the honest-pack-pricing edge.** Every pack operator quotes mean EV because it flatters the product. RPC is the only one positioned to publish both and say "the average pack is worth $8.26, the pack you will actually open is worth $3.20."

### 1.3 The delivery layer exists as code — but not in prod, and it's buggy

The `breaks` subsystem (`supabase/migrations/20260509120000_breaks_schema.sql`, `app/api/breaks/[id]/distribute`, `BREAK_MULTI_TRANSFER_TS`, VRF draft shuffle via `RandomBeaconHistory`) is a genuine RPC-owns-inventory-and-distributes-it system: cost-basis ledger, chunked 30-at-a-time transfers, idempotent, retryable.

**But:** verified live 2026-07-18, **no `break*` tables exist in the production database.** The migration is unapplied, the env vars (`HOT_WALLET_PRIVATE_KEY`, `BREAKS_ADMIN_TOKEN`) are absent from `.env.example`, and there is no UI or nav entry. It is v0 scaffold on disk.

⚠ **It carried a live signing bug — now FIXED (2026-07-19).** `lib/breaks/server-authz.ts:63,65` used `new EC("p256")` (secp256**r1**) + `new SHA3(256)`. Verified against Flow REST (`/v1/accounts/0x3aa11c84d776838f?expand=keys`), **both** keys declare `ECDSA_secp256k1` + `SHA2_256`, weight 1000, not revoked — so the code was wrong on **two** axes, not one (wrong curve *and* wrong hash family), and its own header comment was wrong too (claimed SHA3_256).

Why it survived: a wrong-curve signature is still a well-formed 128-hex-char string, and `__tests__/breaks-server-authz.test.ts` only asserted the *length*. Proven in a standalone harness — the old implementation also emitted exactly 128 chars, so the assertion could never have caught this. The path had also never run against mainnet.

Fixed to `secp256k1` + `sha256`, with the algorithms exported as named constants and the on-chain verification cited in the header. The test now verifies the signature **cryptographically** (validates under the correct config; provably fails under both the old curve and the old hash) instead of measuring its length.

### 1.4 Payments: subscription-only

Stripe is live but `mode: "subscription"` only (`app/api/stripe/checkout/route.ts:43`) — one recurring Pro plan. **There is no goods checkout, no order table, no refund path.** `break_spots.payment_intent_id` exists and nothing populates it. A pack sale needs either `mode: "payment"` (straightforward) or the on-chain FLOW/Storefront rail the base doc recommends (§4.2).

### 1.5 The credits shop is live and already models this

`shop_items` / `points_ledger` / `redemptions` are live with server-side integrity (redeem validates balance/stock/limit/status/verified-wallet in `redeem_shop_item()`; no endpoint accepts a points amount). Live counts:

- 10 shop items, types `cosmetic | merch | moment | pro` — **`moment` already exists as a redemption type**
- 282 points-ledger rows across **10 distinct users**
- **1** redemption ever, a cosmetic, auto-fulfilled. **Zero real assets have ever been delivered.**

So the shop rail is real but entirely untested against physical/on-chain fulfillment.

### 1.6 TAM moved, but not enough

The base doc's §10.1 measured the pack TAM. Re-measured 2026-07-18:

| Metric | June | Now | Read |
|---|---|---|---|
| Account-linked / hybrid-custody wallets | ~66 | **108 children / 114 parents / 117 links** | The self-custody-capable signal. Growing ~60%/mo but tiny. |
| RPC tracked wallets (wmc) | 261 | **296** | RPC's seeded population, not the market. |
| Active TS buyers 90d | 3,655 | **4,031** | Broad ceiling; most transact via Dapper/DUC, not FLOW. |

**The binding constraint is unchanged: the pack-buying market is the self-custody + FLOW-funded slice, which is ~100–300 wallets, not 4,031.** Vaultopolis itself reports ~300 active users. That is the whole addressable market today.

### 1.7 Go-live happened — and the traction gate is still unmet

The public un-gate shipped 2026-07-17. Per the 07-18 funnel work, RPC is at **~31 sessions / 7 days**. The standing gate — no monetization until **50+ WAU** — is not met, and a pack product is monetization with inventory risk attached. That gate was set for exactly this kind of decision.

---

## 2. Multi-collection packs

Not covered in the base doc (which is Top Shot throughout). Analysis:

### 2.1 The contract side is easy — and the reference already does it

**Confirmed by reading the deployed `VaultopolisPacks` source (Flow REST, 2026-07-19).** Its own header comment reads: *"Packs contain NFTs from multiple collections (TopShot, AllDay, TokenWrapper)."* Multi-collection is not a stretch goal for this product shape — it is how the working reference already operates.

The mechanism is a collection-agnostic descriptor struct:

```cadence
access(all) struct Collectible {
    access(all) let address: Address
    access(all) let contractName: String
    access(all) let id: UInt64
    // hashString() -> "A.<16-hex-address>.<ContractName>.<id>"
}
```

Any NFT on any Flow contract is addressable by that triple, so a pack's manifest spans collections for free.

`RPCTradeEscrow` commits each side to a single `Type` (`cadence/contracts/RPCTradeEscrow.cdc:135-136`, asserted at deposit `:254-258`) — a **design choice in that contract**, not a Cadence limitation. Do **not** derive `RPCPacks` from it: wrong shape twice over (single-Type, and a symmetric 1:1 barter where a pack sale is one-sided).

### 2.1a Correction — it is treasury-held, NOT escrow-in-pack

The June doc left this open (§2.6) and inferred escrow was possible; my first draft of this addendum recommended escrow-in-pack. **Reading the contract settles it: Vaultopolis is treasury-held.** The `Pack` resource holds only `hash`, `issuer`, `status`, `salt` — **no NFTs**. `open(id, nfts)` merely re-verifies the commit hash and emits `Opened`; the actual moments are delivered separately by the operator from its own account.

The practical consequence: **the commit-reveal proves the manifest was fixed at mint, but it does NOT prove the operator still holds the moments, nor does it deliver them.** A buyer is trusting the treasury either way. Escrow-in-pack remains the stronger design and a real differentiator — but it is a genuine contract-complexity increase over the reference, not the like-for-like clone the June doc implied.

The exact commit format is now known and implementable verbatim:

```
nftString  = comma-join( "A.<addr>.<Contract>.<id>" for each moment, mint order )
hashString = <saltHex> + "," + nftString
commitHash = SHA2_256( utf8(hashString) )
```

### 2.2 The real problem is the receiver, not the escrow

Each collection has its own storage/public paths. `open()` deposits into the buyer's receiver for *each* collection in the pack. **If the buyer has never initialized an AllDay collection, that deposit fails** — and a partial open is the worst possible failure mode.

Two fixes, both real work:
- **Init-on-open** — the buyer-signed `open` transaction creates and saves any missing collection before depositing. Clean, but it means `open` must know every collection's setup path and the tx gets long.
- **Pre-flight gate** — refuse the sale unless the buyer already has receivers for every collection in the pack. Simpler, shrinks an already-tiny TAM.

Init-on-open is correct. Budget it explicitly; it's the main multi-collection engineering cost.

### 2.3 FMV comparability is the honest blocker

A multi-collection pack priced on FMV is only defensible where FMV is deep. Current live depth (HIGH+MEDIUM confidence editions): **TS ~3,349**, **AllDay ~826**, **UFC 15**, **Golazos 4**. Pinnacle is render-keyed in a separate table (`pinnacle_fmv_history`) on a different grain entirely.

So: **TS + AllDay multi-collection packs are honestly priceable today. Golazos and UFC are not.** Pinnacle needs a cross-grain normalization layer before it can sit in a mixed pack. Putting a Golazos moment in a priced pack right now means guessing — which is the one thing RPC's brand can't survive doing.

### 2.4 A counter-intuitive point in favor

**AllDay is sunset** (no new Moments since 2026-05-13) and **UFC migrated to Aptos**. A finite, closed catalog is *ideal* repack inventory — supply can't be diluted under you, scarcity is knowable, and RPC has the deepest data on it. AllDay is arguably a better repack substrate than Top Shot for exactly the reason it looks worse: nobody's making more.

---

## 3. Multi-chain packs

**There is no honest version of a single pack spanning chains without either a bridge or a custodial IOU.** Three shapes:

| Shape | What it is | Cost |
|---|---|---|
| **(a) Per-chain packs, unified UI** | A Flow pack and a Solana pack are separate on-chain objects; RPC's UI presents one product line. | Zero new trust assumptions. **This is the answer.** |
| **(b) Custodial multi-chain pack** | The "pack" is a database row; RPC holds assets on N chains; open = N separate transfers. | Loses on-chain provable fairness entirely. RPC becomes a full custodian on N chains with N key-management surfaces. This is what most "multi-chain" products actually are. |
| **(c) Bridged / wrapped** | Wrap foreign assets onto one chain. | Bridge risk stacked on custody risk. Don't. |

**Current reality:** every write path in the repo is Flow/Cadence. Solana is read-only (Helius DAS indexing, `lib/chains/solana/das.ts`). The chain-abstraction work (Phases A–F) solved *schema* portability — `collections.chain`, the `collection_chains` view — not *write* portability.

So multi-chain packs are not a v2 feature of a Flow pack product. They are **a second write stack, a second treasury, a second key-management surface, and a second security review.** Sequence them as a separate program, and only under shape (a).

---

## 4. Legal — this has moved, and it's the actual gate

The base doc lists this as risk #4, "worth a legal read." That was fair in June. As of July 2026 it is understated.

### 4.1 What changed

- **February 2026: the New York Attorney General sued Valve**, alleging CS2 loot boxes are "quintessential gambling" under the NY Constitution and Penal Law. The legal hinge in that case — and in the academic literature — is **transferability of contents**. Transferability is what establishes that the contents are a *prize* with real-world value rather than in-game confetti.
- **An NFT pack is the maximal transferability case.** Valve's items are transferable inside Steam. NFT pack contents are transferable everywhere, on a public order book, with a public price history.
- Brazil banned loot box sales to minors effective March 2026; the EU's Digital Fairness Act is moving; Belgium and the Netherlands already treat paid loot boxes as gambling. No US federal law, and most state action runs through consumer-protection rather than gambling statutes — but NY just took the gambling route directly.

The standard test is **consideration + chance + prize**. A sold, randomized NFT pack hits all three without much argument.

### 4.2 The RPC-specific aggravator

This is the part that isn't in any general analysis and is worth sitting with:

**RPC publishes FMV.** The contested prong in most loot-box cases is whether the contents have real-world monetary value. RPC would be operating a randomized pack sale *while simultaneously running an authoritative public appraisal service that proves the contents' dollar value* — and, per §1.2 above, publishing the mean-vs-median gap that quantifies the lottery shape.

**RPC's core product is evidence against RPC's pack product.** Vaultopolis doesn't have this problem to the same degree; they don't run an appraisal engine. This is not a reason RPC can't do it — it's a reason RPC's version carries more exposure than a competitor's identical product, which is the opposite of the usual "they're doing it, so it must be fine" read.

### 4.3 It also contradicts a rule you already set

The rewards program was scoped **off-chain points → prizes, NO physical, NO chance** — deliberately, to stay clear of raffle/sweepstakes law. A randomized pack product is the same exposure class you already ruled out for a lower-stakes feature. Worth reconciling consciously rather than by accident.

### 4.4 The reframe: you can delete the chance prong

**Sell transparent lots, not sealed randomized packs.**

> "This bundle contains exactly these 3 Moments. RPC FMV: $47. Price: $38."

No chance → no gambling analysis at all. It's an e-commerce transaction. And it is *more* on-brand, not less: RPC's entire identity is honest pricing. The intelligence company's version of a pack is the one where **you know exactly what you're getting and exactly what it's worth**, and the value proposition is a verifiable discount to FMV rather than a dopamine hit.

What you keep: curation, inventory turnover, discount-to-FMV as the pitch, and RPC's actual moat (knowing what things are worth better than anyone). What you lose: the rip. That's a real product loss — the rip is the fun — but it's the entire legal surface.

It also *widens* the market: with no fairness mechanism to prove, there's less reason to insist on the on-chain sealed-pack rail, which is what caps TAM at the self-custody+FLOW slice.

Note the middle options don't help: "guaranteed minimum FMV per pack, contents vary" is still chance. The fork is binary — **chance (needs counsel before a line of contract code) or no chance (ship it as commerce).**

---

## 5. The measured market — Vaultopolis has sold 66 packs, ever

The June doc estimated the TAM by inference. It can now be **measured directly** from the operator's own open API, indexed into `external_pack_drops` (2026-07-19):

| Drop | Created | Packs | Sold | Sell-through | Price (FLOW) |
|---|---|---|---|---|---|
| 1 Test Drop | May 7 | 5 | 5 | 100% | — |
| 2 Test Drop 2 | Jun 9 | 21 | 21 | 100% | 5 |
| 3 Finals Pack | Jun 13 | — | — | **cancelled** | 170 |
| 4 Finals Pack | Jun 13 | 15 | 12 | 80% | 170 |
| 5 Heat Check | Jun 25 | 20 | 20 | 100% | 432 |
| 6 First Class | Jul 9 | — | — | **cancelled** | 432 |
| 7 WNBA First Class | Jul 12 | 40 | 8 | **20%** | 369.4 |

**Lifetime: 66 packs sold (40 excluding the two test drops), 13,740 FLOW gross ≈ $365 at $0.0266/FLOW.** Two of seven drops were cancelled before minting.

The shape of that table is the whole story. Drop 5 sold out at 20 packs. Drop 7 doubled the supply to 40 and sold **8** — the first genuine scale-up attempt hit a wall immediately. **The demonstrated market clears roughly 20 packs per drop**, and that is with a live product, an existing user base, and no competition. This is the empirical version of §1.6's inference, and it is considerably harsher: the constraint isn't "hundreds of wallets," it's ~20 buyers per drop.

For calibration, RPC's *existing free intelligence surfaces* serve more people than that in a day.

### 5.1 RPC prices their pools well — and finds the thing they hide

Scored via the new `score_external_pack_drop()` (§6):

| | Drop 4 | Drop 5 |
|---|---|---|
| RPC-priced pool | **$83.94** | **$233.24** |
| Operator's own pool | $78.13 | $248.84 |
| RPC vs operator | **+7.4%** | **−6.3%** |
| Coverage | 45/45 (100%) | 59/60 (98.3%) |
| **Actual EV/pack** (mean) | **$5.60** | **$11.66** |
| **Typical EV/pack** (median) | **$3.00** | **$6.09** |
| Lottery ratio | 1.87 | 1.91 |
| Price paid | 170 FLOW ≈ $4.52 | 432 FLOW ≈ $11.49 |

Two findings worth keeping:

1. **RPC disagrees with the operator in both directions** (+7.4% and −6.3%), which is the signature of an independent valuation rather than a rescaled copy. Coverage is ~99% with zero manual work.
2. **The median pack opens at roughly half the advertised mean** — $3.00 vs $5.60, $6.09 vs $11.66, a ~1.9× lottery ratio on both drops independently. Both drops are honestly priced *at mean EV*, so a buyer reading the headline number is getting a fair deal on average and a below-price pack most of the time. **No pack operator publishes this. RPC can.** That is the single most defensible piece of pack intelligence RPC owns, and it needs no inventory, no contract, and no legal opinion to ship.

### 5.2 The ~20-packs ceiling is partly self-imposed — and RPC need not inherit it

The June doc's §9.3 identified the binding constraint correctly: to buy a Vaultopolis pack you must sign a **FLOW Storefront purchase**, so you need a FLOW-funded, FCL-signable wallet. That is a *purchase-side* wall, and it is the most likely explanation for drop 7 selling 8 of 40.

**Delivery, though, is a separate question — and it is not walled.** The June doc asserted this (§9.1: *"any account's TopShot collection exposes a public deposit receiver… including a fully Dapper-custodial collection"*) but never probed it. Every strategy doc and the ledger repeat the claim; no recorded measurement backs it, and `BREAK_MULTI_TRANSFER_TS` panics an entire 30-recipient chunk if it's wrong for one address.

**Now measured, n=235.** `app/api/wallet-backfill/route.ts:30-37` — the writer behind `wallet_moments_cache` — walks Top Shot wallets with:

```cadence
let acct = getAccount(address)
let col = acct.capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
if col == nil { return [] }
return col!.getIDs()
```

An unauthenticated public-account read that yields `[]` when the capability is absent. Live counts (2026-07-19): of **244** Top Shot wallets in wmc, **235 have never appeared in `linked_accounts` in any role** — no hybrid-custody setup, no self-custody parent — and they hold **1,558,636 moments**. Those rows can only exist if the public capability borrow succeeded 235 times against ordinary, never-linked Top Shot accounts. (Separately, 9 known Dapper-custodial *children* hold 50,162 moments read the same way, while their self-custody parents hold **0** — moments live in the custodial account, exactly as the model predicts.)

**Residual inference, stated honestly.** The walk borrows `TopShot.MomentCollectionPublic`; the delivery paths borrow `NonFungibleToken.CollectionPublic` (`break-transactions.ts:34,63`) and `NonFungibleToken.Receiver` (`gift.ts:77`). These resolve against the same published capability *if* it is published as the concrete `&TopShot.Collection` — which the 2026-05-09 Cadence MCP contract audit recorded (`docs/audits/purchase-moment-2026-05.md:203`: *"published cap type is concrete `&Collection`"*), and a concrete-type capability is borrowable as any interface the type conforms to. Standard Cadence semantics, high confidence, but reasoning rather than measurement.

`/api/wallet-preflight` borrows exactly `NonFungibleToken.CollectionPublic` and would close this in one request, but it is not on the `proxy.ts` public allowlist and I did not modify auth config to reach it. **Cheapest close: one real low-value gift on mainnet via the live `/dashboard/gift` flow** — `moment_gifts` currently has **0 rows**, so that path has never actually executed end-to-end. Two minutes and one common moment converts the last inference into a measurement. *(Operator item — see §7.)*

**Why this matters more than it sounds.** If delivery works to any Top Shot account, then selling for **credits or Stripe** (off-chain) and delivering **on-chain** removes the buyer-side FLOW/self-custody requirement entirely. The buyer needs no FLOW, no FCL wallet, no signature — just a Top Shot account that can receive. **The ceiling that capped Vaultopolis at ~20 packs per drop is a property of their FLOW-Storefront rail, not of the product.** RPC's addressable pool on an off-chain-payment rail is not the ~108 linked wallets of §1.6 — it is closer to every Top Shot account, of which RPC alone indexes **4,031 active buyers in 90 days**.

That is the single most important finding in this document, and it points the same direction as §4.4: **transparent lots, off-chain payment, on-chain delivery** is simultaneously the legal-clean shape *and* the large-market shape. The sealed FLOW-priced pack is both the risky one and the small one.

---

## 6. What shipped this session

Fork-independent work, live on `main` / prod (revert paths in the ledger):

- **`external_pack_drops` + `external_pack_drop_moments`** — RLS on, anon SELECT-only, indexed on `(operator, drop_id)` and `edition_id`. Seeded with all 7 Vaultopolis drops; drops 4 and 5 carry full moment-level composition (105 moments, 104 mapped to RPC editions = 99.0%).
- **`upsert_external_pack_drop(operator, payload, meta)`** — SECURITY DEFINER, explicitly revoked from `anon`/`authenticated`. Takes the operator's composition JSON verbatim, derives `setID:playID[::subID]`, and joins to `editions`. This is the shape a cron ingest calls.
- **`score_external_pack_drop(operator, drop_id)`** — SECURITY INVOKER (reads only anon-readable tables, so no privilege escalation), granted to `anon`. Returns RPC pool, operator pool, the delta, Actual vs Typical EV, top-moment concentration, lottery ratio, sell-through, and coverage.
- **`lib/breaks/server-authz.ts` signing fix** (§1.3) + a test that verifies signatures cryptographically.

**Not shipped, deliberately:** no public `/insights/pack-drops` page. Given §5, a public board about a competitor who has sold 66 packs would draw ~no traffic and cost a route, an OG card, and sitemap surface. The *engine* is the durable asset; it prices any lot, RPC's own included. Ship the page only if a drop is actually worth writing about.

---

## 7. Recommendation

Revised in light of §5 — the direction holds, the urgency inverts.

1. **The sealed FLOW-priced pack is not the opportunity.** 66 lifetime packs, ~$365 gross, a failed 2× scale-up, two cancelled drops. Building `RPCPacks` to compete for that would be ~3–4 weeks, inventory capital, and a security review chasing a demonstrated ceiling of ~20 buyers per drop — a ceiling that §5.2 shows is largely an artifact of the FLOW/self-custody purchase rail.
2. **The pricing engine was the valuable part, and it now exists.** One session, zero inventory, works on any lot — third-party or RPC's own.
3. **The shape to build, if anything: transparent lots · off-chain payment · on-chain delivery.** It deletes the chance prong (§4.4), needs no contract, no commit-reveal, and no audit; it lists as a `shop_items` row against the live credits rail or Stripe `mode:"payment"`; and per §5.2 it addresses every Top Shot account rather than the ~108 self-custody wallets. It is the only version where RPC's FMV engine is an asset rather than the plaintiff's exhibit — the pitch is literally *"here is exactly what you get and exactly what it's worth."*
4. **The 50+ WAU gate still binds** and is still the right gate. At ~31 sessions/7d the constraint is demand for RPC, not RPC's ability to build this.

### 7.1 Next concrete steps, in order

1. **OPERATOR (Trevor, ~2 min):** send one low-value moment via `/dashboard/gift` to a Dapper-custodial account. `moment_gifts` has 0 rows — the gift path has never executed end-to-end. This converts §5.2's last inference into a measurement and simultaneously smoke-tests the live gifting flow.
2. **If that lands:** generalize `score_external_pack_drop()` into a lot-pricing RPC that takes an arbitrary moment set (the scoring math is already collection-agnostic; only the input shape changes).
3. **Then, and only then:** inventory + cost-basis tracking, and a `shop_items` lot listing. Re-fund payer wallet `0x73f55c4450b8d466` and un-pause its balance cron before any Cadence write ships.
4. **Do not** start the `RPCPacks` contract, commit-reveal, or multi-chain work. Multi-chain stays a separate program under shape (a) (§3).

**Revised answer to "what would it take":** for the sealed randomized pack — ~3–4 engineering weeks, inventory capital, a Cadence audit, a goods checkout, and a legal opinion, to reach a market that has demonstrably absorbed 66 packs total. For transparent lots on an off-chain-payment rail — days of work on rails that already exist, aimed at a market roughly 40× larger. The engineering was never the hard part; the rail choice is.

---

## 6. Sources

- [From Card Packs to Loot Crates: The NYAG's Case Against Valve and the Future of Digital Collectibles](https://iplawincontext.com/2026/03/16/from-card-packs-to-loot-crates-the-nyags-case-against-valve-and-the-future-of-digital-collectibles/)
- [New York and Washington Take On the Final Boss of Loot Boxes](https://technologylaw.fkks.com/post/102mnkh/new-york-and-washington-take-on-the-final-boss-of-loot-boxes)
- [Loot Boxes, Regulation, and Where the Line Sits in 2026](https://programminginsider.com/loot-boxes-regulation-and-where-the-line-sits-in-2026/)
- [Does Your Blockchain Game Loot Box Constitute Gambling? (Pillar Legal)](https://www.pillarlegalpc.com/wp-content/uploads/2024/07/Pillar-Legal-Does-Your-Blockchain-Game-Lootbox-Constitute-Gambling-2023-6-12.pdf)
- [Illegal video game loot boxes with transferable content on Steam (longitudinal study)](https://www.tandfonline.com/doi/abs/10.1080/14459795.2024.2390827)
- [Vaultopolis](https://vaultopolis.com/)

_Not legal advice — I'm not a lawyer. §4 is a summary of the current regulatory picture, and the chance-mechanic decision warrants an actual opinion from counsel before any contract work._

_End of addendum._
