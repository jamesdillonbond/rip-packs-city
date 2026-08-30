-- audit_20260830_pinnacle_resolver_claims_null_buyers_not_only_the_trade_contract
--
-- WHY (measured 2026-08-30 03:0x-03:2xZ, cloud autonomous pass):
--   public.claim_pinnacle_resolver_batch() claims ONLY rows whose buyer_address
--   equals the Disney Pinnacle trade contract '0xedf9df96c92f4595'
--   (docs/reference/apis-and-cadence.md). Since 2026-08-13T01:11:42Z the
--   pinnacle-sales-indexer has written buyer_address = NULL instead of that
--   placeholder: the trade-contract count is 0 on EVERY one of the last 35 days,
--   while buyer_null went 0 (through 08-12) -> 197/406 (08-13) -> 16/16 (08-30).
--   6,671 of 7,872 pinnacle_sales rows since 08-13 (84.7%) have NULL buyer AND
--   NULL seller, resolution_status NULL, resolution_attempts 0 -- never claimed.
--   public.pinnacle_resolver_status uses the same predicate and therefore reported
--   total_still_unresolved = 0 while 92% of recent Pinnacle sales had no buyer.
--   The only symptom that ever surfaced was a cron_silent MEDIUM arm on
--   pinnacle-resolve-buyers, which names the wrong thing: the route returns
--   {status:"no_work"} BEFORE log_pipeline_run, so an empty claim writes no
--   pipeline_runs row and a drained-by-predicate queue is indistinguishable from
--   a dead cron.
--
-- POSITIVE CONTROL (run before applying): 3 of 3 sampled NULL-buyer rows from
--   2026-08-30 02:45-03:01Z resolve to a real buyer AND seller when their
--   tx_hash (split_part(id,'_',1)) is fetched from rest-mainnet.onflow.org and
--   the ROUTE'S OWN regex is applied:
--     e8172f26...0107 -> buyer 0x834b160178840864 / seller 0xb830d5c9d3ae4cd8
--     8d701b9d...9229 -> buyer 0x23dde701491082ad / seller 0xab2092d281a9248b
--     12b1fd2b...6b82 -> buyer 0x23dde701491082ad / seller 0x8e655887a360cc3f
--   The buyers are recoverable; only the claim predicate was hiding them.
--
-- PRECEDENT: the sibling AllDay/Golazos backfill already treats NULL and the
--   trade contract as the SAME unresolved state -- ledger 2026-07-06,
--   /api/admin/backfill-allday-buyers: "gated on the buyer still being
--   unresolved (NULL or an intermediary in {... trade contract
--   0xedf9df96c92f4595})". This migration brings Pinnacle to that semantics.
--
-- COST (measured, warm): the widened claim SELECT plans as a Parallel Seq Scan
--   on pinnacle_sales (195,529 rows / 151 MB), 6,651 buffers ALL shared-hit,
--   ZERO reads, 43.7 ms, 15,708 candidate rows. Cold it reads the table once.
--   At batch 50 the queue clears in ~26 h and is self-limiting
--   (resolution_attempts < 5, 1-hour re-attempt backoff, pre_spork terminal).
--
-- SCOPE OF THE FIX: this is a COMPENSATING CONTROL, not the root fix. The root
--   cause is upstream in pinnacle-sales-indexer, which filled buyers inline
--   through 08-12 and stopped -- route/worker code this cloud session cannot
--   push. Masking is prevented BY CONSTRUCTION: rows the RESOLVER fixes carry
--   resolution_status='resolved', rows the INDEXER fills inline carry NULL, so
--     SELECT count(*) FROM pinnacle_sales
--      WHERE resolution_status='resolved' AND sold_at > '2026-08-13'
--   measures exactly how much the indexer is failing to do inline. If that
--   number keeps rising after the backlog drains, the indexer is still broken.
--   The view also now returns unresolved_null_buyer / unresolved_trade_contract
--   split out, so the two populations never merge into one number again.
--
-- REVERT PATH (restores both objects verbatim):
--   CREATE OR REPLACE FUNCTION public.claim_pinnacle_resolver_batch(p_limit integer DEFAULT 50)
--   RETURNS TABLE(id text, tx_hash text, sold_at timestamptz, attempts integer)
--   LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $revert$
--   BEGIN
--     RETURN QUERY
--     WITH claimed AS (
--       SELECT ps.id FROM pinnacle_sales ps
--       WHERE ps.buyer_address = '0xedf9df96c92f4595'
--         AND COALESCE(ps.resolution_status,'') NOT IN ('pre_spork','failed','resolved')
--         AND (ps.last_resolution_attempt_at IS NULL OR ps.last_resolution_attempt_at < now() - interval '1 hour')
--         AND COALESCE(ps.resolution_attempts,0) < 5
--       ORDER BY ps.last_resolution_attempt_at NULLS FIRST, ps.sold_at DESC
--       LIMIT p_limit FOR UPDATE SKIP LOCKED
--     ), marked AS (
--       UPDATE pinnacle_sales ps SET last_resolution_attempt_at = now(),
--         resolution_attempts = COALESCE(ps.resolution_attempts,0) + 1
--       FROM claimed WHERE ps.id = claimed.id
--       RETURNING ps.id, ps.sold_at, ps.resolution_attempts
--     )
--     SELECT m.id, split_part(m.id,'_',1) AS tx_hash, m.sold_at, m.resolution_attempts AS attempts
--     FROM marked m;
--   END; $revert$;
--   -- and re-create the view with a bare buyer_address = '0xedf9df96c92f4595'
--   -- in place of each (buyer_address = '0xedf9df96c92f4595' OR buyer_address IS NULL),
--   -- dropping the two new columns, then
--   -- ALTER VIEW public.pinnacle_resolver_status SET (security_invoker = on);
--
-- ⚠ SCOPE OF THE NO-PUSH NOTE: the inability to commit this file is specific to
--   THIS CLOUD SESSION. Trevor's machine and Claude Code push normally via the
--   PAT in remote.origin.pushurl. COMMIT THIS FILE AS USUAL.

DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'claim_pinnacle_resolver_batch'
      AND p.prosrc LIKE '%ps.buyer_address = ''0xedf9df96c92f4595''%'
      AND p.prosrc NOT LIKE '%buyer_address IS NULL%'
  ) THEN
    RAISE EXCEPTION 'claim_pinnacle_resolver_batch is not the pre-widening shape this migration expects; aborting.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'pinnacle_resolver_status' AND c.relkind = 'v'
  ) THEN
    RAISE EXCEPTION 'pinnacle_resolver_status view is missing; aborting.';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.claim_pinnacle_resolver_batch(p_limit integer DEFAULT 50)
RETURNS TABLE(id text, tx_hash text, sold_at timestamptz, attempts integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    SELECT ps.id
    FROM pinnacle_sales ps
    -- WIDENED 2026-08-30: NULL and the trade contract are the SAME unresolved
    -- state (matches the AllDay/Golazos backfill's gate, ledger 2026-07-06).
    WHERE (ps.buyer_address = '0xedf9df96c92f4595' OR ps.buyer_address IS NULL)
      AND COALESCE(ps.resolution_status, '') NOT IN ('pre_spork', 'failed', 'resolved')
      AND (ps.last_resolution_attempt_at IS NULL
           OR ps.last_resolution_attempt_at < now() - interval '1 hour')
      AND COALESCE(ps.resolution_attempts, 0) < 5
    ORDER BY ps.last_resolution_attempt_at NULLS FIRST, ps.sold_at DESC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ),
  marked AS (
    UPDATE pinnacle_sales ps SET
      last_resolution_attempt_at = now(),
      resolution_attempts = COALESCE(ps.resolution_attempts, 0) + 1
    FROM claimed
    WHERE ps.id = claimed.id
    RETURNING ps.id, ps.sold_at, ps.resolution_attempts
  )
  SELECT
    m.id,
    split_part(m.id, '_', 1) AS tx_hash,
    m.sold_at,
    m.resolution_attempts AS attempts
  FROM marked m;
END;
$fn$;

CREATE OR REPLACE VIEW public.pinnacle_resolver_status AS
SELECT
  count(*) FILTER (
    WHERE (buyer_address = '0xedf9df96c92f4595' OR buyer_address IS NULL)
      AND COALESCE(resolution_status, '') = ''
  ) AS pending,
  count(*) FILTER (
    WHERE (buyer_address = '0xedf9df96c92f4595' OR buyer_address IS NULL)
      AND last_resolution_attempt_at IS NOT NULL
  ) AS in_progress_or_attempted,
  count(*) FILTER (WHERE resolution_status = 'resolved') AS resolved,
  count(*) FILTER (WHERE resolution_status = 'pre_spork') AS pre_spork,
  count(*) FILTER (WHERE resolution_status = 'failed') AS failed,
  count(*) FILTER (
    WHERE (buyer_address = '0xedf9df96c92f4595' OR buyer_address IS NULL)
      AND COALESCE(resolution_attempts, 0) >= 5
  ) AS retries_exhausted,
  count(*) FILTER (
    WHERE (buyer_address = '0xedf9df96c92f4595' OR buyer_address IS NULL)
      AND sold_at >= (now() - '24:00:00'::interval)
  ) AS unresolved_24h,
  count(*) FILTER (
    WHERE (buyer_address = '0xedf9df96c92f4595' OR buyer_address IS NULL)
  ) AS total_still_unresolved,
  min(sold_at) FILTER (
    WHERE (buyer_address = '0xedf9df96c92f4595' OR buyer_address IS NULL)
  ) AS oldest_unresolved,
  count(*) FILTER (WHERE buyer_address IS NULL) AS unresolved_null_buyer,
  count(*) FILTER (WHERE buyer_address = '0xedf9df96c92f4595') AS unresolved_trade_contract
FROM pinnacle_sales;

ALTER VIEW public.pinnacle_resolver_status SET (security_invoker = on);
