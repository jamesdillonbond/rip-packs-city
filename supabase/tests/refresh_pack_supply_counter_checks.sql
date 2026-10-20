-- DB invariant: public.refresh_pack_supply_counter_checks -- the verdicts pack_table_rows uses to
-- withdraw a supply counter (opened / unopened / depletion) that contradicts the opens we observed.
--
--   1. (2026-10-19) A BOX / CASE writes no pack_rips row, so its opens come from Dapper's index:
--      a container pack Opened (or Revealed) in pack_nft_identity, checked BY a counter's stamp,
--      counts toward "opened by the stamp" and refutes a counter claiming fewer (B1, the 8614 shape).
--   2. ...but checked_at only bounds the open time from ABOVE: an index open checked AFTER the stamp
--      neither counts by the stamp nor as "opened after it" (B2 is never refuted).
--   3. Only recipe containers take index opens (P1, an ordinary pack, observes 0 from the index).
--   4. A pack with both a rip and an index row counts once (B3).
--   5. The existing post-stamp arm still uses exact rip times (P2).
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20261020044126_audit_20261019_counter_checks_count_container_opens_dapper_confirmed.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.pack_distributions (collection_id uuid, dist_id text, total_opened int, total_minted int, metadata jsonb);
CREATE TABLE public.topshot_pack_supply (dist_id text, last_success_at timestamptz);
CREATE TABLE public.mv_pack_ev_latest (collection_id uuid, dist_id text, snapshotted_at timestamptz, total_unopened int, depletion_pct smallint);
CREATE TABLE public.pack_rips (collection_id uuid, dist_id text, pack_nft_id text, sealed_at timestamptz);
CREATE TABLE public.pack_nft_identity (collection_id uuid, pack_nft_id text, dist_id text, status text, checked_at timestamptz);
CREATE TABLE public.pack_container_recipes (collection_id uuid, container_dist_id text, inner_dist_id text);
CREATE TABLE public.pack_supply_counter_checks (
  collection_id uuid, dist_id text, checked_at timestamptz, observed_opened int,
  pd_total_opened int, pd_total_minted int, supply_as_of timestamptz, observed_by_supply int, pd_refuted boolean,
  pev_snapshotted_at timestamptz, pev_total_unopened int, pev_depletion_pct smallint, observed_by_pev int, pev_refuted boolean,
  tier_counts_updated_at text, tier_total_pack_count int, tier_total_unopened int, observed_by_tier int, tier_refuted boolean,
  PRIMARY KEY (collection_id, dist_id));

CREATE OR REPLACE FUNCTION public.refresh_pack_supply_counter_checks()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
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
  ),
  -- 2026-10-19: a box or case writes NO pack_rips row (it yields packs, not moments), so the floor
  -- above read 0 for every container opened since ~07-11 and could refute nothing: a fresh EV
  -- snapshot of WNBA Fresh Gems Box published "0 opened / 500 unopened / 0 %" with 472 of its
  -- boxes Opened in Dapper's index. Dapper said Opened (or Revealed -- a stalled open) as of
  -- checked_at, so each such pack was opened BY checked_at: an upper bound on its open time. That
  -- bounds "opened by the stamp" (n_*), never "opened AFTER it" -- those arms keep the exact rip
  -- times (r_after_*). Scoped to recipe containers: 1,536 of the 1,561 index-only opens, and 67k
  -- buffers instead of 2.9M for the anti-join over every rip.
  ix AS (
    SELECT i.dist_id, i.checked_at
    FROM public.pack_nft_identity i
    WHERE i.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
      AND i.status IN ('Opened', 'Revealed')
      AND i.dist_id IN (SELECT cr.container_dist_id FROM public.pack_container_recipes cr
                         WHERE cr.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd')
      AND NOT EXISTS (SELECT 1 FROM public.pack_rips r WHERE r.pack_nft_id = i.pack_nft_id)
  ),
  x AS (
    SELECT ix.dist_id, count(*)::int AS x_all,
           (count(*) FILTER (WHERE ix.checked_at <= COALESCE(d.supply_as_of, 'infinity'::timestamptz)))::int AS x_sup,
           (count(*) FILTER (WHERE ix.checked_at <= d.pev_at))::int AS x_pev,
           (count(*) FILTER (WHERE ix.checked_at <= d.tier_at))::int AS x_tier
    FROM ix JOIN d ON d.dist_id = ix.dist_id
    GROUP BY ix.dist_id
  ),
  c AS (
    SELECT o.collection_id, o.dist_id,
           o.n_all + COALESCE(x.x_all, 0)  AS n_all,
           o.n_sup + COALESCE(x.x_sup, 0)  AS n_sup,
           o.n_pev + COALESCE(x.x_pev, 0)  AS n_pev,
           o.n_tier + COALESCE(x.x_tier, 0) AS n_tier,
           o.n_all - o.n_sup  AS r_after_sup,
           o.n_all - o.n_pev  AS r_after_pev,
           o.n_all - o.n_tier AS r_after_tier
    FROM o LEFT JOIN x ON x.dist_id = o.dist_id
  )
  INSERT INTO public.pack_supply_counter_checks AS t (
    collection_id, dist_id, checked_at, observed_opened,
    pd_total_opened, pd_total_minted, supply_as_of, observed_by_supply, pd_refuted,
    pev_snapshotted_at, pev_total_unopened, pev_depletion_pct, observed_by_pev, pev_refuted,
    tier_counts_updated_at, tier_total_pack_count, tier_total_unopened, observed_by_tier, tier_refuted)
  SELECT d.collection_id, d.dist_id, v_run, c.n_all,
         d.total_opened, d.total_minted, d.supply_as_of, c.n_sup,
         -- opened can never be below what we watched open by its own stamp, and
         -- nothing opens more packs than were minted.
         (c.n_sup > d.total_opened) OR (d.total_minted > 0 AND c.n_all > d.total_minted)
         -- a pack opened after the stamp was sealed at it
         OR (d.total_minted > 0 AND c.r_after_sup > d.total_minted - d.total_opened),
         d.pev_at, d.pev_tu, d.pev_dep,
         CASE WHEN d.pev_at IS NOT NULL THEN c.n_pev END,
         -- the snapshot states unopened=tu at depletion dep% (rounded), so the
         -- opened it implies is at most tu*(dep+.5)/(100-dep-.5); refutable only
         -- when tu > 0 and dep < 99 (else the bound is unbounded).
         COALESCE(d.pev_at IS NOT NULL AND d.pev_tu > 0 AND d.pev_dep IS NOT NULL AND d.pev_dep < 99
                  AND c.n_pev > floor(d.pev_tu * (d.pev_dep + 0.5) / (100 - d.pev_dep - 0.5)), false)
         OR COALESCE(d.pev_at IS NOT NULL AND d.pev_tu IS NOT NULL AND c.r_after_pev > d.pev_tu, false),
         d.tier_at_text, d.tier_tp, d.tier_tu,
         CASE WHEN d.tier_at IS NOT NULL THEN c.n_tier END,
         COALESCE(d.tier_at IS NOT NULL AND d.tier_tp IS NOT NULL AND d.tier_tu IS NOT NULL
                  AND (c.n_tier > d.tier_tp - d.tier_tu OR c.n_all > d.tier_tp
                       OR c.r_after_tier > d.tier_tu), false)
  FROM d JOIN c USING (collection_id, dist_id)
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
$function$;

-- fixtures: one EV snapshot stamp for every dist
INSERT INTO public.pack_container_recipes VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'B1', 'S1'), ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'B2', 'S1'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'B3', 'S1');
INSERT INTO public.pack_distributions VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'B1', 0, 500, '{}'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'B2', 0, 500, '{}'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'B3', 0, 500, '{}'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P1', 0, 500, '{}'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P2', 0, 500, '{}');
INSERT INTO public.mv_pack_ev_latest
SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', d, '2026-10-20 02:28+00', 500, 0 FROM unnest(ARRAY['B1','B2','B3','P1']) d;
-- P2: an older snapshot claiming 2 unopened; 3 packs ripped AFTER it -> refuted by the exact arm
INSERT INTO public.mv_pack_ev_latest VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P2', '2026-10-01 00:00+00', 2, 99);
INSERT INTO public.pack_rips VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P2', 'p2a', '2026-10-02'), ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P2', 'p2b', '2026-10-03'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P2', 'p2c', '2026-10-04'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'B3', 'b3a', '2026-07-01');
INSERT INTO public.pack_nft_identity VALUES
  -- B1: three boxes Dapper said were Opened / Revealed before the stamp
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'b1a', 'B1', 'Opened',   '2026-10-19 00:00+00'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'b1b', 'B1', 'Opened',   '2026-10-19 00:00+00'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'b1c', 'B1', 'Revealed', '2026-10-19 00:00+00'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'b1s', 'B1', 'Sealed',   '2026-10-19 00:00+00'),
  -- B2: opens only CHECKED after the stamp -- 600 of them, more than the 500 the snapshot calls unopened
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'b2x', 'B2', 'Opened',   '2026-10-20 03:00+00'),
  -- B3: one pack seen both ways (rip + index) and one index-only
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'b3a', 'B3', 'Opened',   '2026-10-19 00:00+00'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'b3b', 'B3', 'Opened',   '2026-10-19 00:00+00'),
  -- P1: an ordinary pack opened per the index, no rip: out of scope
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'p1a', 'P1', 'Opened',   '2026-10-19 00:00+00');
INSERT INTO public.pack_nft_identity
SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'b2_' || g, 'B2', 'Opened', '2026-10-20 03:00+00' FROM generate_series(1, 599) g;

DO $$
DECLARE v jsonb; k record;
BEGIN
  v := public.refresh_pack_supply_counter_checks();
  PERFORM _assert((v->>'ok')::boolean AND (v->>'rows_written')::int = 5, 'one verdict row per dist');

  SELECT * INTO k FROM public.pack_supply_counter_checks WHERE dist_id = 'B1';
  PERFORM _assert_eq(k.observed_opened::text, '3', 'B1 Opened + Revealed index opens count, Sealed does not');
  PERFORM _assert_eq(k.observed_by_pev::text, '3', 'B1 all three were checked before the stamp');
  PERFORM _assert(k.pev_refuted, 'B1 "0 opened / 500 unopened / 0 %" is refuted by 3 confirmed opens');

  SELECT * INTO k FROM public.pack_supply_counter_checks WHERE dist_id = 'B2';
  PERFORM _assert_eq(k.observed_opened::text, '600', 'B2 sees its 600 index opens');
  PERFORM _assert_eq(k.observed_by_pev::text, '0', 'B2 none was CHECKED by the stamp');
  PERFORM _assert(NOT k.pev_refuted, 'B2 an index open checked after the stamp is not an open after it -- never refutes');

  SELECT * INTO k FROM public.pack_supply_counter_checks WHERE dist_id = 'B3';
  PERFORM _assert_eq(k.observed_opened::text, '2', 'B3 a pack seen as rip and index counts once');

  SELECT * INTO k FROM public.pack_supply_counter_checks WHERE dist_id = 'P1';
  PERFORM _assert_eq(k.observed_opened::text, '0', 'P1 index-only opens are taken for containers only');
  PERFORM _assert(NOT k.pev_refuted, 'P1 unchanged');

  SELECT * INTO k FROM public.pack_supply_counter_checks WHERE dist_id = 'P2';
  PERFORM _assert(k.pev_refuted, 'P2 three exact rips after a "2 unopened" stamp still refute it');
END $$;

ROLLBACK;
