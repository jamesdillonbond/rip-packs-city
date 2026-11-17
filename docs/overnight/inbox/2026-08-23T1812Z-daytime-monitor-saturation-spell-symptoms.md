# Daytime monitor — 2026-08-23 ~18:10Z — saturation spell active; SYMPTOMS only (re-measure in a quiet window)

Positive control at sweep time: `io_wait=12 / active=11 / total=46` sessions, and `rpc_ops_snapshot()`
timed out. Per SKILL Section 1c this run is INSIDE a disk-IO saturation spell, so nothing below is a
cause or a cost figure — each item is a symptom to re-measure in a quiet window before any action. This
is the KNOWN band class (focus.md item 3 — do NOT open a new saturation investigation, do NOT raise a
timeout, do NOT upgrade the tier). Filed for the record so the night pass has a pointer, not a to-do.

## What was clean (not spell-affected)
- Security: RLS-off tables `[]`, anon/authenticated write-on-RLS-off `[]`, `check_public_security_invariants()` `[]`, `check_secdef_anon_execute_violations()` `[]`. 4/4 clean.
- Vercel: latest production deploy READY (sha 482e68f, pack-sniper SEO fix). CANCELED entries above it are superseded docs commits from today's active interactive session — no ERROR states.

## Symptoms observed under saturation (re-measure in a quiet window; do NOT conclude)
1. `pipeline_runs` last 6h is a wall of timeout-class failures only — `canceling statement due to statement timeout`, `upstream request timeout`, `canceling statement due to lock timeout`, `Could not query the database for the schema cache. Retrying.` (PGRST002). No logic errors. Saturation collateral, one root cause, NOT N bugs.
2. `check_pgcron_recent_failures()` = 14 jobs, every message `statement timeout` or `job startup timeout`, no logic errors. Same class (SKILL 1c: a cluster of these is saturation collateral, not N distinct bugs).
3. `detect_stalled_pipelines()` flagged:
   - `apply-fmv-haircut` — ~2139 min silent (threshold 1800), last good 2026-08-22 06:30Z; it is a daily cron-job.org job at 06:30Z, so it appears to have MISSED today's 06:30Z run. 06:30Z is in-band, so this is plausibly a spell-killed run rather than a dropped cron-job.org entry. SUGGESTED ACTION: quiet-window re-check — did today's 06:30Z run fire and get killed (net._http_response / pipeline_runs heartbeat), or not fire at all? Do NOT conclude from this run. Medium / visibility-only, does not page.
   - `compute-golazos-pack-ev` — ~1052 min silent (threshold 800). All pack-EV computes (topshot/allday) are timing out this window, so this is almost certainly the same collateral. Re-measure in a quiet window before treating as a real stall.
   - `topshot-active-listings-ingest` — ~1943 min silent — KNOWN atlas-proxy `egress_blocked` (known-issues #20). NOT a new finding; not re-raised.
   - `backfill-pack-rip-metadata` (137/120, info) and `topshot-moments-hydrator` (38/30, info) — marginally over their INFO thresholds, spell-consistent. Not alarming.

## Not re-raised (known / already queued)
- Sentry: 0 issues in 24h = the known ingest blackout, dark since 08-18 (nightly lock has it QUEUED; focus/ledger tracked). Zero is NOT reassurance here.
- Artifact payload validation DEFERRED this run: running the heavy payload queries during a spell only stacks IO and returns uninterpretable timeouts (SKILL 1b). `list_artifacts` confirms the estate is intact (11 artifacts). Re-validate payloads in a quiet window.
