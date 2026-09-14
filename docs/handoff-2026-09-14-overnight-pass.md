# RPC nightly autonomous pass — handoff 2026-09-14

*Run id `np-20260914-b1f7` · desktop · started 01:04 PT (08:04Z) · **NO-PUSH MODE** (sandbox VM shell down 6th night — the Sept-8 Windows Plan9 mount breakage; `status.claude.com` incident). All work done via Supabase MCP + Vercel MCP + file-tool mount writes, which are unaffected. Handoff / ledger / metrics written to the mount **UNCOMMITTED** — a push-capable pass (or Trevor's desktop) must `git fetch`, reconcile, re-splice the ledger entry at the first `^### `, run the three ledger guards, then commit.*

## Verdict: QUIET / QUEUE-ONLY — nothing shipped, and that is the correct outcome

> ⛔ **COMMITTED 2026-09-14 ~08:05 AM PT, ~7 h after the pass ran — and THREE of the five items it queues had already shipped in that interval.** A push-capable desktop session did what the italics above ask: fetched (local `main` was **62 commits behind**), fast-forwarded, re-spliced the ledger entry at the first `^### `, ran the three ledger guards (headings **+1**, swallowed **3**, future-dated **0**), and committed. **Corrections, each re-derived at commit time rather than copied from a later entry:**
>
> - 🚨 **#82 — DONE, not queued** (item 2 in "Queued items carried forward"). Repaired the same morning: **37 sales + 643 wmc rows** re-keyed to base, guards on both inflow write points shipped first. `topshot_impossible_parallel_serials` **reads 0** (precompute 07:14 AM PT, re-read live). ⚠ The metric is **parallel-scoped** — **#116 is open** for 1,727 base-edition rows it cannot see, and that is a different defect, not a residue of this one.
> - ✅ **Concierge Goofy probe — FIXED** (item 3), `b86c18361`: the probe now requires the discount phrasing to be **uncorroborated**, so it stops firing on the product working correctly.
> - ✅ **#100 — RE-FRAMED, and the re-frame kills the proposed fix** (item 4): GitHub delivers this repo's scheduled workflows at a ceiling of **~0.3 ticks/hour each**, so moving `pipeline-sentinel.yml` to a tighter cron buys nothing. Moving the trigger **off** GHA is still the live option.
> - ⏳ **Q-SCB (item 1) and #101 (item 5) remain open exactly as written.** Q-SCB verified still unbuilt at commit time — no `claimable_soldat` migration exists anywhere in `supabase/migrations/`.

NO-PUSH removes code commits and Vercel deploys (Vercel builds from GitHub `main`, so an uncommitted change never deploys). That leaves only DB-additive migrations and Cowork artifact repairs as shippable — and the one DB candidate on the table (Q-SCB partial indexes) is **not** clearly-safe to build in this window (see below). A concurrent "Claude" session is also actively pushing docs commits to `main` (#113 delta reads — the last ~3 prod deploys are CANCELED/superseded churn from it), which independently degrades this pass to queue-only under the collision gate. **0 shipped, 0 reverted.**

## Post-ship regression watch (last 24–48h ships) — all green, one owed number finally landed

- ✅ **`daily-portfolio-snapshot` rows_written fix — VERIFIED.** The 00:05 PT run (07:05:30Z) wrote **`rows_written: 25`**, `ok: true`, `extra.result.inserted: 25`, `snapshot_date 2026-09-14`, 22.4 s. This was the one ship (from 09-13) whose real number had not yet landed — the earlier `rows_written: 0` was the OLD code on an earlier same-day run, exactly as the focus steer predicted. **No revert; target metric satisfied.**
- ✅ **`allday-dist-opened-expiry` (pg_cron jobid 490)** — healthy across the overnight ticks: `expired`/`refilled` moving, **`restored: 0`** every tick (Dapper upstream alive, so the self-halt falsifier did not fire). 07:41Z tick found nothing to do (`drifted:0 expired:0`) = caught up.
- ✅ **`idx_sales_2026/2027_nullseller_soldat`** (09-13 prod DB ship) — still chosen by the planner and used: `idx_sales_2026` **idx_scan 75 / 147,097 tuples read**; `idx_sales_2027` idx_scan 24 / 0 (empty partition, expected). No regression.
- No recent ship correlates with any regression; **nothing to auto-revert.**

## Section 2 health-drift triage

- **Security: 4/4 clean** — `invariants` / `anon_write_holes` / `rls_off_base_tables` / `secdef_anon_violations` all `[]` (from `rpc_ops_snapshot()`).
- **`stalled_pipelines`: `[]`** (clean). `sentinel_ts_uuid_editions_48h: 0`. `ts_uuid_dupes_created_24h: 0`.
- **1 trust BREACH — `topshot_impossible_parallel_serials` = 36** (breach_at 3). **Confirmed LIVE producer**, not a settled incident: 5 (09-11) → 29 (09-13 ~08Z) → 35 (09-14 06Z monitor) → **36 (08:03Z, this pass)** — a monotonic climb on the same precompute definition, ~+6/22h. Rows are inert to users (guarded at all four writers; the detector pages, it does not corrupt a surface). **Repair is Trevor/Claude-Code-gated** — a destructive re-key AND the writer fix is a route-logic change to the Top Shot sales→edition redirect path (the single silent-exit `if`, `edIdToExt.get(editionId)` returning undefined, already narrowed in #82). Both off-limits for an autonomous NO-PUSH pass. **Queued; the "is it live?" question is now answered — do not re-file that.**
- **Chronic timeout-under-load class (M11 / #42 / #73 / #84):** `fmv-backfill` 28.6%, `lock-check-batch` 31.8%, `price-snapshots` 43.8%, `run-insider-detectors` 31.5% — all `statement timeout` / `upstream request timeout`. Instance-load control taken at 08:0xZ (`pg_stat_activity`: 19 idle, **2 active IO:DataFileRead**, 1 active ClientRead) — **NOT in a live spell**; these are accumulated collateral from earlier spells. Known/documented, not a new finding.
- **Info-class (known, by design):** `pack_distributions` data_stale 11d (benign); `unmapped-sales-nfl_all_day` 28,413 actionable open rows draining ~15.4d (info); `golazos_sales` resolving_editions (info); Atlas 403 arms all `info` + attributed (net._http_response joined to dispatch request_id), freshness within cycle.
- **DB size 30,574 MB (+1,359 MB / 24h vs 29,215 on 09-13).** Continued growth from Atlas events + `cron.job_run_details` (no retention). Reclaim is a destructive/metered decision — **Trevor-gated**, unchanged.
- **Vercel:** production served by recent READY deploys; the newest ~3 are CANCELED/ERROR-then-superseded churn from the concurrent docs-pushing session. No standing prod ERROR.
- **Sentry:** skipped — browser SDK off / events dropped per #34 (no-spend decision).
- **Artifacts:** 11 enumerated, none flagged broken by the daytime monitor, which validated the merged `rpc-live-health` payload clean (all keys fresh). No logic drift → **none repaired** (artifacts are fresh-on-open; regenerating a working artifact for no reason is out of scope).

## Candidates assessed → all QUEUED

- **Q-SCB — sales-claimable partial indexes** (`idx_sales_2025_claimable_soldat`, `idx_sales_2024_claimable_soldat`; filing `inbox/2026-09-13T1800Z…`). DB-additive and NO-PUSH-eligible in principle, but **not clearly-safe to build in this window:** (1) a **wallet-backfill fan-out wave is active right now** — 30 runs in the last 30 min at hour-0/1 PT — and those waves reach 610 s runs that **block `CREATE INDEX CONCURRENTLY`** (`Lock / virtualxid`); (2) it is now **08:0xZ, past the 02:00–06:00Z DB quiet window** the filing explicitly requires; (3) `CREATE INDEX CONCURRENTLY` via `execute_sql` only works if it finishes inside the **60 s client cap**, and the filing's own attempt aborted at 60 s leaving an `indisvalid=false` index maintained on every write of the hottest write path. **No urgency:** the containment floor (`floor_sold_at` raised to 2026-01-01) keeps the lane cheap, so the only cost of waiting is ~150 `sales_2024/2025` rows staying unreachable. **Run in a genuinely calm 02:00–06:00Z window with no wallet-backfill wave, poll `pg_index.indisvalid` on a client timeout rather than retrying, then drop the floor.** Ready-to-run SQL is in the filing.
- **Concierge Goofy soft-probe permanently red** (`inbox/2026-09-14T0135Z…`). The probe (`concierge filters by character name`) fails every run on **correct** behaviour — the concierge's Goofy deal rows are verified accurate against `pinnacle_catalog`; the guard's regex `/\d{2,3}\s*%\s*(?:below|off|under)/` fires on any percentage-under phrasing, which *is* the deal-finding product. It is `soft: true` so it never fails the suite, but a permanently-red probe is a dead instrument. **Fix is a code change (a smoke-probe definition) → needs a push, and loosening a guard is the highest-risk edit class here → needs the concierge output-contract owner to decide** whether to require the percentage be uncorroborated (no FMV printed) before flagging, or retire the probe. **Queued — do not autonomously loosen.**
- **#82 writer fix** — route-logic + destructive re-key, both off-limits + push-gated (above). Queued.

## Queued items carried forward (for Trevor / a push-capable Claude Code pass)

1. **Q-SCB** — sales-claimable partial indexes; build in a calm 02:00–06:00Z window, poll `indisvalid`, then drop the floor. (SQL in `inbox/2026-09-13T1800Z…`.)
2. **#82 mis-key** — live producer confirmed (36). Destructive re-key (`remap_topshot_parallel_to_base_misattributed()`, no cron) + the single-`if` writer fix on the TS sales→edition redirect path. Replay the route against a captured tick.
3. **Concierge Goofy probe** — owner decides probe-vs-behaviour; then a push.
4. **#100 / master alarm** — `pipeline-sentinel.yml` GHA trigger fires ~27–29% of scheduled; move the trigger off GHA or stop calling it hourly.
5. **#101 / `topshot-misattrib-drain`** backlog growing since the 09-08 unscheduling — re-point to Atlas or accept and say so.
6. **#102 / suppressions naming `is_active=false` rows as active** — re-enable the rows and re-scope the false grants together.
7. **DB retention** — `cron.job_run_details` + Atlas events (destructive; +1.36 GB/24h).
8. **#55** Routines `enabled:false`; **#22** credential-purge GC + rotate; cron-job.org re-enables (offers-sweep, apply-fmv-haircut).
9. **Inbox archival** — needs a push-capable pass (backlog is large; NO-PUSH cannot move+commit).

## Failed / blocked / reverted

None. No verification failure; production shipping was never engaged (NO-PUSH + no clearly-safe candidate).

## Headline metrics (this pass)

- FMV HIGH+MED: **TS 7,869** (1,301H / 6,568M) · **All Day 1,905** (115H / 1,790M) · Golazos 4 · UFC 0 (Pinnacle tracked separately). Read as a RANGE — swings on sweep position.
- Editions: TS 14,015 · NFL 6,190 · Golazos 575 · UFC 518 · Candy MLB 125.
- DB size 30,574 MB · trust precompute max age 5.26h · board MV refresh stale 1.94h · sentinel TS uuid-edition leak 48h = 0.
