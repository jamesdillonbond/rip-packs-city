# Reverse-engineering Top Shot's "bulk purchasing" (Quick Buy) — 2026-07-12

Trevor's most recent buys on `0xbd94cade097e50ac` were made with Top Shot's newer
bulk-buy UI. This doc reverse-engineers what that feature actually does on-chain,
using our own indexed `sales` data (buyer/seller/price + `payer_address` /
`proposer_address`, all populated by the on-chain decode in
`lib/chains/flow/dapper-v1-tx-decode.ts`). Flow REST and the public explorers are
policy-blocked from this environment, so the raw Cadence script bytes weren't
pulled — but the signer fingerprint + event grain we already capture is enough to
fully characterize the mechanism.

## TL;DR

- **It is not an atomic multi-buy.** There is **no** on-chain transaction that
  purchases N moments at once. "Bulk purchase" = Dapper's backend **fires N
  independent single-moment purchase transactions back-to-back**, several landing
  per block.
- **The product name is "Quick Buy"** (Top Shot support: a faster purchase flow
  with "no pop-up windows or additional tabs," rolling out to collectors). The
  bulk UI is a multi-select layer that enqueues many Quick Buys.
- **Every purchase tx is co-signed by Dapper.** For all of Trevor's bulk buys (and
  ~98% of *all* Top Shot marketplace volume in the last 24h):
  - **payer** = `0x18eb4ee6b3c026d2` (Dapper storefront / gas-payer account — pays
    all gas; the buyer pays $0 in FLOW)
  - **proposer** = `0xead892083b3e2c6c` (Dapper's DapperUtilityCoin account — owns
    the transaction sequence number)
  - **authorizer** = the buyer's Dapper-custodied wallet (`0xbd94…50ac`)
- Payment is in **DapperUtilityCoin (DUC)**, split via TokenForwarding into
  seller-cut + royalty (the standard Dapper split our decoder already handles).

## Evidence (Trevor's wallet, indexed)

30 moments bought 2026-07-12, in two bursts (01:39:31 → 01:39:44, then 02:18:28 →
02:18:29), plus a 19-moment burst on 2026-07-10 22:44–22:46.

| Fact | Value |
|---|---|
| Moments per transaction_hash | **1** (30 distinct tx hashes, never shared) |
| Transactions per block | up to **4** (four tx share block-time `01:39:31.371`) |
| payer_address (all 30) | `0x18eb4ee6b3c026d2` |
| proposer_address (all 30) | `0xead892083b3e2c6c` |
| What was bought | cheapest commons across many different editions — WNBA Base Set + Base Set, tier COMMON, circ 4000, ~$0.26–0.28 each |
| Serials | scattered (975, 1336, 2119, 3449…) — **not** sequential → it's a *cheapest-listing sweep*, not "buy serial X" |

The 07-10 burst is the same signer fingerprint at a higher price band (19 moments,
avg $5.84), confirming one mechanism across price tiers.

### Site-wide, this is the dominant purchase path

Last 24h of `nba_top_shot` sales: **payer is `0x18eb4ee6b3c026d2` on 100% of rows.**
Proposer splits:

- `0xead892083b3e2c6c` (Dapper DUC) — **~2,285 moments** (Quick Buy / bulk lane)
- individual buyer wallets — a long tail of 1–6 moments each (classic
  single-purchase flow where the user's own wallet proposes; Dapper still pays gas)

So the Dapper-proposed Quick Buy path now carries the overwhelming majority of Top
Shot marketplace throughput.

## How the mechanism works (assembled)

1. User multi-selects listings (or a "buy the N cheapest" sweep) in the Top Shot UI.
2. Top Shot's backend generates one purchase transaction **per listing**, each on
   the marketplace/storefront purchase path, and **co-signs** each:
   - Dapper DUC account `0xead892083b3e2c6c` as **proposer** (sequence number),
   - Dapper storefront account `0x18eb4ee6b3c026d2` as **payer** (gas),
   - the buyer's custodied wallet as **authorizer** (approves moving DUC + receiving
     the moment).
3. Transactions are submitted rapidly and seal across consecutive blocks (~4/block
   observed). Each emits its own `TopShot.Withdraw`/`Deposit` + DUC
   `TokensWithdrawn` split — indistinguishable, per-tx, from a normal single buy.
4. The "bulk" experience is purely **client + backend orchestration** (a fan-out
   queue). There is no batching primitive on-chain.

Because each moment is its own sealed transaction, a bulk buy is **partially
fillable**: individual buys can succeed/fail independently (listing already sold,
price moved), which a true atomic batch could not do. That's a feature, not a bug.

## Should RPC implement it? (evaluation)

**Executing bulk buys in-app is blocked by the same wall as Cart and Trade Hub.**

- The whole UX depends on **being a Dapper co-signer** (proposer + payer). That
  requires Dapper developer / co-signer access — the exact dependency that shelved
  Cart (Known issues #1) and Trade Hub (#3), and gated by the still-pending Dapper
  dev access (#0). We are not a registered co-signer.
- Without co-sign, the only path is a self-custody FCL flow where the user signs
  **and pays FLOW gas on every single transaction** — unusable for sweeping 30
  commons, and **Top Shot-custodied wallets (the actual collectors) can't use FCL
  discovery at all** (Flow Wallet / Blocto don't custody TS accounts). So a live
  in-app bulk buy is effectively a non-starter until Dapper access lands.

**What is on-brand and buildable now (intelligence-first):**

1. **Bulk-buy *planner*** — "cost to complete this set" / "cheapest N across this
   filter" with a total, EV/FMV per moment, and deep-links out to Top Shot Quick
   Buy. All read-side; leverages our FMV + floor data. No co-sign needed.
2. **Bulk-buy *detection & attribution* in analytics** — we already store
   `payer_address` / `proposer_address`, so we can label Quick-Buy vs classic-buy
   activity, flag sweep bursts (many tx, one buyer, consecutive blocks), and surface
   "floor swept" / accumulation signals per edition. This is a genuine differentiator
   Top Shot's own site doesn't expose, and it's pure read intelligence.

**Recommendation:** do **not** pursue in-app bulk execution (same shelf as Cart).
Do consider (1) the planner and (2) sweep detection as read-side intelligence
features — both are consistent with the intelligence-first framing and need no new
external access.

## Which on-chain purchase path (template)

Our own sales indexer (`app/api/sales-indexer/route.ts`) keys Top Shot secondary
sales on **two** marketplace events, and Quick Buy / bulk buys arrive on the same
paths as any other purchase:

- `A.c1e4f4f4c4257510.TopShotMarketV3.MomentPurchased` (`marketplace = "topshot"`), and
- `A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted` (Dapper storefront).

Both are standard single-moment purchase transactions; the "bulk" wrapper just
fires many of them. The venue string is collapsed into `sales.marketplace`
(`topshot`) so the specific contract per row isn't stored — but every one of
Trevor's bulk buys carried the Dapper co-signer fingerprint above, i.e. the
Dapper-orchestrated Quick-Buy path regardless of which of the two purchase
contracts settled it. The literal Cadence bytes weren't pulled
(`rest-mainnet.onflow.org` + explorers are egress-policy-denied here); if we ever
want them, decode a hash from a Vercel/edge context via `decodeTopShotSaleTx`.
Sample hashes: `9e527ed3234ca55d6fed7b2647ed244dde84a2b8fdee142b12c50350c888b3e2`,
`c23e0b855b6ad869889a1b9e0349d1d6f89076baefef7298da07b99903a873fb`.

## Shipped (2026-07-12) — the two read-side intelligence features

Both recommendations were built and verified live against this DB.

1. **Floor-sweep (bulk-buy) detector** — `detect_topshot_sweeps()` sessionizes the
   Quick-Buy path (proposer = DUC) per buyer and emits a `floor_sweep` insider alert
   when one buyer sweeps ≥8 distinct editions in a burst (≥15 moments OR ≥$75).
   Wired into the hourly `run_all_insider_detectors` and renders on the existing
   InsiderSignals panels (alert_type is rendered generically → no UI change). Plus
   `get_edition_sweep_signal(edition_id)` for the per-edition accumulation share.
   Migrations `20260712190000` / `190500` / `191000`. Verified: caught Trevor's
   24-moment sweep; that Gabby Williams WNBA common shows 56% of its Quick-Buy sales
   were sweeps (27/48, 17 distinct sweepers).
2. **Set-completion bulk-buy planner** — `get_topshot_set_completion_plan(wallet,
   set_id)` returns the editions a wallet is missing from a TS set, each with the
   current floor (`badge_editions.low_ask`) + FMV, and set totals: cost to Quick-Buy
   the rest at floor vs its FMV. Exposed at `GET /api/topshot/set-plan`. Migration
   `20260712192000`. Verified: 533-play Base Set floors at $479.57 vs $484.48 FMV.

Remaining surfacing (needs a logged-in browser QA pass, not shipped autonomously):
a visible planner tab/page and an optional per-edition "being swept" badge on the
edition page (the `get_edition_sweep_signal` RPC is ready for it).
