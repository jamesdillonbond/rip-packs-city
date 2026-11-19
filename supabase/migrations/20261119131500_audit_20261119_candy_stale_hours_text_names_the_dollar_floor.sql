-- audit_20261119_candy_stale_hours_text_names_the_dollar_floor
--
-- 2026-11-19 (PT, afternoon; Claude Code cloud; Trevor: "Handle anything unresolved from this thread").
-- Text only. 20261119113000 made candy_revival_sales_since_recorded_silence sum DOLLARS (floor $250), but its
-- partner candy_sales_stale_hours still says the revival arm "pages on the first sale after the recorded date".
-- One sentence of that arm's `catches` text, md5-guarded on the live view; security_invoker re-set (a
-- CREATE OR REPLACE VIEW resets reloptions).
--
-- REVERT: the same splice with the sentence swapped back.

DO $do$
DECLARE
  v_def text := pg_get_viewdef('public.v_rpc_trust_health'::regclass);
  v_old text := 'Its partner candy_revival_sales_since_recorded_silence pages on the first sale after the recorded date.';
  v_new text := 'Its partner candy_revival_sales_since_recorded_silence pages once Candy sales since the recorded date pass $250 (since 2026-11-19; it counted sales before).';
BEGIN
  IF md5(v_def) <> '42fe1e32532e94a62ac70b4d556c13f6' THEN
    RAISE EXCEPTION 'v_rpc_trust_health changed since this splice was written';
  END IF;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'anchor not exactly once';
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_rpc_trust_health AS ' || replace(v_def, v_old, v_new);
  ALTER VIEW public.v_rpc_trust_health SET (security_invoker = on);
END
$do$;
