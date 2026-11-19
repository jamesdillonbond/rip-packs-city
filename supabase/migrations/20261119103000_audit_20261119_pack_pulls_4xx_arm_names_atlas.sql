-- audit_20261119_pack_pulls_4xx_arm_names_atlas
--
-- 2026-11-19 (PT, morning; Claude Code cloud; Trevor: "Keep going") -- #218 follow-up, text only.
-- The pack-pulls arm of check_edge_fn_http_failures() still says its calls go
-- "request_wallet_pack_pulls -> studio-platform GraphQL". Since 20261119050000 (11-18) the lane reads Atlas
-- PackService/NFTService; a responder reading the alert would chase the wrong (dead) host. Severity logic is
-- unchanged (already info at Cloudflare's base rate, high with no 200 + 3 4xx). md5-guarded splice of ONE string.
--
-- REVERT: the same splice with the strings swapped back.

DO $do$
DECLARE
  v_oid oid := 'public.check_edge_fn_http_failures(interval)'::regprocedure;
  v_def text;
  v_old text := $o$' wallet PACK-PULL call(s) (request_wallet_pack_pulls -> studio-platform GraphQL) returned HTTP '$o$;
  v_new text := $n$' wallet PACK-PULL call(s) (request_wallet_pack_pulls -> Atlas PackService/NFTService) returned HTTP '$n$;
BEGIN
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = v_oid)) <> 'e597af8ecdf7e2869e1087885af6d0f2' THEN
    RAISE EXCEPTION 'check_edge_fn_http_failures changed since this splice was written';
  END IF;
  v_def := pg_get_functiondef(v_oid);
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'splice anchor not found exactly once';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END
$do$;
