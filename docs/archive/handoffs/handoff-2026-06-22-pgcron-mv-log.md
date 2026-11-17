# Handoff — log the pg_cron MV-refresh migration (record-only, no code/DB work)

## Context

Follow-up to `docs/handoff-2026-06-22-cowork-asset-audit.md` (already drained). After that handoff, a Cowork session shipped one more **live DB migration** and finished the asset cleanup. The migration is already applied and verified; **this handoff is purely to record it** in CLAUDE.md + the ledger — Cowork can't `git push`, and it can't safely edit the 276 KB `ledger.md` from the mount (truncation hazard). No code or DB change is needed here.

HEAD at handoff: `bc3b01c` (+ whatever you committed draining the prior handoff).

## The one item — add the log entries

**Migration (already live):** `audit_20260622_pgcron_refresh_special_serial_owners_mv` — registered pg_cron job `rpc-refresh-special-serial-owners-mv` (`13 4,16 * * *` UTC) calling the self-logging SECDEF fn `refresh_topshot_special_serial_owners_mv()`.

**Why:** the special-serial-owners MV refresh was on a (now operator-disabled) cron-job.org HTTP entry whose synchronous PostgREST call hit Supabase's ~120s API-gateway request cap on the ~125s `REFRESH MATERIALIZED VIEW CONCURRENTLY` — so it logged `ok=false` even though the MV committed (the source of the daily `ts-backfill-drain-serial-fmv-watch` red). pg_cron runs in-DB with no gateway cap, and the fn self-logs `ok=true` post-COMMIT. Idiomatic — it's now the 8th pg_cron job, same shape as `rpc-refresh-thin-fmv-guard`. Verified: job `active=true`, fn SECDEF + `statement_timeout=200s` + grants postgres/service_role only (no anon), unique index present for CONCURRENTLY, `check_public_security_invariants()` = 0. First tick fires 04:13 UTC (a one-off `verify-mv-pgcron-first-tick` Cowork task will confirm `ok=true`).

**Revert:** `SELECT cron.unschedule('rpc-refresh-special-serial-owners-mv');` (and operator re-enables the cron-job.org HTTP entry if reverting fully).

### Paste-ready CLAUDE.md "Recent sessions" entry

> ### June 22, 2026 (Cowork) — asset-audit close-out: pg_cron MV refresh + scheduled-task/skill/artifact/memory cleanup
> Closed out the 2026-06-22 Cowork asset audit. **DB (live):** `audit_20260622_pgcron_refresh_special_serial_owners_mv` moved the special-serial-owners MV refresh off the (now-disabled) cron-job.org HTTP entry onto pg_cron job `rpc-refresh-special-serial-owners-mv` (`13 4,16 * * *` UTC → self-logging `refresh_topshot_special_serial_owners_mv()`); fixes the daily false `ok=false` (gateway 120s cap on the ~125s sync refresh) that was reddening `ts-backfill-drain-serial-fmv-watch`. Revert: `SELECT cron.unschedule('rpc-refresh-special-serial-owners-mv');`. **Skills:** `rpc-data` canonical-edition predicate fixed to `^[0-9]+:[0-9]+(::[0-9]+)?$` (was dropping ~1,775 `::` parallels); new `rpc-artifact-ops` skill — both committed (handoff-2026-06-22-cowork-asset-audit) + installed. **Scheduled tasks:** `rpc-flow-ecosystem-watch` prompt fixed (verbatim Pinnacle REST URL), 14 spent one-offs deleted, all enabled tasks verified producing real output. **Artifacts:** retired `pack-drops-ev-check` + `rpc-ts-data-mission` to tombstones; fixed the `rpc-qa-scorecard` stale flowty_archive footnote. **Memory:** trimmed 12 over-budget MEMORY.md index lines back under the size cap. Verified `seed_topshot_sales_history_targets()` already service_role-only (no hole).

### Ledger `Shipped` line

> 2026-06-22 (Cowork) `audit_20260622_pgcron_refresh_special_serial_owners_mv` — pg_cron `rpc-refresh-special-serial-owners-mv` (`13 4,16 * * *` UTC) → `refresh_topshot_special_serial_owners_mv()` (self-logging SECDEF). Bypasses the ~120s API-gateway cap that logged false `ok=false` on the committed MV refresh. cron-job.org HTTP entry disabled by operator. Revert: `SELECT cron.unschedule('rpc-refresh-special-serial-owners-mv');`.

## Guardrails
- Direct-to-`main`, no branches/PRs. Commit via PowerShell `git`; verify `git rev-list --count origin/main..HEAD` → 0.
- This is docs-only — it'll be skipped by the `vercel.json` `ignoreCommand` (no prod deploy), which is fine; nothing to smoke.

## Expected end state
CLAUDE.md + ledger carry the pg_cron migration entry; `git status` clean; nothing else from the 2026-06-22 audit open.
