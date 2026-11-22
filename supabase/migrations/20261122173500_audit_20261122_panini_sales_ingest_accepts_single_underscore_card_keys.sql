-- audit_20261122_panini_sales_ingest_accepts_single_underscore_card_keys
--
-- Trevor 2026-11-22 9:26 AM PT "Keep going and digging and probing" (Panini pack EV strategy pass).
--
-- FINDING: panini_sales_ingest only accepted sale keys shaped `<card>__<serial>_<cap>`. Moonbirds - Birbs Beyond
-- (set 850178) keys its sales `packcard-850178_104_7_7_10` (3-part card, SINGLE underscore before the serial), so
-- every Moonbirds sale the runner offered was filtered out before `src` — 0 rows in panini_sales while 1,160 of its
-- 7,387 serials carry a last_sale (newest 11-18). Nothing alarmed: the return reports `offered` vs `valid`, and no
-- reader compares them. Its FMVs still read MEDIUM (fed from serial last sales), which is how the pack-EV pool
-- model's sale-backed gate exposed the disagreement. Only 850178 uses this shape (checked across every 3-part set:
-- 850180 Stickers, 850179, 2130 all use `__`).
--
-- CHANGE: accept `^packcard-\d+_\d+_\d+_\d+_\d+$` and derive the card as the first three parts. Unambiguous: a
-- 4-part card's single-underscore form would have 6 parts and stays rejected. Body otherwise identical to
-- 20260929020655 (live prosrc md5 3c51686f… verified equal before the edit).
-- BACKFILL: the serial last-sales of 850178 seeded as `serial_last_sale` rows (the same rule as
-- panini_sales_seed_from_serials, scoped to this set; ON CONFLICT DO NOTHING; a later full record within a day
-- supersedes a seed, per the function).
--
-- anon-exec: unchanged (panini_sales_ingest) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved (has_function_privilege anon = false, read 2026-11-22).
--
-- REVERT: re-apply panini_sales_ingest from 20260929020655;
--         delete from panini_sales where source = 'serial_last_sale'
--           and edition_external_id = any (array(select external_id from panini_editions where product_set_id = 850178));

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
           CASE WHEN sku ~ '__\d+_\d+$' THEN split_part(sku, '__', 1)
                -- 2026-11-22: Moonbirds (850178) keys a 3-part card + serial + cap with SINGLE underscores
                -- (packcard-850178_104_7_7_10). The card is the first three parts.
                WHEN sku ~ '^packcard-\d+_\d+_\d+_\d+_\d+$' THEN regexp_replace(sku, '_\d+_\d+$', '')
           END AS edition_external_id,
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
    WHERE sku ~ '^[A-Za-z0-9_-]+__\d+_\d+$' OR sku ~ '^packcard-\d+_\d+_\d+_\d+_\d+$'
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

INSERT INTO panini_sales (sku, edition_external_id, sold_at, amount_usd, source)
SELECT s.sku, s.edition_external_id, s.last_sale_at, s.last_sale_usd, 'serial_last_sale'
FROM panini_card_serials s
WHERE s.edition_external_id = ANY (ARRAY(SELECT e.external_id FROM panini_editions e WHERE e.product_set_id = 850178))   -- indexed; a LIKE scans 5.3M rows
  AND s.last_sale_usd > 0 AND s.last_sale_at IS NOT NULL
ON CONFLICT (sku, sold_at) DO NOTHING;