-- audit_20260928_pinnacle_top_sales_named_by_render
--
-- get_collection_stats('disney_pinnacle').top_sales named every sale through
-- pinnacle_editions ON edition_key = ps.edition_id. pinnacle_editions is
-- SET-LEVEL (one character per key) and its key matches no pin, so the join
-- landed on an arbitrary character from the same set: live 2026-09-28 all 5 of
-- the Overview's "Top Sales (24h)" rows carried the wrong name (a $179 Darth Maul
-- sale read "Sebulba", a $165 Kaa read "Bagheera", a $135 King Triton read
-- "Harold the Merman").
--
-- A sale's pin is ps.render_id, and pinnacle_catalog is one row per render_id,
-- so joining there is exact and cannot fan out. 15 of 5,640 sales in the last
-- 30 days carry no render_id; they now come back unnamed and the Overview
-- discloses them ("N more sales … not yet matched") instead of mislabelling.
-- Also sends set_name and total_minted so the row reads like every other
-- collection's (tier · set · #serial/mint).
--
-- Splice, not a full-body rewrite: the body is asserted by md5 first.
-- Revert: re-run with v_old/v_new swapped against md5 of the post-splice body.

DO $splice$
DECLARE
  v_oid oid;
  v_def text;
  v_old text;
  v_new text;
  v_n int;
BEGIN
  SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_collection_stats'
     AND pg_get_function_identity_arguments(p.oid) = 'p_slug text';
  IF v_oid IS NULL THEN RAISE EXCEPTION 'get_collection_stats(text) missing'; END IF;
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = v_oid)) <> 'dcf3dccbade72e633df508da0cb25220' THEN
    RAISE EXCEPTION 'get_collection_stats body drifted (md5 %)', md5((SELECT prosrc FROM pg_proc WHERE oid = v_oid));
  END IF;
  v_def := pg_get_functiondef(v_oid);

  v_old := E'  -- Top 5 recent sales (unchanged — sales are legacy-keyed; join pinnacle_editions\n'
        || E'  -- for the name at legacy grain to avoid the 26:1 catalog fan-out).\n'
        || E'  IF v_is_pinnacle THEN\n'
        || E'    SELECT jsonb_agg(t ORDER BY t.price DESC)::jsonb INTO v_top_sales\n'
        || E'    FROM (\n'
        || E'      SELECT ps.sale_price_usd AS price, ps.serial_number, ps.sold_at,\n'
        || E'             pe.character_name AS edition_name, pe.variant_type AS tier, pe.character_name\n'
        || E'      FROM pinnacle_sales ps\n'
        || E'      LEFT JOIN pinnacle_editions pe ON pe.edition_key = ps.edition_id\n';
  v_new := E'  -- Top 5 recent sales. 2026-09-28: Pinnacle names the PIN via ps.render_id →\n'
        || E'  -- pinnacle_catalog (one row per render, no fan-out). pinnacle_editions is\n'
        || E'  -- set-level and named an arbitrary character from the set.\n'
        || E'  IF v_is_pinnacle THEN\n'
        || E'    SELECT jsonb_agg(t ORDER BY t.price DESC)::jsonb INTO v_top_sales\n'
        || E'    FROM (\n'
        || E'      SELECT ps.sale_price_usd AS price, ps.serial_number, ps.sold_at,\n'
        || E'             pc.character_name AS edition_name, pc.variant AS tier, pc.character_name,\n'
        || E'             pc.set_name, pc.total_minted AS circulation_count\n'
        || E'      FROM pinnacle_sales ps\n'
        || E'      LEFT JOIN pinnacle_catalog pc ON pc.render_id = ps.render_id\n';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'anchor count % (expected 1)', v_n; END IF;
  v_def := replace(v_def, v_old, v_new);

  IF position('pinnacle_editions pe ON pe.edition_key = ps.edition_id' IN v_def) > 0 THEN
    RAISE EXCEPTION 'post-condition: the set-level join survived';
  END IF;
  EXECUTE v_def;
END
$splice$;

-- Post-flight: every named Pinnacle top sale must carry the name of the pin it
-- sold (checked against the catalog directly). RAISE (roll back) otherwise.
DO $verify$
DECLARE
  v_out jsonb; v_bad int; v_t0 timestamptz; v_ms numeric;
BEGIN
  v_t0 := clock_timestamp();
  v_out := public.get_collection_stats('disney_pinnacle');
  v_ms := extract(epoch from (clock_timestamp() - v_t0)) * 1000;
  IF v_ms > 8000 THEN RAISE EXCEPTION 'disney_pinnacle takes % ms', round(v_ms); END IF;
  SELECT count(*) INTO v_bad
  FROM jsonb_array_elements(coalesce(v_out->'top_sales', '[]'::jsonb)) s
  WHERE s->>'edition_name' IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM pinnacle_sales ps JOIN pinnacle_catalog pc ON pc.render_id = ps.render_id
      WHERE ps.sold_at > now() - interval '25 hours'
        AND ps.sale_price_usd = (s->>'price')::numeric
        AND pc.character_name = s->>'edition_name'
        AND pc.variant IS NOT DISTINCT FROM s->>'tier');
  IF v_bad > 0 THEN RAISE EXCEPTION '% top sale(s) carry a name no sale of that price has', v_bad; END IF;
  RAISE NOTICE 'disney_pinnacle % ms, % top sales', round(v_ms), jsonb_array_length(coalesce(v_out->'top_sales','[]'::jsonb));
END
$verify$;
