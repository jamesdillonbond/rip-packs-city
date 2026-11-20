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

## Addendum — 2026-11-19 ~11:20 PM PT (Cowork cloud, evening audit pass) — composition of the 11-19 Candy day, for whoever re-verifies

Read from `sales` ⋈ `editions`, Candy, 11-19 PT (midnight to midnight): **44 sales, 15 distinct buyers, 9 distinct sellers, 23 sets**, first 5:50 AM PT, last 8:15 PM PT; median $0.51, max $148.99 (2023 Showstopper ICONs). By value: 2024 MLB Postseason Gems $75.44 (1), 2025 MLB Starting 9 ICONs $65.13 (2), 2025 MLB Rookie ICONS $40.24 (1), **2026 MLB Base Series ICONs $21.91 (4)**, 2025 All-Star ICONS $20.87 (2). Daily counts 11-16 → 11-19: 3, 8, 13, 44.

Two things differ from every earlier re-date note on the `candy_mlb` row: this day includes sales in a 2026 set (the notes of 11-12, 11-14 and 11-18 each say "none in a 2026 set"), and the buyers are many rather than one batch. That reads as trading resuming at a low level, not a dust trickle, so a sixth re-date of `silent_since` may be the wrong record. Not changed from this session: the status row is the night pass's to re-verify (it wrote the last five), and what the row should say when a market is open but thin is a wording decision.

Candidate 2 (`rpc-topshot-misattrib-remap`): NOT run from this session — scheduling a one-off pg_cron job for `remap_topshot_from_onchain_map()` was refused by the session's permission system, and the function runs 50–120 s, past the MCP's 60 s statement cap. It re-runs by itself at the 9:53 PM PT tick on 11-20. Run it by hand before then only if a day's lag in Top Shot sale re-attribution matters.

## ✅ RESOLVED — 2026-11-20 ~6:42 AM PT (Cowork cloud, evening-audit thread)

**Candidate 1 — done.** Re-verified at 6:45 AM PT: 11-18 ×13 ($17.98, 5 buyers), 11-19 ×72 ($461.41, 17 buyers, 9 sellers, 70 editions; more 11-19 sales were indexed after the earlier 44-sale read). Trading resumed, so the silence was retired, not re-dated: migration `20261120144221` sets `secondary_status = thin_since_2026_11_19`. The revival arm reads 0 and `candy_sales_stale_hours` is back on its 168 h backstop; trust board 42/42.

**Candidate 2 — closes by itself.** The one-off remap run was refused by the session permission system twice (this thread and the overnight pass) and was not worked around. The daily job re-runs at 9:53 PM PT 11-20; `SELECT public.remap_topshot_from_onchain_map();` by hand closes it sooner.
