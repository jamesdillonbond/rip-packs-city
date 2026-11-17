-- 2026-08-08 — sentinel_sales_ingest_health(): add explicit ::text casts to the grouped
-- marketplace/source expressions.
--
-- Applied to prod via Supabase MCP as migration 20260808173538. The repo record was never
-- committed — found and closed 2026-08-09 by the `migration-parity` sweep (the containment
-- job added the same day for exactly this drift class).
--
-- WHY THIS FILE MATTERS MORE THAN A TYPICAL BACKFILLED RECORD:
--   `20260808170000_audit_20260808_sentinel_multicollection_sales_ingest.sql` IS committed and
--   also defines this function — but prod replaced it ~35 minutes later with the body below.
--   So until this file landed, the newest committed definition of `sentinel_sales_ingest_health`
--   was STALE relative to production: anyone reading the repo to answer "what does the sentinel
--   run?" got the pre-cast version. This is the repo-vs-prod half of the same blind spot the
--   DB-pin staleness check covers for pinned functions; this function is NOT pinned
--   (verified against the drift-guard PINS array 2026-08-09), so nothing else would have caught it.
--
-- WHAT CHANGED vs 20260808170000: `coalesce(s.marketplace,'(none)')` and
--   `coalesce(s.source,'(none)')` (and the pinnacle arm's `coalesce(ps.source,'(none)')`) are now
--   explicitly `::text`. The RETURNS TABLE declares those columns `text`; without the cast the
--   coalesce over a varchar column yields a type the plpgsql RETURN QUERY refuses to coerce,
--   so the function raised at runtime instead of returning rows. Behaviour is otherwise identical.
--
-- REVERT: re-apply the committed body of
--   supabase/migrations/20260808170000_audit_20260808_sentinel_multicollection_sales_ingest.sql
--   (which restores the uncast version — note that version errors at runtime, so reverting is
--   only meaningful as a step toward a different fix, not as a resting state).

CREATE OR REPLACE FUNCTION public.sentinel_sales_ingest_health()
RETURNS TABLE(
  collection             text,
  display_name           text,
  marketplace            text,
  source                 text,
  sales_1h               bigint,
  sales_6h               bigint,
  sales_24h              bigint,
  source_last_at         timestamptz,
  coll_last_at           timestamptz,
  coll_hours_since_last  numeric,
  silence_hours          numeric,
  loudness               text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '25s'
AS $fn$
DECLARE
  cfg record;
  v_last timestamptz;
BEGIN
  FOR cfg IN
    SELECT * FROM public.sentinel_ingest_watch WHERE is_active ORDER BY collection_key
  LOOP
    IF cfg.source_table = 'pinnacle_sales' THEN
      SELECT max(ps.sold_at) INTO v_last FROM public.pinnacle_sales ps;
      RETURN QUERY
        SELECT cfg.collection_key, cfg.display_name, 'pinnacle'::text, coalesce(ps.source,'(none)')::text,
               count(*) FILTER (WHERE ps.sold_at > now()-interval '1 hour'),
               count(*) FILTER (WHERE ps.sold_at > now()-interval '6 hours'),
               count(*),
               max(ps.sold_at),
               v_last,
               round((extract(epoch FROM (now()-v_last))/3600)::numeric,1),
               cfg.silence_hours, cfg.loudness
        FROM public.pinnacle_sales ps
        WHERE ps.sold_at > now()-interval '24 hours'
        GROUP BY coalesce(ps.source,'(none)')::text;
    ELSE
      SELECT max(s.sold_at) INTO v_last FROM public.sales s WHERE s.collection_id = cfg.collection_id;
      RETURN QUERY
        SELECT cfg.collection_key, cfg.display_name, coalesce(s.marketplace,'(none)')::text, coalesce(s.source,'(none)')::text,
               count(*) FILTER (WHERE s.sold_at > now()-interval '1 hour'),
               count(*) FILTER (WHERE s.sold_at > now()-interval '6 hours'),
               count(*),
               max(s.sold_at),
               v_last,
               round((extract(epoch FROM (now()-v_last))/3600)::numeric,1),
               cfg.silence_hours, cfg.loudness
        FROM public.sales s
        WHERE s.collection_id = cfg.collection_id AND s.sold_at > now()-interval '24 hours'
        GROUP BY coalesce(s.marketplace,'(none)')::text, coalesce(s.source,'(none)')::text;
    END IF;

    IF NOT FOUND THEN
      RETURN QUERY SELECT cfg.collection_key, cfg.display_name, '(none)'::text, '(none)'::text,
        0::bigint, 0::bigint, 0::bigint, NULL::timestamptz,
        v_last,
        CASE WHEN v_last IS NULL THEN NULL
             ELSE round((extract(epoch FROM (now()-v_last))/3600)::numeric,1) END,
        cfg.silence_hours, cfg.loudness;
    END IF;
  END LOOP;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.sentinel_sales_ingest_health() FROM PUBLIC, anon, authenticated;
