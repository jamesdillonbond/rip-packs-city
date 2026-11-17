-- populate_wmc_fmv_from_snapshots now denormalizes `confidence` alongside
-- `fmv_usd` into wallet_moments_cache.fmv_confidence.
--
-- THE INVARIANT THIS ENCODES: the label is read from the SAME fmv_snapshots
-- row the value came from — never from "the latest snapshot" resolved
-- independently. Both paths already select exactly one snapshot per edition
-- (DISTINCT ON / LATERAL ... LIMIT 1, both filtered on fmv_usd IS NOT NULL),
-- so taking fs.confidence from that same row is what keeps the label
-- describing the number actually shown. Resolving confidence separately would
-- reintroduce the defect in a subtler form: a NO_DATA latest snapshot carries
-- a NULL fmv, so wmc keeps an older row's value — pairing that value with a
-- NO_DATA label would mislabel a number that did not come from that row.
--
-- Everything else is byte-for-byte the prior definition (signature, SECDEF,
-- search_path, statement_timeout, FOR UPDATE SKIP LOCKED, drain semantics).
-- CREATE OR REPLACE preserves existing grants.
--
-- The chunked (cron) path's candidate set is deliberately NOT widened to
-- `OR fmv_confidence IS NULL`. Doing so would make the hourly cron rewrite all
-- 2.22M rows over successive ticks — sustained write load and bloat on a
-- 2,325 MB table on a disk-IO-throttled instance. Historical rows are filled
-- per-collection through p_force, which the route documents as "reserved for
-- ad-hoc remediation, not the cron".
--
-- Revert: re-apply the prior definition (this migration's body minus the two
-- confidence references); the column drop is a separate revert.

CREATE OR REPLACE FUNCTION public.populate_wmc_fmv_from_snapshots(p_collection_id uuid DEFAULT NULL::uuid, p_force boolean DEFAULT false, p_limit integer DEFAULT 50000)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_updated integer;
BEGIN
  IF p_force THEN
    WITH latest_fmv AS (
      SELECT DISTINCT ON (e.collection_id, e.external_id)
        e.collection_id,
        e.external_id,
        fs.fmv_usd,
        fs.confidence
      FROM public.editions e
      JOIN public.fmv_snapshots fs ON fs.edition_id = e.id
      WHERE fs.fmv_usd IS NOT NULL
        AND (p_collection_id IS NULL OR e.collection_id = p_collection_id)
      ORDER BY e.collection_id, e.external_id, fs.computed_at DESC
    ),
    updated AS (
      UPDATE public.wallet_moments_cache wmc
         SET fmv_usd        = lf.fmv_usd,
             fmv_confidence = lf.confidence
        FROM latest_fmv lf
       WHERE wmc.collection_id = lf.collection_id
         AND wmc.edition_key   = lf.external_id
         AND wmc.edition_key IS NOT NULL
         AND (p_collection_id IS NULL OR wmc.collection_id = p_collection_id)
         AND (wmc.fmv_usd IS DISTINCT FROM lf.fmv_usd
              OR wmc.fmv_confidence IS DISTINCT FROM lf.confidence)
      RETURNING 1
    )
    SELECT COUNT(*)::int INTO v_updated FROM updated;
  ELSE
    -- NULL-only chunked path. Each call processes up to p_limit rows. Once
    -- a row gets a non-NULL fmv_usd it falls out of the candidate set, so
    -- successive cron ticks naturally drain the backlog.
    --
    -- FOR UPDATE SKIP LOCKED: this path races the wallet-backfill writers on the
    -- same wmc rows. Locking the target rows up front and skipping any that a
    -- backfill currently holds means the UPDATE never blocks — skipped rows stay
    -- NULL and are retried next tick (the same drain semantics as above), so the
    -- tick no longer fails with lock/deadlock/statement timeouts.
    WITH targets AS (
      SELECT wmc.id, wmc.collection_id, wmc.edition_key
      FROM public.wallet_moments_cache wmc
      WHERE wmc.fmv_usd IS NULL
        AND wmc.edition_key IS NOT NULL
        AND (p_collection_id IS NULL OR wmc.collection_id = p_collection_id)
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED
    ),
    snapped AS (
      SELECT t.id AS wmc_id, fs.fmv_usd, fs.confidence
      FROM targets t
      JOIN public.editions e
        ON e.collection_id = t.collection_id
       AND e.external_id   = t.edition_key
      CROSS JOIN LATERAL (
        SELECT fmv_usd, confidence
        FROM public.fmv_snapshots
        WHERE edition_id = e.id
          AND fmv_usd IS NOT NULL
        ORDER BY computed_at DESC
        LIMIT 1
      ) fs
    ),
    updated AS (
      UPDATE public.wallet_moments_cache wmc
         SET fmv_usd        = s.fmv_usd,
             fmv_confidence = s.confidence
        FROM snapped s
       WHERE wmc.id = s.wmc_id
       RETURNING 1
    )
    SELECT COUNT(*)::int INTO v_updated FROM updated;
  END IF;

  RETURN COALESCE(v_updated, 0);
END;
$function$;
