-- audit_20261127_sold_pack_outcomes_serial_from_reveal
--
-- 2026-11-27 (PT, ~1:50 PM; Claude Code cloud; Trevor: "work through anything still unresolved").
--
-- WHY: get_wallet_sold_pack_outcomes takes a pull's serial only from `moments`. Pulls loaded from
-- PackNFT.Revealed (pack_reveal_import, 20261127205829 -- the pre-2025-10-14 backfill scheduled for
-- 12-14) carry the serial from the mint event, and most of those moments have no `moments` row, so the
-- Sold tab would print "LeBron James · Legendary" without "#14/39".
--
-- WHAT: splice (md5-asserted base, unique anchor, transform must land): the `named` CTE falls back to
-- pack_reveal_import.serial_number for the same collection + pack + moment. Nothing else changes.
--
-- REVERT: re-apply get_wallet_sold_pack_outcomes from
--   20261127194434_audit_20261127_sold_pack_outcomes_v4_marketplace_sales.sql (prosrc md5
--   37e42cc88c2d3707394ad68fa6f6fa71).

-- NOTE: the `IF v_src IS NULL` guard was added to this file after it was applied (11-27 ~1:42 PM PT):
-- on an empty database md5(NULL) is NULL, which slipped past the base check and built a broken CREATE.
-- The applied object is identical; only a fresh replay behaves differently (it now raises).

DO $mig$
DECLARE
  v_src text; v_new text; v_args text; v_ret text;
  c_anchor constant text := E'         m.serial_number\n  FROM pulls p\n  LEFT JOIN public.moments m ON m.collection_id = p.collection_id AND m.nft_id = p.nft_id\n),';
  c_new    constant text := E'         COALESCE(m.serial_number, ri.serial_number) AS serial_number\n  FROM pulls p\n  LEFT JOIN public.moments m ON m.collection_id = p.collection_id AND m.nft_id = p.nft_id\n  -- 11-27: a pull loaded from PackNFT.Revealed carries its mint serial\n  LEFT JOIN LATERAL (SELECT i.serial_number FROM public.pack_reveal_import i\n                      WHERE i.collection_id = p.collection_id AND i.pack_nft_id = p.pack_nft_id\n                        AND i.item_kind = ''moment'' AND i.item_id = p.nft_id\n                      LIMIT 1) ri ON true\n),';
BEGIN
  SELECT p.prosrc, pg_get_function_arguments(p.oid), pg_get_function_result(p.oid) INTO v_src, v_args, v_ret
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_wallet_sold_pack_outcomes';
  IF v_src IS NULL THEN
    RAISE EXCEPTION '%() not found', 'get_wallet_sold_pack_outcomes';
  END IF;
  IF md5(v_src) <> '37e42cc88c2d3707394ad68fa6f6fa71' THEN
    RAISE EXCEPTION 'base drifted: prosrc md5 %', md5(v_src);
  END IF;
  IF (length(v_src) - length(replace(v_src, c_anchor, ''))) / length(c_anchor) <> 1 THEN
    RAISE EXCEPTION 'anchor not unique';
  END IF;
  v_new := replace(v_src, c_anchor, c_new);
  IF position('a pull loaded from PackNFT.Revealed carries its mint serial' in v_new) = 0 THEN
    RAISE EXCEPTION 'transform did not land';
  END IF;
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.get_wallet_sold_pack_outcomes(%s) RETURNS %s LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''public'', ''pg_temp'' SET statement_timeout TO ''15s'' AS $f$%s$f$',
    v_args, v_ret, v_new);
END
$mig$;

REVOKE EXECUTE ON FUNCTION public.get_wallet_sold_pack_outcomes(text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_wallet_sold_pack_outcomes(text, text[]) TO service_role;
