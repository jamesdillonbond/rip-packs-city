# Flow on-chain intelligence — why RPC got blindsided, and the fix — 2026-06-09

Written autonomously overnight after Trevor's directive: RPC is a "Flow blockchain digital collectibles intelligence platform" yet learned about dapper.market — Dapper's new custodial bulk-buy marketplace — from a third party, not from its own data. For an intelligence platform, that's the gap to close. This doc diagnoses the miss, gives the Flow-transaction mental model RPC was missing, and lays out a concrete capability so it doesn't happen again. It also rolls up the six work items from this thread with decisions and a build order. The execution specs live in the companion handoff `docs/handoff-2026-06-09-onchain-intelligence-and-fixes.md`.

---

## 1. Why we got blindsided (the uncomfortable part)

dapper.market launched and started doing real volume, and **RPC's data showed nothing unusual** — because dapper.market isn't a new contract. It's a new *front-end* that settles through the **same `TopShotMarketV3` marketplace contract** RPC already indexes. Every dapper.market purchase lands in `sales` as `marketplace='topshot', source='onchain'`, identical to a sale made on nbatopshot.com. I confirmed this directly: Trevor's three dapper.market buys are in `sales_2026` right now, indistinguishable from any other Top Shot sale.

So the miss wasn't a broken pipeline. It was a **conceptual blind spot**: RPC monitors *its own pipelines' health* (are the crons green, is FMV fresh) but has no monitoring of *the on-chain world those pipelines observe* — no awareness of new contracts, new execution patterns, or new venues moving the collections it tracks. RPC watches the instruments; it doesn't watch the weather.

Two specific consequences fell out of the same blind spot, both real and both fixable:

- **RPC captures the seller of every Top Shot sale but never the buyer** (`buyer_address` is hardcoded `null` — 100% of ~70k TS sales/month). It reads the `MomentPurchased` event, which carries the seller, and never decodes the buyer from the same transaction's `Deposit` event. (All Day and Flowty *do* resolve the buyer; Top Shot, the flagship, doesn't.)
- **RPC discards the transaction-level signers** (proposer / payer / authorizer). Those are exactly the fields that would have made dapper.market visible: its purchases are proposed and authorized by Dapper's DUC treasury `0xead892083b3e2c6c` and gas-paid by `0x18eb4ee6b3c026d2`. A new venue shows up as new signer accounts. RPC never looks at them.

The lesson generalizes: **an intelligence platform has to capture and watch the structural metadata of the transactions it ingests, not just the payload it currently needs.** The buyer and the signer accounts were always in every transaction RPC indexed; RPC just threw them away.

---

## 2. The mental model RPC was missing: how a Flow marketplace transaction is built

This is the reference so we're never again surprised by "wait, how is that even possible." Worked from Trevor's actual dapper.market purchase (tx `4f2920cb…`, Odyssey Sims, $5).

A Flow transaction has three signer roles, and they can be three *different* accounts — this is the key Flow primitive that custodial marketplaces exploit:

- **Proposer** — supplies the sequence number (like a nonce). For dapper.market: `0xead892083b3e2c6c` (Dapper's DUC treasury).
- **Authorizer(s)** — the accounts whose storage the transaction's `prepare` block can touch. dapper.market: `0xead892083b3e2c6c` again — it withdraws the payment from the treasury's `DapperUtilityCoin` vault.
- **Payer** — pays gas. dapper.market: `0x18eb4ee6b3c026d2` (a Dapper ops account).

Crucially, **the buyer's wallet is none of these.** The buyer (`0xbd94…`, Trevor) appears only as the *recipient*: the moment is deposited into the buyer's `/public/MomentCollection` capability, and on Flow **depositing an NFT into someone's public receiver requires no signature from them.** So Dapper signs and pays the entire transaction from its own accounts, debits the buyer's pre-funded off-chain "Dapper Balance," and drops the NFT into the buyer's wallet. No wallet popup, no buyer gas. That's why three moments clear in two seconds — three independent `TopShotMarketV3.purchase()` transactions fired in parallel from Dapper's backend, across two consecutive ~1-second blocks.

The money path inside the transaction: 5 DUC withdrawn from the treasury vault → split 4.75 to the seller / 0.25 (5% fee) → both routed through `TokenForwarding` (`0xe544175ee0461c4b`) into Dapper's settlement accounts. **DapperUtilityCoin (DUC)** is Dapper's USD-pegged in-house token; users never hold it directly — it's the internal settlement rail.

Contracts in play (all already in CLAUDE.md, now connected to the mechanism):
- `TopShotMarketV3` + legacy `Market` (V1) at `0xc1e4f4f4c4257510` — the Top Shot marketplace. dapper.market, nbatopshot.com, and direct on-chain buyers all settle here. **This is why front-end attribution requires the signer accounts, not the event.**
- `DapperUtilityCoin` `0xead892083b3e2c6c`, `TokenForwarding` `0xe544175ee0461c4b`, NFTStorefront V1 `0x4eb8a10cb9f87357` (native AllDay/Golazos/UFC), V2 Flowty fork `0x3cdbb3d569211ff3` (dormant).

The takeaway for monitoring: **the same contract can host many front-ends; you tell them apart by who signs and pays.**

---

## 3. The capability: RPC Flow on-chain intelligence

Four layers, smallest/safest first. Each is independently valuable; together they close the blind spot and turn it into a differentiator.

### Layer A — capture what we already throw away (foundational)
Extend the sales indexer to record, per sale: the **buyer** (decode `Deposit.to` from the same transaction — the All Day pattern already in `lib/dapper-v1-tx-decode.ts`) and the **execution accounts** (`payer`, `proposer` from `/v1/transactions/{id}`). Two new columns + a decode step. This is the single highest-leverage change: it fixes the buyer gap *and* lays the data foundation for venue detection. Spec: handoff Items 1 + 2.

### Layer B — detect new venues automatically (the "never get surprised" core)
Once execution accounts are captured, a cheap monitor profiles the distribution of payer/proposer accounts behind Top Shot sales over time. A **new or rapidly-growing signer account = a new execution venue or tool** — exactly the signal dapper.market would have tripped. This becomes a `pipeline_runs`-logged check and a row on the ops dashboard: "N% of 7d TS volume flows through previously-unseen execution accounts." It would have surfaced `0x18eb…`/`0xead…` climbing.
- Honest caveat: this cleanly flags *new* venues. Whether it perfectly separates dapper.market from the nbatopshot.com app depends on whether they use distinct signer accounts (unverified — both are Dapper-custodial and may overlap). The robust, true value is **new-account detection**, which is venue-agnostic and is the part that was missing.

### Layer C — the ecosystem watch (catches what's not yet in our data)
Layer B only sees venues that route through contracts RPC already indexes. dapper.market did — but the *next* surprise might be a brand-new contract (a new marketplace, a new chain bridge, a Candy/Solana development). So a recurring **Flow ecosystem watch** (scheduled task, created tonight — see §5) periodically sweeps for: new contracts interacting with the Top Shot / All Day / Pinnacle / pack contracts, Dapper/Flow ecosystem announcements, and anomalies in RPC's own sales (volume shifts, new dominant sellers/execution accounts), and reports anything novel. This is the human-in-the-loop backstop that would have caught dapper.market from the *outside* even before it showed in our data.

### Layer D — turn it into product (the differentiator)
Once RPC knows which execution venue drives each sale, it can publish something **no other tool has**: Flow market-structure intelligence — "what share of Top Shot secondary volume now flows through dapper.market vs the legacy app vs direct," trended over time. That's a genuinely novel `/insights` surface, squarely on RPC's intelligence-first thesis, and it directly markets the platform's edge: *we see the market's plumbing, not just its prices.* Gated behind Layers A–B and the usual traction bar; noted as the upside, not a now-build.

---

## 4. The six work items from this thread — decisions + build order

All diagnosed this session (some via parallel research agents). Specs in the handoff.

1. **Buyer resolution (Top Shot) — BUILD (high priority).** 100% of TS sales are buyer-blind; `app/api/sales-indexer/route.ts:538` hardcodes `buyer_address: null`. Fix = decode `Deposit.to` (All Day pattern) forward + a backfill route for history. This is Layer A and unblocks all buyer-side analytics (top buyers, accumulation, cohorts). Handoff Item 1.
2. **Execution-account capture — BUILD (high priority, pairs with #1).** Same decode pass; store `payer`/`proposer`. Powers Layers B–D. Handoff Item 2.
3. **Usernames instead of addresses — BUILD.** RPC already built ~70% of this and abandoned it (`wallet_usernames` cache, `analytics_resolve_usernames` RPC, `useResolveUsernames` hook, even the TS `searchUsers`-by-address GQL). The gap is *population* (57 rows, ~1% of live addresses) and *wiring* (~8 public surfaces still show raw `0x…`). Build = a resolver cron/route (via topshot-proxy) + broaden the resolver + a shared `<UserLabel>` component. Handoff Item 3. (Note: buyer resolution #1 makes the buyer side of sales history *have* an address to turn into a username — the two compound.)
4. **Pack EV accuracy — FIX, but REVIEW-GATED (pricing logic).** Real bug found: **depletion survivorship bias.** EV is computed over the *remaining* pool, so mostly-opened packs show their leftover chases as if they were the whole pack — a $4 pack reads $370 EV / 92.5x, and the "confidence" flag misses it because coverage is 100%. 98.7% of TS packs are ≥80% depleted. The arithmetic is correct; the *model* is wrong. Fixes (survivor gate + flag re-key + weighted-coverage display) are mostly DB view migrations, but this is core pricing logic — per our own restraint rule it gets shipped only with Trevor's sign-off, not autonomously. Handoff Item 4 + full diagnosis.
5. **Mobile moment thumbnails — FIX.** Root cause: the Collection and Sniper *mobile card* layouts simply omit the `<img>` (desktop tables include it); the thumbnail URL is already in the data. Pure additive markup. Handoff Item 5.
6. **Pack page dual-link — PARTIAL / feasibility-limited.** Unlike moments (which deep-link by on-chain id), neither side of a pack link is cleanly buildable: dapper.market keys pack detail by a Dapper-internal id (`?packDetail=8530`) RPC can't derive, and the native TS pack URL is a primary-drop page that 404s for sold-out packs (All Day has none in scope). Recommendation: a "Browse packs on Dapper" link to the league pack grid (`dapper.market/<league>/search/packs`) is the most that's honestly buildable — weaker than the moment dual-link. Handoff Item 6 documents the constraint so we don't ship a broken deep-link.

**Build order:** Items 1+2 first (one decode pass, foundational, unblocks monitoring + analytics + the username buyer-side). Then 3 (usernames) and 5 (mobile thumbnails) — independent, high visible value. Then 4 (pack EV) on Trevor's review. 6 (pack link) is optional/low-value given the constraints. Monitoring Layers B–C ride on 1+2.

---

## 5. What shipped tonight vs what's queued

**Shipped autonomously (low-risk only):**
- The **Flow ecosystem watch** scheduled task (Layer C) — read-only, recurring, reports novel on-chain/ecosystem developments. Keep-or-kill at Trevor's discretion; details in the morning summary.

**Deliberately NOT shipped autonomously (correctly held for review/CC):**
- Pack EV fixes — pricing logic, needs Trevor's call on the EV definition (renorm-on-remaining vs expectation-on-original-distribution).
- Buyer/execution-account capture, username populator + UI, mobile thumbnails, pack link — all route/.tsx/indexer code Cowork can't push → the handoff.
- The username SECDEF-resolver broadening — safe but a function rewrite on a public route; not worth an unattended regression risk for a ~100-name gain. Folded into the handoff.

This is the disciplined line: stand up the monitoring (the systemic ask), hand off everything that's code or pricing with complete specs, and ship nothing risky while unattended.

---

## 6. The one-sentence version

RPC got surprised because it watches its own pipelines but not the on-chain world they observe, and it throws away the two fields (buyer, signer accounts) that would have made dapper.market visible — so the fix is to capture those fields, monitor for new execution venues and new contracts, and (eventually) sell the resulting market-structure view as the differentiator only an on-chain intelligence platform can offer.
