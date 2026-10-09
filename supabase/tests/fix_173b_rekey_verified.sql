-- DB invariant: the one-off public.fix_173b_rekey_verified (#173 follow-up). Claims:
--   1. a sales / moments / wmc row on an edition other than its topshot_moment_subeditions row's is
--      re-keyed to base or base::N ONLY when the chain verifies the table row: checkpoint base = its
--      base AND the checkpoint's 'tssub' records are exactly its subedition (none for a base nft);
--   2. no checkpoint, a subedition the checkpoint disagrees with, or an uncatalogued target edition
--      leaves the row untouched and unlogged; a row already on its edition is not a candidate;
--   3. moments: a taken (edition, serial) waits; a row freed by an earlier move in the same call is
--      taken in a later pass; one still blocked is counted as waiting_serial_taken;
--   4. wmc: edition fields copied from the right edition, FMV and image cleared;
--   5. every candidate is logged with its old value and stamped applied_at when it moves; a second
--      call logs and moves nothing new.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20261009211308_audit_20261009_173b_checkpoint_verified_rows_follow_their_edition.sql).
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
CREATE TABLE flowty_archive.audit_20261009_173b_rekeys (
  tbl         text NOT NULL,
  key         text NOT NULL,
  nft_id      text NOT NULL,
  old_value   text,
  new_value   text,
  new_ed      uuid,
  serial      bigint,
  at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  applied_at  timestamptz,
  PRIMARY KEY (tbl, key)
);

-- the pinned checkpoint helper (pinned verbatim in topshot_subedition_base_from_checkpoint.sql)
CREATE OR REPLACE FUNCTION public.topshot_checkpoint_base(p_nft_id text)
 RETURNS text LANGUAGE sql STABLE SET search_path TO 'public'
AS $h$
  SELECT CASE WHEN count(DISTINCT (c.a, c.b)) = 1 THEN min(c.a::text || ':' || c.b::text) END
    FROM public.checkpoint_nft_meta c
   WHERE p_nft_id ~ '^[0-9]{1,18}$'
     AND c.c = 'ts' AND c.nft_id = p_nft_id::bigint;
$h$;

-- >>> BEGIN verbatim fix_173b_rekey_verified (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.fix_173b_rekey_verified(p_table text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
DECLARE
  c_ts    constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_cand  int;
  v_n     int := 0;
  v_pass  int;
  v_step  int;
  v_skip  int := 0;
BEGIN
  IF p_table NOT IN ('sales', 'moments', 'wmc') THEN
    RAISE EXCEPTION 'fix_173b_rekey_verified: unknown table %', p_table;
  END IF;

  -- 1. candidates: rows of p_table on an edition other than their table row's, kept only where the chain
  --    verifies the table row -- the checkpoint base is its base, and the checkpoint's subedition records
  --    are exactly its subedition (none for a base nft) -- and the target edition is catalogued.
  --    Logged un-applied; a row already logged is not logged again.
  WITH mis AS (
    SELECT sa.id::text AS key, sa.nft_id, sa.edition_id::text AS old_value, NULL::bigint AS serial,
           s.base_external_id AS b, s.subedition_id AS sub
      FROM public.topshot_moment_subeditions s
      JOIN public.sales sa ON sa.nft_id = s.nft_id AND sa.collection_id = c_ts
      JOIN public.editions e ON e.id = sa.edition_id
     WHERE p_table = 'sales' AND s.subedition_id IS NOT NULL
       AND e.external_id <> s.base_external_id || CASE WHEN s.subedition_id > 0 THEN '::' || s.subedition_id ELSE '' END
    UNION ALL
    SELECT m.id::text, m.nft_id, m.edition_id::text, m.serial_number::bigint,
           s.base_external_id, s.subedition_id
      FROM public.topshot_moment_subeditions s
      JOIN public.moments m ON m.nft_id = s.nft_id AND m.collection_id = c_ts
      JOIN public.editions e ON e.id = m.edition_id
     WHERE p_table = 'moments' AND s.subedition_id IS NOT NULL
       AND e.external_id <> s.base_external_id || CASE WHEN s.subedition_id > 0 THEN '::' || s.subedition_id ELSE '' END
    UNION ALL
    SELECT w.id::text, w.moment_id, w.edition_key, NULL::bigint,
           s.base_external_id, s.subedition_id
      FROM public.topshot_moment_subeditions s
      JOIN public.wallet_moments_cache w ON w.moment_id = s.nft_id AND w.collection_id = c_ts
     WHERE p_table = 'wmc' AND s.subedition_id IS NOT NULL
       AND w.edition_key <> s.base_external_id || CASE WHEN s.subedition_id > 0 THEN '::' || s.subedition_id ELSE '' END
  ), ver AS (
    SELECT mis.*, mis.b || CASE WHEN mis.sub > 0 THEN '::' || mis.sub ELSE '' END AS tgt
      FROM mis
     WHERE mis.nft_id ~ '^[0-9]{1,18}$'
       AND public.topshot_checkpoint_base(mis.nft_id) = mis.b
       AND (SELECT coalesce(array_agg(DISTINCT c.a ORDER BY c.a), '{}'::bigint[])
              FROM public.checkpoint_nft_meta c
             WHERE c.c = 'tssub' AND c.nft_id = mis.nft_id::bigint)
           = CASE WHEN mis.sub > 0 THEN ARRAY[mis.sub::bigint] ELSE '{}'::bigint[] END
  ), ins AS (
    INSERT INTO flowty_archive.audit_20261009_173b_rekeys (tbl, key, nft_id, old_value, new_value, new_ed, serial)
    SELECT p_table, ver.key, ver.nft_id, ver.old_value,
           CASE WHEN p_table = 'wmc' THEN ver.tgt ELSE e.id::text END, e.id, ver.serial
      FROM ver JOIN public.editions e ON e.collection_id = c_ts AND e.external_id = ver.tgt
    ON CONFLICT (tbl, key) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_cand FROM ins;

  -- 2. apply the un-applied, stamping each row as it lands
  IF p_table = 'sales' THEN
    WITH up AS (
      UPDATE public.sales sa SET edition_id = r.new_ed
        FROM flowty_archive.audit_20261009_173b_rekeys r
       WHERE r.tbl = 'sales' AND r.applied_at IS NULL AND sa.id = r.key::uuid AND sa.nft_id = r.nft_id AND sa.collection_id = c_ts
      RETURNING r.key
    ), st AS (
      UPDATE flowty_archive.audit_20261009_173b_rekeys r SET applied_at = clock_timestamp()
        FROM up WHERE r.tbl = 'sales' AND r.key = up.key
      RETURNING 1
    )
    SELECT count(*) INTO v_n FROM st;
  ELSIF p_table = 'moments' THEN
    -- a row whose (edition, serial) is taken waits; a later pass takes it once an earlier move frees it
    FOR v_pass IN 1..3 LOOP
      WITH ok AS (
        SELECT r.key, r.nft_id, r.new_ed FROM flowty_archive.audit_20261009_173b_rekeys r
         WHERE r.tbl = 'moments' AND r.applied_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM public.moments o
                            WHERE o.edition_id = r.new_ed AND o.serial_number IS NOT DISTINCT FROM r.serial
                              AND o.id <> r.key::uuid)
      ), up AS (
        UPDATE public.moments mo SET edition_id = ok.new_ed FROM ok
         WHERE mo.id = ok.key::uuid AND mo.nft_id = ok.nft_id AND mo.collection_id = c_ts RETURNING ok.key
      ), st AS (
        UPDATE flowty_archive.audit_20261009_173b_rekeys r SET applied_at = clock_timestamp()
          FROM up WHERE r.tbl = 'moments' AND r.key = up.key
        RETURNING 1
      )
      SELECT count(*) INTO v_step FROM st;
      v_n := v_n + v_step;
      EXIT WHEN v_step = 0;
    END LOOP;
    SELECT count(*) INTO v_skip FROM flowty_archive.audit_20261009_173b_rekeys
     WHERE tbl = 'moments' AND applied_at IS NULL;
  ELSE
    -- the edition-derived fields are copied from the right edition; FMV and image are cleared for
    -- their refresh lanes (as #173)
    WITH up AS (
      UPDATE public.wallet_moments_cache w
         SET edition_key = r.new_value, tier = e.tier::text, set_name = e.set_name, series_number = e.series,
             mint_count = e.circulation_count, player_name = coalesce(e.player_name, w.player_name),
             team_name = coalesce(e.team_name, w.team_name), edition_name = NULL,
             fmv_usd = NULL, fmv_confidence = NULL, image_url = NULL
        FROM flowty_archive.audit_20261009_173b_rekeys r, public.editions e
       WHERE r.tbl = 'wmc' AND r.applied_at IS NULL AND w.id = r.key::uuid AND w.moment_id = r.nft_id AND w.collection_id = c_ts
         AND e.id = r.new_ed
      RETURNING r.key
    ), st AS (
      UPDATE flowty_archive.audit_20261009_173b_rekeys r SET applied_at = clock_timestamp()
        FROM up WHERE r.tbl = 'wmc' AND r.key = up.key
      RETURNING 1
    )
    SELECT count(*) INTO v_n FROM st;
  END IF;

  RETURN jsonb_build_object('table', p_table, 'candidates_logged', v_cand, 'rekeyed', v_n,
                            'waiting_serial_taken', v_skip);
END;
$function$;
-- <<< END verbatim fix_173b_rekey_verified <<<

-- 201 = 10:10::5 (verified parallel); 202 = 20:20 base; 203 = 20:20::16; 205: checkpoint says ::3, table says 0;
-- 206 = 50:50 (uncatalogued); 207 = 70:70 (already right); 208 = 60:60 (serial held by another nft); 204: no checkpoint
INSERT INTO public.checkpoint_nft_meta (spork, c, nft_id, a, b) VALUES
  (28, 'ts', 201, 10, 10), (28, 'tssub', 201, 5, NULL),
  (25, 'ts', 202, 20, 20), (28, 'ts', 202, 20, 20),
  (28, 'ts', 203, 20, 20), (28, 'tssub', 203, 16, NULL),
  (28, 'ts', 205, 40, 40), (28, 'tssub', 205, 3, NULL),
  (28, 'ts', 206, 50, 50), (28, 'ts', 207, 70, 70), (28, 'ts', 208, 60, 60);

DO $t$
DECLARE v jsonb; ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  e_wrong uuid; e_1010 uuid; e_1010p uuid; e_2020 uuid; e_2020p uuid; e_3030 uuid; e_4040 uuid; e_6060 uuid; e_6161 uuid; e_7070 uuid;
BEGIN
  INSERT INTO public.topshot_moment_subeditions VALUES ('201', '10:10', 5, now()), ('202', '20:20', 0, now()), ('203', '20:20', 16, now()),
    ('204', '80:80', 0, now()), ('205', '40:40', 0, now()), ('206', '50:50', 0, now()), ('207', '70:70', 0, now()), ('208', '60:60', 0, now());
  INSERT INTO public.editions (collection_id, external_id, tier, set_name, series, circulation_count, player_name, team_name) VALUES
    (ts, '99:1', 'RARE', 'Wrong Set', 9, 99, 'Other', 'Other'), (ts, '10:10', 'COMMON', 'Base', 2, 1000, 'P', 'T'),
    (ts, '10:10::5', 'RARE', 'Parallel', 2, 50, 'P', 'T'), (ts, '20:20', 'COMMON', 'B2', 2, 100, 'Q', 'U'),
    (ts, '20:20::16', 'RARE', 'P2', 2, 99, 'Q', 'U'), (ts, '30:30', 'COMMON', 'W3', 2, 100, 'Q', 'U'),
    (ts, '40:40', 'COMMON', 'B4', 2, 100, 'R', 'V'), (ts, '60:60', 'COMMON', 'B6', 2, 10, 'S', 'W'),
    (ts, '61:61', 'COMMON', 'W6', 2, 10, 'S', 'W'), (ts, '70:70', 'COMMON', 'B7', 2, 10, 'X', 'Y'),
    (ts, '80:80', 'COMMON', 'B8', 2, 10, 'N', 'C');   -- 204's target IS catalogued: only its missing checkpoint holds it back
  SELECT id INTO e_wrong FROM public.editions WHERE external_id = '99:1';
  SELECT id INTO e_1010 FROM public.editions WHERE external_id = '10:10';
  SELECT id INTO e_1010p FROM public.editions WHERE external_id = '10:10::5';
  SELECT id INTO e_2020 FROM public.editions WHERE external_id = '20:20';
  SELECT id INTO e_2020p FROM public.editions WHERE external_id = '20:20::16';
  SELECT id INTO e_3030 FROM public.editions WHERE external_id = '30:30';
  SELECT id INTO e_4040 FROM public.editions WHERE external_id = '40:40';
  SELECT id INTO e_6060 FROM public.editions WHERE external_id = '60:60';
  SELECT id INTO e_6161 FROM public.editions WHERE external_id = '61:61';
  SELECT id INTO e_7070 FROM public.editions WHERE external_id = '70:70';

  INSERT INTO public.sales (collection_id, nft_id, edition_id) VALUES
    (ts, '201', e_wrong), (ts, '204', e_wrong), (ts, '205', e_wrong), (ts, '206', e_wrong), (ts, '207', e_7070);
  INSERT INTO public.moments (collection_id, nft_id, edition_id, serial_number) VALUES
    (ts, '201', e_1010, 7),           -- a ::5 parallel flattened onto its base
    (ts, '202', e_3030, 72),          -- wrong base; its (20:20, #72) is held by 203 until 203 moves
    (ts, '203', e_2020, 72),          -- a ::16 parallel sitting on the base
    (ts, '208', e_6161, 1),           -- wrong base; (60:60, #1) is held by another nft for good
    (ts, 'Z', e_6060, 1);
  INSERT INTO public.wallet_moments_cache (collection_id, moment_id, edition_key, tier, set_name, series_number, mint_count, fmv_usd, fmv_confidence, image_url)
    VALUES (ts, '201', '10:10', 'COMMON', 'Base', 2, 1000, 3, 'HIGH', 'img'), (ts, '205', '99:1', 'RARE', 'Wrong Set', 9, 99, 5, 'LOW', 'img');

  v := public.fix_173b_rekey_verified('sales');
  PERFORM _assert_eq((v->>'candidates_logged') || '/' || (v->>'rekeyed'), '1/1',
    'claims 1-2: only the verified 201 sale moves; 204 (no checkpoint), 205 (tssub disagrees), 206 (uncatalogued), 207 (right) do not');
  PERFORM _assert((SELECT edition_id = e_1010p FROM public.sales WHERE nft_id = '201'), 'claim 1: 201 sale is on 10:10::5');
  PERFORM _assert((SELECT count(*) = 3 FROM public.sales WHERE nft_id IN ('204', '205', '206') AND edition_id = e_wrong),
    'claim 2: the unverifiable sales are untouched');

  v := public.fix_173b_rekey_verified('moments');
  PERFORM _assert_eq((v->>'candidates_logged') || '/' || (v->>'rekeyed') || '/' || (v->>'waiting_serial_taken'), '4/3/1',
    'claim 3: 201, 203 then 202 move (202 in a later pass, once 203 frees 20:20 #72); 208 waits');
  PERFORM _assert_eq((SELECT string_agg(m.nft_id || '>' || e.external_id, ',' ORDER BY m.nft_id) FROM public.moments m JOIN public.editions e ON e.id = m.edition_id),
    '201>10:10::5,202>20:20,203>20:20::16,208>61:61,Z>60:60', 'claim 3: each moment on its edition; 208 left where its serial is held');

  v := public.fix_173b_rekey_verified('wmc');
  PERFORM _assert_eq((v->>'candidates_logged') || '/' || (v->>'rekeyed'), '1/1', 'claim 4: the verified 201 wmc row moves; 205 does not');
  PERFORM _assert_eq((SELECT edition_key || '|' || tier || '|' || set_name || '|' || mint_count || '|'
                             || coalesce(fmv_usd::text, 'null') || '|' || coalesce(fmv_confidence, 'null') || '|' || coalesce(image_url, 'null')
                        FROM public.wallet_moments_cache WHERE moment_id = '201'),
    '10:10::5|RARE|Parallel|50|null|null|null', 'claim 4: wmc fields from the right edition, FMV and image cleared');
  PERFORM _assert_eq((SELECT edition_key FROM public.wallet_moments_cache WHERE moment_id = '205'), '99:1', 'claim 2: the unverified wmc row is untouched');

  PERFORM _assert_eq((SELECT count(*)::text || '/' || count(applied_at)::text FROM flowty_archive.audit_20261009_173b_rekeys), '6/5',
    'claim 5: six candidates logged, five applied, 208 waiting');
  PERFORM _assert((SELECT old_value = e_wrong::text AND new_value = e_1010p::text FROM flowty_archive.audit_20261009_173b_rekeys
                    WHERE tbl = 'sales' AND nft_id = '201'), 'claim 5: the log keeps the old and new edition');
  PERFORM _assert((SELECT old_value = '10:10' AND new_value = '10:10::5' FROM flowty_archive.audit_20261009_173b_rekeys
                    WHERE tbl = 'wmc' AND nft_id = '201'), 'claim 5: the wmc log keeps the old and new key');

  v := public.fix_173b_rekey_verified('sales');
  PERFORM _assert_eq((v->>'candidates_logged') || '/' || (v->>'rekeyed'), '0/0', 'claim 5: a second sales call does nothing');
  v := public.fix_173b_rekey_verified('moments');
  PERFORM _assert_eq((v->>'candidates_logged') || '/' || (v->>'rekeyed') || '/' || (v->>'waiting_serial_taken'), '0/0/1',
    'claim 5: a second moments call logs nothing new and 208 still waits');
END
$t$;

SELECT '✓ fix_173b_rekey_verified: all assertions passed' AS result;

ROLLBACK;
