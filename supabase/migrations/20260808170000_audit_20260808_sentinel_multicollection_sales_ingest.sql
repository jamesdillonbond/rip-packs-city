-- Per-collection + per-source sales-ingest health for the RPC Sentinel.
-- Motivation: the sentinel "Sales Ingest (2h)" check is a single aggregate over
-- sales.ingested_at (crit only at ZERO total), so Top Shot's ~92% volume masks a
-- silent ingest death in AllDay/Golazos/Candy; and Pinnacle sales live in a
-- separate table (pinnacle_sales) that the check never touches. This adds a
-- table-driven, per-collection + per-source(=marketplace lane) ingest-health
-- source that the sentinel route renders and alarms on.
--
-- NOTE (durable): there is NO index on sales.ingested_at, so any ingested_at
-- predicate seq-scans the multi-million-row partitions. The reader below queries
-- by sold_at and filters by collection_id so it rides
-- sales_2026_collection_id_sold_at_idx (collection_id, sold_at DESC) and stays
-- cheap even under pooler saturation.

-- 1) Config: per-collection silence ceiling + loudness. Ceilings calibrated
--    2026-08-08 from each collection's worst normal 14d inter-sale gap
--    (TS 0.6h, AllDay 6.2h, Candy 5.4h, Pinnacle 4.5h, Golazos 87.8h) so a
--    market-quiet spell can never false-fire. Loudness per Trevor 2026-08-08:
--    page for the high-volume Flow collections (TS/AllDay), warn the rest,
--    off for UFC (market closed since 2026-05-13; revival is detected by
--    v_rpc_trust_health.ufc_flow_revival_sales_30d, not here).
CREATE TABLE IF NOT EXISTS public.sentinel_ingest_watch (
  collection_key text PRIMARY KEY,
  display_name   text NOT NULL,
  source_table   text NOT NULL DEFAULT 'sales' CHECK (source_table IN ('sales','pinnacle_sales')),
  collection_id  uuid,                          -- index filter for the sales table; NULL for pinnacle_sales
  silence_hours  numeric NOT NULL,              -- alarm when hours-since-last-sale exceeds this
  loudness       text NOT NULL CHECK (loudness IN ('critical','warn','off')),
  is_active      boolean NOT NULL DEFAULT true,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.sentinel_ingest_watch ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sentinel_ingest_watch FROM anon, authenticated;

INSERT INTO public.sentinel_ingest_watch
  (collection_key, display_name, source_table, collection_id, silence_hours, loudness, note)
VALUES
  ('nba_top_shot',   'Top Shot', 'sales',         '95f28a17-224a-4025-96ad-adf8a4c63bfd', 3,   'critical', 'worst normal 14d gap 0.6h; ceiling 5x'),
  ('nfl_all_day',    'All Day',  'sales',         'dee28451-5d62-409e-a1ad-a83f763ac070', 12,  'critical', 'worst normal 14d gap 6.2h; ceiling ~2x'),
  ('candy_mlb',      'Candy MLB','sales',          '209ade70-32c5-4470-bc7c-4793d660f713', 12,  'warn',     'bursty magic_eden cron; worst normal 14d gap 5.4h'),
  ('laliga_golazos', 'Golazos',  'sales',         '06248cc4-b85f-47cd-af67-1855d14acd75', 168, 'warn',     'thin/listing-gated; worst normal 14d gap 87.8h -> only a multi-day death fires'),
  ('ufc_strike',     'UFC',      'sales',         '9b4824a8-736d-4a96-b450-8dcc0c46b023', 999, 'off',      'market closed 2026-05-13; revival detected by v_rpc_trust_health.ufc_flow_revival_sales_30d'),
  ('disney_pinnacle','Pinnacle', 'pinnacle_sales', NULL,                                  12,  'warn',     'separate pinnacle_sales table; worst normal 14d gap 4.5h')
ON CONFLICT (collection_key) DO NOTHING;

-- 2) Health reader. Loops the active config and runs per-collection
--    INDEX-BOUNDED aggregates (collection_id equality on the (collection_id,
--    sold_at DESC) index) so it stays fast even while the pooler is saturated.
--    Returns one row per (collection, marketplace, source) plus a synthetic
--    zero row for a collection with no sales in the last 24h, each carrying the
--    collection's exact hours-since-last (unwindowed index max) + its config.
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

    -- No sales in the last 24h: still emit a presence row so "all collections"
    -- means all, and the route can alarm on an active collection gone silent.
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

-- Service-role only (the sentinel route uses the service key). A new SECDEF
-- function default-grants EXECUTE to PUBLIC, so revoke it explicitly (else the
-- secdef-anon-exec drift arm flags it and anon could call it).
REVOKE EXECUTE ON FUNCTION public.sentinel_sales_ingest_health() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.sentinel_sales_ingest_health() IS
  'Per-collection + per-source sales-ingest health for the RPC Sentinel. Index-bounded per collection (safe under pooler saturation). Config in sentinel_ingest_watch. Added 2026-08-08.';
