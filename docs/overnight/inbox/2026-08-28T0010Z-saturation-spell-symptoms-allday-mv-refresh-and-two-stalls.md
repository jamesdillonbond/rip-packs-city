# 2026-08-28T00:10Z daytime-monitor candidates — a saturation spell, and three pipeline symptoms inside it

**Run:** rpc-daytime-monitor, 2026-08-27 17:06 PDT (00:06Z). NOT the first tick of day (1a skipped).
Lock present but RELEASED (night pass, 08:10Z), so this file is committed.

## FRAME — positive control says we are IN a saturation spell; everything below is a SYMPTOM, not a cause

`SELECT rpc_ops_snapshot()` **timed out** (statement timeout, statement 1). Positive control per §1c:

```
io_wait=37  active=37  total=47   (pg_stat_activity, excl. self)
```

**37 of 37 active sessions are in IO wait.** By CLAUDE.md's measurement discipline every duration read
this tick is uninterpretable, and my own probes add IO to what they measure. So the three findings below
are filed as **SYMPTOMS observed under saturation**; each suggested action is a **quiet-window re-measure**,
never a causal conclusion, a cost figure, or a fix. Do NOT open a new saturation investigation (focus
PRIORITY 3: the kill/timeout family is one root cause — the SMALL-tier disk-IO budget — and the lever is
cutting work, never raising a timeout or upgrading the tier).

I did NOT run the artifact payload queries this tick (each is heavy and would stack IO onto the spell) and
did not re-run the security catalog checks; night pass verified all four invariants clean at 08:10Z today
and nothing security-relevant has shipped since. Re-validate artifacts + security in a quiet window.

## Candidate 1 — pg_cron `rpc-refresh-allday-pack-realized` failing (SYMPTOM)
- **Source:** `check_pgcron_recent_failures()` — 3 fails / 4 runs, latest 2026-08-27T18:35:00Z, status failed.
- **Message:** `canceling statement due to statement timeout` on
  `REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_allday_pack_realized` (in `refresh_allday_pack_realized()`).
- **Read:** classic saturation collateral (a statement timeout on a heavy CONCURRENTLY refresh), not a
  logic error. No same-day fix precedes it, so it is a genuinely-recent failure — but under the spell it
  is not evidence of N distinct bugs.
- **Risk:** low to act now (do not). If it keeps failing in a QUIET window, the MV refresh is genuinely
  over the IO budget → the lever is cutting the refresh's work (scope/partition), per PRIORITY 3 — NOT a
  timeout bump. `mv_allday_pack_realized` staleness has user-facing blast radius (AllDay pack-realized EV).
- **Action:** re-measure in a quiet window; only then judge whether the refresh needs its work cut.

## Candidate 2 — `allday-pack-opens-backfill` silent 263 min vs 90 threshold (SYMPTOM)
- **Source:** `detect_stalled_pipelines()` — last run 2026-08-27T19:46:46Z, silent 263 min, threshold 90.
- **Context:** watchlist note says KEEP ACTIVE past `done:true` because job 55 keeps firing, so silence =
  the SCHEDULER stopped (a real signal). BUT under a spell, `job startup timeout` / statement timeout means
  the body never runs and nothing reaches `pipeline_runs` — indistinguishable from a stopped scheduler on
  this instrument alone.
- **Risk:** low. Do not conclude the scheduler stopped.
- **Action:** re-measure recency in a quiet window; if still silent when the DB is quiet, then chase job 55.

## Candidate 3 — `compute-golazos-pack-ev` stalled 1412 min vs 800 threshold
- **Source:** `detect_stalled_pipelines()` — last run 2026-08-27T00:37:01Z, silent ~23.5h, threshold 800 min.
- **Read:** this predates the current spell by far (~23h vs a spell measured now), so it is less likely to
  be pure saturation collateral than Candidates 1-2 — but the last-run duration still cannot be trusted this
  tick. Golazos is the lowest-liquidity collection (focus P1: 0% HIGH/MED, ~1-3 sales/edition/month), so a
  pack-EV pipeline there may be legitimately low-signal.
- **Risk:** low.
- **Action:** in a quiet window, read `cron.job.command` for the caller + its true cadence and the last
  few `pipeline_runs`/`net._http_response` rows to distinguish a genuine stop from an idle/low-cadence job
  before treating as a stall.

## Not findings this tick
- Vercel: latest real build READY (078ca5d8, telemetry after() fix); no ERROR deploys. The CANCELED tip
  (415db92b) is a docs-only commit — expected (ignoreCommand).
- Sentry: no new 24h issues (known-dead instrument since 08-18 / #34 — weak evidence).
