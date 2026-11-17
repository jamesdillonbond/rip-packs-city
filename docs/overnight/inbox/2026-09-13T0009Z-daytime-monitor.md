# Daytime monitor — 2026-09-12 ~17:09 PT (2026-09-13T00:09Z)

READ-ONLY sweep. Push path down (VM shell dead since the 09-08 Windows update; per today's ledger). **Inbox written to mount, push unavailable** — night pass picks it up locally.

## Health at a glance
- Security invariants 4/4 clean (invariants / anon_write_holes / rls_off_base / secdef_anon all `[]`).
- Vercel: latest production deploy READY (nav re-slot commit, author Claude).
- DB 29,448 MB. io_wait=0 / active=0 at 00:09Z — **not in a live spell right now**, though the day has been spell-prone (18:00–23:25Z pg_cron timeout cluster; consistent with the documented recurring pattern, register #73/#84/#85).
- 3 trust-health BREACHes, all accounted for below.

---

## CANDIDATE 1 — LIVE, MEDIUM — Pack Sniper live-ask feed silent 45 min; two cron-job.org jobs stopped at the same instant

**Source:** `detect_stalled_pipelines()` + `pipeline_runs`. `snapshot-pack-asks` (cron-job.org job 7878615, every 5m) last ran **2026-09-12 23:23:04.268Z**; `golazos-listings-indexer` last ran **23:23:03.638Z**. At 00:08:57Z both were still silent — **45 min, ~9 missed 5-min ticks** for pack-asks (`pack_asks_runs_90m = 1`).

**Why this is NOT saturation collateral (the discriminator):** `pg_stat_activity` at 00:08Z reads **io_wait=0, active=0** — the instance is idle, so the ask-snapshot endpoint would be responsive. The two jobs stopping at the *same second* (23:23:03–04Z) points to a **cron-job.org-side pause/hiccup on those jobs**, not a DB-side stall. (Most RPC lanes run via pg_cron/GHA and are firing normally; these two are the frequent cron-job.org lanes.)

**Blast radius:** `snapshot-pack-asks` feeds `pack_ask_state` recency (the Pack Sniper NEW / price-drop signal) — user-facing freshness degrades the longer it's out. `golazos-listings-indexer` feeds `cached_listings_v2` source=direct for Golazos.

**Risk:** low to inspect, external to fix.
**Suggested action (operator / night pass, NOT sandbox):** check the cron-job.org console for job **7878615** and the Golazos indexer job — are they paused / erroring on cron-job.org's side? If cron-job.org shows them enabled and green, re-check `max(started_at)` for both; if they resumed on their own it was a transient platform hiccup (close). If still silent, this is a cron-job.org enable/schedule issue like the offers-sweep disable, not a code bug.

---

## CANDIDATE 2 — SYMPTOM, LOW — trust precompute + public boards stale/slow (spell collateral)

**Source:** `rpc_ops_snapshot().trust_health`. `trust_precompute_max_age_hours` = **17.3** (breach_at 13); `public_board_slow_count` = **10** (breach_at 1).

**Read as SYMPTOM, not cause (Section 1c):** both are the fingerprint of today's IO-saturation spell starving the precompute/board-refresh lanes (the pg_cron refresh cluster — `rpc-ccm-step2`, `rpc-refresh-*-pack-sales-agg`, `rpc-allday-ev-corrected-refresh`, `rpc-pinnacle-fmv-recalc-backstop` — all hit `statement timeout` between 18:00–23:25Z). The instance is idle now, so these should self-heal on the next uncontended refresh tick.

**Suggested action:** RE-MEASURE in a quiet window (02:00–06:00Z) — if `trust_precompute_max_age_hours` has not fallen back under 13 by then, the precompute refresh lane itself is stuck (escalate); if it has, this was spell collateral (close). Do not derive a cause from a spell-time reading.

---

## Not logged (already known / tracked — verified against ledger + register this pass)
- `topshot_impossible_parallel_serials` = 5 (breach_at 3) — **known #82**, ticked 4→5; re-read as a mis-keyed-sales detector, self-heal is a structural no-op (migration 20260911103459). No new action.
- `sales-counterparty-backfill` 234/502 failed (46.6%) — **pooled across today's 12:31 PT cursor-reset fix** (ledger 2026-09-12); the post-fix ticks do real work (rows_found/written 120). Not a new failure.
- `fmv-backfill` / `allday-buyer-backfill` / `lock-check-batch` / `price-snapshots` / `run-insider-detectors` statement-timeout failure rates — saturation collateral, documented (#73/#84/#85); the FMV chain is ~60% of disk IO and the 09-09 trigger is the open lead, both already tracked.
- `pack_distributions` data_stale 9d — known.
- `offers-sweep` 7/7 (GraphQL 530) — known, intentionally disabled on cron-job.org (fails tailing off; 1 fail/24h).
- Atlas 403 edge-fn arms (editions 5.6%, market 2.0%) + `flow-rest-moment-moved-400` 78% — all self-attributed info arms, by design, freshness green.

## Artifact validation
Core health-vector data (the source for `rpc-live-health`) validated via `rpc_ops_snapshot()` — succeeded, sane. Per-artifact payload queries NOT individually re-run this tick to avoid stacking IO on a spell-prone day; defer full per-artifact validation to a quiet-confirmed tick.
