# Manual steps for Trevor — 2026-07-19

Everything autonomously shippable on Panini + Candy this session is shipped and verified. What remains needs either **your judgment**, **your machine**, or **an external event**. Nothing below is breaking or urgent — platform health is green (security `[]`, RLS-off 0, no pg_cron failures, all pipelines `ok=true`).

Ordered by leverage, not by effort.

> **All figures below are point-in-time.** The Panini index grows continuously (1,647 → 1,842 during this session alone), so treat any number here as a snapshot and run the live query at the bottom for current values. Nothing in the product hardcodes these — every displayed figure is read from a self-measuring view.

---

## A. Decisions only you can make

### A1. Candy — best offer: RESOLVED by data, no longer a decision you need to make now

**The situation:** Candy has *zero* price signal — 0 sales, 0 listings (Magic Eden `listedCount: 0`, suppressed by Candy's quest-hold rule), 0 FMV rows. The only live market signal is **bids**, which the new `candy-offers-indexer` now captures into `candy_offers` / `candy_best_offers`.

**UPDATE — the pipeline ran and answered this.** Two clean ticks (06:50Z + 12:50Z, `ok=true`, 47 offers each, `bidder_fetch_errors` 0). Real numbers from stored standing offers: **47 active offers, 2 distinct bidders, 24 editions, $0.23–$3.04.** Thin and lowball in absolute terms — but the book is **internally rational**: LEGENDARY (Rainbow, /15) averages **$2.74** vs COMMON (/250) at **$0.34**, an ~8× premium for the 16.7×-scarcer tier. So the relative ordering carries real information even though the levels are low.

- Showing it as **"best offer"** is honest and defensible.
- Folding it into **FMV** would not be. Enforced in schema and code — nothing writes `fmv_snapshots`, and `candy_best_offers` exposes `distinct_bidders` and `offer_count` as context.

**⚠ I have to retract my own earlier suggestion.** I proposed "hide the display when `distinct_bidders = 1`" before any data existed. The first real tick shows that would be **backwards**: LEGENDARY editions have `max_bidders` = **1**, COMMON have **2** — the second wallet bids only on commons. So that guard would hide every scarce/chase row and show only the cheap tier, inverting exactly what a collector cares about. Do not implement it as I originally stated.

**Better shape, when Candy eventually has a surface:** don't suppress on bidder count — **show it as context** ("best offer $2.74 · 1 bidder") and let the reader weigh it. If you want a suppression rule at all, apply it at the **collection** level (hide the column while the entire book is one wallet), never per-edition, because per-edition bidder counts correlate with scarcity and therefore with interest.

**Net: nothing for you to decide today.** `candy_mlb` is unpublished with no route dirs, so there is nowhere to render this regardless. Silent accrual is correct, the pipeline is watched (`pipeline_cadence_watchlist`, 800 min / info), and the question only becomes live when Candy has a UI — which is gated on FMV → first sale → an external event.

### A2. Panini — go-live is now genuinely one line, but it's your trigger (2 min typing)

The honesty requirement is **built into the surface** now, not a checklist item someone has to remember: the page renders a coverage disclosure and the public JSON carries `meta.coverage`, both driven off the self-measuring `panini_coverage_summary` view.

Standing rules that still gate this: *no multi-chain public before you say so*, and *no promo until launch-ready*. So this is your call, not a task.

When you want it live, all four touch points (verified 2026-07-19):

1. **Delete the gate** — `proxy.ts:127`:
   ```
   if (/^\/(?:insights|api\/public\/insights|api\/og\/insights)\/panini/.test(pathname)) return false
   ```
   That one line gates the page, the public JSON, and the OG card together.
2. **Sitemap** — add `'panini-squeeze'` to the `INSIGHT_ROUTES` array at `lib/sitemap-data.ts:458`.
3. **Un-noindex** — remove `robots: { index: false, follow: false }` from `app/insights/panini-squeeze/layout.tsx`.
4. **Hub card** — add an entry to the `CARDS` array at `app/insights/page.tsx:84` (and optionally a live stat case in `liveStat()` at `:54`).

Do 2–4 **with or after** 1, never before — adding the sitemap entry while the proxy line still gates the route would feed crawlers a URL that redirects to auth.

**Before you flip it, read this honestly:** the board's per-row numbers are true, but the *index* is 46.6% trustworthy-coverage and structurally cannot be complete (see A3). The disclosure says so. If you're not comfortable shipping a board that discloses partial coverage, the answer is "not yet" — and that's a legitimate answer.

### A3. Panini — accept that full coverage is impossible, or drop the surface (decision, no typing)

I established this definitively: **Panini exposes no catalog.** The complete authenticated route map is home, the marketplace grid, per-card detail, 11 `/myaccount` pages, and static/social. No checklist, set-browse, or collection route. The grid's facets — including CARD SET — sit *on* the `getMarketPlaceList` **listings** query, so filtering by set narrows listings and never reveals an unlisted card.

Consequence: an edition enters our index only once it has been **listed**. Coverage degrades monotonically with scarcity (Red 64% of checklist → Gold 24% → Black 8% → Nebula 7%), and **100% of discovered 1-of-1s are currently listed** — impossible for an unbiased sample.

This is a platform limit, not a bug, and **no amount of engineering fixes it**. The three honest options:

- **Ship with disclosure** (built and ready) — recommended.
- **Wait** — but understand exactly what improves. **Measured 2026-07-19 13:48Z: the absolute index grows, the trustworthy FRACTION does not.** The index went **1,647 → 1,769** editions while `pct_trustworthy` went **46.6% → 46.4%**. The tell is the composition of recent discovery: `broad`-bucket share is **46.5% across all editions but only 31.1% of those first seen in the last 12h and 26.4% in the last 6h** — the high-print, frequently-listed editions are already found, so marginal discovery is increasingly the scarce, thinly-covered tail. Discovery is decelerating too (740 new in the 12-24h block → 50 in 6-12h → 72 in the last 6h). Rows *are* retained permanently, so every card ever listed is captured forever and the board covers more editions each week — but **waiting will not lift the ~46% quality ratio, and if anything nudges it down.** So do not hold on a coverage threshold; it is a threshold that moves away from you.
- **Don't ship Panini publicly** and keep it as internal intelligence.

---

### A4. Pre-launch verification — all three Panini surfaces confirmed working (no action, FYI)

Verified live in a signed-in browser 2026-07-19, so the un-gate is not a leap of faith:

| Surface | Result |
|---|---|
| Page `/insights/panini-squeeze` | Renders clean; KPIs now whole-board; **sorting, search and all four filter bands verified against ground-truth SQL counts**; warm load median **106 ms** (`x-vercel-cache: HIT`), 61 KB transferred |
| Public JSON `/api/public/insights/panini-squeeze` | **200**, `meta.coverage` present (1,769 eds · 46.4% · 115 gated · 54 families · `basis: listing_gated`) |
| OG card `/api/og/insights/panini-squeeze` | **200**, `image/png`, 79,752 bytes, valid PNG magic, 1.35s |

All figures are read from the self-measuring view and moved between reads, confirming nothing is hardcoded. Flipping the gate exposes three surfaces that are already known-good.

---

### A5. Panini — is an ask-anchored FMV acceptable on a public board? (decision, no typing)

Found during QA, and it's the one thing I'd want you to look at before flipping the gate.

**The board's #1 row is Lionel Messi, Base Prizms Black /1 — FMV $517,500, ask $575,000, and `real_sales` = 0.** FMV is exactly 0.90 × ask. Same shape down the top: of the **top 50 rows by FMV, 34 have never sold**.

**This is by design, not a bug.** `lib/chains/panini/ingest-normalize.ts` prices sales-backed when `volume_txns > 0`, else falls back to `floor_price × 0.9` labelled `ASK_ONLY` — the same cold-tail convention RPC uses for Top Shot. Live split: HIGH 1,374 · **ASK_ONLY 206** · LOW 130 · MEDIUM 123.

**Scale:** 686 of 1,833 board rows (**37.4%**) have zero recorded sales, and **$336,358 of the $938,170 "Value sealed in packs" KPI (36%)** derives from them. Mitigating: the board renders the **ASK column beside FMV**, so a reader can see the valuation is ask-anchored.

**I checked the obvious worry and it does NOT hold.** I initially suspected troll asks (the Top Shot class that needed a disconnected-ask clamp). Tested against family medians: ASK_ONLY does skew higher (17.4× vs 5.3× for HIGH), but **HIGH-confidence rows carry extreme outliers too** (89 over 10×, worst 1,429×). Within a parallel, legitimate star-player dispersion is enormous, so that test can't separate a troll ask from a real Messi premium. No evidence of a troll-ask problem.

**The call:** publish ask-anchored FMV on never-sold cards, or not? Options if not — render zero-sale rows without an FMV, default-sort by a sales-backed measure, or exclude ASK_ONLY from the "Value sealed" KPI. **I deliberately did not touch any of these:** CLAUDE.md says data fixes are fine but pricing *logic* gets handed off, and all three are pricing/product decisions.

---

## B. Operator actions on your machine

### B1. ~~`pinnacle-sync` cron trigger is dead~~ — RESOLVED ITSELF, no action needed

Last run **2026-07-17 10:07Z** (~43h ago vs a 26h threshold), so `detect_stalled_pipelines()` flags it.

**Not a data outage** — Pinnacle FMV is fresh (4.7h, 4,383 rows/48h) because the `rpc-pinnacle-fmv-recalc-backstop` pg_cron job is doing the work. That backstop was added for exactly this recurring cron-job.org dropout class and it's holding.

**UPDATE (2026-07-19 13:55Z): no action required — the trigger recovered on its own.** `pinnacle-sync` fired at **10:07:12Z today, `ok=true`**, resuming its normal 10:07Z slot after skipping 07-18 entirely; Pinnacle FMV is **3.8h fresh** and `detect_stalled_pipelines()` is now `[]`. This is the documented recurring cron-job.org dropout class behaving as it always has: it drops a day, then self-heals, while the pg_cron backstop carries FMV in the meantime. Nothing for you to do. Worth knowing the shape though — if it ever drops for **more than ~48h**, that is beyond the usual pattern and the console is worth a look.

### B2. Panini confirmatory capture — now optional, ~10 min

Originally the deciding step; **A3 already answered it** by mapping the site directly. This only closes the last sliver of doubt (a checklist could in principle hide behind an unlabelled UI control rather than a route).

The instrumentation is already shipped and defaults off. On the residential box:

```bash
PANINI_CDP_URL=http://localhost:9222 PANINI_DISCOVERY_HOLD_MIN=10 PANINI_DISCOVERY_ONLY=1 \
  node scripts/ingest-panini-runner.mjs
```

Then, while it holds, click through: any set/collection view, the marketplace grid **with a CARD SET filter applied**, and one card detail page. Afterwards read `panini-ops-capture.jsonl` and look for any operation returning cards independent of listing status.

**Expected result: none exists.** If one does, that's a genuine surprise worth telling me about — it would flip the handoff to branch 2a.

The capture file is size-capped at 25 MB with one rotated generation, so it can't grow unbounded on your box.

### B3. Panini runner throughput — optional (~1 min to assess)

**78%** of the catalog (1,285 / 1,647) is re-observed every 24h, with a stale tail out to ~61h. That's healthier than the "51%" I originally reported — I'd been reading an inert `updated_at` column; the real freshness column is `last_seen_at` (now fixed, plus a touch trigger so `updated_at` is honest going forward).

If you want the tail closed, the lever is runner uptime/frequency on the residential box — Task Scheduler is set to every 4h. Not blocking anything.

---

## C. Blocked on external events — nothing to do

### C1. Candy's first secondary sale

`candy-sales-indexer` is **armed and live** (Vercel cron `20 */3`). Confirmed working: first tick 2026-07-19 03:20:22Z, `ok=true`, 0 sales found, `sol_usd` 75.92 — the correct no-op, and it proves Vercel reaches Magic Eden. It will capture the first printed sale **automatically**; no constant to flip, no cron to wire.

FMV follows sales. Until Candy lifts the quest hold and listings/sales appear, Candy cannot have FMV — and a bid-derived FMV would be dishonest (see A1).

`candy-solana-launch-watch` (daily 9am PT) has been rewritten against actual state and watches for exactly this.

### C2. Candy `is_active` flip

`candy_mlb` is deliberately `is_active=false`. The data layer is now at shared-schema parity **minus pricing**: 125/125 editions with tier/set/player/series, 25,375 wmc rows reconciling exactly to supply, ghost-owner rows purged with a daily self-heal. What's missing is FMV, which is C1. Also note Candy has **no route dirs** — the `pages` array in `lib/collections.ts` is aspirational, so flipping `is_active` alone shows nothing.

---

## D. Queued engineering — Claude Code, not urgent

- **`CANDY-SALES-INDEXER-UNBOUNDED-ACTIVITIES-WALK`** (LOW). With 0 sales the cursor is 0, so every tick walks all 40 Magic Eden pages (~59s, ~320 calls/day). Not dangerous (inside `after()`, `ok=true`) but it's a standing rate-limit exposure. I deliberately did **not** patch it: the unbounded walk is currently *correct* — it guarantees the first sale is caught even if deep in the feed — and a careless time floor would trade a working pipeline for a silently-missed first sale. The sibling offers route already has a bounded walk + floor to mirror.
- **The 5 built-but-unsurfaced Panini boards** (`deal`, `player`, `nation`, `special_serials`, `pack_ev`). Deliberately not surfaced: they read the same listing-gated index, so shipping them now multiplies one completeness defect across five public surfaces — worst for `special_serials`, whose subject matter lives entirely in the 7–24%-covered scarce tail. The squeeze page is a complete 3-file template (page + JSON + OG) once coverage is acceptable.

---

## Verification you can run anytime

```sql
-- Panini coverage (drives the public disclosure)
SELECT * FROM panini_coverage_summary;

-- Candy data integrity: wmc must equal supply exactly
SELECT (SELECT count(*) FROM wallet_moments_cache
        WHERE collection_id='209ade70-32c5-4470-bc7c-4793d660f713') AS wmc,
       (SELECT sum(circulation_count) FROM editions
        WHERE collection_id='209ade70-32c5-4470-bc7c-4793d660f713') AS supply;

-- The three Candy pipelines
SELECT pipeline, max(started_at) AS last_run, bool_and(ok) AS all_ok
FROM pipeline_runs
WHERE pipeline IN ('candy-editions-ingest','candy-sales-indexer','candy-offers-indexer')
  AND started_at > now() - interval '48 hours'
GROUP BY pipeline;

-- Security invariants (both must be [] / 0)
SELECT check_secdef_anon_execute_violations(),
       (SELECT count(*) FROM pg_tables WHERE schemaname='public' AND rowsecurity=false);
```

A one-time task `candy-offers-first-tick-check` fires **07:10Z today** to verify the offers pipeline's first cron tick (06:50Z) and reports the error verbatim if Magic Eden's response shapes differ from what it was built against.

---

## One caveat on my own work

`docs/overnight/ledger.md` carries the full detail and revert path for all 8 migrations shipped this session. Two corrections I made to my own earlier claims, both now in the record: I shipped a coverage view reading an inert timestamp column (fixed), and I falsely accused a commit of a second ledger clobber before verifying (retracted — there was one clobber, `fecda2e`, and `eb5d7f6` was innocent).

CI was green through `b255eb1` (8/8). The final two commits' CI I could **not** verify — GitHub's API rate-limited me — though `npx tsc --noEmit` and the affected test suites passed locally. Worth a glance at the Actions tab.
