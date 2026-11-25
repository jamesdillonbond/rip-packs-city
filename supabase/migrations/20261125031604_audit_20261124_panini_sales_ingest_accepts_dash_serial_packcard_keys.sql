-- audit_20261124_panini_sales_ingest_accepts_dash_serial_packcard_keys — 2026-11-24 ~7:40 PM PT (Claude Code cloud,
-- autonomous pass; Trevor: "work autonomously ... fix any issues you encounter").
--
-- WHY. The Sentinel "Panini Ingest" arm has warned since ~4:30 PM PT 11-24: 18 sale records in 24 h dropped by
-- panini_sales_ingest for an unrecognised key shape (pipeline_runs panini-ingest extra.sales_history_unrecognised_*),
-- every sample from product 1551 sub-product 284632, e.g. packcard-1551_284632_7103141_194_-2-3. That sub-product keys
-- the serial as `_-<serial>-<cap>` (a /3 card: _-1-3, _-2-3, _-3-3); none of the four shapes matches, so every sale
-- of it is dropped. Measured before the edit (index-bounded on sku): 216 serials / 72 editions under
-- packcard-1551_284632, ALL in this shape, 0 editions mixing shapes, and regexp_replace(sku, '_-\d+-\d+$', '') =
-- panini_card_serials.edition_external_id on all 216 (0 mismatches). 0 stored sales for the sub-product, so
-- accepting this shape cannot store a sale twice.
--
-- WHAT. One more WHEN arm and one more WHERE alternative for `^packcard-\d+_\d+_\d+_\d+_-\d+-\d+$`. Body otherwise =
-- 20261123045852 (live prosrc md5 5dc943b26d6eabef3ee5d0c4f9abff88, asserted below). TS mirror:
-- lib/chains/panini/ingest-normalize.ts PANINI_SALE_KEY_SHAPES (pinned by __tests__/panini-sale-key-shapes.test.ts).
-- SEED: the serial last-sales of the affected editions (0 stored today), as 20261123045852 did; a full record of
-- the same sale supersedes its seed later (the `superseded` CTE).
--
-- anon-exec: unchanged (panini_sales_ingest) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved.
-- REVERT: re-apply 20261123045852_audit_20261122_panini_sales_ingest_accepts_hyphenated_packcard_keys.sql;
--   delete from panini_sales where source='serial_last_sale' and sku ~ '^packcard-\d+_\d+_\d+_\d+_-\d+-\d+$'
--     and edition_external_id >= 'packcard-1551_284632_' and edition_external_id < 'packcard-1551_284632`';

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.panini_sales_ingest(jsonb)'::regprocedure)
     IS DISTINCT FROM '5dc943b26d6eabef3ee5d0c4f9abff88' THEN
    RAISE EXCEPTION 'panini_sales_ingest is not the 20261123045852 body; re-read it and re-base';
  END IF;
END
$guard$;

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
                -- 2026-11-22 (later): product 2077 keys a 4-part card the same way
                -- (packcard-2077_403382_10871318_139_15_25; catalog serial sku is identical). Card = all but
                -- the trailing serial + cap.
                WHEN sku ~ '^packcard-\d+_\d+_\d+_\d+_\d+_\d+$' THEN regexp_replace(sku, '_\d+_\d+$', '')
                -- 2026-11-22 (evening): product 850147 sub-product 111938 keys a card whose third part is hyphenated
                -- (packcard-850147_111938_2-2_5_21_79; catalog serial sku identical). Card = all but serial + cap.
                WHEN sku ~ '^packcard-\d+_\d+_\d+-\d+_\d+_\d+_\d+$' THEN regexp_replace(sku, '_\d+_\d+$', '')
                -- 2026-11-24: product 1551 sub-product 284632 keys the serial as `_-<serial>-<cap>`
                -- (packcard-1551_284632_7103141_194_-2-3; catalog serial sku identical, edition = the sku minus
                -- that suffix). Card = all but `_-<serial>-<cap>`.
                WHEN sku ~ '^packcard-\d+_\d+_\d+_\d+_-\d+-\d+$' THEN regexp_replace(sku, '_-\d+-\d+$', '')
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
       OR sku ~ '^packcard-\d+_\d+_\d+_\d+_\d+_\d+$' OR sku ~ '^packcard-\d+_\d+_\d+-\d+_\d+_\d+_\d+$'
       OR sku ~ '^packcard-\d+_\d+_\d+_\d+_-\d+-\d+$'
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

-- Seed: the serial last-sales of the affected editions (index-bounded to sub-product 284632; all 216 of its serials
-- use this shape). 0 of these editions had a stored sale (measured above).
INSERT INTO panini_sales (sku, edition_external_id, sold_at, amount_usd, source)
SELECT s.sku, s.edition_external_id, s.last_sale_at, s.last_sale_usd, 'serial_last_sale'
FROM panini_card_serials s
WHERE s.edition_external_id >= 'packcard-1551_284632_' AND s.edition_external_id < 'packcard-1551_284632`'
  AND s.sku ~ '^packcard-\d+_\d+_\d+_\d+_-\d+-\d+$'
  AND s.last_sale_usd > 0 AND s.last_sale_at IS NOT NULL
ON CONFLICT (sku, sold_at) DO NOTHING;
