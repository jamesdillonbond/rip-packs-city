-- anon-exec: intentional — new SECURITY DEFINER maintenance function; REVOKEd from PUBLIC/anon/authenticated below, service_role only (dedupe_topshot_dupe_sales)
-- audit_20260908: known-issue #68 — remove the duplicate Top Shot sales, reversibly and in bounded pages.
--
-- WHY. Every sale written between ~2020-11 and 2026-08-28 by two of {topshot_gql, onchain, offer_fill,
-- ts_history_backfill_v1, NULL} was stored TWICE: same `nft_id`, same `transaction_hash`, same
-- `price_usd`. One on-chain transaction cannot be two sales, so the extra row is redundant by
-- construction. Measured 2026-09-08: **30,636 such pairs in the last 90 days, 20,592 of them inside the
-- live 30-day FMV window**, and **31,682 removable rows in the 2026 partition alone** against 3,216,034
-- Top Shot sales (~1 %). ZERO pairs share the same source and ZERO share the same `sold_at`.
--
-- ⛔ WHY THE EXISTING GUARD NEVER FIRED: `idx_sales_tx_nft_sold` is
-- `UNIQUE (transaction_hash, nft_id, sold_at) WHERE transaction_hash IS NOT NULL` — it CONTAINS
-- `sold_at`, and the writers date the same transaction differently (marketplace clock vs block time),
-- median ~3.4 s apart. Not one pair ever collided, so `ON CONFLICT DO NOTHING` was never reached and the
-- constraint reads as healthy. **A uniqueness constraint containing a timestamp cannot dedupe two
-- writers who disagree about the timestamp; the tell is a violation count of EXACTLY zero.**
--
-- IMPACT OF LEAVING IT: FMV confidence is a count over a rolling 30-day window (MEDIUM >= 5 sales,
-- HIGH >= 7), so a doubled sale is a doubled comp — 598 editions currently hold a MEDIUM they have not
-- earned and 624 a HIGH, ~4.3 points of the go-live M1 metric. The 30-day window clears that by ~09-27,
-- but the ROWS never leave: every all-time sale count, price chart and volume figure on a moment or
-- edition page stays wrong until they are removed. That is why this drains now rather than waiting.
--
-- KEEP-RULE, MEASURED NOT ASSUMED (the filing told the next session to verify this, so it was verified).
-- Completeness across the 30,636 duplicated rows is IDENTICAL on every field that matters —
-- buyer_address, seller_address, serial_number and edition_id are 100 % present on EVERY source. The one
-- real discriminator is `block_height`: present on 100 % of `onchain` and `offer_fill` rows and 0 % of
-- `topshot_gql`, `ts_history_backfill_v1` and NULL-source rows. So the surviving row is chosen by
-- on-chain provenance, not by recency:
--     onchain > offer_fill > topshot_gql > ts_history_backfill_v1 > NULL,  ties broken by sold_at, id.
-- (⚠ This CORRECTS the guess recorded in the #68 filing, which said the GQL row "often lacks" the
-- buyer/seller. It does not — the difference is block_height. Same conclusion, better reason.)
--
-- SAFETY. Nothing is deleted that is not first copied, in the same transaction, into
-- `audit_20260908_ts_dupe_sales` (RLS on, service_role only) together with the id of the row that
-- survived it. Three assertions RAISE — and therefore roll the whole page back — if:
--   (1) rows backed up <> rows deleted;
--   (2) ANY surviving id named by the page is missing from `sales` afterwards  <- the "never removed the
--       last copy of a sale" check, and the one that actually matters;
--   (3) the page tried to delete a row whose group has no survivor.
-- Bounded per call (`p_max`, default 5,000) and date-scoped, because a single window function over all
-- Top Shot partitions exceeds the statement timeout — 2026 alone is fine, the older years are walked
-- separately.
--
-- REVERT (a stranger can run this) — restores every deleted row byte-for-byte:
--   INSERT INTO public.sales
--     SELECT id, moment_id, edition_id, collection_id, serial_number, price_usd, price_native, currency,
--            seller_address, buyer_address, marketplace, transaction_hash, block_height, sold_at, nft_id,
--            collection, source
--       FROM public.audit_20260908_ts_dupe_sales;   -- column list per the table's own definition
--   DROP FUNCTION public.dedupe_topshot_dupe_sales(timestamptz, timestamptz, int);
--   DROP TABLE public.audit_20260908_ts_dupe_sales;
-- FMV self-heals afterwards: fmv-recalc sweeps ~500 editions every 8-12 min and re-derives confidence
-- from whatever `sales` holds, so no manual recompute is required — only patience and a re-read of M1.

CREATE TABLE IF NOT EXISTS public.audit_20260908_ts_dupe_sales
  (LIKE public.sales INCLUDING DEFAULTS);

ALTER TABLE public.audit_20260908_ts_dupe_sales
  ADD COLUMN IF NOT EXISTS kept_sale_id uuid,
  ADD COLUMN IF NOT EXISTS backed_up_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.audit_20260908_ts_dupe_sales ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.audit_20260908_ts_dupe_sales FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.audit_20260908_ts_dupe_sales TO service_role;

CREATE INDEX IF NOT EXISTS idx_a20260908_dupe_sales_kept
  ON public.audit_20260908_ts_dupe_sales (kept_sale_id);

CREATE OR REPLACE FUNCTION public.dedupe_topshot_dupe_sales(
  p_from timestamptz DEFAULT '2026-01-01',
  p_to   timestamptz DEFAULT '2027-01-01',
  p_max  int DEFAULT 5000)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_started  timestamptz := clock_timestamp();
  v_ts       constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_page     int := 0;
  v_backed   int := 0;
  v_deleted  int := 0;
  v_orphans  int := 0;
  v_nosurv   int := 0;
  v_remain   int;
BEGIN
  PERFORM set_config('statement_timeout', '110000', true);

  DROP TABLE IF EXISTS _dd_page;
  CREATE TEMP TABLE _dd_page ON COMMIT DROP AS
  WITH ranked AS (
    SELECT s.id,
           row_number() OVER w  AS rn,
           first_value(s.id) OVER w AS keep_id
      FROM public.sales s
     WHERE s.collection_id = v_ts
       AND s.transaction_hash IS NOT NULL
       AND s.sold_at >= p_from AND s.sold_at < p_to
    WINDOW w AS (PARTITION BY s.nft_id, s.transaction_hash, s.price_usd
                 ORDER BY CASE COALESCE(s.source, '~')
                            WHEN 'onchain'                THEN 1
                            WHEN 'offer_fill'             THEN 2
                            WHEN 'topshot_gql'            THEN 3
                            WHEN 'ts_history_backfill_v1' THEN 4
                            ELSE 5 END,
                          s.sold_at, s.id)
  )
  SELECT id, keep_id FROM ranked WHERE rn > 1 LIMIT p_max;

  SELECT count(*) INTO v_page FROM _dd_page;

  -- Assertion 3 (pre-flight): every page row must name a survivor that is NOT itself in the page.
  SELECT count(*) INTO v_nosurv
    FROM _dd_page d
   WHERE d.keep_id IS NULL OR EXISTS (SELECT 1 FROM _dd_page k WHERE k.id = d.keep_id);
  IF v_nosurv > 0 THEN
    RAISE EXCEPTION 'dedupe aborted: % page row(s) name no surviving sale', v_nosurv;
  END IF;

  IF v_page > 0 THEN
    INSERT INTO public.audit_20260908_ts_dupe_sales
    SELECT s.*, d.keep_id, now()
      FROM public.sales s JOIN _dd_page d ON d.id = s.id;
    GET DIAGNOSTICS v_backed = ROW_COUNT;

    DELETE FROM public.sales s USING _dd_page d WHERE s.id = d.id;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;

    -- Assertion 1: nothing deleted that was not backed up.
    IF v_backed <> v_deleted THEN
      RAISE EXCEPTION 'dedupe aborted: backed up % but deleted %', v_backed, v_deleted;
    END IF;

    -- Assertion 2 (the one that matters): every survivor is still in sales.
    SELECT count(*) INTO v_orphans
      FROM (SELECT DISTINCT keep_id FROM _dd_page) d
     WHERE NOT EXISTS (SELECT 1 FROM public.sales s WHERE s.id = d.keep_id);
    IF v_orphans > 0 THEN
      RAISE EXCEPTION 'dedupe aborted: % sale(s) lost their last copy', v_orphans;
    END IF;
  END IF;

  SELECT count(*) INTO v_remain
    FROM (SELECT 1 FROM public.sales s
           WHERE s.collection_id = v_ts AND s.transaction_hash IS NOT NULL
             AND s.sold_at >= p_from AND s.sold_at < p_to
           GROUP BY s.nft_id, s.transaction_hash, s.price_usd
          HAVING count(*) > 1) q;

  PERFORM public.log_pipeline_run(
    'topshot-dupe-sales-dedupe', v_started, v_page, v_deleted, 0, true, NULL,
    'nba_top_shot', NULL, NULL,
    jsonb_build_object('page', v_page, 'backed_up', v_backed, 'deleted', v_deleted,
                       'groups_still_duplicated', v_remain,
                       'range_from', p_from, 'range_to', p_to,
                       'issue', 'known-issue #68',
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));

  RETURN jsonb_build_object('page', v_page, 'backed_up', v_backed, 'deleted', v_deleted,
                            'groups_still_duplicated', v_remain);
END $$;

REVOKE ALL ON FUNCTION public.dedupe_topshot_dupe_sales(timestamptz, timestamptz, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dedupe_topshot_dupe_sales(timestamptz, timestamptz, int) TO service_role;