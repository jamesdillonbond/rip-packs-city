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

⚠ **And it carries a live signing bug.** `lib/breaks/server-authz.ts:63,65` uses `new EC("p256")` (secp256**r1**) + `new SHA3(256)`. The actual hot wallet `0x3aa11c84d776838f` is **ECDSA_secp256k1 / SHA2_256**. The code matches neither the wallet nor its own comment on line 11-12. `__tests__/breaks-server-authz.test.ts:7` pins the *wrong* behavior and only asserts the signature is 128 hex chars — never that it verifies. It has never run against mainnet, so this has never surfaced. **Any revival of this path must fix the curve first.**

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

### 2.1 The contract side is easy — easier than `RPCTradeEscrow` suggests

`RPCTradeEscrow` commits each side to a single `Type` (`cadence/contracts/RPCTradeEscrow.cdc:135-136`, asserted at deposit `:254-258`). That is a **design choice in that contract**, not a Cadence limitation. A `Pack` resource escrowing `@[{NonFungibleToken.NFT}]` holds heterogeneous NFTs natively — TopShot + AllDay + Pinnacle in one array is fine.

Do **not** try to derive `RPCPacks` from `RPCTradeEscrow`. Wrong shape twice over: single-Type, and a symmetric 1:1 barter where a pack sale is one-sided.

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

## 5. Recommendation

Unchanged in direction from the base doc, sharpened by a month of data:

1. **Ship Shape A** — the FMV-backed "is this drop worth it" board over Vaultopolis's open API. 2–3 days, zero custody, and it's now *better* than when scoped (§1.1). It tests whether anyone cares about pack intelligence before a dollar of inventory is bought.
2. **Decide the chance question before any contract work.** Transparent lots and sealed randomized packs are different products with different legal surfaces, and the decision changes the contract, the rail, and the TAM. Making it after `RPCPacks` is written is expensive.
3. **Don't start Shape B until the 50+ WAU gate is met.** At ~31 sessions/7d and ~108 linked wallets, a pack product would be selling to a market RPC can measure and that is currently about a hundred people.
4. **If Shape B ever starts:** fix the `server-authz.ts` curve bug, re-fund payer wallet `0x73f55c4450b8d466` and un-pause its balance cron, and treat multi-chain as a separate program under shape (a).

**The honest summary of "what would it take":** ~3–4 focused engineering weeks, inventory capital, an external Cadence security review, a goods-checkout path that doesn't exist yet, and a legal opinion on the chance mechanic — sold into a market of roughly 100–300 wallets. The engineering is the cheap part and always was.

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
