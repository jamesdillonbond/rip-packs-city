-- audit_20261118_pack_identity_4xx_arm_reads_atlas_base_rate
--
-- 2026-11-18 (PT, ~10:40 PM; Claude Code cloud; Trevor: "Keep going") -- #218 follow-up.
-- The pack-identity lane moved from Studio searchPackNft to Atlas PackService tonight
-- (20261119050000). Atlas sits behind Cloudflare, which challenges this egress at a ~5-15 % base
-- rate, so the lane now sees occasional 403s in normal operation. check_edge_fn_http_failures()
-- filed EVERY pack-identity 4xx as severity 'high' with Studio-era text: measured 10:35 PM PT,
-- 707 x 200 vs 4 x 403 in 2 h (0.6 %) paged "pack-nft-identity-403" HIGH. A false HIGH this
-- change created, so this change removes it.
--
-- WHAT. Splice (md5-guarded against the live body) the pack-identity arm only:
--   severity 'high' only when the lane has collected NO 200 in the last 2 h (a real outage);
--   otherwise 'info' -- the same shape as the Atlas usernames arm. Detail text names Atlas.
-- Nothing else in the function changes. Not drift-pinned (prior arms are spliced the same way).
--
-- REVERT: the same splice in reverse (severity 'high'; the old detail strings), or re-run the
-- previous body captured by md5 0c5466b3511cab4cd611e36cf4544d2e.

DO $do$
DECLARE
  v_oid oid := 'public.check_edge_fn_http_failures(interval)'::regprocedure;
  v_def text;
  v_old1 text := $o$          'severity', 'high',
          'type',     'edge_fn_http_error',
          'pipeline', 'pack-nft-identity-' || g.status_code::text,$o$;
  v_new1 text := $n$          -- 2026-11-18: Atlas challenges at a base rate; HIGH only when nothing has succeeded for 2 h.
          'severity', CASE WHEN (SELECT max(collected_at) FROM public.pack_nft_identity_requests WHERE status_code = 200) IS NULL
                             OR (SELECT max(collected_at) FROM public.pack_nft_identity_requests WHERE status_code = 200) < now() - interval '2 hours'
                           THEN 'high' ELSE 'info' END,
          'type',     'edge_fn_http_error',
          'pipeline', 'pack-nft-identity-' || g.status_code::text,$n$;
  v_old2 text := $o$' pack-identity lookup(s) to Dapper searchPackNft returned HTTP '$o$;
  v_new2 text := $n$' pack-identity lookup(s) to Dapper Atlas PackService returned HTTP '$n$;
  v_old3 text := $o$'A 4xx here means the studio-platform GraphQL host rejected the request '$o$;
  v_new3 text := $n$'Cloudflare challenges Atlas at a ~5-15 pct base rate and a challenged id is re-asked next tick, so this is info unless no 200 landed in 2 h; a HIGH means the Atlas host rejected the request '$n$;
BEGIN
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = v_oid)) <> '0c5466b3511cab4cd611e36cf4544d2e' THEN
    RAISE EXCEPTION 'check_edge_fn_http_failures changed since this splice was written';
  END IF;
  v_def := pg_get_functiondef(v_oid);
  IF (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1) <> 1
     OR (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2) <> 1
     OR (length(v_def) - length(replace(v_def, v_old3, ''))) / length(v_old3) <> 1 THEN
    RAISE EXCEPTION 'splice anchors not found exactly once';
  END IF;
  v_def := replace(replace(replace(v_def, v_old1, v_new1), v_old2, v_new2), v_old3, v_new3);
  EXECUTE v_def;
END
$do$;
