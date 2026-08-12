-- audit_20260812_snapshot_record_wallet_backfill_scan
--
-- SNAPSHOT migration — commits the VERBATIM live definition of
-- public.record_wallet_backfill_scan(text, text, integer) so it becomes
-- PINNABLE by the DB-invariant layer. Applied via the Supabase MCP with no
-- committed DDL, so the drift guard had no comparison target.
--
-- Byte-identical to live `pg_get_functiondef` as of 2026-08-12 — applying it is
-- a NO-OP.
--
-- Why it is worth pinning: it is the bookkeeping write behind
-- wallet_backfill_state, which is what `skip_cached` reads to decide whether a
-- wallet needs a fresh Cadence walk. Three behaviours matter:
--
--   1. It VALIDATES rather than writing garbage — a blank wallet, a negative
--      found_count, or an unknown collection slug each return
--      {ok:false,error:...} and write nothing. A regression that let an unknown
--      slug through would write a NULL collection_id row.
--   2. `scan_count` INCREMENTS on conflict (`scan_count + 1`) rather than
--      resetting to 1. That counter is how a repeatedly-rescanned wallet is
--      distinguished from a first-time one.
--   3. The wallet address is lowercased+trimmed on the way in. Flow addresses
--      are case-insensitive and the rest of the platform stores them lowercase,
--      so a mixed-case write here would create a duplicate state row that never
--      matches the reader. (Note this is the OPPOSITE situation from the
--      documented `lower()`-on-the-COLUMN sargability trap — normalising the
--      INPUT before writing is correct; wrapping the stored column in a query
--      predicate is what defeats the index.)
--
-- Revert: none needed (no-op snapshot).

CREATE OR REPLACE FUNCTION public.record_wallet_backfill_scan(p_wallet text, p_collection_slug text, p_found_count integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_wallet text := lower(trim(p_wallet));
  v_collection_id uuid;
BEGIN
  IF v_wallet IS NULL OR v_wallet = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_wallet');
  END IF;
  IF p_found_count < 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_found_count');
  END IF;

  SELECT id INTO v_collection_id
    FROM public.collections
   WHERE slug = p_collection_slug;
  IF v_collection_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_collection_slug');
  END IF;

  INSERT INTO public.wallet_backfill_state
    (wallet_address, collection_id, last_scanned_at, last_found_count, scan_count)
  VALUES (v_wallet, v_collection_id, now(), p_found_count, 1)
  ON CONFLICT (wallet_address, collection_id) DO UPDATE SET
    last_scanned_at = now(),
    last_found_count = EXCLUDED.last_found_count,
    scan_count = wallet_backfill_state.scan_count + 1;

  RETURN jsonb_build_object('ok', true);
END;
$function$;
