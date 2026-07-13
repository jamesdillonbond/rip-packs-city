# Candidate — MISATTRIB-DRAIN-REKEY-UPSTREAM-TIMEOUT (2026-07-12, one-off verify task)

**Source:** scheduled one-off `misattrib-drain-tick-verify-0712` (follow-up to the 07-11 diagnosis + commit `7130963` logging add). Read-only run; nothing shipped.

**Finding:** the daily 11:00Z Vercel cron `/api/admin/drain-topshot-misattribution?rekey=1` FIRED on 2026-07-12 (11:00:49Z — so the scheduler dropout did NOT repeat) but logged **ok=false**: `rekey: upstream request timeout`.

- Drain leg healthy: chunks 25, resolved 1000, map_written 1000, gql_failed 0, terminated_reason `targets_exhausted`.
- Rekey leg failed: `extra.rekey` = null (never completed), duration_ms **132,956** (~133s), errors_sample `["rekey: upstream request timeout"]`. No `stage` key in extra — the timeout is on the rekey call itself, before its summary is assembled.
- Baseline: the 07-11 20:11:56Z manual dashboard Run succeeded in 36.6s with rekey complete (map_size 26,973; 267 sales + 40 moments rekeyed; 0 unresolved).

**Read:** the new `7130963` logging worked as designed — this failure is now diagnosable instead of a silent 500. The rekey step's upstream (DB RPC) times out in the 11:00Z window but completes in ~seconds off-peak; smells like the known DAYTIME/overnight-CONTENTION class rather than a code regression. Note both runs hit `targets_exhausted` at the 1000-target cap, so backlog supply is continuous; a failed rekey leg is deferred, not lost.

**Candidate actions (for nightly pass / CC — do NOT auto-ship if route logic is off-limits):**
1. Give the rekey step its own timeout budget / statement_timeout headroom (mirror the wallet-tools 20s-vs-6s per-tool budget pattern), or split rekey into a chunked loop like the drain leg.
2. Alternatively move the rekey pass off the 11:00Z contention window.
3. Watch the 07-13 11:00Z tick first — if it greens, fold into the contention family and downgrade.

**Severity:** LOW-MED (drain leg working; rekey self-retries next day; no data loss).
