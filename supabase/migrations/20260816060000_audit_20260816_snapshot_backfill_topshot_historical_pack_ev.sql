-- Snapshot migration: public.backfill_topshot_historical_pack_ev(integer).
--
-- pg_cron `rpc-backfill-historical-pack-ev` @ `13 * * * *`. Applied to prod via
-- the Supabase MCP with no committed migration file, which made it UNPINNABLE.
-- This commits the CURRENT LIVE definition verbatim (pg_get_functiondef,
-- 2026-08-16, md5 e3e87cba0b3fa7199ac4fc307892142c). Applying it is a no-op.
--
-- ⚠ OPERATIONAL NOTE: this is one of the three heavy pg_cron jobs CLAUDE.md
-- names as colliding at `:13`, the collision behind the platform-wide disk-IO
-- saturation. Treat any change to its cadence or `p_limit` as an IO-budget
-- change, not a scheduling tweak.
--
-- ── WHAT IT DOES ───────────────────────────────────────────────────────────
-- Backfills pack EV for Top Shot distributions priced at their PRIMARY retail
-- price (unlike refresh_atlas_pack_ev, which prices against the secondary ask).
-- It writes to `pack_ev_history`, the table behind `pack_ev_latest` and the
-- PUBLIC **+EV** badge.
--
-- ── THE GUARDS, AND WHY EACH IS THERE ──────────────────────────────────────
--
--   1. ⚠ `gross_ev <= 3 * sec_ask` — THE SURVIVOR-BIAS CAP, and the reason this
--      function is worth pinning at all. CLAUDE.md records that a DEPLETED Top
--      Shot pool prices at 40-86x: once the good moments are pulled, the drop
--      pool that remains is the tail, and a naive EV computed over an "original"
--      pool produces an absurd multiple. This clause DISCARDS such a row rather
--      than publishing it. Removing it does not merely add noise — it puts a
--      green +EV badge on packs that are nothing of the sort, on an unfurl seen
--      by people who never open the page.
--   2. ⚠ `c.sec_ask IS NOT NULL` — nothing is written unless a live secondary ask
--      exists. That is what gives guard 1 a denominator; without an ask there is
--      no sanity anchor at all, so the row is skipped entirely rather than
--      published unchecked.
--   3. ⚠ The satoshi conversion: `retail_price_usd >= 1000000` is divided by 1e8.
--      Some `pack_distributions.metadata` carries the price in satoshi-like
--      units. Getting this wrong by either direction produces a pack price off
--      by eight orders of magnitude, and every EV derived from it.
--   4. `count(DISTINCT drop_weight) > 1` — only genuinely WEIGHTED pools are
--      backfilled. A pool whose weights are all identical carries no weighting
--      information, so a weighted EV over it would be a uniform average wearing
--      a weighted label.
--   5. ⚠ The 12-hour NOT EXISTS carries `COALESCE(h.edition_count, 0) > 0`, so a
--      SENTINEL row (a failed computation, edition_count 0) does NOT count as
--      covered and the distribution is retried. Dropping that clause would let
--      one failure suppress retries for 12 hours.
--   6. `(c.ev->>'ok')::boolean = true` — a failed EV computation writes NOTHING
--      here. ⚠ That is the OPPOSITE of refresh_atlas_pack_ev, which writes a
--      sentinel row on failure. Both are correct for their own job: the atlas
--      sweep must invalidate its own previous hour, while this one is a backfill
--      whose absence is simply "not yet done" — and guard 5 is what makes the
--      difference safe.
--   7. `COALESCE((c.ev->>'is_positive_ev')::boolean, false)` — never NULL.
--      ⚠ Also unlike refresh_atlas_pack_ev, whose success path can yield NULL.
--   8. `LIMIT GREATEST(p_limit, 1)` — floor at 1; a zero or negative limit would
--      make the job a silent permanent no-op.
--   9. Scoped to the Top Shot collection_id, and requires both a metadata uuid
--      and a positive retail price.
--
-- ⚠ NOTE, recorded but NOT changed: it has no exception handler and writes no
-- `pipeline_runs` row at all, so a failure is invisible except as a stalled
-- backlog. Its return value (rows inserted) is discarded by pg_cron.
--
-- REVERT: a snapshot of what is already live, so reverting the FILE changes
-- nothing in prod. To remove the function:
--   DROP FUNCTION public.backfill_topshot_historical_pack_ev(integer);
-- (plus unscheduling pg_cron `rpc-backfill-historical-pack-ev`). Its writes are
-- append-only snapshots; to undo one run, delete by its `snapshotted_at`.

CREATE OR REPLACE FUNCTION public.backfill_topshot_historical_pack_ev(p_limit integer DEFAULT 200)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_inserted int;
BEGIN
  WITH cand AS (
    SELECT d.dist_id, d.collection_id, d.title, d.metadata,
           CASE WHEN (d.metadata->>'retail_price_usd')::numeric >= 1000000
                THEN round((d.metadata->>'retail_price_usd')::numeric/100000000,2)
                ELSE round((d.metadata->>'retail_price_usd')::numeric,2) END AS pack_price,
           COALESCE(NULLIF((d.metadata->>'number_of_pack_slots'),'')::int, 1) AS slots,
           (SELECT a.lowest_ask FROM pack_ask_state a
             WHERE a.dist_id = d.dist_id AND a.collection_slug = 'nba-top-shot'
               AND a.is_listed IS TRUE AND a.lowest_ask > 0
             ORDER BY a.lowest_ask ASC LIMIT 1) AS sec_ask
    FROM pack_distributions d
    WHERE d.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
      AND d.metadata->>'uuid' IS NOT NULL
      AND (d.metadata->>'retail_price_usd') IS NOT NULL
      AND (d.metadata->>'retail_price_usd')::numeric > 0
      AND (SELECT count(DISTINCT p.drop_weight) FROM pack_drop_pool p
           WHERE p.collection_id = d.collection_id AND p.dist_id = d.dist_id
             AND p.drop_weight > 0) > 1
      AND NOT EXISTS (SELECT 1 FROM pack_ev_history h
                  WHERE h.collection_id = d.collection_id AND h.dist_id = d.dist_id
                    AND h.snapshotted_at > now() - interval '12 hours'
                    AND COALESCE(h.edition_count, 0) > 0)
    LIMIT GREATEST(p_limit, 1)
  ),
  computed AS (
    SELECT c.*, public.compute_pack_ev_per_edition_weighted(c.collection_id, c.dist_id, c.pack_price, c.slots) AS ev
    FROM cand c
  ),
  ins AS (
    INSERT INTO pack_ev_history (pack_listing_id, collection_id, dist_id, pack_name, pack_price,
                                 gross_ev, pack_ev, is_positive_ev, value_ratio, fmv_coverage_pct,
                                 edition_count, typical_ev, snapshotted_at)
    SELECT c.metadata->>'uuid', c.collection_id, c.dist_id, c.title, c.pack_price,
           (c.ev->>'gross_ev')::numeric, (c.ev->>'pack_ev')::numeric,
           COALESCE((c.ev->>'is_positive_ev')::boolean, false),
           (c.ev->>'value_ratio')::numeric, (c.ev->>'fmv_coverage_pct')::smallint,
           (c.ev->>'edition_count')::smallint,
           (c.ev->>'typical_pull_ev')::numeric,
           now()
    FROM computed c
    WHERE (c.ev->>'ok')::boolean = true
      AND c.sec_ask IS NOT NULL
      AND (c.ev->>'gross_ev')::numeric <= 3 * c.sec_ask
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted FROM ins;
  RETURN v_inserted;
END
$function$;
