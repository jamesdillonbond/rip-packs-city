-- audit_20261009_173b_checkpoint_verified_rows_follow_their_edition
--
-- 2026-10-09 ~2:13 PM PT (Claude Code, cloud). Follow-up to known-issues #173. Trevor: "Keep going and do
-- all you can. Make decisions based upon what's best for RPC long term and for our users."
--
-- MEASURED (10-09 ~2:10 PM PT). #173 corrected the topshot_moment_subeditions rows whose BASE disagreed with
-- the checkpoint and re-keyed those nfts' rows. A second population was outside its conflict set: the
-- table row is RIGHT, but a sales / moments / wallet_moments_cache row of the same nft sits on another
-- edition (another base, or the base when the nft is a ::N parallel). Of every such row, the ones the
-- chain can VERIFY -- topshot_checkpoint_base(nft) equals the table's base AND the checkpoint's 'tssub'
-- records name exactly the table's subedition (none for a base nft) -- are: 77 sales, 68 moments,
-- 32 wmc rows, every target edition catalogued. The other ~7 k mismatched rows are on nfts with no
-- checkpoint record (minted after the spork-root checkpoints): which side is right there is NOT
-- verifiable from the DB, so they are left alone (a re-key on an unverified side would be a coin flip).
-- It also clears #173's last moments residue: nft 51334426 could not take 218:8212 #72 while nft
-- 51398216 (a ::16 parallel, checkpoint-verified) sat on the base; that moves to 218:8212::16 first.
--
-- RESULT (applied as 20261009211308, run ~2:15 PM PT, one call per table): moments 62, sales 71, wmc 32
-- re-keyed and logged, 0 waiting on a taken serial; the re-measure reads 0 verified mismatches left in all
-- three tables, and nft 51334426 / 51398216 sit on 218:8212 / 218:8212::16. (The 2:10 PM measure read
-- 68 / 77; 6 of each stopped mismatching before the call ran -- not attributed; the hourly remap lanes
-- write these tables.)
--
-- WHAT THIS DOES.
--   · flowty_archive.audit_20261009_173b_rekeys: the work set AND the revert log -- each verified
--     candidate is logged (old value, target) un-applied, then stamped applied_at as its row moves.
--     (Stamped, never deleted: no DELETE in the body.)
--   · fix_173b_rekey_verified(p_table): logs then re-keys the checkpoint-verified mismatched rows of ONE
--     table ('sales' | 'moments' | 'wmc'; one call each keeps each under the MCP's 60 s) to the edition
--     base or base::N. moments: a row whose (edition, serial) is taken waits, up to three passes, so a
--     row freed by an earlier move is taken in the next; the rest are returned as waiting_serial_taken.
--     wmc: the edition-derived fields are copied from the right edition, FMV and image cleared for their
--     refresh lanes (as #173). Re-callable: a logged row is not logged again; un-applied rows retry.
--
-- anon-exec: revoked (fix_173b_rekey_verified) — new one-off fn, postgres only.
--
-- REVERT (data, from the log):
--   UPDATE public.sales s SET edition_id = r.old_value::uuid FROM flowty_archive.audit_20261009_173b_rekeys r
--    WHERE r.tbl = 'sales' AND r.applied_at IS NOT NULL AND s.id::text = r.key;
--   UPDATE public.moments m SET edition_id = r.old_value::uuid FROM flowty_archive.audit_20261009_173b_rekeys r
--    WHERE r.tbl = 'moments' AND r.applied_at IS NOT NULL AND m.id::text = r.key;
--   UPDATE public.wallet_moments_cache w SET edition_key = r.old_value FROM flowty_archive.audit_20261009_173b_rekeys r
--    WHERE r.tbl = 'wmc' AND r.applied_at IS NOT NULL AND w.id::text = r.key;   -- (the cleared fields refill from the lanes)

CREATE TABLE IF NOT EXISTS flowty_archive.audit_20261009_173b_rekeys (
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
REVOKE ALL ON flowty_archive.audit_20261009_173b_rekeys FROM PUBLIC, anon, authenticated;

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

REVOKE ALL ON FUNCTION public.fix_173b_rekey_verified(text) FROM PUBLIC, anon, authenticated;
