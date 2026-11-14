-- audit_20261114_topshot_parallel_sales_follow_their_subedition
--
-- WHAT (Trevor 11-14, "Fix it"): Top Shot PARALLEL moments' sales keep landing on their BASE
-- (Standard) edition, so a parallel's price feeds the Standard printing's sales and FMV. Found from
-- the 2026 rookie post: a Blockchain Dybantsa sale filed under the base Rookie Debut. Measured
-- 11-14 (~2 PM PT) against Atlas's own `parallel` label, last 60 days: 308 sales of moments Atlas
-- calls a parallel sit on a base edition (onchain 240, offer_fill 67, atlas 1), and the monthly
-- count is rising (Sep 18 · Oct 82 · Nov-to-date 208).
--
-- WHY (the #171 residual, still open): every writer files a sale on the parallel edition only when
-- public.topshot_moment_subeditions already holds subedition_id > 0 for its NFT. For 271 of the 308
-- the NFT had NO row at all — a moment minted or first sold after the #171 checkpoint fill is
-- queued for the chain lane only if it is a misattribution candidate — and for the rest the row was
-- resolved AFTER the sale was written. Nothing re-files a sale once the chain answers:
-- remap_topshot_base_keyed_parallel_sales() does exactly that but has no schedule, and a full pass
-- of it joins all 331k mapped parallels to `sales`.
--
-- WHAT THIS DOES — one new function, run every 2 hours:
--   1. QUEUE. Every NFT sold in the last p_days on a base edition THAT HAS PARALLELS, with no
--      subedition row, gets a pending row (subedition_id NULL, base = the sale's edition). The chain
--      lane (TopShot.getMomentsSubedition, ~10k/day) resolves pending rows; a NULL row reads like no
--      row to every consumer. Measured: 3,439 NFTs for 30 days, 6 s cold.
--   2. RE-KEY. Every Top Shot sale on a base edition whose NFT the chain map says is a parallel
--      (subedition_id > 0, resolved in the last p_resolved_days, same base) moves to its
--      `<base>::<sub>` edition when that edition exists — the predicate of
--      remap_topshot_base_keyed_parallel_sales(), scoped to what the chain answered recently.
--      Only edition_id changes; each move is logged to topshot_parallel_sales_rekey_log first.
--      Measured: 591 sales for a 3-day window, 3 s.
--   3. LOG to pipeline_runs ('topshot-parallel-sales-followup'): rows_written = sales moved,
--      extra.queued = NFTs queued. A failure is ok=false with the error, never a 0.
-- The first run below uses p_days 30 / p_resolved_days 3650 (the whole map) to clear the backlog.
-- FMV for the moved editions follows on its next recalculation.
--
-- APPLIED 2026-11-14 ~1:56 PM PT via apply_migration (version 20261114215605) on Trevor's "Fix it".
-- Backlog run: 595 sales re-keyed (logged), 3,447 NFTs queued, 59.7 s, ok. Read back: 0 sales remain
-- on a base edition whose NFT the chain map says is a parallel with an existing target edition.
-- pg_cron job 884 (postgres) '41 */2 * * *'; anon EXECUTE false.
--
-- REVERT:
--   SELECT cron.unschedule('rpc-topshot-parallel-sales-followup');
--   UPDATE public.sales s SET edition_id = l.old_edition_id FROM public.topshot_parallel_sales_rekey_log l
--    WHERE s.id = l.sale_id AND s.sold_at = l.sold_at AND s.edition_id = l.new_edition_id;
--   (pending subedition rows queued by step 1 are left: they are harmless, and the chain lane resolves them)
--   DROP FUNCTION public.topshot_parallel_sales_followup(integer, integer);

CREATE TABLE IF NOT EXISTS public.topshot_parallel_sales_rekey_log (
  sale_id        uuid        NOT NULL,
  sold_at        timestamptz NOT NULL,
  nft_id         text        NOT NULL,
  old_edition_id uuid        NOT NULL,
  new_edition_id uuid        NOT NULL,
  subedition_id  integer     NOT NULL,
  rekeyed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS topshot_parallel_sales_rekey_log_at ON public.topshot_parallel_sales_rekey_log (rekeyed_at);
ALTER TABLE public.topshot_parallel_sales_rekey_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.topshot_parallel_sales_rekey_log FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.topshot_parallel_sales_followup(p_days integer DEFAULT 2, p_resolved_days integer DEFAULT 3)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_ts      constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_queued  integer;
  v_moved   integer;
  v_err     text;
BEGIN
  BEGIN
    -- 1. QUEUE unmapped NFTs sold on a base edition that has parallels.
    WITH par AS MATERIALIZED (
      SELECT DISTINCT split_part(external_id, '::', 1) AS base
        FROM editions
       WHERE collection_id = v_ts AND external_id LIKE '%::%'
    ), cand AS (
      SELECT DISTINCT ON (s.nft_id) s.nft_id, e.external_id AS base
        FROM sales s
        JOIN editions e ON e.id = s.edition_id
        JOIN par ON par.base = e.external_id
       WHERE s.collection_id = v_ts
         AND s.sold_at > now() - make_interval(days => p_days)
         AND s.nft_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM topshot_moment_subeditions m WHERE m.nft_id = s.nft_id)
       ORDER BY s.nft_id, s.sold_at DESC
    ), ins AS (
      INSERT INTO topshot_moment_subeditions (nft_id, base_external_id, subedition_id, queued_at)
      SELECT nft_id, base, NULL, now() FROM cand
      ON CONFLICT (nft_id) DO NOTHING
      RETURNING 1
    )
    SELECT count(*) INTO v_queued FROM ins;

    -- 2. RE-KEY sales of chain-confirmed parallels off their base edition (logged first).
    WITH mv AS (
      SELECT s.id, s.sold_at, s.nft_id, s.edition_id AS old_id, te.id AS new_id, ms.subedition_id
        FROM topshot_moment_subeditions ms
        JOIN sales s     ON s.nft_id = ms.nft_id AND s.collection_id = v_ts
        JOIN editions be ON be.id = s.edition_id
                        AND be.external_id NOT LIKE '%::%'
                        AND be.external_id = ms.base_external_id
        JOIN editions te ON te.collection_id = v_ts
                        AND te.external_id = be.external_id || '::' || ms.subedition_id
       WHERE ms.subedition_id > 0
         AND ms.resolved_at > now() - make_interval(days => p_resolved_days)
    ), logged AS (
      INSERT INTO topshot_parallel_sales_rekey_log (sale_id, sold_at, nft_id, old_edition_id, new_edition_id, subedition_id)
      SELECT id, sold_at, nft_id, old_id, new_id, subedition_id FROM mv
      RETURNING sale_id, sold_at, old_edition_id, new_edition_id
    ), upd AS (
      UPDATE sales s SET edition_id = l.new_edition_id
        FROM logged l
       WHERE s.id = l.sale_id AND s.sold_at = l.sold_at AND s.edition_id = l.old_edition_id
      RETURNING 1
    )
    SELECT count(*) INTO v_moved FROM upd;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := SQLERRM;
  END;

  PERFORM log_pipeline_run(
    'topshot-parallel-sales-followup', v_started,
    NULL,
    CASE WHEN v_err IS NULL THEN v_moved END,
    NULL,
    v_err IS NULL, v_err, 'nba_top_shot', NULL, NULL,
    jsonb_build_object('queued', CASE WHEN v_err IS NULL THEN v_queued END, 'sales_rekeyed', CASE WHEN v_err IS NULL THEN v_moved END,
                       'p_days', p_days, 'p_resolved_days', p_resolved_days));

  IF v_err IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', v_err);
  END IF;
  RETURN jsonb_build_object('ok', true, 'queued', v_queued, 'sales_rekeyed', v_moved);
END
$function$;

REVOKE ALL ON FUNCTION public.topshot_parallel_sales_followup(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.topshot_parallel_sales_followup(integer, integer) TO service_role;

SELECT cron.schedule('rpc-topshot-parallel-sales-followup', '41 */2 * * *',
                     'SELECT public.topshot_parallel_sales_followup(2, 3);');

-- Clear the backlog once: 30 days of unmapped NFTs, every chain-confirmed parallel still on its base.
SELECT public.topshot_parallel_sales_followup(30, 3650);
