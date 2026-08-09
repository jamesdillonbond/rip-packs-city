-- 2026-08-09 — STEP 2 of 2: swap the perfect-mint board onto the ed_med-restricted definition.
-- ONE TRANSACTION, so there is no instant where the public board is missing.
--
-- MEASURED: the v2 MV refreshed in **9 SECONDS** (pg_cron jobid 260, 20:03:03 -> 20:03:12Z) against
-- 300-460s for the current definition, which has also blown the 600s ceiling repeatedly.
-- ⚠ TWO HONEST CAVEATS on that number, because it is not apples-to-apples:
--   (1) the 9s was a PLAIN `REFRESH`, while production uses `REFRESH ... CONCURRENTLY`, which
--       additionally builds a diff and applies it — so the production figure will be higher.
--   (2) two planner-only EXPLAINs on this same shape ran moments earlier, so index pages may have
--       been warm. Cold cost will be higher.
--   The claim I stand behind is the ROW-SCAN reduction (396,644 -> 6,202, -98.4%) and the direction;
--   the real production number is the post-ship watch item below, not something measured here.
--
-- EQUIVALENCE — proven by construction AND corroborated:
--   By construction: restricting a GROUP BY's input to a set of group keys removes whole groups and
--   cannot alter a surviving group's membership, so each survivor's percentile_cont median and
--   count(*) — and therefore `HAVING count(*) >= 15` — are unchanged; and the final
--   `perfect JOIN ed_med` is INNER, so every removed group was already discarded.
--   Corroborated live against the UNRESTRICTED aggregate for all 164 editions v2 produced:
--     164 rows / 164 matched / **0 median mismatches** / 1 count mismatch / 0 below the HAVING cut.
--   ⚠ That 1 mismatch was CHASED, not waved off: edition dc1cb92a-1ac1-46e4-b0a3-755aa6d6f99a,
--   delta +7, and exactly 7 qualifying rows were ingested after the 20:03:03Z refresh stamp. It is
--   refresh-time drift, not a definitional difference. (The ideal same-instant EXCEPT diff could not
--   be run: computing the OLD definition inline exceeds the 55s client cap — itself corroboration.)
--
-- The swap RENAMES v2 into the original name rather than repointing consumers, because two things
-- key on that exact string: the pg_cron command text, and `board_mv_refresh_max_stale_hours()`,
-- which matches jobs to boards with `command ILIKE '%' || matview_name || '%'`. Renaming keeps the
-- watchdog, the cron entry, and the watchlist row all valid with no further edits.
--
-- REVERT: re-apply the pre-swap definition from migration
--   20260809145945's sibling (or `git log` the committed board definition), i.e. recreate
--   mv_topshot_perfect_mint_premiums_board with the UNRESTRICTED ed_med CTE, its unique index on
--   edition_id, then the view below + `ALTER VIEW … SET (security_invoker = on)` + the same grants.

DO $mig$
DECLARE
  v_other_deps int;
  v_v2_rows    int;
BEGIN
  -- Pre-condition: nothing other than the known view depends on the view we are about to recreate.
  SELECT count(*) INTO v_other_deps
    FROM pg_depend d
    JOIN pg_rewrite r ON r.oid = d.objid
    JOIN pg_class dep ON dep.oid = r.ev_class
   WHERE d.refobjid = 'public.topshot_perfect_mint_premiums_board'::regclass
     AND dep.relname <> 'topshot_perfect_mint_premiums_board';
  IF v_other_deps > 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: % other object(s) depend on topshot_perfect_mint_premiums_board — resolve before swapping', v_other_deps;
  END IF;

  -- Pre-condition: v2 is populated (a WITH NO DATA swap would dark-board the public surface).
  EXECUTE 'SELECT count(*) FROM public.mv_topshot_perfect_mint_premiums_board_v2' INTO v_v2_rows;
  IF v_v2_rows < 50 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: v2 holds only % rows — refusing to swap', v_v2_rows;
  END IF;
END
$mig$;

DROP VIEW public.topshot_perfect_mint_premiums_board;
DROP MATERIALIZED VIEW public.mv_topshot_perfect_mint_premiums_board;

ALTER MATERIALIZED VIEW public.mv_topshot_perfect_mint_premiums_board_v2
  RENAME TO mv_topshot_perfect_mint_premiums_board;
ALTER INDEX public.mv_topshot_perfect_mint_premiums_board_v2_edition_id_key
  RENAME TO mv_topshot_perfect_mint_premiums_board_edition_id_key;

-- Recreate the consumer view verbatim (pass-through + ORDER BY premium_multiple DESC).
CREATE VIEW public.topshot_perfect_mint_premiums_board AS
 SELECT edition_id,
    external_id,
    player_name,
    set_name,
    tier,
    circulation_count,
    thumbnail_url,
    moment_id,
    nft_id,
    perfect_serial,
    edition_median_usd,
    perfect_last_sale_usd,
    premium_multiple,
    perfect_sold_at,
    edition_sales_180d,
    is_conflated
   FROM mv_topshot_perfect_mint_premiums_board
  ORDER BY premium_multiple DESC;

-- CREATE VIEW does not carry reloptions — re-assert (this exact view class bit us 2026-08-03).
ALTER VIEW public.topshot_perfect_mint_premiums_board SET (security_invoker = on);

-- Restore the original grant posture: the public board is reachable ONLY through the view; the MV
-- itself stays unreadable by anon/authenticated.
GRANT SELECT ON public.topshot_perfect_mint_premiums_board TO anon, authenticated, service_role;
REVOKE SELECT ON public.mv_topshot_perfect_mint_premiums_board FROM PUBLIC;
REVOKE SELECT ON public.mv_topshot_perfect_mint_premiums_board FROM anon, authenticated;
GRANT SELECT ON public.mv_topshot_perfect_mint_premiums_board TO service_role;