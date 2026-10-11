-- DB invariant: public.rekey_pack_rips_to_chain_identity — a Top Shot rip / purchase whose dist disagrees with
-- Dapper's index identity (a known drop) is re-keyed to it, and the rip's topshot_pack_rip_attribution copy
-- follows in the same run. Added 2026-10-11 (the attribution half; the re-key itself dates from 20261004181500).
-- Claims:
--   K1. A rip whose recent identity names a different, KNOWN dist is re-keyed; the old value is backed up.
--   K2. Its attribution row follows: dist = the new dist, method 'dapper_index', confidence 'high',
--       n_editions NULL; the old attribution is backed up.
--   K3. An identity naming a dist missing from pack_distributions moves nothing (rip and attribution).
--   K4. A rip already equal to its recent identity but with a stale attribution copy is synced too; an
--       identity checked more than an hour ago is outside the window and moves nothing; the run reports
--       attribution_synced.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20261011083816_audit_20261011_rip_rekey_keeps_attribution_in_step.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.pipeline_runs_stub (pipeline text, ok boolean, extra jsonb);
CREATE FUNCTION public.log_pipeline_run(p_pipeline text, p_started_at timestamptz, p_rows_found int, p_rows_written int,
  p_rows_skipped int, p_ok boolean, p_error text, p_collection_slug text, p_cursor_before text, p_cursor_after text, p_extra jsonb)
RETURNS bigint LANGUAGE sql AS $$ INSERT INTO public.pipeline_runs_stub VALUES (p_pipeline, p_ok, p_extra) RETURNING 1::bigint $$;

CREATE TABLE public.pack_nft_identity (collection_id uuid, pack_nft_id text, dist_id text, checked_at timestamptz,
  PRIMARY KEY (collection_id, pack_nft_id));
CREATE TABLE public.pack_rips (id uuid PRIMARY KEY, collection_id uuid, pack_nft_id text, dist_id text);
CREATE TABLE public.pack_purchases (id uuid PRIMARY KEY, collection_id uuid, pack_nft_id text, pack_dist_id text);
CREATE TABLE public.pack_distributions (collection_id uuid, dist_id text);
CREATE TABLE public.topshot_pack_rip_attribution (rip_id uuid PRIMARY KEY, dist_id text, method text, confidence text, n_editions int);
CREATE TABLE public.audit_20261004_pack_rips_dist_rekey_backup (rip_id uuid PRIMARY KEY, pack_nft_id text NOT NULL,
  old_dist_id text, new_dist_id text NOT NULL, rekeyed_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.audit_20261004_pack_purchases_dist_rekey_backup (purchase_id uuid PRIMARY KEY, pack_nft_id text NOT NULL,
  old_dist_id text, new_dist_id text NOT NULL, rekeyed_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.audit_20261011_rip_attribution_rekey_backup (rip_id uuid PRIMARY KEY, old_dist_id text, old_method text,
  old_confidence text, old_n_editions int, new_dist_id text NOT NULL, synced_at timestamptz NOT NULL DEFAULT now());

-- >>> BEGIN verbatim rekey_pack_rips_to_chain_identity (body byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.rekey_pack_rips_to_chain_identity()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_n int := 0;
  v_p int := 0;
  v_a int := 0;
BEGIN
  WITH target AS (
    SELECT r.id, r.pack_nft_id, r.dist_id AS old_dist_id, i.dist_id AS new_dist_id
    FROM public.pack_nft_identity i
    JOIN public.pack_rips r ON r.pack_nft_id = i.pack_nft_id AND r.collection_id = i.collection_id
    WHERE i.checked_at > now() - interval '1 hour'
      AND i.collection_id = v_ts
      AND i.dist_id IS NOT NULL AND i.dist_id <> '0'
      AND r.dist_id IS NOT NULL
      AND i.dist_id <> r.dist_id
      AND EXISTS (SELECT 1 FROM public.pack_distributions d
                   WHERE d.collection_id = i.collection_id AND d.dist_id = i.dist_id)
  ), saved AS (
    INSERT INTO public.audit_20261004_pack_rips_dist_rekey_backup (rip_id, pack_nft_id, old_dist_id, new_dist_id)
    SELECT id, pack_nft_id, old_dist_id, new_dist_id FROM target
    ON CONFLICT (rip_id) DO NOTHING
    RETURNING rip_id
  ), upd AS (
    UPDATE public.pack_rips r
       SET dist_id = t.new_dist_id
      FROM target t
     WHERE r.id = t.id
    RETURNING r.id
  )
  SELECT count(*) INTO v_n FROM upd;

  -- 2026-10-11: the attribution copy follows the rip (20261011084500). get_pack_realized_ev_row picks
  -- rips by attribution.dist_id alone, so a re-keyed rip left there kept counting under the old dist.
  -- Any attribution row of a rip whose identity (checked in the window) now equals its dist.
  WITH target AS (
    SELECT a.rip_id, a.dist_id AS old_dist_id, a.method, a.confidence, a.n_editions, r.dist_id AS new_dist_id
    FROM public.pack_nft_identity i
    JOIN public.pack_rips r ON r.pack_nft_id = i.pack_nft_id AND r.collection_id = i.collection_id
    JOIN public.topshot_pack_rip_attribution a ON a.rip_id = r.id
    WHERE i.checked_at > now() - interval '1 hour'
      AND i.collection_id = v_ts
      AND i.dist_id IS NOT NULL AND i.dist_id <> '0'
      AND r.dist_id = i.dist_id
      AND a.dist_id IS DISTINCT FROM r.dist_id
  ), saved AS (
    INSERT INTO public.audit_20261011_rip_attribution_rekey_backup (rip_id, old_dist_id, old_method, old_confidence, old_n_editions, new_dist_id)
    SELECT rip_id, old_dist_id, method, confidence, n_editions, new_dist_id FROM target
    ON CONFLICT (rip_id) DO NOTHING
    RETURNING rip_id
  ), upd AS (
    UPDATE public.topshot_pack_rip_attribution a
       SET dist_id = t.new_dist_id, method = 'dapper_index', confidence = 'high', n_editions = NULL
      FROM target t
     WHERE a.rip_id = t.rip_id
    RETURNING a.rip_id
  )
  SELECT count(*) INTO v_a FROM upd;

  -- 2026-10-04: purchases too (20261004190000). Same chain-only rule, own backup table.
  WITH target AS (
    SELECT p.id, p.pack_nft_id, p.pack_dist_id AS old_dist_id, i.dist_id AS new_dist_id
    FROM public.pack_nft_identity i
    JOIN public.pack_purchases p ON p.pack_nft_id = i.pack_nft_id AND p.collection_id = i.collection_id
    WHERE i.checked_at > now() - interval '1 hour'
      AND i.collection_id = v_ts
      AND i.dist_id IS NOT NULL AND i.dist_id <> '0'
      AND p.pack_dist_id IS NOT NULL
      AND i.dist_id <> p.pack_dist_id
      AND EXISTS (SELECT 1 FROM public.pack_distributions d
                   WHERE d.collection_id = i.collection_id AND d.dist_id = i.dist_id)
  ), saved AS (
    INSERT INTO public.audit_20261004_pack_purchases_dist_rekey_backup (purchase_id, pack_nft_id, old_dist_id, new_dist_id)
    SELECT id, pack_nft_id, old_dist_id, new_dist_id FROM target
    ON CONFLICT (purchase_id) DO NOTHING
    RETURNING purchase_id
  ), upd AS (
    UPDATE public.pack_purchases p
       SET pack_dist_id = t.new_dist_id
      FROM target t
     WHERE p.id = t.id
    RETURNING p.id
  )
  SELECT count(*) INTO v_p FROM upd;

  PERFORM public.log_pipeline_run('pack-rips-chain-rekey', v_started, v_n + v_p, v_n + v_p + v_a, 0, true, NULL,
    'nba_top_shot', NULL, NULL, jsonb_build_object('rekeyed', v_n, 'purchases_rekeyed', v_p, 'attribution_synced', v_a));
  RETURN jsonb_build_object('ok', true, 'rekeyed', v_n, 'purchases_rekeyed', v_p, 'attribution_synced', v_a);
EXCEPTION WHEN query_canceled OR OTHERS THEN
  -- query_canceled named: a 57014 kill escapes WHEN OTHERS (R118). The tail is one
  -- log_pipeline_run insert, bounded even though the timer is not re-armed after a catch.
  PERFORM public.log_pipeline_run('pack-rips-chain-rekey', v_started, 0, 0, 0, false, SQLERRM,
    'nba_top_shot', NULL, NULL, '{}'::jsonb);
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$;
-- <<< END verbatim <<<

DO $$
DECLARE v jsonb;
  ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  r1 constant uuid := '00000000-0000-0000-0000-000000000001';
  r2 constant uuid := '00000000-0000-0000-0000-000000000002';
  r3 constant uuid := '00000000-0000-0000-0000-000000000003';
  r4 constant uuid := '00000000-0000-0000-0000-000000000004';
  r5 constant uuid := '00000000-0000-0000-0000-000000000005';
BEGIN
  INSERT INTO public.pack_distributions VALUES (ts, '7743'), (ts, '7800'), (ts, '8000');
  -- r1: wrong guess 7800, index says 7743 (known)        -> re-key + attribution follows
  -- r2: index names 9999 (unknown drop)                    -> nothing moves
  -- r3: rip already 8000 = index, attribution stale 7800  -> attribution synced
  -- r4: like r1 but identity checked 2 h ago               -> outside the window
  -- r5: like r3 but identity checked 2 h ago               -> attribution outside the window too
  INSERT INTO public.pack_rips VALUES (r1, ts, 'p1', '7800'), (r2, ts, 'p2', '7800'), (r3, ts, 'p3', '8000'), (r4, ts, 'p4', '7800'), (r5, ts, 'p5', '8000');
  INSERT INTO public.pack_nft_identity VALUES (ts, 'p1', '7743', now()), (ts, 'p2', '9999', now()),
    (ts, 'p3', '8000', now()), (ts, 'p4', '7743', now() - interval '2 hours'), (ts, 'p5', '8000', now() - interval '2 hours');
  INSERT INTO public.topshot_pack_rip_attribution VALUES (r1, '7800', 'rip_dist', 'high', 3), (r2, '7800', 'rip_dist', 'high', 3),
    (r3, '7800', 'empirical_subset', 'medium', 2), (r4, '7800', 'rip_dist', 'high', 3),
    (r5, '7800', 'rip_dist', 'high', 3);

  v := public.rekey_pack_rips_to_chain_identity();

  PERFORM _assert((SELECT dist_id = '7743' FROM public.pack_rips WHERE id = r1), 'K1: the rip is re-keyed to the index dist');
  PERFORM _assert((SELECT old_dist_id = '7800' AND new_dist_id = '7743' FROM public.audit_20261004_pack_rips_dist_rekey_backup WHERE rip_id = r1),
                  'K1: the old rip dist is backed up');
  PERFORM _assert((SELECT dist_id = '7743' AND method = 'dapper_index' AND confidence = 'high' AND n_editions IS NULL
                     FROM public.topshot_pack_rip_attribution WHERE rip_id = r1), 'K2: the attribution follows the rip');
  PERFORM _assert((SELECT old_dist_id = '7800' AND old_method = 'rip_dist' AND old_confidence = 'high' AND old_n_editions = 3
                     FROM public.audit_20261011_rip_attribution_rekey_backup WHERE rip_id = r1), 'K2: the old attribution is backed up');
  PERFORM _assert((SELECT dist_id = '7800' FROM public.pack_rips WHERE id = r2)
                  AND (SELECT dist_id = '7800' AND method = 'rip_dist' FROM public.topshot_pack_rip_attribution WHERE rip_id = r2),
                  'K3: an unknown index dist moves neither the rip nor its attribution');
  PERFORM _assert((SELECT dist_id = '8000' AND method = 'dapper_index' FROM public.topshot_pack_rip_attribution WHERE rip_id = r3),
                  'K4: a stale attribution of an already-correct rip is synced');
  PERFORM _assert((SELECT dist_id = '7800' FROM public.pack_rips WHERE id = r4)
                  AND (SELECT dist_id = '7800' FROM public.topshot_pack_rip_attribution WHERE rip_id = r4),
                  'K4: an identity older than the hour window moves nothing');
  PERFORM _assert((SELECT dist_id = '7800' AND method = 'rip_dist' FROM public.topshot_pack_rip_attribution WHERE rip_id = r5),
                  'K4: a stale attribution whose identity is older than the window is left for the one-off sweep');
  PERFORM _assert_eq(v->>'rekeyed', '1', 'K1: one rip re-keyed');
  PERFORM _assert_eq(v->>'attribution_synced', '2', 'K4: two attribution rows synced (r1, r3)');
  PERFORM _assert((SELECT (extra->>'attribution_synced')::int = 2 FROM public.pipeline_runs_stub ORDER BY ctid DESC LIMIT 1),
                  'K4: the run log reports attribution_synced');
END $$;

ROLLBACK;
