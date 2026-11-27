-- audit_20261127_panini_sales_ingest_catalog_fallback — 2026-11-27 ~3:35 PM PT (Claude Code cloud, autonomous pass;
-- Trevor: "work autonomously ... fix any issues you encounter").
--
-- WHY. Five times in six days (11-22 x3, 11-24, 11-27) panini_sales_ingest silently dropped every sale of a card
-- because Panini keyed it in a shape no regex arm knew (single underscores, a 4-part card, a hyphenated part,
-- `_-<serial>-<cap>`, a SPACE field). Each time the drop lasted until the Sentinel warned and a session wrote one
-- more arm. In every one of the five cases the key was ALREADY in panini_card_serials.sku with the right
-- edition_external_id (each migration measured it: 0 mismatches) -- the catalog knew the answer all along.
--
-- WHAT. (1) After the shape arms, ELSE take the edition from panini_card_serials (unique index on sku), and the
-- WHERE also admits a key the catalog holds. The arms keep precedence, so every key stored today parses exactly
-- as before. (2) The function now RETURNS `unrecognised` (keys neither a shape nor the catalog knows -- the
-- records it drops) and `unrecognised_sample` (up to 3), so the route reports what was DROPPED rather than
-- what a TypeScript copy of the shapes would guess. Body otherwise = 20261127225033 (live prosrc md5
-- 4f14adb53d2664e0d469393f1b1731c5, asserted below). The TS mirror PANINI_SALE_KEY_SHAPES is unchanged (the
-- shape chain in the WHERE is unchanged; the catalog clause is on its own line).
--
-- anon-exec: unchanged (panini_sales_ingest) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved.
-- REVERT: re-apply 20261127225033_audit_20261127_panini_sales_ingest_accepts_space_field_packcard_keys.sql (its
--   function body only; skip its seed INSERT, which is idempotent anyway).

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.panini_sales_ingest(jsonb)'::regprocedure)
     IS DISTINCT FROM '4f14adb53d2664e0d469393f1b1731c5' THEN
    RAISE EXCEPTION 'panini_sales_ingest is not the 20261127225033 body; re-read it and re-base';
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
                -- 2026-11-27: product 1551 sub-product 297782 card 7496368_21 keys the serial after a SPACE field
                -- (packcard-1551_297782_7496368_21_ _12_62; catalog serial sku identical, edition = the sku minus
                -- `_ _<serial>_<cap>`). Card = all but that suffix.
                WHEN sku ~ '^packcard-\d+_\d+_\d+_\d+_ +_\d+_\d+$' THEN regexp_replace(sku, '_ +_\d+_\d+$', '')
                -- 2026-11-27 (later): ANY other key the serial catalog holds takes its edition from the
                -- catalog -- a sale is never dropped for a key shape no arm above knows yet.
                ELSE cat.cat_edition
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
    LEFT JOIN (SELECT s.sku AS cat_sku, s.edition_external_id AS cat_edition FROM panini_card_serials s) cat
      ON cat.cat_sku = raw.sku
    WHERE sku ~ '^[A-Za-z0-9_-]+__\d+_\d+$' OR sku ~ '^packcard-\d+_\d+_\d+_\d+_\d+$'
       OR sku ~ '^packcard-\d+_\d+_\d+_\d+_\d+_\d+$' OR sku ~ '^packcard-\d+_\d+_\d+-\d+_\d+_\d+_\d+$'
       OR sku ~ '^packcard-\d+_\d+_\d+_\d+_-\d+-\d+$' OR sku ~ '^packcard-\d+_\d+_\d+_\d+_ +_\d+_\d+$'
       OR cat.cat_edition IS NOT NULL
  ), unrec AS (
    -- keys neither a shape nor the catalog recognises: what this call DROPS (the route reports these)
    SELECT raw.sku FROM raw
    WHERE NOT EXISTS (SELECT 1 FROM parsed p WHERE p.sku IS NOT DISTINCT FROM raw.sku)
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
    'gaps_now',         (SELECT count(*) FROM calc WHERE gap_now),
    'unrecognised',     (SELECT count(*) FROM unrec),
    'unrecognised_sample', (SELECT coalesce(jsonb_agg(k), '[]'::jsonb) FROM (SELECT DISTINCT coalesce(sku, '') AS k FROM unrec ORDER BY 1 LIMIT 3) x)
  )
$$;

