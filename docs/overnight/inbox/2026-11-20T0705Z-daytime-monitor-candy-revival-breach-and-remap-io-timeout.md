# Daytime monitor — 2026-11-20 ~07:05Z — Candy revival trust arm BREACHES again ($429.83 > $250): Candy is trading, the recorded 11-17 closure is stale; plus a one-off remap IO-timeout

**Source:** `rpc_ops_snapshot()` → `trust_health_breaches` + `v_rpc_trust_health.catches`; `sales`/`editions` day read; `check_pgcron_recent_failures()` + `cron.job_run_details`.

Both candidates are LOW-risk, sense-only. No platform breakage, no data loss, no user-facing staleness. No push sent.

---

## Candidate 1 (lead) — `candy_revival_sales_since_recorded_silence` = 429.83 (floor 250): re-verify Candy and re-date the closure

**Risk read:** LOW — this is the arm working **as designed** (its catches text literally describes this breach as the trigger to go re-verify), not a regression. Same maintenance class handled on 2026-11-18 (ledger: "Candy re-verified … silence re-dated to 11-17") and redefined to a $250 dollar floor on 2026-11-19 (ledger 113–117).

**What the instrument shows**
- `v_collection_marketplace_status` candy_mlb `secondary_status` is currently `silent_since_2026_11_17`. The arm sums USD of Candy sales on/after the day AFTER that date (i.e. 11-18 onward, PT).
- That sum is now **$429.83** across **11-18 $17.98 + 11-19 $411.85** — arithmetic matches the arm exactly ($17.98 + $411.85 = $429.83). Crossed the $250 floor on the 11-19 trading day.
- The 11-19 day is **44 sales / $411.85** — genuine resumed trading, not the wind-down dust trickle the $250 floor was built to ignore. (The $637.62 batch on 11-14 predates the current 11-17 silent_since and is correctly excluded.)
- Confirms `candy_sales_stale_hours` (2.8h, ok) — Candy sales are flowing again.

**Suggested action (night pass / Trevor)**
Re-look at Candy trading and update the `candy_mlb` row of `v_collection_marketplace_status` (`secondary_status`, `notes`, `last_verified_at`) — either re-date `silent_since` to the latest verified silence or flip the status if Candy is genuinely re-open. Per the arm's catches text, that returns `candy_sales_stale_hours` to its 7-day backstop and clears this breach. Sense-only maintenance; no code/DB-logic change implied beyond the status row.

---

## Candidate 2 — `rpc-topshot-misattrib-remap` one-off statement timeout at its quiet 05:53Z slot (11-20)

**Risk read:** LOW — one IO-spike timeout, not a steady-growth trend. Today's daily remap was missed; it self-recovers on the 11-21 05:53Z tick.

**What the instrument shows**
- `check_pgcron_recent_failures()` lists it `failed` at 2026-11-20 05:53:00Z, `canceling statement due to statement timeout` on the `INSERT INTO audit_topshot_sale_drain_remap_20260621 …`.
- Runtime trend (last 10 daily runs, s): 51.6 / 46.2 / 48.5 / 50.8 / 51.7 / 54.2 / **98.5** / 55.6 / **70.4** / **120.1→FAIL**. Median ~50s with headroom; the failures are **IO-variance spikes crossing the 120 s wall**, not monotonic growth (contrast `rpc-candy-wmc-ghost-purge`, which sat 70–109s for 10 days). A transient majority-IO-wait sample was seen at 07:05Z and cleared within a minute.
- Daily job; it won't re-fire until 11-21 05:53Z, so today's topshot sale re-attribution is one day behind.

**Suggested action (night pass)**
Run `SELECT public.remap_topshot_from_onchain_map();` once (in a quiet window) to close today's gap, and keep an eye on the 05:53Z headroom — if timeouts recur beyond IO variance, the ghost-purge prefilter/scoping pattern is the lever. No urgency.

---

## NOT findings (recorded so they are not re-raised)
- `rpc-candy-wmc-ghost-purge` pg_cron failure (11-19 09:10Z, statement timeout): STALE pre-fix run — fix `20261119110000` landed ~19:00Z 11-19, next tick 11-20 09:10Z. Already filed in `2026-11-20T0105Z` + ledger:121.
- `compute-pinnacle-pack-ev` severity: resolved 11-19 (`20261119171500` caps the Atlas challenge at medium); snapshot shows **0 HIGH** alerts this sweep.
- All `pipeline_alerts` medium/info rows are the recovering #218 Dapper 530 window (streak-split to info) or designed Atlas/Flow Cloudflare base-rate rows — none escalated.
- Security invariants/anon-write/RLS-off/secdef-anon all `[]`; `detect_stalled_pipelines()` []; sentinel TS-UUID-48h 0; `ts_uuid_dupes_created_24h` 0; 13/13 dashboards' objects + 5 RPC fns resolve; Vercel 0 ERROR (last READY ff383f0b; newest docs commit 91f33950b CANCELED); recent ship `panini-market-board` hourly cron_heavy 06:37Z ok 83.6s.
