-- 2026-09-25 (PT) — a Top Shot pack supply counter that our OWN observed
-- openings contradict stops being published.
--
-- WHY. Every Top Shot depletion / packs-remaining / sealed figure comes from a
-- counter whose refresh lane is dead (topshot_pack_supply newest success
-- 2026-08-26; the v20 tier counts newest 2026-08-28; register #74). #74 dated
-- them but said "NOT CLAIMED — that any rendered number is wrong". Measured
-- tonight against pack_rips (on-chain opens, dist attribution 0 disagreements
-- with pack_nft_identity on the sampled dists):
--   · 42 of 823 dists' v20 tier counts claim fewer opened than we OBSERVED
--     opened by the counter's own stamp — 13 of them claim NONE opened
--     (8643 "6,000 of 6,000 remaining" with 5,727 opened before its stamp;
--     8642 "15,000 of 15,000" with 5,723).
--   · 50 of 2,027 published depletion_pct figures sit below the observed opens
--     at their own as-of.
--   · 715 dists carry total_opened = 0 (the column's DEFAULT, not a reading)
--     while we observed opens — a fabricated zero, and total_sealed = minted.
--   · 30 dists have MORE observed opens than total_minted.
-- Observed opens are a LOWER bound (pack_rips misses opens), so they can
-- refute a counter but never replace it: a refuted figure goes NULL (unknown),
-- never to the observed count.
--
-- WHAT.
--   1. pack_supply_counter_checks — per Top Shot dist: the observed opens (all,
--      and by each counter's stamp), the counter values checked, and three
--      verdicts. Service-role only.
--   2. refresh_pack_supply_counter_checks() — recomputes it (~3 s, one pass
--      over pack_rips' Top Shot rows); upserts first, deletes only rows it did
--      not write. Called by /api/cron/topshot-pack-dist-names-onchain daily.
--   3. pack_table_rows (guarded splice, each anchor exactly once or RAISE):
--      a verdict applies ONLY while the view still carries the exact values it
--      checked (pd total_opened/total_minted; pev snapshotted_at; the v20
--      tier stamp), so a revived counter is published again at once.
--        pd_bad  -> total_opened, total_sealed NULL; the pd depletion branch
--                   drops out (falls to the EV snapshot's, if not refuted)
--        pev_bad -> total_unopened, ev_depletion_pct NULL; pev depletion
--                   branch drops out
--        depletion_as_of follows whichever branch survived
--      and appends tier_counts_contradicted + observed_packs_opened, read by
--      the pack page to drop the v20 metadata counts it reads directly.
--
-- definer-view: intentional — pack_table_rows was a definer view before this change
-- (reloptions NULL) and is on security_definer_view_allowlist since 2026-06-28; this
-- migration keeps that mode unchanged.
--
-- REVERT:
--   DO $$ BEGIN EXECUTE 'CREATE OR REPLACE VIEW public.pack_table_rows AS ' ||
--     (SELECT def FROM public.audit_20260925_pack_table_rows_prev); END $$;
--   -- (that restores the old column list; the two appended columns must be
--   --  dropped by DROP VIEW + CREATE if a consumer is gone — none select them
--   --  except the pack page, which tolerates their absence as undefined)
--   DROP FUNCTION public.refresh_pack_supply_counter_checks();
--   DROP TABLE public.pack_supply_counter_checks;

CREATE TABLE IF NOT EXISTS public.audit_20260925_pack_table_rows_prev AS
SELECT pg_get_viewdef('public.pack_table_rows'::regclass) AS def, now() AS saved_at;
ALTER TABLE public.audit_20260925_pack_table_rows_prev ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260925_pack_table_rows_prev FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.pack_supply_counter_checks (
  collection_id          uuid        NOT NULL,
  dist_id                text        NOT NULL,
  checked_at             timestamptz NOT NULL,
  observed_opened        integer     NOT NULL,
  -- pack_distributions counters (topshot_pack_supply era)
  pd_total_opened        integer,
  pd_total_minted        integer,
  supply_as_of           timestamptz,
  observed_by_supply     integer     NOT NULL,
  pd_refuted             boolean     NOT NULL,
  -- mv_pack_ev_latest (v20 EV sweep)
  pev_snapshotted_at     timestamptz,
  pev_total_unopened     integer,
  pev_depletion_pct      smallint,
  observed_by_pev        integer,
  pev_refuted            boolean     NOT NULL,
  -- pack_distributions.metadata v20 tier counts (read by the pack page directly)
  tier_counts_updated_at text,
  tier_total_pack_count  integer,
  tier_total_unopened    integer,
  observed_by_tier       integer,
  tier_refuted           boolean     NOT NULL,
  PRIMARY KEY (collection_id, dist_id)
);
ALTER TABLE public.pack_supply_counter_checks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pack_supply_counter_checks FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pack_supply_counter_checks TO service_role;
COMMENT ON TABLE public.pack_supply_counter_checks IS
  'Per Top Shot dist: do our observed opens (pack_rips, a LOWER bound) contradict the supply counters pack_table_rows publishes? Refreshed daily by refresh_pack_supply_counter_checks() from /api/cron/topshot-pack-dist-names-onchain. A verdict applies only while the checked values are unchanged. 2026-09-25.';

-- anon-exec: none (refresh_pack_supply_counter_checks) — new fn; REVOKE FROM PUBLIC, anon, authenticated; GRANT service_role (read 2026-09-25).
CREATE OR REPLACE FUNCTION public.refresh_pack_supply_counter_checks()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '120s'
AS $fn$
DECLARE
  v_run  timestamptz := clock_timestamp();
  v_rows int;
  v_del  int;
BEGIN
  WITH d AS (
    SELECT pd.collection_id, pd.dist_id, pd.total_opened, pd.total_minted,
           tss.last_success_at AS supply_as_of,
           pev.snapshotted_at AS pev_at, pev.total_unopened AS pev_tu, pev.depletion_pct AS pev_dep,
           pd.metadata->>'tier_counts_updated_at' AS tier_at_text,
           CASE WHEN pd.metadata->>'tier_counts_updated_at' ~ '^\d{4}-\d{2}-\d{2}T'
                THEN (pd.metadata->>'tier_counts_updated_at')::timestamptz END AS tier_at,
           CASE WHEN pd.metadata->>'total_pack_count' ~ '^\d+$' THEN (pd.metadata->>'total_pack_count')::int END AS tier_tp,
           CASE WHEN pd.metadata->>'total_unopened'   ~ '^\d+$' THEN (pd.metadata->>'total_unopened')::int   END AS tier_tu
    FROM public.pack_distributions pd
    LEFT JOIN public.topshot_pack_supply tss ON tss.dist_id = pd.dist_id
    -- mv_pack_ev_latest can hold >1 row per dist; check the newest (a verdict
    -- on another row never matches the view's snapshotted_at, so it fails OPEN).
    LEFT JOIN LATERAL (
      SELECT m.snapshotted_at, m.total_unopened, m.depletion_pct
      FROM public.mv_pack_ev_latest m
      WHERE m.collection_id = pd.collection_id AND m.dist_id = pd.dist_id
      ORDER BY m.snapshotted_at DESC NULLS LAST
      LIMIT 1
    ) pev ON true
    WHERE pd.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
  ),
  o AS (
    SELECT d.collection_id, d.dist_id,
           count(r.pack_nft_id)::int AS n_all,
           (count(r.pack_nft_id) FILTER (WHERE r.sealed_at <= COALESCE(d.supply_as_of, 'infinity'::timestamptz)))::int AS n_sup,
           (count(r.pack_nft_id) FILTER (WHERE r.sealed_at <= d.pev_at))::int AS n_pev,
           (count(r.pack_nft_id) FILTER (WHERE r.sealed_at <= d.tier_at))::int AS n_tier
    FROM d
    LEFT JOIN public.pack_rips r ON r.collection_id = d.collection_id AND r.dist_id = d.dist_id
    GROUP BY d.collection_id, d.dist_id
  )
  INSERT INTO public.pack_supply_counter_checks AS t (
    collection_id, dist_id, checked_at, observed_opened,
    pd_total_opened, pd_total_minted, supply_as_of, observed_by_supply, pd_refuted,
    pev_snapshotted_at, pev_total_unopened, pev_depletion_pct, observed_by_pev, pev_refuted,
    tier_counts_updated_at, tier_total_pack_count, tier_total_unopened, observed_by_tier, tier_refuted)
  SELECT d.collection_id, d.dist_id, v_run, o.n_all,
         d.total_opened, d.total_minted, d.supply_as_of, o.n_sup,
         -- opened can never be below what we watched open by its own stamp, and
         -- nothing opens more packs than were minted.
         (o.n_sup > d.total_opened) OR (d.total_minted > 0 AND o.n_all > d.total_minted),
         d.pev_at, d.pev_tu, d.pev_dep,
         CASE WHEN d.pev_at IS NOT NULL THEN o.n_pev END,
         -- the snapshot states unopened=tu at depletion dep% (rounded), so the
         -- opened it implies is at most tu*(dep+.5)/(100-dep-.5); refutable only
         -- when tu > 0 and dep < 99 (else the bound is unbounded).
         COALESCE(d.pev_at IS NOT NULL AND d.pev_tu > 0 AND d.pev_dep IS NOT NULL AND d.pev_dep < 99
                  AND o.n_pev > floor(d.pev_tu * (d.pev_dep + 0.5) / (100 - d.pev_dep - 0.5)), false),
         d.tier_at_text, d.tier_tp, d.tier_tu,
         CASE WHEN d.tier_at IS NOT NULL THEN o.n_tier END,
         COALESCE(d.tier_at IS NOT NULL AND d.tier_tp IS NOT NULL AND d.tier_tu IS NOT NULL
                  AND (o.n_tier > d.tier_tp - d.tier_tu OR o.n_all > d.tier_tp), false)
  FROM d JOIN o USING (collection_id, dist_id)
  ON CONFLICT (collection_id, dist_id) DO UPDATE SET
    checked_at = EXCLUDED.checked_at, observed_opened = EXCLUDED.observed_opened,
    pd_total_opened = EXCLUDED.pd_total_opened, pd_total_minted = EXCLUDED.pd_total_minted,
    supply_as_of = EXCLUDED.supply_as_of, observed_by_supply = EXCLUDED.observed_by_supply,
    pd_refuted = EXCLUDED.pd_refuted,
    pev_snapshotted_at = EXCLUDED.pev_snapshotted_at, pev_total_unopened = EXCLUDED.pev_total_unopened,
    pev_depletion_pct = EXCLUDED.pev_depletion_pct, observed_by_pev = EXCLUDED.observed_by_pev,
    pev_refuted = EXCLUDED.pev_refuted,
    tier_counts_updated_at = EXCLUDED.tier_counts_updated_at, tier_total_pack_count = EXCLUDED.tier_total_pack_count,
    tier_total_unopened = EXCLUDED.tier_total_unopened, observed_by_tier = EXCLUDED.observed_by_tier,
    tier_refuted = EXCLUDED.tier_refuted;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- Write first, delete only what this run did not write (a dist gone from
  -- pack_distributions).
  DELETE FROM public.pack_supply_counter_checks WHERE checked_at < v_run;
  GET DIAGNOSTICS v_del = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok', true,
    'rows_written', v_rows,
    'rows_deleted', v_del,
    'pd_refuted',   (SELECT count(*) FROM public.pack_supply_counter_checks WHERE pd_refuted),
    'pev_refuted',  (SELECT count(*) FROM public.pack_supply_counter_checks WHERE pev_refuted),
    'tier_refuted', (SELECT count(*) FROM public.pack_supply_counter_checks WHERE tier_refuted));
END
$fn$;
REVOKE ALL ON FUNCTION public.refresh_pack_supply_counter_checks() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_pack_supply_counter_checks() TO service_role;

DO $mig$
DECLARE
  d text := pg_get_viewdef('public.pack_table_rows'::regclass);
  n int;
  i int;
  olds text[] := ARRAY[
    -- 1 total_opened / total_sealed
    $q$    pd.total_opened,
    pd.total_sealed,
$q$,
    -- 2 depletion_pct: both branches
    $q$    COALESCE(NULLIF(pd.depletion_pct, (0)::smallint),
        CASE
            WHEN sent.is_sentinel THEN NULL::smallint
            ELSE (round((pev.depletion_pct)::double precision))::smallint
        END) AS depletion_pct,
$q$,
    -- 3 total_unopened
    $q$    pev.total_unopened,
$q$,
    -- 4 ev_depletion_pct
    $q$            WHEN sent.is_sentinel THEN NULL::smallint
            ELSE pev.depletion_pct
        END AS ev_depletion_pct,
$q$,
    -- 5 depletion_as_of, pd branch
    $q$            WHEN (NULLIF(pd.depletion_pct, (0)::smallint) IS NOT NULL) THEN
$q$,
    -- 6 depletion_as_of, pev branch
    $q$            WHEN ((NOT sent.is_sentinel) AND (pev.depletion_pct IS NOT NULL)) THEN pev.snapshotted_at
$q$,
    -- 7 appended columns
    $q$        END AS depletion_as_of
   FROM $q$
  ];
  reps text[] := ARRAY[
    $q$    CASE WHEN ref.pd_bad THEN NULL::integer ELSE pd.total_opened END AS total_opened,
    CASE WHEN ref.pd_bad THEN NULL::integer ELSE pd.total_sealed END AS total_sealed,
$q$,
    $q$    COALESCE(CASE WHEN ref.pd_bad THEN NULL::smallint ELSE NULLIF(pd.depletion_pct, (0)::smallint) END,
        CASE
            WHEN sent.is_sentinel THEN NULL::smallint
            WHEN ref.pev_bad THEN NULL::smallint
            ELSE (round((pev.depletion_pct)::double precision))::smallint
        END) AS depletion_pct,
$q$,
    $q$    CASE WHEN ref.pev_bad THEN NULL::integer ELSE pev.total_unopened END AS total_unopened,
$q$,
    $q$            WHEN sent.is_sentinel THEN NULL::smallint
            WHEN ref.pev_bad THEN NULL::smallint
            ELSE pev.depletion_pct
        END AS ev_depletion_pct,
$q$,
    $q$            WHEN ((NULLIF(pd.depletion_pct, (0)::smallint) IS NOT NULL) AND (NOT ref.pd_bad)) THEN
$q$,
    $q$            WHEN ((NOT sent.is_sentinel) AND (NOT ref.pev_bad) AND (pev.depletion_pct IS NOT NULL)) THEN pev.snapshotted_at
$q$,
    $q$        END AS depletion_as_of,
    ref.tier_bad AS tier_counts_contradicted,
    chk.observed_opened AS observed_packs_opened
   FROM $q$
  ];
  join_sql constant text := $q$
     LEFT JOIN public.pack_supply_counter_checks chk ON ((chk.collection_id = pd.collection_id) AND (chk.dist_id = pd.dist_id)))
     LEFT JOIN LATERAL ( SELECT
            COALESCE((chk.pd_refuted AND (chk.pd_total_opened = pd.total_opened) AND (chk.pd_total_minted = pd.total_minted)), false) AS pd_bad,
            COALESCE((chk.pev_refuted AND (chk.pev_snapshotted_at = pev.snapshotted_at)), false) AS pev_bad,
            COALESCE((chk.tier_refuted AND (chk.tier_counts_updated_at = (pd.metadata ->> 'tier_counts_updated_at'::text))), false) AS tier_bad) ref ON (true)$q$;
BEGIN
  FOR i IN 1..array_length(olds, 1) LOOP
    n := (length(d) - length(replace(d, olds[i], ''))) / length(olds[i]);
    IF n <> 1 THEN RAISE EXCEPTION 'pack_table_rows anchor % matched % times', i, n; END IF;
    d := replace(d, olds[i], reps[i]);
  END LOOP;
  -- The FROM list is one parenthesised join chain; open one more paren at its
  -- head and close it after the new chk join, so the ref lateral sees pev.
  n := (length(d) - length(replace(d, '   FROM ((((((((pack_distributions pd', ''))) / length('   FROM ((((((((pack_distributions pd');
  IF n <> 1 THEN RAISE EXCEPTION 'FROM head matched % times', n; END IF;
  d := replace(d, '   FROM ((((((((pack_distributions pd', '   FROM (((((((((pack_distributions pd');
  d := rtrim(d);
  IF right(d, 1) = ';' THEN d := left(d, length(d) - 1); END IF;
  d := d || join_sql;
  EXECUTE 'CREATE OR REPLACE VIEW public.pack_table_rows AS ' || d;
END
$mig$;

SELECT public.refresh_pack_supply_counter_checks();

-- Post-conditions.
DO $post$
DECLARE
  prev_n int; now_n int; bad int; flagged int; r record;
BEGIN
  -- Same rows as the pre-change view (every collection).
  EXECUTE 'SELECT count(*) FROM (' || (SELECT regexp_replace(def, ';\s*$', '') FROM public.audit_20260925_pack_table_rows_prev LIMIT 1) || ') x' INTO prev_n;
  SELECT count(*) INTO now_n FROM public.pack_table_rows;
  IF prev_n <> now_n THEN RAISE EXCEPTION 'row count moved % -> %', prev_n, now_n; END IF;

  -- No-change control: a row changes ONLY in the six guarded columns, and only
  -- where a verdict applied.
  EXECUTE $s$
    WITH p AS (SELECT to_jsonb(x) j FROM ($s$ || (SELECT regexp_replace(def, ';\s*$', '') FROM public.audit_20260925_pack_table_rows_prev LIMIT 1) || $s$) x),
         c AS (SELECT to_jsonb(y) - 'tier_counts_contradicted' - 'observed_packs_opened' j FROM public.pack_table_rows y)
    SELECT count(*) FROM p JOIN c
      ON (p.j->>'collection_id') = (c.j->>'collection_id') AND (p.j->>'dist_id') = (c.j->>'dist_id')
     WHERE (p.j - 'total_opened' - 'total_sealed' - 'depletion_pct' - 'total_unopened' - 'ev_depletion_pct' - 'depletion_as_of')
        <> (c.j - 'total_opened' - 'total_sealed' - 'depletion_pct' - 'total_unopened' - 'ev_depletion_pct' - 'depletion_as_of')
        OR ((p.j <> c.j) AND (c.j->>'collection_id') <> '95f28a17-224a-4025-96ad-adf8a4c63bfd')
  $s$ INTO bad;
  IF bad <> 0 THEN RAISE EXCEPTION '% rows changed outside the guarded columns / outside Top Shot', bad; END IF;

  -- Positive controls (measured before the change).
  SELECT tier_counts_contradicted, observed_packs_opened INTO r FROM public.pack_table_rows
   WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND dist_id = '8643';
  IF r.tier_counts_contradicted IS NOT TRUE OR r.observed_packs_opened < 5000 THEN
    RAISE EXCEPTION '8643 not flagged (%, %)', r.tier_counts_contradicted, r.observed_packs_opened;
  END IF;
  -- 8597: total_opened 0 (the column default) with 12,776 observed opens.
  SELECT count(*) INTO flagged FROM public.pack_table_rows
   WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND dist_id = '8597'
     AND total_opened IS NULL AND total_sealed IS NULL;
  IF flagged <> 1 THEN RAISE EXCEPTION '8597 total_opened/total_sealed not NULLed'; END IF;
  -- A refuted figure is NULL, never a number below the observed floor.
  SELECT count(*) INTO bad FROM public.pack_table_rows t
    JOIN public.pack_supply_counter_checks k ON k.collection_id = t.collection_id AND k.dist_id = t.dist_id
   WHERE t.total_opened IS NOT NULL AND t.total_opened < k.observed_by_supply;
  IF bad <> 0 THEN RAISE EXCEPTION '% published total_opened still below the observed floor', bad; END IF;
END
$post$;

-- Post-condition: ACL unchanged.
DO $$
BEGIN
  IF has_table_privilege('anon', 'public.pack_table_rows', 'SELECT')
     OR has_table_privilege('anon', 'public.pack_supply_counter_checks', 'SELECT')
     OR has_function_privilege('anon', 'public.refresh_pack_supply_counter_checks()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.refresh_pack_supply_counter_checks()', 'EXECUTE') THEN
    RAISE EXCEPTION 'ACL widened';
  END IF;
END $$;
