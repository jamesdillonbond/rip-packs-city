-- DB invariant: public.topshot_checkpoint_base + trg_topshot_subedition_base_from_checkpoint (#173)
-- and the one-off public.fix_173_rekey_batch. Claims:
--   1. a base that disagrees with an all-sporks-agreeing checkpoint is replaced on INSERT and on an
--      UPDATE of base_external_id; an agreeing base is left alone;
--   2. no checkpoint, a spork disagreement, or a non-numeric nft id leaves the base untouched;
--   3. an UPDATE that does not touch base_external_id (the subedition apply) does not fire it;
--   4. fix_173_rekey_batch re-keys the nft's sales / moments / wmc rows on another base to the
--      checkpoint edition (base::N for subedition N), logs every old value, copies the wmc edition
--      fields from the right edition and clears its FMV; rows already on the checkpoint base are not
--      touched; a taken (edition, serial) in moments is skipped and counted; a missing target edition
--      and an unresolved subedition are skipped with the reason; a second batch does nothing.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20261009203911_audit_20261009_topshot_subedition_base_follows_the_checkpoint.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE SCHEMA IF NOT EXISTS flowty_archive;
CREATE TABLE public.checkpoint_nft_meta (spork smallint, c text, nft_id bigint, a bigint, b bigint, serial bigint, PRIMARY KEY (c, nft_id, spork));
CREATE TABLE public.topshot_moment_subeditions (nft_id text PRIMARY KEY, base_external_id text NOT NULL, subedition_id smallint, resolved_at timestamptz);
CREATE TABLE public.editions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), collection_id uuid, external_id text, tier text,
  set_name text, series smallint, circulation_count int, player_name text, team_name text);
CREATE TABLE public.sales (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), collection_id uuid, nft_id text, edition_id uuid);
CREATE TABLE public.moments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), collection_id uuid, nft_id text, edition_id uuid, serial_number int,
  UNIQUE (edition_id, serial_number));
CREATE TABLE public.wallet_moments_cache (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), collection_id uuid, moment_id text, edition_key text,
  tier text, set_name text, series_number int, mint_count int, player_name text, team_name text, edition_name text,
  fmv_usd numeric, fmv_confidence text, image_url text);
CREATE TABLE flowty_archive.audit_20261009_173_conflicts (
  nft_id         text PRIMARY KEY,
  old_base       text NOT NULL,
  ckpt_base      text NOT NULL,
  subedition_id  smallint,
  collected_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  fixed_at       timestamptz,
  outcome        jsonb
);
CREATE TABLE flowty_archive.audit_20261009_173_rekeys (
  tbl        text NOT NULL,
  key        text NOT NULL,
  nft_id     text NOT NULL,
  old_value  text,
  new_value  text,
  at         timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- >>> BEGIN verbatim topshot_checkpoint_base (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.topshot_checkpoint_base(p_nft_id text)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE WHEN count(DISTINCT (c.a, c.b)) = 1 THEN min(c.a::text || ':' || c.b::text) END
    FROM public.checkpoint_nft_meta c
   WHERE p_nft_id ~ '^[0-9]{1,18}$'
     AND c.c = 'ts' AND c.nft_id = p_nft_id::bigint;
$function$;
-- <<< END verbatim topshot_checkpoint_base <<<

-- >>> BEGIN verbatim trg_topshot_subedition_base_from_checkpoint (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.trg_topshot_subedition_base_from_checkpoint()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_base text;
BEGIN
  -- The chain's set:play wins over a base copied from a sale / moment / wmc row (#173).
  v_base := public.topshot_checkpoint_base(NEW.nft_id);
  IF v_base IS NOT NULL AND NEW.base_external_id IS DISTINCT FROM v_base THEN
    NEW.base_external_id := v_base;
  END IF;
  RETURN NEW;
END;
$function$;
-- <<< END verbatim trg_topshot_subedition_base_from_checkpoint <<<

CREATE TRIGGER trg_topshot_subedition_base_from_checkpoint
  BEFORE INSERT OR UPDATE OF base_external_id ON public.topshot_moment_subeditions
  FOR EACH ROW EXECUTE FUNCTION public.trg_topshot_subedition_base_from_checkpoint();

-- >>> BEGIN verbatim audit_173_collect (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.audit_173_collect(p_lo bigint, p_hi bigint)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_n integer;
BEGIN
  WITH ck AS (
    SELECT c.nft_id, min(c.a::text || ':' || c.b::text) AS base
      FROM public.checkpoint_nft_meta c
     WHERE c.c = 'ts' AND c.nft_id >= p_lo AND c.nft_id < p_hi
     GROUP BY c.nft_id
    HAVING count(DISTINCT (c.a, c.b)) = 1
  ), ins AS (
    INSERT INTO flowty_archive.audit_20261009_173_conflicts (nft_id, old_base, ckpt_base, subedition_id)
    SELECT s.nft_id, s.base_external_id, ck.base, s.subedition_id
      FROM ck JOIN public.topshot_moment_subeditions s ON s.nft_id = ck.nft_id::text
     WHERE s.base_external_id IS DISTINCT FROM ck.base
    ON CONFLICT (nft_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_n FROM ins;
  RETURN v_n;
END;
$function$;
-- <<< END verbatim audit_173_collect <<<

-- >>> BEGIN verbatim fix_173_rekey_batch (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.fix_173_rekey_batch(p_limit integer DEFAULT 300)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  c_ts   constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  r      record;
  v_ext  text;
  v_ed   uuid;
  v_s int; v_m int; v_w int; v_mskip int;
  t_nfts int := 0; t_s int := 0; t_m int := 0; t_w int := 0; t_skip int := 0; t_mskip int := 0;
BEGIN
  FOR r IN SELECT * FROM flowty_archive.audit_20261009_173_conflicts
            WHERE fixed_at IS NULL ORDER BY nft_id LIMIT p_limit LOOP
    t_nfts := t_nfts + 1;
    -- the table row: re-assert the base; the trigger writes the checkpoint's
    UPDATE public.topshot_moment_subeditions SET base_external_id = r.ckpt_base WHERE nft_id = r.nft_id;

    IF r.subedition_id IS NULL THEN
      UPDATE flowty_archive.audit_20261009_173_conflicts
         SET fixed_at = clock_timestamp(), outcome = jsonb_build_object('skipped', 'subedition_id unresolved')
       WHERE nft_id = r.nft_id;
      t_skip := t_skip + 1;
      CONTINUE;
    END IF;
    v_ext := r.ckpt_base || CASE WHEN r.subedition_id > 0 THEN '::' || r.subedition_id ELSE '' END;
    SELECT e.id INTO v_ed FROM public.editions e WHERE e.collection_id = c_ts AND e.external_id = v_ext;
    IF v_ed IS NULL THEN
      UPDATE flowty_archive.audit_20261009_173_conflicts
         SET fixed_at = clock_timestamp(), outcome = jsonb_build_object('skipped', 'no edition ' || v_ext)
       WHERE nft_id = r.nft_id;
      t_skip := t_skip + 1;
      CONTINUE;
    END IF;

    WITH tgt AS (
      SELECT sa.id, sa.edition_id FROM public.sales sa JOIN public.editions e ON e.id = sa.edition_id
       WHERE sa.collection_id = c_ts AND sa.nft_id = r.nft_id
         AND split_part(e.external_id, '::', 1) <> r.ckpt_base
    ), lg AS (
      INSERT INTO flowty_archive.audit_20261009_173_rekeys (tbl, key, nft_id, old_value, new_value)
      SELECT 'sales', tgt.id::text, r.nft_id, tgt.edition_id::text, v_ed::text FROM tgt
    ), up AS (
      UPDATE public.sales sa SET edition_id = v_ed FROM tgt WHERE sa.id = tgt.id RETURNING 1
    )
    SELECT count(*) INTO v_s FROM up;

    WITH tgt AS (
      SELECT mo.id, mo.edition_id, mo.serial_number FROM public.moments mo JOIN public.editions e ON e.id = mo.edition_id
       WHERE mo.collection_id = c_ts AND mo.nft_id = r.nft_id
         AND split_part(e.external_id, '::', 1) <> r.ckpt_base
    ), ok AS (
      SELECT tgt.* FROM tgt
       WHERE NOT EXISTS (SELECT 1 FROM public.moments o
                          WHERE o.edition_id = v_ed AND o.serial_number IS NOT DISTINCT FROM tgt.serial_number
                            AND o.id <> tgt.id)
    ), lg AS (
      INSERT INTO flowty_archive.audit_20261009_173_rekeys (tbl, key, nft_id, old_value, new_value)
      SELECT 'moments', ok.id::text, r.nft_id, ok.edition_id::text, v_ed::text FROM ok
    ), up AS (
      UPDATE public.moments mo SET edition_id = v_ed FROM ok WHERE mo.id = ok.id RETURNING 1
    )
    SELECT (SELECT count(*) FROM up), (SELECT count(*) FROM tgt) - (SELECT count(*) FROM ok) INTO v_m, v_mskip;

    WITH tgt AS (
      SELECT w.id, w.edition_key FROM public.wallet_moments_cache w
       WHERE w.collection_id = c_ts AND w.moment_id = r.nft_id
         AND split_part(w.edition_key, '::', 1) <> r.ckpt_base
    ), lg AS (
      INSERT INTO flowty_archive.audit_20261009_173_rekeys (tbl, key, nft_id, old_value, new_value)
      SELECT 'wmc', tgt.id::text, r.nft_id, tgt.edition_key, v_ext FROM tgt
    ), up AS (
      -- the edition-derived fields came from the wrong edition: copied from the right one; the FMV
      -- (refresh_wmc_fmv_changed, every 10 min) and the image (its fill lane) are cleared to re-derive
      UPDATE public.wallet_moments_cache w
         SET edition_key = v_ext, tier = e.tier::text, set_name = e.set_name, series_number = e.series,
             mint_count = e.circulation_count, player_name = coalesce(e.player_name, w.player_name),
             team_name = coalesce(e.team_name, w.team_name), edition_name = NULL,
             fmv_usd = NULL, fmv_confidence = NULL, image_url = NULL
        FROM tgt, public.editions e
       WHERE w.id = tgt.id AND e.id = v_ed
      RETURNING 1
    )
    SELECT count(*) INTO v_w FROM up;

    UPDATE flowty_archive.audit_20261009_173_conflicts
       SET fixed_at = clock_timestamp(),
           outcome = jsonb_build_object('edition', v_ext, 'sales', v_s, 'moments', v_m,
                                        'moments_skipped_serial_taken', v_mskip, 'wmc', v_w)
     WHERE nft_id = r.nft_id;
    t_s := t_s + v_s; t_m := t_m + v_m; t_w := t_w + v_w; t_mskip := t_mskip + v_mskip;
  END LOOP;

  RETURN jsonb_build_object('nfts', t_nfts, 'sales', t_s, 'moments', t_m, 'wmc', t_w,
                            'skipped', t_skip, 'moments_skipped_serial_taken', t_mskip,
                            'remaining', (SELECT count(*) FROM flowty_archive.audit_20261009_173_conflicts WHERE fixed_at IS NULL));
END;
$function$;
-- <<< END verbatim fix_173_rekey_batch <<<

-- checkpoints: 101 = 2:89 at three sporks; 102 = 5:5; 103 sporks disagree; 104 none
INSERT INTO public.checkpoint_nft_meta (spork, c, nft_id, a, b) VALUES
  (25, 'ts', 101, 2, 89), (26, 'ts', 101, 2, 89), (28, 'ts', 101, 2, 89),
  (28, 'ts', 102, 5, 5),
  (25, 'ts', 103, 7, 1), (28, 'ts', 103, 7, 2),
  (28, 'ts', 105, 3, 3), (28, 'ts', 106, 4, 4), (28, 'ts', 107, 6, 6),
  (28, 'tssub', 101, 0, 0);

DO $t$
DECLARE v jsonb; ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  e_wrong uuid; e_right uuid; e_right_par uuid; e_other uuid; e_taken uuid;
BEGIN
  -- claims 1-3: the trigger
  INSERT INTO public.topshot_moment_subeditions VALUES ('101', '51:1804', NULL, NULL);
  PERFORM _assert_eq((SELECT base_external_id FROM public.topshot_moment_subeditions WHERE nft_id = '101'), '2:89',
    'claim 1: a disagreeing base is replaced on INSERT');
  INSERT INTO public.topshot_moment_subeditions VALUES ('102', '5:5', NULL, NULL), ('103', '9:9', NULL, NULL),
    ('104', '8:8', NULL, NULL), ('abc', '1:1', NULL, NULL);
  PERFORM _assert_eq((SELECT string_agg(nft_id || '=' || base_external_id, ',' ORDER BY nft_id) FROM public.topshot_moment_subeditions
                       WHERE nft_id IN ('102', '103', '104', 'abc')), '102=5:5,103=9:9,104=8:8,abc=1:1',
    'claims 1-2: agreeing base kept; spork disagreement, no checkpoint, non-numeric id untouched');
  UPDATE public.topshot_moment_subeditions SET base_external_id = '99:99' WHERE nft_id = '101';
  PERFORM _assert_eq((SELECT base_external_id FROM public.topshot_moment_subeditions WHERE nft_id = '101'), '2:89',
    'claim 1: a disagreeing base is replaced on UPDATE of the base');
  ALTER TABLE public.topshot_moment_subeditions DISABLE TRIGGER trg_topshot_subedition_base_from_checkpoint;
  INSERT INTO public.topshot_moment_subeditions VALUES ('105', '90:1', NULL, NULL), ('106', '90:2', 7, NULL), ('107', '90:3', 0, NULL);
  ALTER TABLE public.topshot_moment_subeditions ENABLE TRIGGER trg_topshot_subedition_base_from_checkpoint;
  UPDATE public.topshot_moment_subeditions SET subedition_id = 0, resolved_at = now() WHERE nft_id = '105';
  PERFORM _assert_eq((SELECT base_external_id FROM public.topshot_moment_subeditions WHERE nft_id = '105'), '90:1',
    'claim 3: the subedition apply (base untouched) does not fire the trigger');
  UPDATE public.topshot_moment_subeditions SET subedition_id = NULL WHERE nft_id = '105';

  -- claim 4: the one-off re-key. 105 (sub 0 -> 3:3), 106 (sub 7 -> 4:4::7, missing edition),
  -- 107 (sub 0 -> 6:6), and a pre-wrong 101-style row with sub NULL
  INSERT INTO public.editions (collection_id, external_id, tier, set_name, series, circulation_count, player_name, team_name) VALUES
    (ts, '90:1', 'RARE', 'Wrong Set', 9, 99, 'Same Player', 'Team'),
    (ts, '3:3', 'COMMON', 'Right Set', 2, 1000, 'Same Player', 'Team'),
    (ts, '90:3', 'RARE', 'Wrong Set B', 9, 50, 'P7', 'T7'),
    (ts, '6:6', 'COMMON', 'Right Set B', 3, 500, 'P7', 'T7');
  SELECT id INTO e_wrong FROM public.editions WHERE external_id = '90:1';
  SELECT id INTO e_right FROM public.editions WHERE external_id = '3:3';
  SELECT id INTO e_other FROM public.editions WHERE external_id = '90:3';
  SELECT id INTO e_taken FROM public.editions WHERE external_id = '6:6';
  UPDATE public.topshot_moment_subeditions SET subedition_id = 0 WHERE nft_id = '105';
  INSERT INTO public.sales (collection_id, nft_id, edition_id) VALUES (ts, '105', e_wrong), (ts, '105', e_wrong), (ts, '105', e_right),
    (ts, '107', e_other);
  INSERT INTO public.moments (collection_id, nft_id, edition_id, serial_number) VALUES (ts, '105', e_wrong, 12),
    (ts, '107', e_other, 4), (ts, 'X', e_taken, 4);
  INSERT INTO public.wallet_moments_cache (collection_id, moment_id, edition_key, tier, set_name, series_number, mint_count, fmv_usd, fmv_confidence, image_url)
    VALUES (ts, '105', '90:1', 'RARE', 'Wrong Set', 9, 99, 50, 'HIGH', 'img');

  PERFORM _assert_eq((SELECT sum(c)::text FROM (SELECT public.audit_173_collect(0, 1000) c) z), '3',
    'collect: the three table rows on a wrong base (105, 106, 107); 101-104 agree or are unprovable');
  PERFORM _assert_eq((SELECT string_agg(nft_id || '>' || ckpt_base, ',' ORDER BY nft_id) FROM flowty_archive.audit_20261009_173_conflicts),
    '105>3:3,106>4:4,107>6:6', 'collect: the checkpoint base per conflict');

  v := public.fix_173_rekey_batch(10);
  PERFORM _assert_eq((v->>'nfts') || '/' || (v->>'sales') || '/' || (v->>'moments') || '/' || (v->>'wmc') || '/' || (v->>'skipped')
                     || '/' || (v->>'moments_skipped_serial_taken') || '/' || (v->>'remaining'),
    '3/3/1/1/1/1/0', 'claim 4: 3 nfts, 3 sales + 1 moment + 1 wmc re-keyed, 106 skipped, 107 moment serial taken');
  PERFORM _assert_eq((SELECT string_agg(base_external_id, ',' ORDER BY nft_id) FROM public.topshot_moment_subeditions WHERE nft_id IN ('105','106','107')),
    '3:3,4:4,6:6', 'claim 4: the table rows now carry the checkpoint base');
  PERFORM _assert((SELECT count(*) = 3 FROM public.sales WHERE nft_id = '105' AND edition_id = e_right), 'claim 4: every 105 sale is on 3:3');
  PERFORM _assert((SELECT edition_id = e_taken FROM public.sales WHERE nft_id = '107'), 'claim 4: 107 sale re-keyed to 6:6');
  PERFORM _assert((SELECT edition_id = e_right FROM public.moments WHERE nft_id = '105'), 'claim 4: 105 moment re-keyed');
  PERFORM _assert((SELECT edition_id = e_other FROM public.moments WHERE nft_id = '107'), 'claim 4: 107 moment left where (6:6, #4) is taken');
  PERFORM _assert_eq((SELECT edition_key || '|' || tier || '|' || set_name || '|' || series_number || '|' || mint_count || '|'
                             || coalesce(fmv_usd::text, 'null') || '|' || coalesce(fmv_confidence, 'null') || '|' || coalesce(image_url, 'null')
                        FROM public.wallet_moments_cache WHERE moment_id = '105'),
    '3:3|COMMON|Right Set|2|1000|null|null|null', 'claim 4: wmc re-keyed, fields from the right edition, FMV and image cleared');
  PERFORM _assert_eq((SELECT count(*)::text FROM flowty_archive.audit_20261009_173_rekeys), '5', 'claim 4: every changed row is logged');
  PERFORM _assert((SELECT count(*) = 2 FROM flowty_archive.audit_20261009_173_rekeys WHERE tbl = 'sales' AND old_value = e_wrong::text AND nft_id = '105'),
    'claim 4: the log keeps the old edition (only the two wrong 105 sales, not the right one)');
  PERFORM _assert_eq((SELECT outcome->>'skipped' FROM flowty_archive.audit_20261009_173_conflicts WHERE nft_id = '106'), 'no edition 4:4::7',
    'claim 4: a missing target edition is skipped with the reason');
  v := public.fix_173_rekey_batch(10);
  PERFORM _assert_eq(v->>'nfts', '0', 'claim 4: a second batch does nothing');
END
$t$;

SELECT '✓ topshot_checkpoint_base / trg_topshot_subedition_base_from_checkpoint / fix_173_rekey_batch: all assertions passed' AS result;

ROLLBACK;
