-- 2026-09-28: refresh_series_detail_rollup names query_canceled in the handler
-- that isolates its refresh_edition_fmv_current step (a 57014 kill escapes
-- WHEN OTHERS and took the whole rollup down). The resulting body is the one in
-- 20260929063531_audit_20260928_pinnacle_entity_totals_say_what_they_sum.sql;
-- this file is the md5-guarded splice that was applied.
DO $do$
DECLARE d text; o oid;
BEGIN
  SELECT oid INTO STRICT o FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='refresh_series_detail_rollup';
  IF md5((SELECT prosrc FROM pg_proc WHERE oid=o)) <> 'b731ff7b7110bf759ad56ac488eedfcb' THEN RAISE EXCEPTION 'drifted'; END IF;
  d := pg_get_functiondef(o);
  IF position($l$    v_fmv := public.refresh_edition_fmv_current();
  EXCEPTION WHEN OTHERS THEN
$l$ in d) = 0 THEN RAISE EXCEPTION 'anchor'; END IF;
  d := overlay(d placing $l$    v_fmv := public.refresh_edition_fmv_current();
  -- query_canceled named (2026-09-28): a statement_timeout kill (57014) escapes
  -- WHEN OTHERS, which took the whole rollup down instead of isolating this step.
  EXCEPTION WHEN query_canceled OR OTHERS THEN
$l$ from position($l$    v_fmv := public.refresh_edition_fmv_current();
  EXCEPTION WHEN OTHERS THEN
$l$ in d) for length($l$    v_fmv := public.refresh_edition_fmv_current();
  EXCEPTION WHEN OTHERS THEN
$l$));
  EXECUTE d;
  IF md5((SELECT prosrc FROM pg_proc WHERE oid=o)) <> '0cb641fc0b801a83f786fb2935337c2a' THEN RAISE EXCEPTION 'new md5'; END IF;
END
$do$;
