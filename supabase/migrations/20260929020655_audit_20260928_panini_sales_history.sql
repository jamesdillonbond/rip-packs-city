-- audit_20260928_panini_sales_history
--
-- WHY. Panini's per-edition SALES HISTORY tab answers op nftSalesData with realized sales —
-- { url_key, txn_amount, purchased_date, buyer_name, seller_name, transaction_hash, sale_type } —
-- and the runner reads two lists per edition visit: TOP SALES (the 20 highest-priced ever) and
-- RECENT SALES (the newest 20). /api/cron/panini-ingest received every record and KEPT ONLY THE
-- NEWEST PER CARD (panini_card_serials.last_sale_*): measured 2026-09-25..28, 4,146–27,064 sale
-- records a day arrived and 40–49% survived as "last sale". A per-card last-sale column cannot
-- carry a time series — its weekly shape is RPC's read timing (a false ~90% drop in the last two
-- weeks, measured 2026-09-28) — so Panini had no sales analytics. This keeps every sale.
--
-- DESIGN.
--   · panini_sales — one row per (sku, sold_at). A card cannot sell twice in the same second,
--     and both the nftSalesData path and the legacy last-sale columns stamp sold_at the same way
--     (toSaleTimestamp), so the seed below and later live reads of the same sale collide
--     instead of duplicating. Insert-only (ON CONFLICT refreshes last_seen_at and fills fields a
--     seed lacked; it never changes a price). A sale with no timestamp is not stored: it cannot
--     be placed on a time axis.
--   · panini_sales_reads — per edition, what the RECENT list showed, which makes coverage a
--     MEASUREMENT instead of a claim. A recent read with fewer rows than its page size holds the
--     edition's ENTIRE history (complete forever). A full page covers back to its oldest row, and
--     it continues the previous read's coverage only if it overlaps it (its oldest sale is no
--     newer than the previous read's newest); otherwise there may be a gap and coverage restarts
--     at this read's oldest row. `complete_since` is therefore "every sale of this edition from
--     here on is in panini_sales" ('-infinity' = all of them).
--   · The runner tags each record with the list its REQUEST asked for (`__list`: top | recent)
--     and the page size (`__page_size`). Untagged records (an older runner, a replayed backup)
--     are stored as sales but never move coverage.
--
-- anon-exec: revoked below — service-role only (public.panini_sales_ingest)
-- anon-exec: revoked below — service-role only (public.panini_sales_seed_from_serials)

CREATE TABLE IF NOT EXISTS public.panini_sales (
  sku                 text        NOT NULL,
  edition_external_id text        NOT NULL,
  sold_at             timestamptz NOT NULL,
  amount_usd          numeric     NOT NULL CHECK (amount_usd > 0),
  buyer               text,
  seller              text,
  tx_hash             text,
  sale_kind           text,
  source              text        NOT NULL CHECK (source IN ('nft_sales_data', 'serial_last_sale', 'serial_sale_fossil')),
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sku, sold_at)
);
CREATE INDEX IF NOT EXISTS idx_panini_sales_edition_sold ON public.panini_sales (edition_external_id, sold_at DESC);
CREATE INDEX IF NOT EXISTS idx_panini_sales_sold ON public.panini_sales (sold_at DESC);

CREATE TABLE IF NOT EXISTS public.panini_sales_reads (
  edition_external_id     text PRIMARY KEY,
  first_recent_read_at    timestamptz NOT NULL,
  last_recent_read_at     timestamptz NOT NULL,
  last_recent_n           integer     NOT NULL,
  last_recent_page_size   integer,
  last_recent_oldest_at   timestamptz,
  last_recent_newest_at   timestamptz,
  complete_since          timestamptz,
  gaps                    integer     NOT NULL DEFAULT 0
);

ALTER TABLE public.panini_sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.panini_sales_reads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.panini_sales FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.panini_sales_reads FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.panini_sales TO service_role;
GRANT ALL ON public.panini_sales_reads TO service_role;

-- One ingest batch of nftSalesData records (the raw records, as the route receives them), as ONE
-- statement so the function is safe to call repeatedly in a transaction.
-- Returns what it WROTE: { offered, valid, stored_new, refreshed, seeds_superseded, recent_reads, gaps_now }.
CREATE OR REPLACE FUNCTION public.panini_sales_ingest(p_records jsonb)
RETURNS jsonb
LANGUAGE sql
SET search_path = public
AS $$
  WITH raw AS (
    SELECT btrim(coalesce(r->>'url_key', r->>'sku')) AS sku,
           coalesce(r->>'purchased_date', r->>'sold_at') AS ts,
           coalesce(r->>'txn_amount', r->>'amount') AS amt,
           r
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_records) = 'array' THEN p_records ELSE '[]'::jsonb END) r
  ), parsed AS (
    SELECT sku,
           split_part(sku, '__', 1) AS edition_external_id,
           -- toSaleTimestamp's rule: a zone-less "YYYY-MM-DD HH:MM[:SS]" is UTC.
           CASE
             WHEN ts ~ '^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?$'
               THEN (replace(ts, ' ', 'T') || 'Z')::timestamptz
             WHEN ts ~ '^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?([zZ]|[+-]\d{2}:?\d{2})$'
               THEN ts::timestamptz
           END AS sold_at,
           CASE WHEN amt ~ '^\d{1,9}(\.\d{1,6})?$' THEN amt::numeric END AS amount_usd,
           left(nullif(btrim(r->>'buyer_name'), ''), 64) AS buyer,
           left(nullif(btrim(r->>'seller_name'), ''), 64) AS seller,
           left(nullif(btrim(r->>'transaction_hash'), ''), 200) AS tx_hash,
           left(nullif(btrim(r->>'sale_type'), ''), 40) AS sale_kind,
           CASE WHEN r->>'__list' IN ('top', 'recent') THEN r->>'__list' END AS list,
           CASE WHEN r->>'__page_size' ~ '^\d{1,4}$' THEN (r->>'__page_size')::int END AS page_size
    FROM raw
    WHERE sku ~ '^[A-Za-z0-9_-]+__\d+_\d+$'
  ), src AS (
    SELECT DISTINCT ON (sku, sold_at) *
    FROM parsed
    WHERE sold_at IS NOT NULL AND amount_usd > 0
    ORDER BY sku, sold_at, (list = 'recent') DESC NULLS LAST
  ), superseded AS (
    -- A seed (learned from a last-sale column, possibly stamped by the pre-08-08 grid field) is
    -- the SAME sale as a full record of that card at that price within a day: drop the seed so
    -- the sale is not counted twice. Rows at the identical instant are merged by the upsert.
    DELETE FROM panini_sales t
    USING src
    WHERE t.sku = src.sku AND t.source <> 'nft_sales_data' AND t.sold_at <> src.sold_at
      AND t.amount_usd = src.amount_usd AND abs(extract(epoch FROM t.sold_at - src.sold_at)) <= 86400
    RETURNING 1
  ), ins AS (
    INSERT INTO panini_sales AS t (sku, edition_external_id, sold_at, amount_usd, buyer, seller, tx_hash, sale_kind, source)
    SELECT sku, edition_external_id, sold_at, amount_usd, buyer, seller, tx_hash, sale_kind, 'nft_sales_data' FROM src
    ON CONFLICT (sku, sold_at) DO UPDATE
      SET last_seen_at = now(),
          buyer = coalesce(t.buyer, excluded.buyer),
          seller = coalesce(t.seller, excluded.seller),
          tx_hash = coalesce(t.tx_hash, excluded.tx_hash),
          sale_kind = coalesce(t.sale_kind, excluded.sale_kind),
          source = 'nft_sales_data'
    RETURNING (xmax = 0) AS inserted
  ), rd AS (
    -- Coverage from RECENT lists only (see header).
    SELECT r.edition_external_id, r.n, r.page_size, r.oldest, r.newest,
           prev.last_recent_newest_at AS prev_newest, prev.complete_since AS prev_since,
           (r.n >= coalesce(r.page_size, 20)) AS full_page
    FROM (
      SELECT edition_external_id, count(*)::int AS n, max(page_size) AS page_size,
             min(sold_at) AS oldest, max(sold_at) AS newest
      FROM src WHERE list = 'recent'
      GROUP BY edition_external_id
    ) r
    LEFT JOIN panini_sales_reads prev ON prev.edition_external_id = r.edition_external_id
  ), calc AS (
    SELECT rd.*,
           CASE
             WHEN NOT full_page THEN '-infinity'::timestamptz
             WHEN prev_newest IS NOT NULL AND oldest <= prev_newest THEN coalesce(prev_since, oldest)
             ELSE oldest
           END AS new_since,
           (full_page AND prev_newest IS NOT NULL AND oldest > prev_newest) AS gap_now
    FROM rd
  ), up AS (
    INSERT INTO panini_sales_reads AS s (edition_external_id, first_recent_read_at, last_recent_read_at, last_recent_n,
                                        last_recent_page_size, last_recent_oldest_at, last_recent_newest_at, complete_since, gaps)
    SELECT edition_external_id, now(), now(), n, page_size, oldest, greatest(newest, prev_newest), new_since, gap_now::int
    FROM calc
    ON CONFLICT (edition_external_id) DO UPDATE
      SET last_recent_read_at = now(),
          last_recent_n = excluded.last_recent_n,
          last_recent_page_size = excluded.last_recent_page_size,
          last_recent_oldest_at = excluded.last_recent_oldest_at,
          last_recent_newest_at = excluded.last_recent_newest_at,
          complete_since = excluded.complete_since,
          gaps = s.gaps + excluded.gaps
    RETURNING 1
  )
  SELECT jsonb_build_object(
    'offered',          (SELECT count(*) FROM raw),
    'valid',            (SELECT count(*) FROM src),
    'stored_new',       (SELECT count(*) FROM ins WHERE inserted),
    'refreshed',        (SELECT count(*) FROM ins WHERE NOT inserted),
    'seeds_superseded', (SELECT count(*) FROM superseded),
    'recent_reads',     (SELECT count(*) FROM up),
    'gaps_now',         (SELECT count(*) FROM calc WHERE gap_now)
  )
$$;

-- One-time (idempotent) seed from what RPC already held: each serial's last sale, and the
-- archived fossil prices Panini can no longer serve. Labelled by source; never moves coverage.
CREATE OR REPLACE FUNCTION public.panini_sales_seed_from_serials()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_serial int := 0;
  v_fossil int := 0;
BEGIN
  INSERT INTO panini_sales (sku, edition_external_id, sold_at, amount_usd, source)
  SELECT s.sku, s.edition_external_id, s.last_sale_at, s.last_sale_usd, 'serial_last_sale'
  FROM panini_card_serials s
  WHERE s.last_sale_usd > 0 AND s.last_sale_at IS NOT NULL AND s.edition_external_id IS NOT NULL
  ON CONFLICT (sku, sold_at) DO NOTHING;
  GET DIAGNOSTICS v_serial = ROW_COUNT;

  INSERT INTO panini_sales (sku, edition_external_id, sold_at, amount_usd, source)
  SELECT f.sku, split_part(f.sku, '__', 1), f.last_sale_at, f.last_sale_usd, 'serial_sale_fossil'
  FROM panini_card_serial_sale_fossils f
  WHERE f.last_sale_usd > 0 AND f.last_sale_at IS NOT NULL AND f.sku ~ '__\d+_\d+$'
  ON CONFLICT (sku, sold_at) DO NOTHING;
  GET DIAGNOSTICS v_fossil = ROW_COUNT;

  RETURN jsonb_build_object('from_serials', v_serial, 'from_fossils', v_fossil);
END
$$;

REVOKE ALL ON FUNCTION public.panini_sales_ingest(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.panini_sales_seed_from_serials() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.panini_sales_ingest(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.panini_sales_seed_from_serials() TO service_role;
