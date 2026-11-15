# Overnight pass — 2026-11-15 (Cowork cloud, VM clone + .rpc-git-cred push)

**Run:** started ~1:03 AM PT 11-15 (09:03Z). Clock verified against DB: shell/VM 09:02Z · DB `now()` 09:03Z · newest sale ingest 08:54Z · newest FMV 08:53Z — no skew, genuine overnight window. **Push AVAILABLE** (VM route, dry-run exit 0). Not frozen. Lock `.lock` was RELEASED (prior run a40d6bc8, ~17 h old); taken over, run id d730bea7d465.

**Verdict: GREEN. Nothing shipped — a quiet, honest night.** Security clean, post-ship watch clean, every inbox candidate already resolved by the concurrent Claude Code session or queued (one off-limits DROP, one multi-step research item). No low-risk, not-already-done, not-off-limits work surfaced, so nothing was shipped. Two items queued for Trevor/Claude Code.

⚠ **Concurrent session active:** Claude Code cloud (`session_014vX7Q6EXbZfQfofQnUGac8`) pushed #190 cost-basis work through 11:23 PM PT 11-14 (last commit `b5ade828`, ~1.5 h before this run). origin/main did NOT advance during this pass. Most #190 route/lib/migration files are HOT (committed <48h) — untouched here.

---

## What was reviewed

- **CLAUDE.md** (full), focus.md (all steers are future-dated post-ship watches; no overnight shipping steer for tonight), ledger head, `metrics-latest.json` (11-14 pass), the last overnight handoff, and the inbox since the last pass.
- **Inbox drained (dispositions below; files left in place — append-only):**
  - `2026-11-15T0410Z` candy-revival-overtaking — ✅ already RESOLVED by Claude Code (re-scored 9 sales, all legacy/Magic Eden, none in a 2026 set; re-dated `silent_since_2026_11_14`, `20261115041831`; revival arm back to 0/10). The `candy_sales_stale_hours` breach is the indexer-unhealthy branch (parked legacy-backfill sales), NOT the #58 false shape. Verified below.
  - `2026-11-14T2211Z` board_mv_refresh false BREACH — ✅ RESOLVED by Claude Code (both the comment fix `20261114221716` and the class fix `20261114225500`; metric 2502.9h→<2h ok, down-detection re-proven).
  - `2026-11-14T1905Z` alert_sub_is_exact_serial search_path — ✅ RESOLVED by Claude Code (comment-exempt `20261114192649`; drift length 0).
  - `2026-11-14T1710Z` #248 rwfc-drops-only-what-it-applied — ✅ APPLIED 11-14 9:13 AM PT (`20261114171317`); its §5 watch (reads/call at ≥24h, 0.8%→~0.2% miss re-sample) is **not yet due** (~9 AM PT 11-15). Carried as a watch.
  - `2026-11-15T0500Z` fmv-activity-gap — steps 1–4 ✅ done by Claude Code (`20261115045831`). Step 5 (legacy-listings run check) **verified healthy here** (below). Steps 6 & 7 QUEUED.
  - `2026-11-15T0506Z` drop parked `sets_summary_prev_20261114` — **QUEUED** (off-limits DROP; see below).
  - Older 11-13 items (net._http_response weekly read; franchise-hub recurrence; active-listings egress-blocked-once) were handled in prior passes; the weekly size read is refreshed below.

## Section 2 — health-drift triage

- **Security:** all 4 arms `[]` (invariants / anon_write_holes / rls_off_base_tables / secdef_anon_violations). Clean.
- **Trust health — 2 breaches, both known/expected transients:**
  - `candy_sales_stale_hours` = 14.7 (breach_at 0, the *indexer-unhealthy* branch). Cause: the 11-14 legacy-collection Magic Eden sweep (`b43f5ddfe`) is backfilling history and parking Candy sales it cannot yet resolve — `candy_sales_unresolved` 6,444 total / 2,634 `queued_collections_walk` (grew from the 1,175 parked 7:47 PM PT 11-14 as more legacy collections were swept). Drains ~300/tick. Claude Code's disposition: clears ~noon PT 11-15; if still breach_at 0 by then, read `candy_sales_unresolved` attempts. **Watch, not a fix.**
  - `public_board_slow_count` = 1 (breach_at 1). Chronic saturation-collateral, standing known-class (do not characterize direction on <several days).
- **Pipelines:** `detect_stalled_pipelines()` `[]`; `check_pgcron_recent_failures()` `[]`. `pipeline_fails_24h` all `upstream:0`: the chronic Atlas Cloudflare lanes (topshot-pack-supply-atlas 29, atlas-pack-market 16, atlas-market-feed 5, pack-nft-identity 3, atlas-editions-refresh 2, …), `refresh_wmc_fmv_changed` 3, plus the two #190 lanes (hop 1 — predates its 11:23 PM PT unschedule; provenance 1 — a Dune 429 at offset 77k, self-recovered, next 4 ticks ok).
- **Sentinel:** ts_uuid editions 48h `0`. `wmc_null_edition_key` `[]`. `edition_integrity_flags` 8 (breach_at 250) — ok, flat.
- **Post-ship watch — CLEAN:**
  - atlas-market-events-prune 40P01 fix (`20261114153229`, 15:32Z 11-14): **holding** — the 2 prune deadlocks in the 48h window (01:27Z, 05:27Z 11-14) both PREDATE the fix; 0 prune deadlocks since.
  - New transient: `ts-sold-floor-clear` deadlocked once at 23:45Z 11-14 (a different lane, post-fix). It runs every ~5–10 min and **all 25+ runs since are ok=true** (9+ hours clean) — a one-off transient, fully recovered. No action.
- **Vercel:** prod `dpl_J9ebSNW` = `b5ade828` (HEAD), READY. No ERROR deploys (READY + CANCELED only; CANCELED = docs/superseded). 24h runtime errors: 24 groups, all count 1–9 and all the known chronic graceful-degradation tail (entity-section edition/set/player timeouts degrading to empty, pack-detail 5s, panini-premiums/trophies/cost-basis/market-cap 8s, candy-set-progress 57014 partial) or bounded clusters (rookie-sales timeout ×9 in one 7-min window 20:56–21:03Z 11-14, nothing since; candy-set-progress ×7 in a 6-min window). No new crash class.
- **net._http_response (weekly size read, was overdue):** 677 MB / 9,117 rows, oldest 03:08Z (~6h TTL). Down from 855 MB (11-04). Healthy sawtooth, not a leak.
- **candy-collections-market (fmv-activity-gap step 5):** last 3 runs ok, listings_written 1,254 / 1,435 — actively sweeping legacy collections, the falsifier's healthy shape. ✅

## Overnight deltas (vs 11-14 metrics-latest)

- db 52,252 → 52,838 MB (+586; net._http_response sawtooth + Candy legacy churn).
- FMV HIGH+MED: nba 6,844 → 7,010 · panini 20,208 → 20,347 · nfl 1,764 → 1,774 · pinnacle 984 → 988 · candy 0 · golazos 1 · ufc 0.
- editions: panini 46,556 → 47,238 (+682); candy 21,472 (flat); others flat.
- edition_integrity_flags 8 → 8. Trust breaches 0→2 (both known transients above). Security 0→0.

## Shipped

None.

## Queued (needs Trevor / Claude Code — not auto-shipped)

1. **Drop the parked `sets_summary_prev_20261114` materialized view** (inbox `2026-11-15T0506Z`; known-issues #255). Trevor pre-approved it in that 11-14 thread, but it is a `DROP MATERIALIZED VIEW` — on the night pass's hard OFF-LIMITS list (destructive SQL), and a scheduled run cannot act on a recorded (non-live) approval. Low-risk cleanup (2.7 MB; 0 functions / cron / views / repo refs; scan counter flat). Ready-to-run md5-guarded SQL + read-backs + the repo/ledger/#255 half are fully specified in the inbox file. **Why not auto-shipped:** off-limits DROP; needs live approval.
2. **fmv-activity-gap steps 6 & 7** (inbox `2026-11-15T0500Z`; #256/#257):
   - Step 6 — diff the two Magic Eden files (they live only in the claude.ai Project; import blocked) against `candy_sales_unresolved.signature` ∪ `sales.transaction_hash`, parking only the remainder via `candy_park_unresolved_sale(… 'queued_collections_walk')`. **Gated** on every legacy collection being re-walked (`candy_collections … sales_high_water_at='2026-07-01'` → 0; was 284 at 8:15 PM PT 11-14, ~8h of runs) AND on the Project files. **Why not auto-shipped:** the ME source files are not reachable from this cloud clone, and the gate may not be met yet.
   - Step 7 — OpenSea's Solana settlement program id from an OFFICIAL source (Trevor's sourcing rule), confirmed against a real Candy sale transaction, appended to #256. **Why not auto-shipped:** browser research with a strict provenance bar; gates further Claude Code cost-basis work, not time-critical.

## Watches to re-check in the morning (no decision needed)

- `candy_sales_stale_hours` should clear by ~noon PT 11-15 as the legacy-backfill drains; if still breach_at 0, read `candy_sales_unresolved` attempts.
- #248 rwfc §5: at ≥24h out (~9 AM PT 11-15), re-run the miss sample (0.8%→~0.2% expected) and check reads/call vs the 08-28 bar (74,159 cron / 7,195 PostgREST) before any revert; then `resync_stuck_wmc_fmv` (job 617) can move to daily.

## Failed / blocked / reverted

None.
