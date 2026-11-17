-- 20260913040000_audit_20260913_trophy_art_falls_back_to_the_live_edition_render
--
-- WHAT: public.get_trophy_slab_data — `thumbnail_url` becomes
--       COALESCE(tm.thumbnail_url, e.thumbnail_url). Plus a one-row data repair.
--
-- ⚠ REBASED ONTO 20260911093000 (the impossible-serial guard), which landed in
-- production WHILE this change was being written. The first draft here was built
-- on the definition dumped ~40 minutes earlier and would have SILENTLY REVERTED
-- that guard — caught only because the live `pg_get_functiondef` length had moved
-- from 3,077 to 3,873 between the dump and the apply. Re-read the live definition
-- immediately before replacing a function; two sessions edit this estate at once.
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
-- Every display field in this function is COALESCE(e.<live>, tm.<snapshot>) —
-- player, set, tier, circulation, video, FMV, badges. `thumbnail_url` sat in the
-- middle of that column with no live side at all, and lib/profile/
-- trophy-thumbnail.ts had already NOTICED ("two stored fields are NOT coalesced")
-- while its own docstring promised that a rejected pin means "the art simply
-- falls back". It did not fall back. It rendered ART UNAVAILABLE.
--
-- Found through a live card: collector `blaise_27` has exactly ONE pinned Moment
-- (Victor Wembanyama, Metallic Gold LE 233:8334) and its stored art is a
-- truncated hybrid of Top Shot's two URL shapes —
--   .../play_<uuid>_<set>_capture_/image
-- the static filename cut off at `capture_`, with the render endpoint's `/image`
-- appended. It 404s. `editions.thumbnail_url` for the same edition is intact
-- (..._capture_Hero_2880_2880_Transparent.png), and the RPC was handing back the
-- broken one. Their entire trophy case published as a blank slab.
--
-- ── THE DIRECTION IS MEASURED, NOT STYLISTIC ────────────────────────────────
-- The snapshot WINS here and loses on every other field. Over the 22 live trophy
-- rows: 13 store art identical to the edition's, 1 has no edition to resolve,
-- and 8 differ — of which SEVEN store
-- `assets.nbatopshot.com/media/<nft_id>/image?width=180|512`, a per-serial
-- derivative measured at ~31KB, against an `editions` master that is a 2880x2880
-- PNG of 4-7MB (several of them over the OG card's own 4MB cap). A live-first
-- COALESCE would have swapped eight working thumbnails for eight masters and
-- called it a fix. This is a FALLBACK: it fires only where the stored art is
-- NULL, which today is zero rows and tomorrow is every pin that
-- sanitizeTrophyThumbnail() rejects. Both directions are pinned in
-- supabase/tests/get_trophy_slab_data.sql, and each control fails the OTHER
-- spelling.
--
-- ⚠ ZERO ROWS CHANGE FROM THE FUNCTION CHANGE ALONE (no trophy row has a NULL
-- thumbnail today). The behaviour it buys is forward-looking, and it is what
-- makes the writer-side rejection landing in the same push safe rather than
-- destructive.
--
-- ── THE DATA REPAIR ─────────────────────────────────────────────────────────
-- Row 1185 is set to the edition's own art. Deliberately NOT set to NULL and
-- left to the new fallback: `GET /api/profile/trophy` returns raw
-- trophy_moments rows to the owner's own editing surface, which does not go
-- through this RPC, so a NULL would blank the art there.
--
-- ⚠ CREATE OR REPLACE does not reset the function ACL, so the service-role-only
-- grant from 20260731213000 survives. Verified after apply with
-- has_function_privilege + check_secdef_anon_exec_drift().
--
-- ── REVERT ──────────────────────────────────────────────────────────────────
--   1. Re-apply the definition from
--      20260911093000_audit_20260911_trophy_slab_refuses_an_impossible_serial_over_circulation.sql
--      (the only difference is the thumbnail_url line).
--   2. UPDATE public.trophy_moments SET thumbnail_url =
--      'https://assets.nbatopshot.com/editions/8_metallic_gold_le_rare/4b0d4e78-0654-4281-89a2-f54bc4977746/play_4b0d4e78-0654-4281-89a2-f54bc4977746_8_metallic_gold_le_rare_capture_/image'
--      WHERE id = 1185;
--      (that is the broken value being replaced, recorded so the revert is exact)
--
-- anon-exec: intentional — get_trophy_slab_data — CREATE OR REPLACE does NOT
-- reset a function ACL, so a REVOKE here would CHANGE production while
-- pretending to be a one-line edit. Its grants were set deliberately by
-- 20260731213000 (service-role-only SECDEF batch) and are re-verified with
-- has_function_privilege after apply rather than assumed.

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
      -- ⭐ THE ONE DISPLAY FIELD WITH NO LIVE SIDE, until 2026-09-12. Every
      -- neighbour here is COALESCE(e.<live>, tm.<snapshot>); art alone was the
      -- frozen pin-time value, so a trophy whose stored URL was junk had
      -- nothing to fall back to and published as a blank slab. One live row
      -- (1 of 22) carries a truncated static render that 404s, and it belongs
      -- to one of the 4 of 7 collectors who have pinned exactly one Moment.
      --
      -- ⚠ THE SNAPSHOT WINS HERE AND LOSES EVERYWHERE ELSE, deliberately, and
      -- the asymmetry is measured rather than stylistic: 7 of the 8 rows where
      -- the two disagree store assets.nbatopshot.com/media/<nft>/image?width=
      -- 180|512 — a per-serial derivative of ~31KB — against an `editions`
      -- master that is a 2880x2880 PNG of 4-7MB. Live-first would swap eight
      -- working thumbnails for eight masters, several of them over the OG
      -- card's own byte cap. So this is a FALLBACK, not a preference: it fires
      -- only where the stored art is absent, which is exactly what
      -- sanitizeTrophyThumbnail() produces when it rejects a URL.
      COALESCE(tm.thumbnail_url, e.thumbnail_url) AS thumbnail_url,
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


-- ── The one-row repair, guarded on the exact broken value ───────────────────
-- Guarded so a re-run is a no-op and so this cannot touch a row someone has
-- since re-pinned.
UPDATE public.trophy_moments
SET thumbnail_url =
  'https://assets.nbatopshot.com/editions/8_metallic_gold_le_rare/4b0d4e78-0654-4281-89a2-f54bc4977746/play_4b0d4e78-0654-4281-89a2-f54bc4977746_8_metallic_gold_le_rare_capture_Hero_2880_2880_Transparent.png'
WHERE id = 1185
  AND thumbnail_url =
  'https://assets.nbatopshot.com/editions/8_metallic_gold_le_rare/4b0d4e78-0654-4281-89a2-f54bc4977746/play_4b0d4e78-0654-4281-89a2-f54bc4977746_8_metallic_gold_le_rare_capture_/image';
