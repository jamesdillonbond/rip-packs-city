# RPC nightly autonomous pass — 2026-08-08 (GENUINE OVERNIGHT, but NO-PUSH: shell/git down)

**Mode: GENUINE OVERNIGHT → NO-PUSH.** Real time at run start (from DB, not the shell): DB `now()`
2026-08-08 08:03Z = **01:03 PDT**, inside the 00:00–06:00 overnight window. App rows bound real time
from below (max `sales.ingested_at` 07:59Z, max `fmv_snapshots.computed_at` 07:57Z) — no clock skew
concern, and it doesn't matter here because the shell clock was unavailable anyway.

**The workspace shell is completely down** — every `mcp__workspace__bash` call failed identically
3× with `mkdir /sessions/practical-quirky-wozniak/mnt: no space left on device` (the documented
"/sessions no space" class, this time fatal to the whole sandbox, not just the clone). That means
**no git at all** this run: no sandbox clone, and even the mount-based `GIT_INDEX_FILE` plumbing
fallback needs the shell. Per the NO-PUSH rule this run therefore:
- did the full review + Section 2 health triage + post-ship watch;
- could still read the mounted tree (Read/Glob with explicit Windows paths) and query Supabase /
  Vercel / Sentry over MCP;
- **shipped no code and no DB migration** (see "Shipped" — 0 was also the correct call on merits);
- wrote all output docs **directly to the mounted tree** via the file tools (they persist on
  Trevor's machine; **flagged UNPUSHED — Trevor/CC must commit them**).

Shipped 0 · reverted 0 · repaired 0. A quiet, honest night: the big 08-07→08 Claude-Code/interactive
wave is healthy and holding, candy-offers and the Panini home-box are both **already resolved**, and
every open finding is operator-owned, already-tracked, or a documented do-not-re-flag class.

Lock: prior `.lock` was RELEASED (2026-08-07T15:12Z); took it, marked RELEASED again at end.

---

## Post-ship regression watch — 08-07→08 CC/interactive wave: ALL PASS, 0 reverts

The last ~24–48h landed a large wave (candy-offers reliability fix, the FMV 90d-accuracy catch-up,
several test-only batches, the candy-offers trust-health coverage arms, and the proxy.ts page-metering
mitigation). Re-measured each against the metric it was meant to move:

- **candy-offers reliability fix** (concurrency→1 + per-request throttle + batched DB reads;
  `git log --grep="drop concurrency to 1"`). **HOLDING.** The two most recent ticks are
  `2026-08-08 06:50Z` and `03:15Z`, both **ok=true, degraded_sweep=false**, deactivation running
  (7 and 9 offers retired). The two failures immediately before (00:50Z, 02:52Z) predate the fix
  (03:15Z was the first ok). No regression — this is the recovery, not a relapse.
- **candy-offers trust-health coverage arms** (migration `20260808035000_audit_20260808_candy_offers_coverage_arms`,
  the repo-catch-up commit for MCP-applied arms). Both arms read healthy now:
  `candy_offers_unverified_pct` = **0.0** (would have read 78 during the outage),
  `candy_offers_oldest_active_hours` = **1.3** (was 79.7). Neither breaches.
- **FMV 90d catch-up** (Top Shot + All Day; `fmv-recalc` Step 2a-quinquies + `fmv_recalc_90d_catchup_editions`).
  Target metric = share of prices at HIGH/MEDIUM. HIGH+MED **climbing, no regression:** Top Shot
  7112 → **7359** (+247), All Day 1713 → **1746** (+33). `fmv_sweep_stall_pct_24h` steady at 4.3.
- **proxy.ts page-metering mitigation** (`acb5ff24`, 08-07 — meters DB-backed page routes against the
  AI-crawler pooler-exhaustion class). The statement-timeout signal is now the **intermittent** class,
  not persistent saturation: `pipeline_runs` 209 ok=false / 13,997 runs in 24h = **1.5%**, and
  `pg_stat`-class jobs recover on the next uncontended tick (see the two pgcron jobs below). No new
  Sentry issue traces to it.
- **Panini home-box runner** (08-07 operator item "wake the box"). **RESOLVED:** `panini_fmv_stale_hours`
  = **2.4** (ok); the runner resumed FMV writes. Only `panini_sale_price_capture_dry_days` (=11) is
  still breached — a separate upstream price-capture outage that needs a live A/B on the box.

**Nothing to revert.** No shipped change in the window correlates with a regression.

---

## Section 2 health-drift findings + deltas

**Security: fully clean (4/4).** `check_public_security_invariants()` [] · `detect_stalled_pipelines()`
[] · `check_anon_write_surface()` [] · `check_secdef_anon_exec_drift()` []. (`rpc_ops_snapshot()`
itself timed out on its `sentinel_fmv_confidence_rows` leg — a known heavy-scan flap under contention,
not a security signal; ran each check individually instead.)

**Stalled pipelines: none** (`detect_stalled_pipelines()` = []). Both prior stalls — candy-offers
(was 62h) and panini-ingest (was 37.7h) — are resolved.

**pg_cron:** `check_pgcron_recent_failures()` = 2, both the documented statement-timeout contention
class on idempotent MV refreshes, both self-recovering:
- `rpc-refresh-allday-pack-realized` — 11 ok / 5 fail over 4 days; last_ok 2026-08-08 00:35Z, the
  06:35Z tick failed. Runs every 6h; recovers next tick. Not a finding.
- `rpc-refresh-misattrib-candidates` — 3 ok / 1 fail over 4 days; last_ok 2026-08-06 15:35Z, the
  08-07 15:35Z daily tick failed (`REFRESH MATERIALIZED VIEW mv_topshot_misattrib_candidates` hit the
  statement timeout). Runs ONCE daily, so the MV is ~1.7d stale and won't self-clear until the next
  tick (~08-08 15:35Z). This is the 08-08T0306Z inbox candidate. **QUEUED** (see below) — LOW,
  internal helper MV (parallel↔base misattribution drain), corrupts nothing.

**pipeline_alerts (2-day window):** all map to tracked classes — `allday-lock-refresh` 66.7%
(QUEUED, ALLDAY-LOCK-REFRESH-SELECTION-COST, owner-gated index), `candy-offers-indexer` 80% (TRAILING
window; latest ticks ok=true per above — not a live finding), `sync-nba-projections` 100%
(off-season, no NBA in August), `topshot-active-listings-ingest` egress_blocked (Atlas-WAF, "do not
suppress"), `allday-buyer-backfill` / `lock-check-batch` / `wallet-username-resolver` /
`topshot-pack-opens-history-backfill` (known timeout/wedge classes, all queued/handed off),
`unmapped-sales-nfl_all_day` info (44,096 actionable, net-draining).

**Sentry:** **0 new issues first-seen in 24h** (`is:unresolved firstSeen:-24h` → none). The standing
entity-page statement-timeout cluster is the documented scraper-saturation collateral; real fix is
edge rate-limiting (operator, Vercel Firewall).

**Trust health — 4 BREACH, all known/by-design/tracked:**
- `panini_sale_price_capture_dry_days` = **11** (breach_at 3) — upstream Panini price-capture outage
  since ~07-29; needs a live A/B across listType values on the runner box (interactive). Carried.
- `public_board_slow_count` = **5** (breach_at 1) — crawler-contention class; "do NOT re-budget under
  crawler load". Bursty (0 → 4 → 5 across recent ticks). Carried.
- `ufc_fmv_stale_hours` = **97.6** (breach_at 30) — RED BY DESIGN since UFC market closed 2026-05-13;
  retire-or-rebase decision owed to Trevor. Do NOT raise breach_at. Carried.
- `unmapped_resolution_backlog_max` = **175** (breach_at 100) — documented continuously-replenished
  permanent-class floor. **Stable at 175** (was climbing 105→127→175 through 08-07; held flat today).
  Carried.

**Overnight deltas vs metrics-latest (2026-08-07):**
- FMV HIGH+MED: Top Shot 7112 → **7359** (+247), All Day 1713 → **1746** (+33), candy_mlb 74 → 72
  (−2), Golazos 3, UFC 0 (by design). Pinnacle render-keyed (not in `fmv_current`).
- editions: Top Shot 19,666 (flat), All Day 6,190 (flat).
- DB size 12,368 → **12,444 MB** (+76).
- `fmv_sweep_stall_pct_24h` 4.2 → **4.3** (healthy).
- `panini_fmv_stale_hours` breach (37.7) → **cleared** (2.4). candy-offers stalls → cleared.
- pipeline fails 209 / 13,997 runs 24h = **1.5%** (normal contention noise).

**Artifacts:** not exercised this run — the Cowork artifact tools were available, but (a) the daytime
monitor validated the flagship `rpc-live-health` payload live at both 08-07 ticks (all panels sensible,
data fresh to seconds, no renamed backing objects), (b) no schema-break shipped since, and (c) artifact
data is fresh-on-open, so there was nothing drifted to repair. No repair needed.

---

## Shipped

**None.** Ship 0 is correct here on two independent grounds: (1) NO-PUSH mode structurally blocks code
commits/deploys (Vercel builds from GitHub `main`; an unpushed commit never deploys); (2) on merits,
no genuinely-low-risk, net-positive, fully-verifiable DB migration presented itself — the one LOW
candidate (misattrib-candidates reschedule) is speculative and would drift the repo from prod (see
below). A quiet honest night is the intended outcome.

---

## Queued

### NEW this run

1. **`rpc-refresh-misattrib-candidates` daily MV refresh timed out (08-07 15:35Z tick) — LOW, internal.**
   `REFRESH MATERIALIZED VIEW public.mv_topshot_misattrib_candidates` hit the statement timeout; the
   job runs once daily so the MV is ~1.7d stale until the ~08-08 15:35Z tick. It seq-scans the full
   Top Shot sales history (~613k cost; `collection_id` indexes non-selective) and dies under
   contention — the 07-13 reschedule (03:25Z → 15:35Z, per `audit_20260713_reschedule_misattrib_candidates_offpeak`,
   pg_cron job 70) no longer holds because 15:35Z is now also contended. **Not autonomously shipped
   this run because:** (a) NO-PUSH — a `cron.alter_job` reschedule applied via MCP can't be committed
   to the repo, creating the exact repo-vs-prod drift class the 08-08 candy-offers-arms catch-up was
   cleaning up; (b) the inbox itself notes all candidate slots (21:00-01:00Z, 00-06Z, evening peaks)
   are crowded, so a "quiet slot" move is speculative; (c) it's an internal helper MV for the
   parallel↔base misattribution drain — a stale refresh delays candidate discovery but corrupts
   nothing, and it self-retries daily. **Two options for a normal (push-capable) run:** (a) low-risk
   lever — reschedule to a genuinely idle slot verified against `pg_stat_activity` (needs a live idle
   window; ready form: `SELECT cron.alter_job(70, schedule => '<idle> * * *');` revert = restore
   `35 15 * * *`); (b) deeper fix — rework the refresh so it uses the pristine
   `idx_sales_*_ts_edserial_collide` indexes instead of seq-scanning (query rework, tests, CC-owned).
   Night-count 1.

### Carried (unchanged)

- **`allday-lock-refresh` selection-cost** 66.7% timeout — owner-gated index (ALLDAY-LOCK-REFRESH-SELECTION-COST).
- **`wallet-username-resolver`** 33.9–46% timeout — heavy 21-day re-aggregation; operator cadence-cut
  (~20min → hourly) or a code RPC watermark rewrite. Night-count 4.
- **`topshot-pack-opens-history-backfill` wedge** — spork-routed Deno edge fn hard-wedged on a
  persistently-transient leading chunk (`status 0`); handoff `docs/handoff-2026-08-07-pack-opens-history-backfill-wedge.md`
  (`8d01cc61`). Unverifiable from the cloud sandbox (Flow/spork egress proxy-blocked) → operator/CC.
- **`unmapped_resolution_backlog_max` = 175** — permanent-class floor; held flat today (stopped
  climbing). Fix is a resolver failure-REASON + exclude-by-reason, not a threshold. Pull forward only
  if it resumes climbing.
- **`ufc_fmv_stale_hours` red-by-design** — Trevor decision owed: retire-or-rebase the arm (do NOT
  raise breach_at). Precedent: the ufc_sales CRITICAL arm was suppressed 2026-08-02 for the same reason.
- **`panini_sale_price_capture_dry_days` = 11** — upstream capture-mechanism outage; needs a live A/B
  on the runner box (interactive). Do NOT install a mechanism guess without that A/B.
- **`public_board_slow_count` crawler contention** — do NOT re-budget the board-probe max_ms under
  crawler load (rebaseline already queued).
- **FMV-RECALC-MAXDURATION 300 → 800** — DE-PRIORITIZED; sweep-stall holds ~4%.
- **`topshot_flowty_backfill` cursor_stalled false positive** at `SPORK_FLOOR_HINT` — LOW/cosmetic.
- **Standing queue** — edge-orchestration, non-wave wallet driver, DUNE seller-recovery inert,
  chain-two gated.

---

## Failed / blocked / reverted

Nothing shipped, nothing errored, nothing rolled back. The only "blocker" is environmental: the
workspace shell is down (`/sessions` no space), which forced NO-PUSH mode. All output docs below are
written to the mounted tree and are **UNPUSHED** — Trevor or a Claude Code session needs to commit:
`docs/handoff-2026-08-08-overnight-pass.md`, the `docs/overnight/ledger.md` entry,
`docs/overnight/metrics-latest.json`, the two archived inbox files, and the CLAUDE.md Recent-sessions
entry.

**Operator visibility gaps:** the sandbox `/sessions` "no space left on device" has escalated from
"clone must go to /tmp" (prior nights) to "the whole workspace shell won't start" — worth a provisioning
look so future overnight passes can push again.
