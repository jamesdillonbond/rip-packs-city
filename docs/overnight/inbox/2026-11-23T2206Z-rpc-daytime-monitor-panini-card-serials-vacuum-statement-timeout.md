# Daytime monitor — pg_cron VACUUM job `maint-vacuum-panini-card-serials` hit a statement timeout (first failure)

- **Filed:** 2026-11-23T22:06Z by `rpc-daytime-monitor` (read-only daytime pass).
- **Source:** `check_pgcron_recent_failures()` → pg_cron job 678 `maint-vacuum-panini-card-serials`, schedule `4 11,19 * * *`, command `VACUUM (ANALYZE) public.panini_card_serials`.
  - Last run **2026-11-23 19:04:00Z — `ERROR: canceling statement due to statement timeout`** (fails_in_window 1 / runs_in_window 2).
  - The 5 runs before it (11-21 11:04Z → 11-23 11:04Z) all `succeeded`. This is the **first** failure for this job.

## What it is
`panini_card_serials` is the estate's heaviest table (~12.8 GB, ~6.1M rows, ~35M lifetime updates; see ledger: "DB growth since 10-26 ~3.7 GB/wk, led by panini_card_serials 12.8 GB", and the repeated "margin is closing" notes on full-scans of this table at 47–87 s against the 120 s budget). A twice-daily `VACUUM (ANALYZE)` of it just crossed the role's `statement_timeout` for the first time. A VACUUM that is cancelled leaves no work committed and reruns next tick — the 11-24 11:04Z tick will re-attempt — so **nothing is lost right now**; this is a freshness/throughput margin signal, not an outage, and it tracks the known continued-growth class on this table.

## Risk read
LOW. Single isolated timeout, self-recovering on cadence; not a logic error; not a spell (positive control not taken but `rpc_ops_snapshot()` and trust-health all returned fast/clean this run). Autovacuum still covers the table independently of this scheduled VACUUM.

## Suggested action (night pass / Trevor — NOT taken by this read-only monitor)
A scheduled maintenance `VACUUM` should not sit under a short `statement_timeout`. Consider wrapping the job command so the VACUUM runs with `statement_timeout = 0` (or a generous value), e.g. `SET statement_timeout=0; VACUUM (ANALYZE) public.panini_card_serials;` via `cron.alter_job(678, command := ...)` — same statement-timeout-fit class as the prior offers-backstop / serial-FMV job fits. Alternatively confirm autovacuum/analyze cadence is sufficient and retire or thin job 678. Reversible: `cron.alter_job(678, command := 'VACUUM (ANALYZE) public.panini_card_serials')`.
- Re-measure: if the next 1–2 scheduled runs (11-24 11:04Z / 19:04Z) also time out, the margin has closed for good and this escalates from a one-off to a standing fit.

---

## 🔧 FIX APPLIED 2026-11-23 ~3:19 PM PT (Claude Code cloud) — `20261123231928`; verify 11-24 3:04 AM PT

- ⛔ **The suggested `SET statement_timeout=0; VACUUM …` would have failed outright:** a multi-statement pg_cron command runs in a transaction block, and `VACUUM cannot run inside a transaction block` (database.md, R108 — the same class as CIC).
- **Applied instead:** job 383's recipe for `sales_2026`. `GRANT MAINTAIN ON panini_card_serials TO cron_heavy`, and the job was re-created under `SET LOCAL ROLE cron_heavy`. Same name and schedule, now **jobid 919**, with a 600 s role default and no `SET` prefix. A post-condition asserts MAINTAIN, because without it VACUUM warns-and-skips and still reads `succeeded`.
- **Verify (focus.md):** the 11-24 11:04Z run of 919 `succeeded`, AND `last_vacuum` for `panini_card_serials` moved to that run. Then mark this RESOLVED.
