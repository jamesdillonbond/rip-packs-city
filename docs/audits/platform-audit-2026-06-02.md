# RPC Platform Audit — 2026-06-02 (Cowork interactive pass)

**Bottom line:** Platform **GREEN**. 20/20 recent prod deploys READY (0 ERROR); current prod = `27fdfbd` (this session's cleanup commit). Security 0/0 base-table holes. FMV improving. `detect_stalled_pipelines()` empty. Shipped **2 queue items live + verified** this session (P1 monitoring-config, S1 security). Biggest open work: FMV confidence depth (in progress, LiveToken pass), Packs UX (handoff ready, RTR-time-sensitive), Sentry smoke-noise cleanup.

---

## Shipped this session (live, end-state verified)

1. **Cleanup commit `27fdfbd`** — committed the 10 overnight-pass working-tree files (CLAUDE.md note, ledger, metrics-latest, 2 handoffs, inbox→archive moves), pushed to `main`. No code changes. Verified not-truncated before commit.
2. **P1 — `audit_20260602_evm_transfers_watchlist_threshold_150m`** — `evm-transfers-ingest` stall-watchlist threshold 60→150m. Kills the hourly `detect_stalled_pipelines()` false-positive (pipeline runs hourly; no product consumer). Verified `max_silent_minutes=150`. Revert in migration comment.
3. **S1 — `audit_20260602_revoke_anon_v_moments_needing_hydration`** — `REVOKE ALL ON public.v_moments_needing_hydration FROM anon, authenticated`. Closes the lone anon-readable SECURITY DEFINER view. Verified anon/authenticated SELECT = false, service_role = true (hydrator unaffected). Revert: `GRANT SELECT ... TO anon, authenticated`.

---

## Health by surface

- **DB:** 5,966 MB. `check_public_security_invariants()` → 0 rows. RLS on all base tables. 0 anon-write holes; 0 anon-readable non-invoker views (was 1, fixed by S1).
- **Pipelines:** `detect_stalled_pipelines()` empty (N1 `snapshot-institutional-wallets` stall from the 13:42Z metrics snapshot has since cleared). Last 24h: ~13 pipelines with 1–6 transient cron-rush fails each (pool/statement/lock timeouts at 00/06/12Z rushes), all self-recovering, none logic faults, none deploy-attributable.
- **FMV:** TS HIGH 270 / MED 662 (HIGH+MED 932), LOW 9,517, ASK_ONLY 754, STALE 505, NO_DATA 4,625 (improving from 4,634). AllDay HIGH+MED 274. `fmv-recalc` fresh (~12m) — primary writer healthy. `topshot-fmv-populate` failing on pool/statement timeout but does NOT affect freshness (it's the ~150–220-listed-edition marketplace feed, structurally can't close the NO_DATA tail).
- **Vercel:** 20/20 prod deploys READY. `lambdaRuntimeStats {"nodejs":18}` = 18 lambdas, NOT Node 18 (known meaning).
- **Sentry:** 15 unresolved. Triage: (a) **NEXTJS-15** gated AllDay `listing_resolution_failures` — known, gating works, mark-resolve if 24h-clean; (b) **~11 issues are 25-day-STALE** one-off smoke failures (first+last seen late April, never recurred) → bulk-resolvable; (c) **3–4 recurring smoke false-positives** (NEXTJS-4 market-returns-TS-listings, NEXTJS-A fmv-healthy, NEXTJS-B sales-healthy, NEXTJS-8 cached_listings-has-rows) — Q5 cron-rush class + STALE assertions for dead infra (cached_listings frozen since Flowty shutdown; market reframed to outbound links May 23). No genuine app crash spiking.
- **Cowork artifacts:** 11, all healthy (re-query live on open). Most recently updated: rpc-insights-health, rpc-audit-followups (06-01), rpc-security-drift, rpc-traction (05-31).
- **Scheduled tasks:** 7, all enabled & firing — weekly-health-check (Mon), weekly-health-report (Mon), nightly-autonomous-pass (daily 1am), daytime-monitor (~3h), monthly-memory-consolidation (1st), + 2 Candy/Solana chain-two tripwire audits (one-time 6/22 + 7/8).
- **Skills:** RPC custom skills present (rpc-data, rpc-handoff, rpc-migration, rpc-insights-qa). Gap candidates below.

---

## Prioritized backlog

### [SHIP-NOW-DB] (Cowork-shippable)
- *(none remaining after P1 + S1)* — next DB candidates are N2's supporting index and the optional packs cheapest-ask MV (both below).

### [HANDOFF-CODE] (needs Claude Code — .tsx/route/worker)
- **Packs cheapest-secondary sort + clickability** — HIGH (RTR live now). Pure-frontend; handoff written (`docs/handoff-2026-06-02-packs-cheapest-sort-and-clickability.md`). Each list row already carries a resolved `displayPrice` (live secondary ask > cached secondary_ask > retail), so the sort is a new `display_price_asc` default + clickable thumbnails/pull-cards.
- **N2 — `v_moments_needing_hydration` statement timeout** — MED. The 06-01 materialized-CTE fix is net-positive (do NOT revert). Deeper fix: add a supporting index on the anti-join predicate OR bump `statement_timeout` on the hydrator's candidate-read call. Recurs 3/138 at cron rushes, self-recovering.
- **Q5 — rebase pipeline-health smoke threshold** to last-successful-run (not newest `sales.sold_at`) — MED. Kills the fmv-healthy/sales-healthy smoke false-positives during low-traffic windows.
- **Smoke assertion cleanup** — MED. Remove/replace dead assertions: `cached_listings has rows` (Flowty dead, table frozen ~24 rows) and `market API returns Top Shot listings` (market reframed to outbound links). These re-fire as Sentry noise every smoke run.
- **Q8 — badge-sync `onConflict:id` vs `UNIQUE(external_id,collection_id)`** — MED, badge data quality only (offers decoupled to `edition_offers`).

### [OPERATOR] (Trevor / external)
- **N1 — `snapshot-institutional-wallets` cron** — cleared now; consider moving its 06:00Z slot off the cron-rush peak.
- **Q7 — scheduled-sandbox `.git` fragility** (bot clone not mounted in the scheduled sandbox) — blocks autonomous code shipping; recommend a sandbox-native clone syncing via origin. Confirmed again this session (the stale `.git` locks I hit on commit).
- **Bulk-resolve the ~11 stale Sentry smoke issues** (25-day-untouched, never recurred).
- **Q2 — Golazos pack-EV cadence** — verify by-design pause vs silent break.

### [RESEARCH] / optional
- **Packs cheapest-secondary-ask-per-dist MV** (Cowork-shippable later) — lift persisted TS secondary coverage above today's 40% and give AllDay a non-live price, from the same Dapper Studio listings the EV cron already reads. NOT required for the sort (live `/api/pack-listings` already covers TS+AllDay). `pack_purchases` is NOT a usable source (dist_id always NULL on secondary_sale rows).

---

## New skills / operational-efficiency ideas

1. **`rpc-fmv-audit` skill (HIGH)** — encode the LiveToken FMV cross-check workflow being built this session: pull a wallet's top-value moments + confidence from RPC, the LiveToken URL/sort/extraction pattern, the match-by-player+serial+circulation rule (LiveToken is serial-adjusted, RPC edition-level), and the snapshot-write pattern for confirmed discrepancies. Makes every future accuracy pass repeatable and correct-first-time.
2. **`rpc-packs` skill (MED)** — encode the pack data model so packs work is correct first time: `pack_table_rows` ← `pack_ev_latest` (secondary_ask/price_source), `/api/pack-listings` (live Dapper Studio asks, TS+AllDay), the `displayPrice` resolution order, slot-count coverage (TS 83% / others 0%), and the `pack_purchases.pack_dist_id`-always-NULL footgun.
3. **Live "RTR cheapest-EV pack" Cowork artifact (MED, fast)** — a persistent board of cheapest TS packs by secondary ask with EV beside each, re-querying live, serving the Road-to-the-Ring daily-quest need immediately — even before the frontend sort ships.
4. **Sentry smoke-hygiene automation** — let the daytime monitor auto-flag (not resolve) Sentry smoke issues untouched >14d so stale noise is surfaced for one-click bulk-resolve.

---

## What was NOT done / spans sessions
- **FMV accuracy pass (top-100 × 10 wallets vs LiveToken)** — the headline new ask; in progress, resumable via the per-wallet ledger.
- **Packs frontend changes** — handoff written, needs Claude Code to ship (Cowork can't push .tsx). Can be kicked off in parallel now given RTR is live.
