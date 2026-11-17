-- Snapshot migration: public.refresh_atlas_pack_ev().
--
-- pg_cron `rpc-atlas-pack-ev` @ `25 * * * *`. Applied to prod via the Supabase
-- MCP with no committed migration file, which made it UNPINNABLE. This commits
-- the CURRENT LIVE definition verbatim (pg_get_functiondef, 2026-08-16,
-- md5 acbe79769403d75542bf17f1550959a9). Applying it is a no-op against prod.
--
-- ── WHAT IT DOES ───────────────────────────────────────────────────────────
-- Hourly, for every Top Shot distribution whose drop pool came from ATLAS, it
-- computes pack EV against the current secondary ask and appends a row to
-- `pack_ev_history` — the table behind `pack_ev_latest` and the PUBLIC **+EV**
-- badge. `is_positive_ev` is the single boolean a collector reads as "buying
-- this pack is worth it", so every guard below is an honesty guard.
--
-- ── THE HONESTY PROPERTIES ─────────────────────────────────────────────────
--
--   1. ⚠ `is_positive_ev` requires `r.lowest_ask > 0`. With no live ask
--      `lowest_ask` is NULL, `NULL > 0` is NULL, and the flag is false. **A pack
--      whose price we do not know can never be published as +EV** — the claim
--      is about a MARGIN, and there is no margin without a price.
--   2. ⚠ `value_ratio` is NULL when there is no ask, never a fabricated number.
--      A ratio against an absent or zero price is UNDEFINED, not enormous — the
--      `|| 1` divide-by-zero class CLAUDE.md documents on the profile page.
--   3. ⚠ `pack_ev` is `gross_ev - COALESCE(lowest_ask, 0)`, so a pack with NO
--      ask still gets a positive-looking `pack_ev` equal to its gross EV. That
--      is deliberate and is exactly why property 1 lives on a SEPARATE column:
--      `pack_ev` is an arithmetic result, `is_positive_ev` is the CLAIM. Anything
--      rendering a buy signal must read the flag, never the sign of pack_ev.
--   4. ⚠ A FAILED EV COMPUTATION STILL WRITES A ROW, with `gross_ev` 0,
--      `typical_ev` NULL and `is_positive_ev` FALSE. Skipping would leave the
--      previous hour's row as `pack_ev_latest`, so a pack that stopped being
--      computable would keep publishing a stale +EV badge indefinitely. Note
--      `(ev->>'ok')::boolean IS NOT TRUE` — `IS NOT TRUE`, so a NULL `ok` takes
--      the failure branch rather than falling through as success.
--   5. `price_source` is 'secondary' or 'none', and `primary_available` is
--      hard-false: the Atlas pool is a secondary-market source, so the row never
--      implies a primary drop price exists.
--   6. The ask join requires `is_listed IS TRUE AND lowest_ask > 0` — a delisted
--      pack or a zero ask is treated as HAVING NO ASK, not as a $0 pack.
--   7. `LEAST(edition_count, 32767)` — `edition_count` is smallint; without the
--      clamp a large pool would raise 22003 and abort the whole hourly sweep.
--   8. `GREATEST(COALESCE(number_of_pack_slots, 1), 1)` — slots floor at 1.
--      CLAUDE.md records that `number_of_pack_slots` coverage is only ~83% on
--      Top Shot, so the COALESCE is load-bearing, not defensive noise.
--
-- ⚠ NOTE FOR A FUTURE EDITOR, recorded but deliberately NOT changed: the
-- `EXCEPTION WHEN OTHERS` handler returns `{ok:false}` WITHOUT re-raising and
-- WITHOUT logging a pipeline_runs row — `log_pipeline_run` is only reached on
-- the success path. The cron discards the return value, so a failed sweep is
-- invisible in `pipeline_runs` and indistinguishable from "never scheduled".
-- Same shape as the AllDay/Golazos badge refreshers and the trust-precompute
-- legs. Additionally, PostgreSQL excludes QUERY_CANCELED from OTHERS, so a
-- `statement_timeout = 120s` kill does not even reach this handler.
--
-- REVERT: a snapshot of what is already live, so reverting the FILE changes
-- nothing in prod. To remove the function:
--   DROP FUNCTION public.refresh_atlas_pack_ev();
-- (plus unscheduling pg_cron `rpc-atlas-pack-ev`). Its writes are append-only
-- snapshots; to undo one sweep, delete by its `snapshotted_at`.

CREATE OR REPLACE FUNCTION public.refresh_atlas_pack_ev()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_cid uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  r record;
  ev jsonb;
  v_gross numeric;
  v_typical numeric;
  v_written int := 0;
  v_now timestamptz := now();
BEGIN
  FOR r IN
    SELECT DISTINCT p.dist_id,
           pd.metadata->>'uuid' AS listing_uuid,
           COALESCE(pd.title, pd.metadata->>'name') AS title,
           GREATEST(COALESCE((pd.metadata->>'number_of_pack_slots')::int, 1), 1) AS slots,
           pas.lowest_ask
    FROM pack_drop_pool p
    JOIN pack_distributions pd ON pd.collection_id = v_cid AND pd.dist_id = p.dist_id
    LEFT JOIN pack_ask_state pas ON pas.collection_slug = 'nba-top-shot' AND pas.dist_id = p.dist_id
                                 AND pas.is_listed IS TRUE AND pas.lowest_ask > 0
    WHERE p.collection_id = v_cid AND p.pool_source = 'atlas'
  LOOP
    ev := public.compute_pack_ev_per_edition_weighted(v_cid, r.dist_id, COALESCE(r.lowest_ask, 0), r.slots);
    IF (ev->>'ok')::boolean IS NOT TRUE THEN
      INSERT INTO pack_ev_history (pack_listing_id, collection_id, dist_id, pack_name, pack_price,
        primary_price, secondary_ask, price_source, primary_available, secondary_available,
        gross_ev, typical_ev, pack_ev, is_positive_ev, value_ratio, fmv_coverage_pct, edition_count, total_unopened, depletion_pct, snapshotted_at)
      VALUES (r.listing_uuid, v_cid, r.dist_id, r.title, COALESCE(r.lowest_ask,0),
        NULL, r.lowest_ask, CASE WHEN r.lowest_ask > 0 THEN 'secondary' ELSE 'none' END,
        false, r.lowest_ask > 0, 0, NULL, 0, false, NULL, NULL, 0, 0, 100, v_now);
      v_written := v_written + 1;
      CONTINUE;
    END IF;
    v_gross := (ev->>'gross_ev')::numeric;
    v_typical := (ev->>'typical_pull_ev')::numeric;
    INSERT INTO pack_ev_history (pack_listing_id, collection_id, dist_id, pack_name, pack_price,
      primary_price, secondary_ask, price_source, primary_available, secondary_available,
      gross_ev, typical_ev, pack_ev, is_positive_ev, value_ratio, fmv_coverage_pct, edition_count, total_unopened, depletion_pct, snapshotted_at)
    VALUES (
      r.listing_uuid, v_cid, r.dist_id, r.title, COALESCE(r.lowest_ask, 0),
      NULL, r.lowest_ask, CASE WHEN r.lowest_ask > 0 THEN 'secondary' ELSE 'none' END,
      false, r.lowest_ask > 0,
      v_gross, v_typical,
      round(v_gross - COALESCE(r.lowest_ask, 0), 2),
      (r.lowest_ask > 0 AND (v_gross - r.lowest_ask) > 0),
      CASE WHEN r.lowest_ask > 0 THEN round(v_gross / r.lowest_ask, 3) ELSE NULL END,
      (ev->>'fmv_coverage_pct')::smallint, LEAST((ev->>'edition_count')::int, 32767), 0, NULL, v_now);
    v_written := v_written + 1;
  END LOOP;

  PERFORM public.log_pipeline_run('topshot-atlas-pack-ev', v_now, v_written, v_written, 0, true, NULL,
    'nba-top-shot', NULL, NULL, jsonb_build_object('rows', v_written));
  RETURN jsonb_build_object('ok', true, 'written', v_written, 'finished_at', now());
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM, 'written', v_written);
END;
$function$;
