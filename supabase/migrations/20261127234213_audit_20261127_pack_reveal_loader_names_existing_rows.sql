-- audit_20261127_pack_reveal_loader_names_existing_rows
--
-- 2026-11-27 (PT, ~4:10 PM; Claude Code cloud; Trevor: "Keep going ... leaving nothing unresolved").
--
-- WHY: load_pack_reveal_import() (20261127205829) inserted pulls ON CONFLICT DO NOTHING. 4,645 pulls
-- already sit in pack_open_pulls UNNAMED for packs opened before 2025-10-14 (3,133 All Day ids Atlas
-- does not know -- asked 11-27, 2,885 answered with nothing -- and 1,460 Top Shot, where no live node
-- can read the rip block). Those are exactly the rows the 12-14 Dune read names; DO NOTHING would have
-- thrown the edition away.
--
-- WHAT: md5-asserted splice -- the pulls insert becomes ON CONFLICT (collection_id, pack_nft_id, nft_id)
-- DO UPDATE SET the edition, resolved_via and resolved_at, only WHERE the existing row is unnamed and the
-- import carries an edition. A named row is never overwritten.
--
-- REVERT: re-apply load_pack_reveal_import from 20261127205829 (prosrc md5 3148fea6807789efdf024f66cb20fc86).

DO $mig$
DECLARE
  v_src text; v_new text;
  c_anchor constant text := E'     WHERE p.item_kind = ''moment'' AND p.opener_address IS NOT NULL\n    ON CONFLICT DO NOTHING\n    RETURNING edition_id';
  c_new    constant text := E'     WHERE p.item_kind = ''moment'' AND p.opener_address IS NOT NULL\n    -- 11-27: an existing UNNAMED row takes the import''s edition; a named row is never overwritten\n    ON CONFLICT (collection_id, pack_nft_id, nft_id) DO UPDATE\n      SET edition_id = EXCLUDED.edition_id, resolved_via = EXCLUDED.resolved_via, resolved_at = now()\n      WHERE public.pack_open_pulls.edition_id IS NULL AND EXCLUDED.edition_id IS NOT NULL\n    RETURNING edition_id';
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'load_pack_reveal_import';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'load_pack_reveal_import() not found';
  END IF;
  IF md5(v_src) <> '3148fea6807789efdf024f66cb20fc86' THEN
    RAISE EXCEPTION 'base drifted: prosrc md5 %', md5(v_src);
  END IF;
  IF (length(v_src) - length(replace(v_src, c_anchor, ''))) / length(c_anchor) <> 1 THEN
    RAISE EXCEPTION 'anchor not unique';
  END IF;
  v_new := replace(v_src, c_anchor, c_new);
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.load_pack_reveal_import() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''public'', ''pg_temp'' AS $f$%s$f$',
    v_new);
END
$mig$;

REVOKE ALL ON FUNCTION public.load_pack_reveal_import() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_pack_reveal_import() TO service_role;
