-- audit_20260910: the trust-health FMV leg publishes SWEEP COMPLETENESS, so a leg
-- reading can be told apart from a level.
--
-- WHY. M1 and M2 are go-live gates read off `*_fmv_high_med_share_pct`, and on
-- 2026-09-10 both swung hard with no change to the market or the code:
-- All Day 22.59 -> 24.07 -> 28.3 -> 23.0 and Top Shot 53.4 -> 55.4 -> 47.9, inside nine
-- hours. Cause, measured hour by hour: the metric reads the LATEST fmv_snapshots row
-- per edition, and fmv-recalc walks the liquid head before the illiquid tail, so the
-- whole-estate share falls as days-old MEDIUMs are corrected to honest LOWs. NOT an
-- under-fetch -- recalc's recorded sales_count_30d was compared against an independent
-- count from `sales` for every edition touched and they track in both directions.
--
-- THE INSTRUMENT COULD NOT SEE ITS OWN SAMPLING PROBLEM. Two companions existed and
-- both are structurally silent here:
--   * `v_rpc_trust_health_freshness` measures how old the METRIC ROW is -- "is the leg
--     running", not "is this reading a level".
--   * `*_fmv_pct_stale_30d` has 30-DAY granularity and reads 0.0, while the quantity it
--     would have to qualify moves on a ~6-hour cycle. A qualification coarser than the
--     thing it qualifies is not a qualification.
--
-- WHAT THIS ADDS, per collection, folded into the SAME DISTINCT ON pass the leg already
-- makes (so it costs no extra scan of fmv_snapshots -- the platform's expensive read):
--   <c>_fmv_sweep_pct_24h         share of priced editions whose latest snapshot is <24h old
--   <c>_fmv_high_med_fresh24h_pct HIGH/MEDIUM share over ONLY those fresh editions
--
-- THE TWO ARE A PAIR AND MUST BE READ AS ONE. The fresh share alone would be another
-- unqualified number: it is a consistent population but a SMALL one, and how small is
-- exactly what sweep_pct_24h says. Neither replaces `*_fmv_high_med_share_pct`, and the
-- fresh share is NOT a softer gate -- it is biased HIGH because recalc prioritises
-- active editions. The headline stays the gate; these say whether it is a level.
--
-- THREE STATES, deliberately distinguishable because `value` is NOT NULL so NULL is
-- unavailable:
--   0..100 a real percentage
--   -1     UNDEFINED -- the window holds no editions, so the share has no denominator.
--          A share over an empty population is not 0%, and publishing 0 would be the
--          fabricated-number shape this platform is built around. -1 is outside the
--          percentage range so it cannot be misread as a measurement, and a
--          below-threshold check on it fires rather than silently passing.
--   999    the leg threw (the pre-existing sentinel; unchanged).
--
-- OBSERVED, NOT CHANGED: the pre-existing families COALESCE a missing collection to 0,
-- which is that same shape one level down. Every collection in the want-lists has rows
-- today so it is latent, not live, and altering it would move a published go-live
-- number -- a separate decision, deliberately not bundled here.
--
-- VERIFIED ON APPLY (2026-09-10 23:08Z, invoked through the production wrapper
-- run_thp_leg_logged, ok=true, 17,593ms), three controls:
--   1. Output matches an independently written hand-derivation to the decimal --
--      Top Shot 48.1 / 76.9 / 62.5 and All Day 23.2 / 58.5 / 39.6 on both.
--   2. The -1 branch fired on REAL data unprompted: UFC has priced editions but zero
--      recomputed in 24h, so ufc_fmv_high_med_fresh24h_pct = -1 while
--      ufc_fmv_high_med_share_pct = 0.0 -- a genuine measured zero and an undefined
--      share, now distinguishable. No synthetic probe was needed.
--   3. Candy sits at sweep_pct_24h = 100.0 and its fresh share EQUALS its headline
--      exactly (55.2 = 55.2) -- the identity that must hold at full coverage.
--   Grants after: anon false, authenticated false, service_role true, cron_heavy true,
--   postgres true; exactly 1 overload; check_secdef_anon_exec_drift() length 0;
--   SECURITY DEFINER, search_path and statement_timeout=240s all preserved.
--
-- anon-exec: intentional -- rpc_thp_leg_fmv_coverage is NOT revoked here.
-- This is a SNAPSHOT replace of an existing function, and CREATE OR REPLACE does not
-- reset a function ACL, so a revoke in this migration would CHANGE production rather
-- than preserve it. Verified live after applying: has_function_privilege reads
-- anon=false, authenticated=false, service_role=true, cron_heavy=true, postgres=true,
-- with exactly 1 overload and check_secdef_anon_exec_drift() length 0.
--
-- REVERT: `CREATE OR REPLACE FUNCTION public.rpc_thp_leg_fmv_coverage()` with the body
-- from migration 20260830021550 (the prior definition), then
-- `DELETE FROM public.rpc_trust_health_precompute WHERE metric LIKE '%_fmv_sweep_pct_24h'
--  OR metric LIKE '%_fmv_high_med_fresh24h_pct';`
-- Signature is unchanged, so no grant is touched and no overload is created.

CREATE OR REPLACE FUNCTION public.rpc_thp_leg_fmv_coverage()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public, pg_temp'
SET statement_timeout = '240s'
AS $fn$
DECLARE t1 timestamptz := clock_timestamp();
BEGIN
  BEGIN
    WITH latest AS (
      SELECT DISTINCT ON (fs.collection_id, fs.edition_id)
             fs.collection_id, fs.edition_id, fs.computed_at, fs.confidence
      FROM public.fmv_snapshots fs
      ORDER BY fs.collection_id, fs.edition_id, fs.computed_at DESC
    ),
    elig AS (
      SELECT l.collection_id, l.edition_id, l.computed_at, l.confidence
      FROM latest l
    ),
    agg AS (
      SELECT elig.collection_id,
             round(100.0 * count(*) FILTER (WHERE elig.computed_at < (now() - '30 days'::interval))::numeric
                   / NULLIF(count(*), 0)::numeric, 1) AS pct_stale_30d,
             round(100.0 * count(*) FILTER (WHERE elig.confidence IN ('HIGH','MEDIUM'))::numeric
                   / NULLIF(count(*), 0)::numeric, 1) AS high_med_pct,
             -- Sweep completeness: how much of the estate this reading actually refreshed.
             round(100.0 * count(*) FILTER (WHERE elig.computed_at >= (now() - '24 hours'::interval))::numeric
                   / NULLIF(count(*), 0)::numeric, 1) AS sweep_pct_24h,
             -- The share over a CONSISTENT population. Denominator is the fresh set, so it
             -- is NULL (-> -1 below) when nothing was recomputed, never a spurious 0.
             round(100.0 * count(*) FILTER (WHERE elig.confidence IN ('HIGH','MEDIUM')
                                              AND elig.computed_at >= (now() - '24 hours'::interval))::numeric
                   / NULLIF(count(*) FILTER (WHERE elig.computed_at >= (now() - '24 hours'::interval)), 0)::numeric, 1)
               AS high_med_fresh24h_pct
      FROM elig GROUP BY elig.collection_id
    ),
    want(metric, collection_id) AS (
      VALUES ('topshot_fmv_pct_stale_30d', '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid),
             ('allday_fmv_pct_stale_30d',  'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid),
             ('golazos_fmv_pct_stale_30d', '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid),
             ('ufc_fmv_pct_stale_30d',     '9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid),
             ('candy_fmv_pct_stale_30d',   '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
    ),
    want_share(metric, collection_id) AS (
      VALUES ('topshot_fmv_high_med_share_pct', '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid),
             ('allday_fmv_high_med_share_pct',  'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid),
             ('golazos_fmv_high_med_share_pct', '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid),
             ('ufc_fmv_high_med_share_pct',     '9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid),
             ('candy_fmv_high_med_share_pct',   '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
    ),
    want_sweep(metric, collection_id) AS (
      VALUES ('topshot_fmv_sweep_pct_24h', '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid),
             ('allday_fmv_sweep_pct_24h',  'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid),
             ('golazos_fmv_sweep_pct_24h', '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid),
             ('ufc_fmv_sweep_pct_24h',     '9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid),
             ('candy_fmv_sweep_pct_24h',   '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
    ),
    want_fresh(metric, collection_id) AS (
      VALUES ('topshot_fmv_high_med_fresh24h_pct', '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid),
             ('allday_fmv_high_med_fresh24h_pct',  'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid),
             ('golazos_fmv_high_med_fresh24h_pct', '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid),
             ('ufc_fmv_high_med_fresh24h_pct',     '9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid),
             ('candy_fmv_high_med_fresh24h_pct',   '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
    ),
    resolved AS (
      SELECT w.metric, COALESCE(a.pct_stale_30d, 0::numeric) AS value
      FROM want w LEFT JOIN agg a ON a.collection_id = w.collection_id
      UNION ALL
      SELECT w.metric, COALESCE(a.high_med_pct, 0::numeric) AS value
      FROM want_share w LEFT JOIN agg a ON a.collection_id = w.collection_id
      UNION ALL
      -- -1, not 0: an absent collection has no denominator, and 0% would be a claim.
      SELECT w.metric, COALESCE(a.sweep_pct_24h, -1::numeric) AS value
      FROM want_sweep w LEFT JOIN agg a ON a.collection_id = w.collection_id
      UNION ALL
      SELECT w.metric, COALESCE(a.high_med_fresh24h_pct, -1::numeric) AS value
      FROM want_fresh w LEFT JOIN agg a ON a.collection_id = w.collection_id
    )
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    SELECT r.metric, r.value, now(),
           round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000)
    FROM resolved r
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  EXCEPTION WHEN OTHERS THEN
    -- The new families are listed here too. Omitting them would leave them holding a
    -- PREVIOUS value while their siblings read 999 -- a half-failed leg that looks
    -- partly healthy, which is the shape that makes an outage unmeasurable.
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    SELECT m, 999, now(), round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000)
    FROM unnest(ARRAY['topshot_fmv_pct_stale_30d','allday_fmv_pct_stale_30d','golazos_fmv_pct_stale_30d',
                      'ufc_fmv_pct_stale_30d','candy_fmv_pct_stale_30d',
                      'topshot_fmv_high_med_share_pct','allday_fmv_high_med_share_pct','golazos_fmv_high_med_share_pct',
                      'ufc_fmv_high_med_share_pct','candy_fmv_high_med_share_pct',
                      'topshot_fmv_sweep_pct_24h','allday_fmv_sweep_pct_24h','golazos_fmv_sweep_pct_24h',
                      'ufc_fmv_sweep_pct_24h','candy_fmv_sweep_pct_24h',
                      'topshot_fmv_high_med_fresh24h_pct','allday_fmv_high_med_fresh24h_pct',
                      'golazos_fmv_high_med_fresh24h_pct','ufc_fmv_high_med_fresh24h_pct',
                      'candy_fmv_high_med_fresh24h_pct']) AS m
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  END;
END;
$fn$;

COMMENT ON FUNCTION public.rpc_thp_leg_fmv_coverage() IS
'Trust-health FMV leg. Publishes, per collection: *_fmv_pct_stale_30d, *_fmv_high_med_share_pct (whole-estate, the M1/M2 headline), and since 2026-09-10 *_fmv_sweep_pct_24h + *_fmv_high_med_fresh24h_pct. The last two exist because the headline reads the LATEST snapshot per edition and therefore swings 5-7 points on where fmv-recalc''s cursor sits: read them as a PAIR to tell a leg reading from a level. The fresh share is biased HIGH (recalc prioritises active editions) and is a diagnostic, never a softer gate. Values: 0..100 a percentage; -1 the window has no editions so the share has no denominator (never published as 0); 999 the leg threw.';
