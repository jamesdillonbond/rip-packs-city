-- audit_20260913_record_total_count_so_the_edition_verify_lanes_waste_is_an_instrument
--
-- WHY. `atlas_edition_verify_settle` closes stale listings per edition, but ONLY when a
-- complete snapshot proves it: `v_complete := v_total IS NOT NULL AND v_total <= 200`.
-- That refusal is correct — closing on a partial fetch would fabricate a closure.
--
-- Measured 2026-09-13 (PT): of 12,597 editions verified since 09-06, only 3,268 (25.9%)
-- came back complete=true. The other 9,329 (74.1%) closed NOTHING, because their
-- totalCount exceeds the request's hardcoded `limit := 200` (no offset, no open-only
-- filter), while `atlas_edition_verify_dispatch` re-picks anything whose verified_at is
-- older than 24h — so those editions are re-probed every day, forever, and can never
-- conclude.
--
-- That 74% is currently an INFERENCE: `complete=false` conflates "too big to conclude"
-- with "no response / null totalCount". This migration records the number the settle
-- already computes, so the waste becomes an INSTRUMENT instead:
--
--   SELECT count(*) FILTER (WHERE NOT complete AND total_count > 200) AS too_big,
--          count(*) FILTER (WHERE NOT complete AND total_count IS NULL) AS no_count
--     FROM public.topshot_atlas_edition_verified;
--
-- BEHAVIOUR IS UNCHANGED. The only difference is that v_total is persisted. No
-- predicate, no closure rule, and no dispatch selection is touched. Nothing reads
-- total_count yet.
--
-- REVERT: ALTER TABLE public.topshot_atlas_edition_verified DROP COLUMN total_count;
--         then CREATE OR REPLACE the function from the body below minus total_count.

ALTER TABLE public.topshot_atlas_edition_verified
  ADD COLUMN IF NOT EXISTS total_count integer;

COMMENT ON COLUMN public.topshot_atlas_edition_verified.total_count IS
  'pagination.totalCount from the edition verify probe. > 200 means the snapshot was incomplete, so the settle could not close anything for this edition. NULL means no usable response. Written by atlas_edition_verify_settle; recorded 2026-09-13 to make the lane''s wasted-call rate measurable.';

-- anon-exec: unchanged — atlas_edition_verify_settle is ALREADY revoked in prod, and this is
-- a CREATE OR REPLACE of a pre-existing function, which does NOT reset a function ACL.
-- Verified on the live DB 2026-09-13 (PT), immediately before adding this line:
--   has_function_privilege('anon', …)          = false
--   has_function_privilege('authenticated', …) = false
--   has_function_privilege('public', …)        = false
-- So a REVOKE here would be a no-op that READS AS HARDENING — the wrong statement to
-- leave in the record. Same shape as 20260822205500 / 20260822211000.
--
-- ⚠ COMMENT-ONLY, ADDED RETROACTIVELY 2026-09-13 after this file's own commit (3840baf)
-- took `main` red on `migration-new-function-states-its-anon-exec-decision` (CI #5476),
-- and THREE consecutive docs-only pushes then reported green without re-running it —
-- `unit-tests-shard` is gated on `needs.changes.outputs.code == 'true'`. No SQL changed;
-- parity matches on migration NAME, and an applied migration's file cannot alter prod.
-- Live body re-read immediately before this replace (md5 8b8ccb3846a65a71289a4775a0445c73,
-- length 2188) per the CREATE OR REPLACE full-body-write rule.
CREATE OR REPLACE FUNCTION public.atlas_edition_verify_settle()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE q record; v_total int; v_complete boolean; v_settled int := 0; v_closed int := 0; v_n int;
BEGIN
  FOR q IN
    SELECT a.request_id, a.dispatched_at, substr(a.error, length('__edition__') + 1) AS atlas_edition_id, a.rows_upserted,
           (r0.content::jsonb->'pagination'->>'totalCount')::int AS total_count
      FROM public.topshot_atlas_market_requests a
      LEFT JOIN net._http_response r0 ON r0.id = a.request_id
     WHERE a.offset_at = -4 AND a.drained_at IS NOT NULL AND a.status_code = 200
       AND a.error LIKE '\_\_edition\_\_%'
     ORDER BY a.dispatched_at
     LIMIT 20
  LOOP
    v_total := q.total_count;
    v_complete := v_total IS NOT NULL AND v_total <= 200;
    IF v_complete THEN
      UPDATE public.topshot_atlas_market_events ev
         SET completed = true
       WHERE ev.product = 'nba' AND ev.atlas_edition_id = q.atlas_edition_id
         AND NOT ev.completed AND ev.last_seen_at < q.dispatched_at;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_closed := v_closed + v_n;
    END IF;
    INSERT INTO public.topshot_atlas_edition_verified (atlas_edition_id, verified_at, complete, open_listings, open_offers, total_count)
    VALUES (q.atlas_edition_id, q.dispatched_at, v_complete,
            (SELECT count(*) FROM public.topshot_atlas_market_events e2 WHERE e2.product='nba' AND e2.atlas_edition_id = q.atlas_edition_id AND e2.kind='listing' AND NOT e2.completed),
            (SELECT count(*) FROM public.topshot_atlas_market_events e2 WHERE e2.product='nba' AND e2.atlas_edition_id = q.atlas_edition_id AND e2.kind='offer' AND NOT e2.completed),
            v_total)
    ON CONFLICT (atlas_edition_id) DO UPDATE
      SET verified_at = EXCLUDED.verified_at, complete = EXCLUDED.complete,
          open_listings = EXCLUDED.open_listings, open_offers = EXCLUDED.open_offers,
          total_count = EXCLUDED.total_count;
    UPDATE public.topshot_atlas_market_requests SET offset_at = -5 WHERE request_id = q.request_id;
    v_settled := v_settled + 1;
  END LOOP;
  RETURN jsonb_build_object('settled', v_settled, 'closed', v_closed);
END $function$;
