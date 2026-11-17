# Daytime monitor — 2026-08-25 ~14:06 PT (21:10Z): saturation spell in progress (SYMPTOM only)

Filed by `rpc-daytime-monitor`. READ-ONLY sweep. **This is a SYMPTOM observed under saturation — every causal / cost claim below is deferred to a quiet-window re-measure per Section 1c. Do not act on it as a diagnosis.**

## What was observed
- `rpc_ops_snapshot()` **timed out** (statement timeout) inside `get_pipeline_alerts_core()`. Per the skill, a snapshot timeout is itself a spell signal.
- Positive control (`pg_stat_activity`, `pid <> pg_backend_pid()`): **io_wait=21, active=33, total_backends=44** → ~64% of active sessions in IO wait = **confirmed spell** (SMALL 2 GB instance, IO-budget-bound; this is the known root cause class, not a new one).
- Active-query profile at 21:07Z: **25 identical `WITH pgrst_source AS (SELECT pgrst_call.pgrst_scalar ...)` PostgREST reads all in IO wait, oldest ~3m01s**; one `SELECT public.refresh_mv_pack_ev_latest()` in IO wait **~6m09s**; two `wallet_moments_cache` reads; a `sales`-by-edition read ~50s.

## What is HEALTHY (unaffected by the spell)
- **Security: fully clean.** `pg_tables rowsecurity=false` → 0 rows; anon/authenticated write-grant-on-RLS-off join → 0 rows.
- **Vercel:** last production deploy **READY** (`9b8f0ff1`, backfill honesty fix). No ERROR states in the recent 20; newest commit `5906c31` (docs) CANCELED as expected. Trevor pushing actively all day.
- **Sentry:** no new unresolved issues in the last 24h.

## Suggested action (RE-MEASURE, not conclude)
In a **quiet window** (positive control shows io_wait small / snapshot returns fast):
1. Identify the endpoint behind the **25 stacked identical PostgREST scalar-source reads** — the query text was truncated at capture, so its source route/RPC is unknown. If a single caller is fanning out 25 concurrent identical scalar RPCs, that is a work-cutting lever (batch / cache / lower fan-out), consistent with focus PRIORITY 3 ("cut work, never raise a timeout"). **This is the one novel, un-attributed signature in this spell; everything else matches the known saturation set.**
2. Confirm `refresh_mv_pack_ev_latest()` completes in a quiet window (it was mid-flight ~6m here — under saturation that duration is uninterpretable).

## Not re-raised
- Generic disk-IO saturation is already the characterized known root cause (focus PRIORITY 3) — not filed as new.
- Night pass's 2 queued candidates (topshot-pack-pool-backfill cause shift; `cross_collection_overlap_stale_hours` trust arm) already in inbox — not duplicated.

## Skipped this run (spell discipline)
- Heavy checks (`detect_stalled_pipelines`, `check_pgcron_recent_failures`, full artifact payload validation) NOT run — each stacks IO onto the spell, and an artifact timeout during a spell is a symptom, not a broken artifact. Re-validate next quiet tick.
- Section 1a first-tick-of-day extras skipped (this is the ~14:06 PT tick, not the ~8am tick).
