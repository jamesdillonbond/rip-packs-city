-- audit_20261009_topshot_subedition_base_follows_the_checkpoint
--
-- 2026-10-09 ~1:35 PM PT (Claude Code, cloud). known-issues #173. Trevor: "Keep going and do all you can.
-- Make decisions based upon what's best for RPC long term and for our users."
--
-- MEASURED (known-issues #173, re-measured 10-09): 1,853 of the 692,782 topshot_moment_subeditions rows
-- that have a Top Shot checkpoint record carry a base_external_id (setID:playID) different from the
-- chain's; on every one, all checkpoint sporks agree with each other. The five seed_topshot_*_targets
-- functions copy the base from an existing sales / moments / wmc row and the chain read
-- (apply_topshot_subeditions) only fills subedition_id, so a conflation already in sales flows into this
-- table and, through seven remap functions, back out. Downstream for those 1,853 nfts: 1,375 sales,
-- 849 moments, 156 wallet_moments_cache rows on the wrong edition (2,199 sales already right).
--
-- WHAT THIS DOES.
--   · topshot_checkpoint_base(nft_id): the chain's setID:playID for a Top Shot nft from
--     checkpoint_nft_meta (c='ts') -- ONLY when every spork record agrees; NULL otherwise (no record,
--     a non-numeric id, or a disagreement). An nft's set and play never change on chain.
--   · Trigger on topshot_moment_subeditions (BEFORE INSERT OR UPDATE OF base_external_id, SECURITY
--     DEFINER so every writer role can read the checkpoint): a base that
--     disagrees with topshot_checkpoint_base is replaced by it. One guard for every writer (the five
--     seeds, backfill-topshot-subeditions, the drain route); rows with no checkpoint are untouched.
--   · flowty_archive.audit_20261009_173_conflicts: the conflict set, collected in nft-id slices by
--     audit_173_collect(lo, hi) (one call per slice keeps each under the MCP's 60 s).
--   · flowty_archive.audit_20261009_173_rekeys: every value fix_173_rekey_batch changes, old and new,
--     per table and row -- the revert log.
--   · fix_173_rekey_batch(limit): for each collected conflict, sets the table base (through the
--     trigger), then re-keys that nft's Top Shot sales / moments rows whose edition base differs to the
--     checkpoint edition (base, or base::N when subedition_id = N > 0), and re-keys its wmc rows
--     (edition_key): the edition-derived fields are copied from the right edition, the FMV and image
--     are cleared for their refresh lanes. Skips (and counts) an nft whose target edition does not
--     exist, a NULL subedition_id, or a moments row whose (edition, serial) is already taken.
--
-- anon-exec: revoked (topshot_checkpoint_base) — new fn; trigger + one-off helpers only.
-- anon-exec: revoked (trg_topshot_subedition_base_from_checkpoint) — new trigger fn.
-- anon-exec: revoked (audit_173_collect) — new one-off fn, postgres only.
-- anon-exec: revoked (fix_173_rekey_batch) — new one-off fn, postgres only.
--
-- REVERT (data, newest first, from the log):
--   UPDATE public.sales s SET edition_id = r.old_value::uuid FROM flowty_archive.audit_20261009_173_rekeys r
--    WHERE r.tbl = 'sales' AND s.id::text = r.key;
--   UPDATE public.moments m SET edition_id = r.old_value::uuid FROM flowty_archive.audit_20261009_173_rekeys r
--    WHERE r.tbl = 'moments' AND m.id::text = r.key;
--   UPDATE public.wallet_moments_cache w SET edition_key = r.old_value FROM flowty_archive.audit_20261009_173_rekeys r
--    WHERE r.tbl = 'wmc' AND w.id::text = r.key;   -- (the cleared fields refill from the lanes)
--   DROP TRIGGER trg_topshot_subedition_base_from_checkpoint ON public.topshot_moment_subeditions;
--   UPDATE public.topshot_moment_subeditions t SET base_external_id = c.old_base
--     FROM flowty_archive.audit_20261009_173_conflicts c WHERE t.nft_id = c.nft_id;
-- (reverting restores the 1,375 mispriced sales -- revert only to undo a defect.)

CREATE TABLE IF NOT EXISTS flowty_archive.audit_20261009_173_conflicts (
  nft_id         text PRIMARY KEY,
  old_base       text NOT NULL,
  ckpt_base      text NOT NULL,
  subedition_id  smallint,
  collected_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  fixed_at       timestamptz,
  outcome        jsonb
);
CREATE TABLE IF NOT EXISTS flowty_archive.audit_20261009_173_rekeys (
  tbl        text NOT NULL,
  key        text NOT NULL,
  nft_id     text NOT NULL,
  old_value  text,
  new_value  text,
  at         timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON flowty_archive.audit_20261009_173_conflicts, flowty_archive.audit_20261009_173_rekeys
  FROM PUBLIC, anon, authenticated;

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

CREATE TRIGGER trg_topshot_subedition_base_from_checkpoint
  BEFORE INSERT OR UPDATE OF base_external_id ON public.topshot_moment_subeditions
  FOR EACH ROW EXECUTE FUNCTION public.trg_topshot_subedition_base_from_checkpoint();

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

REVOKE ALL ON FUNCTION public.topshot_checkpoint_base(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_topshot_subedition_base_from_checkpoint() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.audit_173_collect(bigint, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fix_173_rekey_batch(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.topshot_checkpoint_base(text) TO service_role;
