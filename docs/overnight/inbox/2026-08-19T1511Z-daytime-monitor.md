# Daytime monitor — 2026-08-19T15:11Z (≈08:11 PT, first tick)

Written to the MOUNT, push unavailable (`remote.origin.pushurl` absent on desktop Cowork; git push has no creds per the 08-19 nightly lock). Night pass picks this up locally.

**Sweep ran under an ACTIVE saturation spell** — positive control `io_wait=31 / active=32` (majority in IO wait), and `rpc_ops_snapshot()` timed out inside its `get_pipeline_alerts` leg (`57014 canceling statement due to statement timeout`). Per spell discipline (SKILL §1c) the candidate below is filed as a **SYMPTOM**, not a causal conclusion; all durations/causes deferred to a quiet-window re-measure. Heavy checks (full pipeline-alerts, `v_rpc_trust_health`, `detect_stalled_pipelines`, `check_pgcron_recent_failures`, artifact payload queries) were **deliberately not run** this tick — each adds IO to the spell and would time out uninterpretably; the 08-19 nightly's ~7h-old characterization of those stands (trust 4/19 breached all known-class, pgcron 10 fails all statement-timeout saturation, 4 stalled all known).

Clean, non-saturation-maskable reads that DID complete:
- **Security: catalog-clean** — 0 public tables with RLS off, 0 anon/authenticated write grants on RLS-off tables.
- **Vercel: healthy** — latest READY production deploy `dpl_7ihQPRRD4Bdf8ooC` (08-18 21:08Z, the series-filter fix) is serving; the newer CANCELED deploys (08-18 21:12–21:28Z) are docs-only commits skipped by `ignoreCommand`, expected, **0 ERROR-state deploys**.

---

## CANDIDATE 1 (HIGH) — cross-collection MVs now ~59h stale = SECOND consecutive failed refresh cycle; the pre-set escalation trigger has fired

- **Title:** `rpc-ccm-step1`/`step2` cross-collection MV refresh has now missed TWO consecutive nightly cycles (08-18 + 08-19), crossing the "escalate on a second consecutive day" threshold set in the 08-18 ledger.
- **Source:** freshness read — `cross_collection_cohort_mat.max(computed_at)=2026-08-17 04:10:00Z` (count 179, healthy) and `cross_collection_ts_set_overlap_mat.max(computed_at)=2026-08-17 04:25:00Z`, vs now `2026-08-19 15:11Z` → **~59h stale**. Both steps stuck at the 08-17 tick.
- **Prior context (do not re-derive):** ledger 2026-08-18 (`…the wmc backfill…and the ccm timeout was saturation`, line ~123) established these timeouts are **SATURATION, not growth** — a rolled-back probe returned `cohort=193 elapsed_ms=104924` (105s against the `cron_heavy` 600s role ceiling; the function's own `proconfig statement_timeout=180s` is inert). Its disposition, verbatim: *"self-heals at the next clean 04:10Z tick, escalate only on a second consecutive day."* That entry saw it at ~38h stale (one missed cycle, 08-18). It is now ~59h → the **08-19 04:10Z cycle also failed**, so the second-consecutive-day condition it named is now met.
- **Blast radius:** the public `/insights/cross-collection` board and any cross-collection whale-map artifact serve 08-17 data (~2.5 days stale). Cohort count is stable (179), so no data loss — a freshness miss only.
- **Risk read:** LOW-to-MEDIUM. Read-only staleness; no correctness/security impact. The recovery is a known operator-judgment call, NOT a code change.
- **Suggested action (SYMPTOM — deferred, night-pass / Trevor decision, NOT to be run mid-spell or mid-day):** re-measure in a quiet window first (confirm still stuck at 08-17 and whether the failure is again a clean statement-timeout). If a catch-up is wanted, the ledger already flagged the trap: **`refresh_cross_collection_cohort_step1` opens with `TRUNCATE`, taking ACCESS EXCLUSIVE on a table the public board reads** — a multi-minute daytime block. Preferred recovery is a self-cleaning pg_cron one-shot for the failed step during low traffic (body ends in `cron.unschedule` of itself; a FAILED one-shot does not self-unschedule and must be cleaned next day). Underlying lever remains cutting the step's work, not raising a timeout or upgrading tier (focus §3). Do **not** manually `TRUNCATE`+rebuild during the day.

No other new low-risk candidates this tick — the dominant signal (user-facing entity-page 45s RPC timeouts across edition/team/player/set, ongoing to ~15:07Z) is saturation collateral of the known root cause and is not re-filed per focus §3 ("do not open new investigations into disk-IO saturation symptoms").
