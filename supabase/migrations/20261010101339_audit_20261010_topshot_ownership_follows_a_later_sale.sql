-- audit_20261010_topshot_ownership_follows_a_later_sale  (known-issues #179)
--
-- MEASURED 2026-10-10 ~3:20 AM PT (Cowork cloud). `topshot_ownership` (267,742 rows) credited 1,497
-- moments to a holder who SOLD them in the last 30 days alone (Claude Code's 2:05 AM PT all-time read:
-- 10,785, 4.0 %). Both writers upsert on nft_id only and neither retires a departed row:
-- `sync-topshot-ownership-dune` re-attributes only on a FRESH Dune execution, and `ownership-onchain-walk`
-- leaves rows a wallet no longer holds so their aging `observed_at` flags them -- but NO reader filters on
-- `observed_at` (`get_edition_top_owners`, `topshot_rookie_collector_leaderboard_mv`,
-- `refresh_topshot_edition_concentration`, `topshot_set_completers_mv`), so every board built on the table
-- shows departed holders. Wrong public data, not missing data.
--
-- THE FIX. `reattribute_topshot_ownership_from_sales(p_since)` moves a row to the buyer of the LATEST Top
-- Shot sale of that nft that is newer than the row's `observed_at` (`sales` is the chain-of-custody record
-- the table lacks), and sets `observed_at = sold_at` so the next walk is still newer. Driven from the SALES
-- side (sold_at > now() - p_since, partition-pruned) so the hourly job reads a day of sales, not the table.
-- Guards: the buyer must be a well-formed Flow address (`^0x[0-9a-f]{16}$`, which is what 74,176 of
-- 74,184 recent buyers are), a buyer equal to the current owner is left alone, and `source` is NEVER
-- changed -- the Dune sync counts `source = 'dune'` rows to decide whether a stale cache needs a PAID
-- re-walk, so relabelling would trigger spend (#179). Every moved row is archived (old owner, old
-- observed_at, source, new owner, the sale) in flowty_archive.audit_20261010_179_ownership_reattrib.
-- pg_cron `rpc-topshot-ownership-reattribute` runs it hourly at :52 over 2 days (overlap is harmless: a
-- row already on the buyer is skipped). This migration also runs the one-off pass over 100 days
-- (the oldest observed_at is 2026-07-06), in two calls so each stays under the 110 s budget.
--
-- Falsifier for the watch: the next `edition_top_owners` read of an edition with a known recent sale
-- still lists the seller; or `pipeline_runs` 'topshot-ownership-reattribute' rows with ok=false.
--
-- REVERT:
--   SELECT cron.unschedule('rpc-topshot-ownership-reattribute');
--   UPDATE public.topshot_ownership o SET owner_address = a.old_owner, observed_at = a.old_observed_at
--     FROM flowty_archive.audit_20261010_179_ownership_reattrib a WHERE a.nft_id = o.nft_id
--     AND o.owner_address = a.new_owner;   -- (latest archive row per nft wins; run per applied_at DESC if re-run)
--   DROP FUNCTION public.reattribute_topshot_ownership_from_sales(interval);
--   (keep the archive table until the restore is verified)

CREATE TABLE IF NOT EXISTS flowty_archive.audit_20261010_179_ownership_reattrib (
  applied_at      timestamptz NOT NULL DEFAULT now(),
  nft_id          text        NOT NULL,
  old_owner       text        NOT NULL,
  old_observed_at timestamptz NOT NULL,
  old_source      text        NOT NULL,
  new_owner       text        NOT NULL,
  sale_sold_at    timestamptz NOT NULL,
  sale_id         uuid
);
REVOKE ALL ON flowty_archive.audit_20261010_179_ownership_reattrib FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.reattribute_topshot_ownership_from_sales(p_since interval DEFAULT interval '2 days')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '110s'
AS $$
DECLARE
  v_started   timestamptz := clock_timestamp();
  v_coll      constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_candidates int := 0;
  v_moved     int := 0;
  v_err       text;
BEGIN
  BEGIN
    CREATE TEMP TABLE _own_moves ON COMMIT DROP AS
    WITH latest AS (
      -- the newest qualifying sale per nft inside the window
      SELECT DISTINCT ON (s.nft_id) s.nft_id, s.id AS sale_id, s.sold_at, lower(s.buyer_address) AS buyer
        FROM public.sales s
       WHERE s.collection_id = v_coll
         AND s.sold_at > now() - p_since
         AND s.buyer_address IS NOT NULL
         AND lower(s.buyer_address) ~ '^0x[0-9a-f]{16}$'
       ORDER BY s.nft_id, s.sold_at DESC, s.id
    )
    SELECT o.nft_id, o.owner_address AS old_owner, o.observed_at AS old_observed_at, o.source AS old_source,
           l.buyer AS new_owner, l.sold_at, l.sale_id
      FROM latest l
      JOIN public.topshot_ownership o ON o.nft_id = l.nft_id
     WHERE l.sold_at > o.observed_at
       AND lower(o.owner_address) <> l.buyer;
    SELECT count(*) INTO v_candidates FROM _own_moves;

    INSERT INTO flowty_archive.audit_20261010_179_ownership_reattrib
      (nft_id, old_owner, old_observed_at, old_source, new_owner, sale_sold_at, sale_id)
    SELECT nft_id, old_owner, old_observed_at, old_source, new_owner, sold_at, sale_id FROM _own_moves;

    UPDATE public.topshot_ownership o
       SET owner_address = m.new_owner,
           observed_at   = m.sold_at
      FROM _own_moves m
     WHERE o.nft_id = m.nft_id
       AND o.owner_address = m.old_owner
       AND o.observed_at = m.old_observed_at;
    GET DIAGNOSTICS v_moved = ROW_COUNT;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
    v_moved := 0;
  END;

  PERFORM public.log_pipeline_run(
    'topshot-ownership-reattribute', v_started, v_candidates, v_moved, 0,
    v_err IS NULL AND v_moved = v_candidates,
    COALESCE(v_err, CASE WHEN v_moved <> v_candidates THEN v_candidates || ' candidate(s), ' || v_moved || ' moved' END),
    'nba_top_shot', NULL, NULL,
    jsonb_build_object('since', p_since::text, 'candidates', v_candidates, 'moved', v_moved, 'via', 'pg_cron',
                       'duration_ms', (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int));

  RETURN jsonb_build_object('since', p_since::text, 'candidates', v_candidates, 'moved', v_moved, 'error', v_err);
END $$;

-- anon-exec: revoked (reattribute_topshot_ownership_from_sales) — a new SECDEF fn that rewrites ownership rows; postgres + service_role only.
REVOKE EXECUTE ON FUNCTION public.reattribute_topshot_ownership_from_sales(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reattribute_topshot_ownership_from_sales(interval) TO postgres, service_role;

SELECT cron.schedule('rpc-topshot-ownership-reattribute', '52 * * * *',
                     $cmd$ SELECT public.reattribute_topshot_ownership_from_sales(interval '2 days') $cmd$);
