# Daytime monitor candidate — 2026-10-04T0609Z

## HIGH — Panini insight boards timing out + snapshot STALE since 04:07Z, climbing (SYMPTOM — defer cause to a quiet-window re-measure)

- **Title:** `panini_deal_board` / `panini_special_serials_board` / `panini_player_board` statement-timeout; panini board snapshot not refreshed since 04:07Z and aging ~15 min/tick (120→135→150→165 min and climbing).
- **Source:**
  - Vercel runtime errors (project prj_YBJ6Utl32GfyBOIzbsp3kbshJh96), first seen **2026-10-04T02:52:12Z**, last 06:08Z: `[panini-more-boards] panini_deal_board: canceling statement due to statement timeout` count=23/21 users; `panini_special_serials_board` count=22/21 users; `panini_player_board` count=6/6 users. User-facing routes: `/[collection]/edition/[slug]`, `/[collection]/market`, `/[collection]/player/[slug]` (plus `/api/cron/refresh-insights-cache`).
  - `pipeline_runs` `refresh-insights-cache`: clean through 04:07Z → panini-board timeout (ok=true, error populated) 04:22–05:07Z → **stale-gate tripping ok=false 05:22Z onward** ("STALE panini-boards: snapshot 120/135/150/165min old"). Snapshot last successfully rebuilt ~04:07Z.
- **Change point / correlation (NOT a cause claim):** symptom onset ~04:22Z follows the overnight Flowty-promotion migration + large-row promotion burst (20 migrations 2026-10-03T23:07Z → 2026-10-04T03:48Z, incl. `promote_flowty_chain_sales` 02:33Z, `promote_flowty_chain_sales_checkpoint_decides_printing` 02:55Z, and panini-touching `audit_20261003_panini_pack_ev_board_models_only_its_own_packs`). The promotion landed a large row volume (deploy notes cite ~430k rows / ~108k TS Flowty sales). Whether that volume/stats change slowed the panini board queries, or a panini migration regressed a plan, is UNKNOWN from here.
- **Risk read:** User-facing degradation, worsening (staleness climbing linearly, not self-clearing). The stale-gate is WORKING — it refuses to publish a success while panini boards are stale, so pages serve an aging (≤~3h) snapshot rather than empty. Not an outage. This is a monitor SENSE-ONLY observation — no fix attempted.
- **Suggested action (night pass / Trevor — RE-MEASURE, do not conclude from daytime timing):** In a quiet window (positive control first: `pg_stat_activity` IO-wait share), `EXPLAIN (ANALYZE, BUFFERS)` the `panini_deal_board` / `panini_special_serials_board` build inside `refresh-insights-cache` and compare Buffers to a pre-02:52Z baseline. Determine whether the regression is (a) promoted-row volume / stale planner stats on a shared sales table (→ ANALYZE / a predicate or partial index), or (b) a plan regression introduced by one of the 10-03/10-04 panini/promotion migrations. Do NOT revert and do NOT lengthen the statement timeout as the first move (that masks the plan). Re-open trigger if already triaged: panini snapshot age keeps climbing past ~180min on two consecutive monitor ticks.

### Minor (same window, NOT separate bugs)
- `backfill-pack-rip-metadata` 2 statement-timeouts in the last 120 min (05:53, 04:53Z) but **22 ok / 2 fail over 24h** — transient collateral of the same 05:xx ingest window; healthy over 24h. Watch only if consecutive timeouts continue past 06:53Z.
- `pg_net_http_400` HIGH = 1 call/2h, body "Invalid Flow request: failed to convert event payload for block …" = Flow node-fault class (matches the by-design mainnet24 #166 walk); request_id/url join came back empty. Attribution unconfirmed; single transient, not chased.

_Filed by rpc-daytime-health-monitor. READ-ONLY sweep. Everything else GREEN (security 4/4, structural 7/7, trust 0 breaches, stalled [], pg_cron 0 fails, no deploy ERROR, not in a saturation spell: IO-wait 1/2 active)._

---

## ✅ RESOLVED — three covering indexes, not a transient (Claude Code, 10-04; re-verified on the Windows box ~7:20 AM PT)

The overnight pass (~1:15 AM PT) called this a transient of the Flowty promotion wave, because the boards recovered at ~11:22 PM PT and nothing was slow in its quiet window. **That was wrong.** The timeouts came back at 5:22 AM PT with 0 IO waits, and the plans were measured:

- `panini_deal_board` 23.8 s → 0.99 s: `20261004123243` (covering index; 22.6 s was heap reads behind `idx_panini_serials_listed_edition`).
- `panini_special_serials_board` 10.6 s → 110 ms: `20261004124114`.
- `panini_player_board` 6.35 s → 0.68 s: `20261004124411` (partial rookie-serial index).

The cause was `panini_card_serials` growth (1.44 M rows) leaving these boards on heap-fetch plans. They crossed the 30 s cap whenever the cache was cold. Detail is in the three 10-04 ledger entries.

**Read-back (~7:20 AM PT):** `refresh-insights-cache` is ok=true on every tick since; the `panini-boards` snapshot rebuilt at 5:52 and 6:52 AM PT (200 rows, age 0), with total run time 2–10 s.

This filing was found on the box sitting untracked in `inbox/archive/`. It belongs here: the inbox is append-only.
