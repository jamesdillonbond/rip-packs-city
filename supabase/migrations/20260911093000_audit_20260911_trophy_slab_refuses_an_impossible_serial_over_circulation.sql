-- 2026-09-11 (Cowork deep-audit/QA pass, Trevor asleep).
--
-- 🚨 A TROPHY SLAB PUBLISHED AN ARITHMETICALLY IMPOSSIBLE FACT: `#1017/50`.
-- `serial_number` is taken from `tm.serial_number` (verified server-side against
-- wallet_moments_cache at pin time), while `circulation_count` came from
-- `COALESCE(e.circulation_count, tm.circulation_count)` where `e` resolves via
-- `wmc.edition_key` -- which for a mis-keyed moment is a `::N` PARALLEL whose
-- mint is 50. TWO FIELDS, TWO GRAINS, NO CROSS-CHECK, on the most-shared surface
-- in the product.
--
-- ⭐ THIS IS THE RENDER HALF OF REGISTER ITEM D25, WHICH SAYS IT OUTRIGHT: "the
-- data is not corrupt; the RENDER pairs two different units." The data half (the
-- mis-keyed wmc rows) is a separate, reversible repair; this migration makes the
-- READER refuse to publish an impossible pair no matter what the data does.
--
-- ⚠ NULL IS THE HONEST BRANCH, NOT A COP-OUT. `TrophySlab.tsx` already renders a
-- bare `#1017` when `circulation_count` is null -- true -- where `#1017/50` is
-- false. When the frozen per-moment mint CAN hold the serial we prefer it; when
-- neither source can, we drop the denominator rather than pick a prettier lie.
--
-- ⚠ THE SAME EXPRESSION GOES INTO serial_fmv_estimate. Fixing only the rendered
-- number would leave the #1/perfect-mint premium computed against `/50` -- the
-- repo's own "fix the guard AND the field the observer keys on" rule.
--
-- ⚠ THREE-FILE CHANGE (drift-pinned): this migration, the verbatim copy in
-- supabase/tests/get_trophy_slab_data.sql, and the guard's registration row in
-- __tests__/db-invariants-drift-guard.test.ts which must repoint at THIS file.
--
-- anon-exec: unchanged -- get_trophy_slab_data keeps the ACL it already has;
-- CREATE OR REPLACE FUNCTION does not reset it, so re-revoking would be ACL churn
-- rather than a decision.
--
-- REVERT: re-run 20260726016000_audit_20260726_serial_fmv_consumers_pooled_edition_id.sql,
-- restore the verbatim block in the pinned test from it, and repoint the guard row back.

CREATE OR REPLACE FUNCTION public.get_trophy_slab_data(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'forbidden_cross_user' USING ERRCODE = '42501';
  END IF;

  WITH slabs AS (
    SELECT
      tm.id, tm.slot, tm.moment_id, tm.edition_id,
      COALESCE(e.player_name, tm.player_name) AS player_name,
      COALESCE(e.set_name,    tm.set_name)    AS set_name,
      tm.serial_number,
      CASE
        WHEN tm.serial_number IS NOT NULL
         AND e.circulation_count IS NOT NULL
         AND tm.serial_number > e.circulation_count
        THEN CASE
               WHEN tm.circulation_count IS NOT NULL
                AND tm.serial_number <= tm.circulation_count
               THEN tm.circulation_count
               ELSE NULL::int
             END
        ELSE COALESCE(e.circulation_count, tm.circulation_count)
      END AS circulation_count,
      COALESCE(e.tier::text, tm.tier) AS tier,
      tm.thumbnail_url,
      COALESCE(e.video_url, tm.video_url) AS video_url,
      COALESCE(f.fmv_usd, tm.fmv) AS fmv,
      f.confidence AS fmv_confidence,
      -- Phase 2 serial-adjusted FMV (additive; owner surface renders it now).
      public.serial_fmv_estimate(
        tm.collection_id,
        tm.serial_number,
        CASE
          WHEN tm.serial_number IS NOT NULL
           AND e.circulation_count IS NOT NULL
           AND tm.serial_number > e.circulation_count
          THEN CASE
                 WHEN tm.circulation_count IS NOT NULL
                  AND tm.serial_number <= tm.circulation_count
                 THEN tm.circulation_count
                 ELSE NULL::int
               END
          ELSE COALESCE(e.circulation_count, tm.circulation_count)
        END,
        COALESCE(e.tier::text, tm.tier),
        COALESCE(f.fmv_usd, tm.fmv),
        f.confidence::text,
        (CASE WHEN e.jersey_number > 1 THEN e.jersey_number END),
        e.id
      ) AS serial_fmv,
      COALESCE(
        CASE WHEN e.id IS NOT NULL THEN (
          SELECT jsonb_agg(elem->>'title')
          FROM jsonb_array_elements(public.get_edition_badges_unified(e.id)) elem
          WHERE elem->>'title' IS NOT NULL
        ) END,
        to_jsonb(tm.badges)
      ) AS badges,
      tm.note,
      tm.collection_id,
      c.slug AS collection_slug,
      c.name AS collection_display_name,
      e.play_category AS play_description,
      e.team_name AS team_name,
      e.series AS series,
      tm.pinned_at,
      (
        SELECT ma.buy_price FROM moment_acquisitions ma
        WHERE ma.nft_id = tm.moment_id
        ORDER BY ma.acquired_date DESC NULLS LAST
        LIMIT 1
      ) AS acquired_price,
      (
        SELECT ma.acquisition_method FROM moment_acquisitions ma
        WHERE ma.nft_id = tm.moment_id
        ORDER BY ma.acquired_date DESC NULLS LAST
        LIMIT 1
      ) AS acquisition_method
    FROM trophy_moments tm
    LEFT JOIN LATERAL (
      SELECT w.edition_key
      FROM wallet_moments_cache w
      WHERE w.moment_id = tm.moment_id
        AND w.collection_id = tm.collection_id
        AND w.edition_key IS NOT NULL
      LIMIT 1
    ) wk ON true
    LEFT JOIN editions e
      ON e.external_id    = COALESCE(wk.edition_key, tm.edition_id)
     AND e.collection_id  = tm.collection_id
    LEFT JOIN LATERAL (
      SELECT fs.fmv_usd, fs.confidence
      FROM fmv_snapshots fs
      WHERE fs.edition_id = e.id
      ORDER BY fs.computed_at DESC
      LIMIT 1
    ) f ON true
    LEFT JOIN collections c ON c.id = tm.collection_id
    WHERE tm.user_id = p_user_id
    ORDER BY tm.slot ASC
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(slabs.*) ORDER BY slot), '[]'::jsonb)
  INTO v_result FROM slabs;

  RETURN v_result;
END;
$function$;
