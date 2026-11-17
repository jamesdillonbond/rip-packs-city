# Build Candidates from Competitive Recon — 2026-05-30

Three intelligence-surface specs derived from [competitive-recon-2026-05-30.md](competitive-recon-2026-05-30.md). These are **proposals for evaluation**, not committed work. All three are read-only public `/insights`-class surfaces in the same family as the shipped `/insights/squeeze` board (commit `61d53b3`), and all are intelligence-first — none touch buy flow, monetization, or the Pro paywall (gated by the standing "no paywall until 50+ WAU" rule).

Each spec lists: the competitive gap it closes, the RPC data that already exists to power it, a proposed surface, a phased scope, and the QA/security checklist items (per the `rpc-insights-qa` skill) that gate ship.

**Cross-cutting guardrails (apply to all three):**
- Public route + page + OG image triad, brand tokens only (`var(--rpc-red)`, `var(--font-display)`, `var(--font-mono)`), `loading.tsx` skeleton, canonical tag, sitemap entry.
- Backing views must be `security_invoker`, RLS-on, anon `SELECT`-only (per [[rpc-public-table-rls-grant-hole]] / [[secdef-anon-grant-regression]]). Verify with direct catalog SQL, not `get_advisors` ([[get-advisors-output-too-big]]).
- Surface FMV **confidence** wherever a price appears — it's RPC's honesty edge over LiveToken/MomentRanks' single number.
- Cowork can ship the DB migration + view; the route/page/OG `.tsx` goes through a Claude Code handoff ([[cowork-deploy-split]]).

---

## Spec 1 — RPC Index (highest-value, highest-effort)

### Gap
Card Ladder's **Index / CL50** is the single biggest daily-return retention surface in collectible intelligence ("the S&P 500 for cards"). CryptoSlam, MomentRanks, and LiveToken all show a market-cap or player-market-cap view; **no Flow sports-collectible tool ships a real, charted index of the whole market.** This is a defensible, "check it every morning" surface.

> **Methodology note (corrected 2026-05-30):** Card Ladder's CL50 is a **simple average** of 50 editorially-curated cards (sum ÷ 50), NOT market-cap weighted — and it's explicitly "not designed to represent the hobby as a whole." Their *whole-market* indexes and their per-card "Card Ladder Value" price model are separate products. This gives RPC a genuine design choice rather than a default: a **market-cap-weighted** index (Σ FMV × circulation) is more rigorous and more defensible than a simple average, and RPC has the circulation + FMV data to do it properly — so RPC can ship the index Card Ladder *didn't* (true cap-weighting) rather than copying the simple-average CL50. Recommend cap-weighting for the whole-market/sub-collection indexes, and a curated simple-average "RPC 50" as the marketing-friendly flagship alongside it.

### RPC data that already exists
- `sales` (year-partitioned, 2020–2026) — the transaction history to compute volume-weighted value.
- `fmv_snapshots` (confidence-tagged, latest-per-edition via `DISTINCT ON (edition_id) … ORDER BY computed_at DESC`) — per-edition fair value.
- `editions` carries `circulation_count` — the supply leg of market cap (Σ FMV × effective circulation).
- `collection_chains` view + the 5 collection UUIDs — for per-collection sub-indexes.
- Precedent: `topshot_squeeze_board` view + `/api/public/insights/squeeze` route is the exact build pattern to copy.

### Proposed surface — `/insights/index`
- **Headline index value** (rebased to 100 at a chosen epoch), with 1M/3M/6M/1Y/All time toggles (the universal time-window control seen on every ranking surface).
- **Methodology:** market-cap-weighted (Σ per-edition FMV × effective circulation), rebalanced on a fixed cadence; **only HIGH/MEDIUM-confidence FMV editions** included in the index (honesty — exclude STALE/NO_DATA so the index isn't built on guesses). State the methodology on the page (Card Ladder does; it builds trust).
- **Sub-indexes:** per-collection (Top Shot, All Day, Golazos, UFC, Pinnacle), and a flagship curated **"RPC 50"** (the 50 editions that best represent the market — analogous to CL50).
- **Compare mode (phase 2):** overlay sub-indexes against each other; (phase 3, post-login) overlay a wallet's holdings vs. the index.

### Phasing
1. **P1:** one whole-market index + per-collection sub-indexes, daily snapshot to a new `index_snapshots` table, line chart + time toggles. *(DB migration + materialized snapshot job shippable from Cowork; chart page via Claude Code.)*
2. **P2:** "RPC 50" curated index + compare-overlay.
3. **P3:** wallet-vs-index overlay (uses existing portfolio data; login-gated).

### Effort / risk
Highest effort of the three (needs a snapshotting job + methodology decisions + backfill of historical index points from `sales`). Highest payoff. Methodology is the hard part — get the confidence-filtering and rebalancing rules right before backfilling history, because re-backfilling is expensive.

### QA gate (rpc-insights-qa)
Backing view `security_invoker` + anon SELECT-only; smoke-test the index RPC under load; freshness indicator on the page (when was the last snapshot); canonical + sitemap; OG card showing current index value + Δ; brand tokens.

---

## Spec 2 — Wallet-paste public landing (lowest-effort, fixes the funnel)

### Gap
**MomentRanks, CryptoSlam, AND LiveToken (`/myaccount?address=`) all let you value any wallet with zero login** — it's the top-of-funnel hook for the whole category. RPC gates `/` behind login (`proxy.ts`, root is NOT public). For a top-of-funnel intelligence product this is the single clearest funnel leak (ties to [[rpc-funnel-instrumentation-gap]]). A visitor who pastes a wallet and instantly sees value + squeeze exposure is a visitor who comes back.

### RPC data that already exists
- `wallet_moments_cache` (wmc) — per-wallet holdings with `edition_key`, `serial_number`, `tier`, `set_name`, `player_name`, `mint_count` already backfilled.
- `fmv_snapshots` — to value each holding (with confidence).
- `topshot_squeeze_board` — to compute the wallet's **squeeze exposure**, which is RPC's unique angle no competitor can replicate.
- The `rpc-my-wallet` Cowork artifact already proves the query shape (portfolio + FMV + confidence + top holdings + sets + tier).
- Existing wallet-backfill routes (`/api/wallet-backfill*`) to enrich an unseen wallet on demand.

### Proposed surface — public `/wallet/<addr>` (or `/w/<addr>`)
- **Instant, no-login:** paste/enter a Flow address → portfolio total value, moment count, tier breakdown, top holdings, FMV-confidence mix.
- **The RPC-only hook:** a **"squeeze exposure"** panel — how much of this wallet sits in locked/burned-thin (high-squeeze) editions. Nobody else can show this.
- **Confidence-honest:** every value tagged HIGH/MED/LOW/STALE so the total reads as trustworthy, not inflated.
- **Conversion CTA:** "track this wallet / get alerts" → the (eventual) login, but value is delivered *before* the wall.
- Make it the **OG-shareable** unit — a wallet card with value + squeeze exposure that renders in Discord/Twitter unfurls (RPC already has per-feature OG generators).

### Phasing
1. **P1:** read-only public `/wallet/<addr>` from wmc + fmv_snapshots; total value + holdings + confidence mix + squeeze-exposure panel; on-demand backfill if wallet unseen.
2. **P2:** OG share card; "compare to FMV" deltas per holding.
3. **P3:** soft conversion (watch/alerts) — defer until alerting is re-instrumented.

### Effort / risk
Lowest effort — the data and query shape already exist (artifact proves it). Main work is a public route outside the `proxy.ts` login wall + rate-limiting/bot-guard on the public endpoint (it's an unauthenticated read of arbitrary wallets — add an edge rate-limit; see the deferred-hardening note in CLAUDE.md). **Security review the public exposure carefully** before shipping (no PII, only on-chain public holdings).

### QA gate
Public route must be in the `proxy.ts` public-path bypass; rate-limit the backfill trigger; backing reads anon SELECT-only; no wallet-derived PII; canonical + sitemap (probably `noindex` on individual wallet pages, index the landing); OG card; brand tokens.

---

## Spec 3 — Movers + live sales ticker (medium-effort, high stickiness)

### Gap
A **biggest-movers board** and a **real-time sales feed** appear on nearly every platform (MomentRanks Activity with inline Δ-vs-value, CryptoSlam recent/top sales, OpenSea Activity, Blur). RPC has the sales data but no first-class movers/ticker surface. This is cheap, recurring dopamine that drives daily returns — and RPC can do it one better by annotating each row with **FMV delta + confidence** (MomentRanks shows Δ-vs-MR-Value; RPC can show Δ-vs-FMV with a confidence dot).

### RPC data that already exists
- `sales` (partitioned, deduped on `transaction_hash`) — the live feed source; `analytics_sales` / `analytics_sales_resolved` views already translate collection vocab and resolve canonical owners.
- `fmv_snapshots` — to compute each sale's premium/discount vs. fair value.
- `get_market_summary()` and existing market RPCs — partial precedent.
- The `rpc-fmv-watch` + `rpc-live-health` artifacts prove the trend-query shapes.

### Proposed surface — `/insights/movers` (+ an embeddable ticker)
- **Movers board:** biggest FMV movers up/down over 24h / 7d / 30d, per collection and overall; each row = edition · Δ% · current FMV · **confidence** · volume.
- **Live sales feed:** recent sales with Sale Price · FMV · **Δ-vs-FMV (over/under fair value)** · confidence · time; filters by collection / tier / price / set (mirrors MomentRanks Activity, plus the confidence column they lack).
- **Embeddable ticker** strip (the brand already has a ticker component in the collection layout) — reuse on the homepage as ambient "the market is alive" signal.
- Honest caveat on thin-volume editions (RPC already does this on Market).

### Phasing
1. **P1:** `/insights/movers` board (FMV movers, time toggles, per-collection).
2. **P2:** live sales feed with Δ-vs-FMV + confidence + filters.
3. **P3:** homepage ticker reuse; optional audio/notification alert (LiveToken's "Silence" toggle pattern) — defer alerting until re-instrumented.

### Effort / risk
Medium. The movers computation is a delta over two FMV snapshots per edition — straightforward given the snapshot history. Watch the [[fmv-recalc-step6-self-perpetuating-pattern]] trap: compute movers from true latest-per-edition snapshots, not arbitrary partition rows. Live feed needs a sensible refresh cadence (don't hammer; 5-min cache like the squeeze route is fine).

### QA gate
Movers RPC chunked/performant; backing view anon SELECT-only; freshness indicator; thin-volume honesty caveat; canonical + sitemap; OG card; brand tokens; confidence shown on every priced row.

---

## Suggested sequencing (if pursuing more than one)

1. **Wallet-paste landing first** — lowest effort, data exists, directly attacks the #1 funnel leak, and makes everything else more discoverable (it's the front door).
2. **Movers + ticker second** — medium effort, high daily-return stickiness, reuses existing ticker component.
3. **RPC Index third** — highest effort + payoff; needs methodology lock-in and historical backfill, so it benefits from being last when the snapshotting patterns are warm.

All three compound: the landing brings people in, the ticker/movers bring them back daily, the index gives them a reason to treat RPC as *the* market authority. None require monetization to deliver value.
