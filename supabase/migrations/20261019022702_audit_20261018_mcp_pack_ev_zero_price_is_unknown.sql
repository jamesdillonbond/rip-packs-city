-- audit_20261018_mcp_pack_ev_zero_price_is_unknown
--
-- WHY: 20261019002658 stopped compute_pack_ev_from_pool calling an unpriced pack +EV, but its only
-- DB caller, mcp_compute_pack_ev (the MCP proxy's compute_pack_ev tool), reads
-- nullif(metadata->>'retail_price_usd','')::numeric — and that string is '0' on 1,337 dists, so the
-- price arrives as 0, not NULL. No 'pack_price_missing_from_metadata' gap is raised, and the answer
-- is now a confident "is_positive_ev: false, pack_price: 0, gaps: []" for a pack whose price is
-- UNKNOWN (the earlier migration's own header calls a 0 price unknown). Found by a read-only review
-- of the session's commits, 10-18 ~7:30 PM PT.
--
-- HOW: a zero price is treated as missing, so it takes the existing gap path
-- (pack_price_missing_from_metadata + ev_skipped_missing_inputs, ev NULL). A one-anchor splice of
-- the live body, guarded on md5(prosrc) and on the anchor occurring exactly once; same signature,
-- so ACLs, SECURITY INVOKER/DEFINER and search_path are kept.
-- anon-exec: intentional — unchanged by this migration; CREATE OR REPLACE with the same signature keeps the existing grants (mcp_compute_pack_ev)
--
-- POST-APPLY (10-18 ~7:29 PM PT): md5(prosrc) aaf7ca4088e231aa2207666f75c4e964; SECURITY DEFINER,
-- ACL {postgres,service_role} and search_path=public unchanged. Probe: dist 1090 (price '0', slots present)
-- was gaps [] / pack_price 0 / is_positive_ev false / pack_ev 15.52 -> now gaps
-- [pack_price_missing_from_metadata, ev_skipped_missing_inputs], ev null. Control dist 0 ($99.99) unchanged.
-- REVERT: the same DO block with v_old/v_new swapped, guarded on md5 aaf7ca4088e231aa2207666f75c4e964.
DO $$
DECLARE
  v_oid oid;
  v_m text;
  v_src text;
  v_def text;
  v_old constant text := 'v_pack_price := nullif(v_pd.metadata->>''retail_price_usd'','''')::numeric;';
  v_new constant text := 'v_pack_price := nullif(nullif(v_pd.metadata->>''retail_price_usd'','''')::numeric, 0);';
BEGIN
  SELECT p.oid, md5(p.prosrc), p.prosrc INTO v_oid, v_m, v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'mcp_compute_pack_ev';
  IF v_oid IS NULL THEN RAISE EXCEPTION 'mcp_compute_pack_ev not found'; END IF;
  IF v_m <> 'e1c24fb006eab6cad7f499f53d3cffb8' THEN
    RAISE EXCEPTION 'mcp_compute_pack_ev body drifted (md5 %): re-read before splicing', v_m;
  END IF;
  IF (length(v_src) - length(replace(v_src, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'anchor does not occur exactly once';
  END IF;
  v_def := pg_get_functiondef(v_oid);
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'anchor not exactly once in functiondef';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END
$$;
