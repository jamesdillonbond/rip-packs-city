-- audit_20261122_sentinel_panini_health_unrecognised_sale_keys
--
-- anon-exec: not granted (sentinel_panini_health) — CREATE OR REPLACE keeps the live ACL; has_function_privilege('anon') read false 11-22.
--
-- 2026-11-22 (Claude Code cloud; Trevor: "Approve and proceed" on the Panini pack-EV strategy, P0.1).
--
-- WHY. Moonbirds sales went unrecorded for weeks because their card keys (`packcard-<a>_<b>_<c>_<d>_<e>`)
-- matched neither shape the panini_sales_ingest WHERE clause accepted — the rows were dropped, nothing
-- failed, and the pack EV priced Moonbirds from asks only (fixed in 20261122173500). The next new key shape
-- must be caught in hours. The panini-ingest route now reports, per run, how many offered sale records
-- carry a key neither shape matches (`extra.sales_history_unrecognised_keys`, + a 3-key sample), using
-- PANINI_SALE_KEY_SHAPES in lib/chains/panini/ingest-normalize.ts — which a test pins equal to the newest
-- panini_sales_ingest WHERE clause.
--
-- WHAT CHANGES. Two NEW keys; every existing key unchanged.
--   unrecognised_sale_keys_24h     sum over panini-ingest runs in 24 h that REPORT the field.
--                                  NULL = no run reports it yet (pre-deploy) — an absent instrument, not 0.
--   unrecognised_sale_keys_sample  the newest non-empty sample (jsonb array), or NULL.
-- Cost measured 11-22: 42 ms, 3.3k buffers (pipeline_runs_pipeline_started_idx, 4,556 runs/24 h).
-- Base prosrc md5 9d8f62fe8acc48cb50232e6c415ab6ff (== body of 20261109040000) re-read 11-22.
--
-- Revert: re-apply the body from 20261109040000.

DO $premise$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'sentinel_panini_health') <> '9d8f62fe8acc48cb50232e6c415ab6ff' THEN
    RAISE EXCEPTION 'premise: sentinel_panini_health changed since read; re-read before replacing';
  END IF;
END
$premise$;

CREATE OR REPLACE FUNCTION public.sentinel_panini_health()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'newest_walk_at',     (SELECT max(last_seen_at) FROM panini_editions),
    'edition_age_max_h',  (SELECT round((extract(epoch FROM now() - min(last_seen_at)) / 3600)::numeric, 1) FROM panini_editions),
    'editions',           (SELECT count(*) FROM panini_editions),
    'edition_refreshed_24h',
                          (SELECT count(*) FROM panini_editions WHERE last_seen_at > now() - interval '24 hours'),
    'max_serials_per_edition_newest_captures',
                          (SELECT COALESCE(max(n), 0) FROM (
                             SELECT count(*) AS n FROM (
                               SELECT edition_external_id FROM panini_card_serials
                                WHERE captured_at > now() - interval '26 hours'
                                ORDER BY captured_at DESC
                                LIMIT 20000) r
                              GROUP BY edition_external_id) z),
    'newest_sale_at',     (SELECT max(last_sale_at) FROM panini_card_serials),
    'unrecognised_sale_keys_24h',
                          (SELECT sum((extra->>'sales_history_unrecognised_keys')::int) FROM pipeline_runs
                            WHERE pipeline = 'panini-ingest' AND started_at > now() - interval '24 hours'
                              AND extra ? 'sales_history_unrecognised_keys'),
    'unrecognised_sale_keys_sample',
                          (SELECT extra->'sales_history_unrecognised_sample' FROM pipeline_runs
                            WHERE pipeline = 'panini-ingest' AND started_at > now() - interval '24 hours'
                              AND (extra->>'sales_history_unrecognised_keys')::int > 0
                            ORDER BY started_at DESC LIMIT 1)
  )
$function$;
