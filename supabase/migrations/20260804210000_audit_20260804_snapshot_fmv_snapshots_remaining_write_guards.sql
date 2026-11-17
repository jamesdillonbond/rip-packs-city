-- Snapshot migration: the two remaining fmv_snapshots BEFORE INSERT write guards
--   public.fmv_snapshots_block_stale_ingest_algo()  → trigger
--   public.tg_fmv_snapshots_set_collection()        → trigger
--
-- Both were applied to prod with no committed migration, making them UNPINNABLE —
-- the drift guard compares a supabase/tests/*.sql verbatim block against a committed
-- migration, so with no migration there is nothing to pin against. This commits the
-- CURRENT LIVE bodies verbatim (pulled via pg_get_functiondef 2026-08-04). Applying
-- it is a no-op vs prod (byte-identical to live).
--
-- Context: fmv_snapshots carries FIVE BEFORE INSERT guards. Three are now pinned —
-- block_phantoms (#…), cap_closed_market_confidence, zero_stale_sales_count (#119).
-- These are the remaining two, and each fails in a distinct direction:
--
--   fmv_snapshots_block_stale_ingest_algo — RETURNS NULL (silently DROPS the row)
--     for any algo_version LIKE '1.1.0%'. This is the guard that keeps the legacy
--     ingest writer from clobbering fmv-recalc's canonical FMV. The dangerous
--     regression is a WIDENED predicate: matching more than '1.1.0%' would silently
--     discard live FMV writes platform-wide with no error and no row — the hardest
--     possible failure to notice. The pass-through cases carry the weight, exactly
--     as with zero_stale_sales_count.
--     NOTE: this one is deliberately NOT SECURITY DEFINER (prosecdef = false).
--
--   tg_fmv_snapshots_set_collection — denormalises collections.slug into
--     fmv_snapshots.collection and RAISES on a NULL or unknown collection_id. It is
--     the only thing guaranteeing collection_id is both present and real on every
--     snapshot; every per-collection FMV metric, trust arm and board filter keys off
--     that column. The dangerous regression is softening either RAISE into a silent
--     default, which would let unattributed snapshots accumulate.
--
-- Once committed, pin each with a supabase/tests/*.sql carrying the verbatim block
-- and register it in the drift guard's PINS array — an unregistered test file is
-- invisible to the guard and asserts nothing (the 2026-08-04 orphan-file finding).

CREATE OR REPLACE FUNCTION public.fmv_snapshots_block_stale_ingest_algo()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.algo_version LIKE '1.1.0%' THEN
    RETURN NULL;  -- silently skip — fmv-recalc owns canonical FMV
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_fmv_snapshots_set_collection()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_slug text;
BEGIN
  IF NEW.collection_id IS NULL THEN
    RAISE EXCEPTION 'fmv_snapshots.collection_id is required';
  END IF;
  SELECT slug INTO v_slug FROM collections WHERE id = NEW.collection_id;
  IF v_slug IS NULL THEN
    RAISE EXCEPTION 'fmv_snapshots: unknown collection_id %', NEW.collection_id;
  END IF;
  NEW.collection := v_slug;
  RETURN NEW;
END;
$function$;
