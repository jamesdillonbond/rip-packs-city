-- audit_20260816: companion view exposing PER-METRIC freshness for the trust board.
--
-- ⚠⚠ COMMITTED **UNAPPLIED** ON PURPOSE — DO NOT ASSUME THIS IS LIVE. ⚠⚠
-- Written 2026-08-16 15:30Z during an ACUTE disk-IO saturation spell (pipeline_runs failure rate
-- 13.8% over the trailing 60 min, up from the 11% the 15:25Z monitor recorded; entity pages already
-- throwing user-facing 45s timeouts). Every apply_migration invalidates PostgREST's schema cache and
-- costs a ~10-20s burst of user-facing PGRST002 500s. This view is a DIAGNOSTIC improvement, not an
-- outage fix, so paying that cost on top of a live user-facing degradation is the wrong trade.
-- APPLY IN A LOW-TRAFFIC WINDOW (and ideally batch it with any other pending migration -- N
-- migrations in one window cost ONE burst instead of N).
--
-- WHY THIS EXISTS -- the gap that made a whole defect class invisible.
-- `v_rpc_trust_health` publishes `metric / value / breach_at / status / catches` and **no age**.
-- 19 of its arms are not computed live; they are read from `rpc_trust_health_precompute`, which is
-- refreshed by the eight `rpc_thp_leg_*` legs. Before the 2026-08-16 split those legs shared one
-- 600s budget, so a timeout left the legs it reached fresh and everything behind it FROZEN -- and
-- because the view exposes no age, **a frozen leg publishes a stale value that is byte-identical in
-- presentation to a current one**. Measured that morning: 15 metrics at ~8h and one at 14.1h, all
-- rendering as ordinary current readings. The only thing standing between that and an operator
-- acting on a stale number was the single `trust_precompute_max_age_hours` arm.
--
-- WHY A COMPANION VIEW AND NOT A COLUMN ON `v_rpc_trust_health`.
-- That view's definition is **48,766 characters** across ~38 UNION ALL arms. Adding an age column
-- means editing every branch, and only 19 of the arms even have an age (the rest are computed live,
-- so their honest age is "now"). A separate view is purely ADDITIVE: it cannot regress the board,
-- cannot alter any existing arm's value, and needs no change to any consumer.
-- Consumers of `v_rpc_trust_health` were enumerated before choosing this shape -- all three read
-- NAMED COLUMNS, so even a column add would have been safe, but the 48k-char rewrite is not worth it:
--   * app/api/sentinel/route.ts  -> .select("metric, value, breach_at, status")
--   * rpc_ops_snapshot           -> jsonb_build_object('metric', metric, 'value', value, ...)
--   * analytics_smoke_run        -> mentions it in a COMMENT only; does not query it
--   * rpc_trust_health_precompute_refresh -> the ORPHANED 13,009-char monolith (0 callers anywhere;
--     the scheduled object is the `_p` PROCEDURE -- see the CLAUDE.md name-trap note).
--
-- `refreshed_by_leg` is DERIVED from `pg_proc.prosrc`, not hardcoded, so it stays correct when a
-- metric moves between legs. A NULL there means no `rpc_thp_leg_*` body mentions the metric -- which
-- is itself a finding (an orphaned precompute row nothing refreshes), not a display gap.
--
-- ⚠ SCOPE HONESTY: this covers ONLY the 19 precomputed metrics. The live-computed arms of
-- `v_rpc_trust_health` are always current and deliberately do NOT appear here. Do not read a metric's
-- absence from this view as "no freshness data" -- read it as "computed live".
--
-- ⚠ `cron_heavy` has **no SELECT** on `rpc_trust_health_precompute` (verified live). That is fine
-- here -- this view is for operators/service_role -- but any future tail-check running AS cron_heavy
-- against it would fail on every tick, which is a trap this repo has already paid for once.
--
-- VERIFY AFTER APPLYING:
--   select * from public.v_rpc_trust_health_freshness order by age_hours desc;
--   -- post-split expectation: all rows under ~7h. A single row far above the rest names the leg to
--   -- investigate in `refreshed_by_leg` -- which is the entire point of this view.
--   select has_table_privilege('anon','public.v_rpc_trust_health_freshness','SELECT');  -- must be false
--
-- REVERT:
--   DROP VIEW IF EXISTS public.v_rpc_trust_health_freshness;

CREATE OR REPLACE VIEW public.v_rpc_trust_health_freshness
WITH (security_invoker = on) AS
SELECT
  p.metric,
  p.computed_at,
  round((extract(epoch FROM (now() - p.computed_at)) / 3600.0)::numeric, 2) AS age_hours,
  p.duration_ms,
  leg.proname AS refreshed_by_leg,
  -- 6h cadence per leg post-split; 7h allows a full cycle plus a slow run before flagging.
  (now() - p.computed_at) > interval '7 hours' AS is_stale
FROM public.rpc_trust_health_precompute p
LEFT JOIN LATERAL (
  SELECT pr.proname
  FROM pg_proc pr
  JOIN pg_namespace nn ON nn.oid = pr.pronamespace
  WHERE nn.nspname = 'public'
    AND pr.proname LIKE 'rpc\_thp\_leg\_%'
    AND pr.prosrc LIKE '%' || p.metric || '%'
  ORDER BY pr.proname
  LIMIT 1
) leg ON true;

-- Re-assert explicitly: CREATE OR REPLACE VIEW with no WITH clause RESETS reloptions and silently
-- strips security_invoker. It is carried in the WITH above AND re-asserted here deliberately -- this
-- repo has lost security_invoker to that trap four times, and ALTER VIEW cannot drift the query.
ALTER VIEW public.v_rpc_trust_health_freshness SET (security_invoker = on);

-- Mirror v_rpc_trust_health's grants exactly (measured live: anon false, authenticated false,
-- service_role true). REVOKE both halves -- a PUBLIC-only revoke leaves Supabase's default per-role
-- grant in place.
REVOKE ALL ON public.v_rpc_trust_health_freshness FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_rpc_trust_health_freshness TO service_role;

COMMENT ON VIEW public.v_rpc_trust_health_freshness IS
  'Per-metric freshness for the 19 PRECOMPUTED trust-board arms (v_rpc_trust_health exposes no age, '
  'so a frozen refresh leg publishes a stale value indistinguishable from a current one). '
  'refreshed_by_leg is derived from pg_proc.prosrc, not hardcoded. Live-computed arms are absent by '
  'design, not missing. Companion to v_rpc_trust_health; never a replacement for it.';
