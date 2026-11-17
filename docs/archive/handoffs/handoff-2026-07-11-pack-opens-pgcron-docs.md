# Handoff — Pack-opens scheduler migration to pg_cron (docs closeout)

**For:** Claude Code, direct-to-main.
**Date:** 2026-07-11 (~23:00Z)

## Context

Cowork shipped everything DB-side live this session; **nothing code/route/worker-side changed**. This handoff is docs-only: commit one already-written ledger correction and update the cron schedule doc to match reality. origin/main HEAD at writing: `9be9394c` (post tree-wipe restore).

Already live (Supabase migrations, no action needed):

- `audit_20260711_pgcron_allday_pack_opens_backfill` — pg_cron **job 55** `rpc-allday-pack-opens-backfill` (`6,16,26,36,46,56 * * * *`) → `ingest-allday-pack-opens?mode=backfill`. Restores the leg that died when pg_cron jobid 21 was unscheduled at ~13:52Z during the same-day edge-fn rework. Verified: cursor descending from 140.8M toward AllDay genesis (floor 35M), spork-routed below 137390146.
- `audit_20260711_pgcron_topshot_pack_opens_history` — pg_cron **job 56** `rpc-topshot-pack-opens-history` (`9,24,39,54 * * * *`) → `ingest-topshot-pack-opens-history?mode=backfill`. Replaces cron-job.org job 8070439, which failed every tick at the 30s client cap (auto-disable silent-kill class). **Trevor has already deleted console job 8070439.** Verified: cursor descending ~137.09M toward spork floor 27341470, contiguous windows across the swap.
- `audit_20260711_watchlist_pack_opens_backfills` — `pipeline_cadence_watchlist` rows for both pipelines (90 min / medium). `detect_stalled_pipelines()` does not flag either.

## Item 1 — Commit + push the ledger correction (already written, just commit)

**File:** `docs/overnight/ledger.md` (exists; has one uncommitted appended section in the working copy).

The appended section is `### audit_20260711_pgcron_topshot_pack_opens_history (+ correction to the entry above)` at the end of the file. It corrects the earlier entry's wrong "cron-job.org dropout" attribution (real cause: pg_cron jobid 21 unscheduled) and records job 56 + reverts. Do not rewrite it — just commit what's there. If the working copy is somehow clean (already committed), skip this item.

**Revert:** revert the commit.

## Item 2 — Update `docs/operations/cron-schedule.md`

**File:** `docs/operations/cron-schedule.md` (exists; verified line 95 currently reads the stale entry).

Line 95 currently documents the deleted console job:

```
| RPC TopShot Pack Opens History | ingest-topshot-pack-opens-history?mode=backfill&key=<gate-key — now an edge secret, see D2> | 4,19,34,49 (every 15 min; job 8070439, created 2026-07-11; NO auth header — key gate in URL, verify_jwt=false) |
```

Replace it (or move it to whatever pg_cron section the file has — adapt to the actual file structure) so the doc records:

- `rpc-topshot-pack-opens-history` — **pg_cron job 56**, `9,24,39,54 * * * *`, `net.http_get` → `ingest-topshot-pack-opens-history?mode=backfill&key=…tsopenhist`, 120s timeout. Console job 8070439 deleted 2026-07-11 (30s-cap failed every tick; auto-disable risk).
- `rpc-allday-pack-opens-backfill` — **pg_cron job 55**, `6,16,26,36,46,56 * * * *`, `net.http_get` → `ingest-allday-pack-opens?mode=backfill&key=…alldayopen`, 90s timeout. Successor to unscheduled jobid 21; there is NO cron-job.org entry for this fn.
- Both are FINITE backfills: retire the pg_cron job + set the watchlist row `is_active=false` when the pipeline logs `done:true`.

**Revert:** revert the commit.

## Guardrails

- Direct-to-`main`, no branches, no PRs. If a `claude/*` branch is pre-checked-out, switch to `main` first.
- Commit via PowerShell `git` on Windows (Git Bash `git commit` can silently no-op). Re-verify with `git rev-list --count origin/main..HEAD` (expect 0 after push).
- Docs-only change — no `tsc` impact — but the push triggers a Vercel build: confirm the deploy reaches READY (the repo was tree-wipe-restored today; a clean READY on the restored tree is itself useful signal).
- CRLF: don't string-replace-patch; edit by line or full-file write.
- Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape.

## Expected end state

One docs commit on `main` (ledger correction + cron-schedule.md truth-up), pushed, Vercel deploy READY; scheduler docs match the live pg_cron state (jobs 55/56 + watchlist), and no cron-job.org entries reference either pack-opens history fn.
