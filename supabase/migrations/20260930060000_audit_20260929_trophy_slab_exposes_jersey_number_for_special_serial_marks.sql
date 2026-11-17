-- audit_20260929: get_trophy_slab_data exposes jersey_number, so the trophy
-- slab can draw its special-serial marks (#1 / jersey match / perfect mint).
--
-- A collector reported via the concierge (support_conversations #10153,
-- 2026-09-29 PT) that their trophy case shows edition badges (Debut, Rookie
-- Year) but no special-serial badges, and the serial is not highlighted. The
-- slab component never drew them. `first` and `perfect` come off serial /
-- circulation, which this function already returns; `jersey` needs
-- editions.jersey_number, which it READ (for serial_fmv_estimate) but did not
-- return. One added output key; to_jsonb(slabs.*) carries it.
--
-- The value is NULL unless > 0: editions.jersey_number is 0 (not NULL) for a
-- player with no number on file, and lib/badges/glyphs.ts specialCats() treats
-- 0 as unknown. Returning NULL there keeps every consumer from having to know.
--
-- Body built from the pinned + live definition (md5 of the normalised prosrc
-- matched the migration 20260929061743 and supabase/tests pin before editing).
--
-- anon-exec: unchanged (get_trophy_slab_data) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false.
--
-- Revert: re-apply the CREATE OR REPLACE body from
-- 20260929061743_audit_20260928_trophy_still_held_state.sql (drops the one key).

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
      -- Special-serial jersey match (lib/badges/glyphs.ts specialCats). NULL
      -- unless > 0: 0 means no number on file, never jersey #0.
      (CASE WHEN e.jersey_number > 0 THEN e.jersey_number END) AS jersey_number,
      tm.pinned_at,
      -- Is the trophy still in the collector's indexed holdings? THREE states
      -- (2026-09-28): 'held' / 'not_held' / 'unknown'. 'not_held' needs a CLEAN
      -- walk after the pin for every relevant wallet or linked username; without
      -- one the answer is 'unknown', never a guess.
      hs.held_state,
      hs.held_checked_at,
      (
        SELECT ma.buy_price FROM moment_acquisitions ma
        WHERE ma.nft_id = tm.moment_id
          AND ma.collection_id = tm.collection_id
        ORDER BY ma.acquired_date DESC NULLS LAST
        LIMIT 1
      ) AS acquired_price,
      (
        SELECT ma.acquisition_method FROM moment_acquisitions ma
        WHERE ma.nft_id = tm.moment_id
          AND ma.collection_id = tm.collection_id
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
    LEFT JOIN LATERAL (
      WITH uw AS (
        SELECT DISTINCT sw.wallet_addr FROM saved_wallets sw WHERE sw.user_id = tm.user_id
      ),
      -- FLOW / SOLANA: the moment under any of the user's saved wallets.
      w_present AS (
        SELECT EXISTS (
          SELECT 1 FROM wallet_moments_cache w
          JOIN uw ON uw.wallet_addr = w.wallet_address
          WHERE w.moment_id = tm.moment_id AND w.collection_id = tm.collection_id
        ) AS present
      ),
      -- The wallets that hold anything in this collection (or were cleanly
      -- walked for it). Each must have a clean walk AFTER the pin, and a recent
      -- one: prune_stale_wmc drops rows unseen for 14 days, and a clean walk
      -- refreshes every held row, so a floor older than 13 days could be
      -- looking at a pruned-but-held moment.
      w_relevant AS (
        SELECT uw.wallet_addr, cw.last_clean_walk_at
        FROM uw
        LEFT JOIN wmc_clean_walks cw
          ON cw.wallet_address = uw.wallet_addr AND cw.collection_id = tm.collection_id
        WHERE cw.wallet_address IS NOT NULL
           OR EXISTS (SELECT 1 FROM wallet_moments_cache w2
                      WHERE w2.wallet_address = uw.wallet_addr AND w2.collection_id = tm.collection_id)
      ),
      -- PANINI: cards under the usernames the user linked.
      p_names AS (
        SELECT sci.identity_value AS username, pw.last_complete_at, pw.profile_state
        FROM saved_collector_identities sci
        LEFT JOIN panini_collector_walks pw ON pw.username = sci.identity_value
        WHERE sci.user_id = tm.user_id AND sci.collection_id = tm.collection_id
          AND sci.identity_kind = 'username'
      ),
      p_present AS (
        SELECT EXISTS (
          SELECT 1 FROM panini_user_holdings h JOIN p_names n ON n.username = h.username
          WHERE h.url_key = tm.moment_id
        ) OR EXISTS (
          SELECT 1 FROM panini_card_serials s JOIN p_names n ON s.owner <> '' AND lower(s.owner) = n.username
          WHERE s.sku = tm.moment_id AND COALESCE(s.serial_state, '') <> 'BURNT'
            AND (n.last_complete_at IS NULL OR s.captured_at > n.last_complete_at)
        ) AS present
      )
      SELECT
        CASE
          WHEN c.slug = 'panini_blockchain' THEN
            CASE
              WHEN (SELECT present FROM p_present) THEN 'held'
              WHEN EXISTS (SELECT 1 FROM p_names)
               AND NOT EXISTS (SELECT 1 FROM p_names n
                               WHERE n.last_complete_at IS NULL OR n.last_complete_at <= tm.pinned_at
                                  OR n.profile_state IS DISTINCT FROM 'public')
              THEN 'not_held'
              ELSE 'unknown'
            END
          ELSE
            CASE
              WHEN (SELECT present FROM w_present) THEN 'held'
              WHEN EXISTS (SELECT 1 FROM w_relevant)
               AND NOT EXISTS (SELECT 1 FROM w_relevant r
                               WHERE r.last_clean_walk_at IS NULL
                                  OR r.last_clean_walk_at <= tm.pinned_at
                                  OR r.last_clean_walk_at < now() - interval '13 days')
              THEN 'not_held'
              ELSE 'unknown'
            END
        END AS held_state,
        CASE
          WHEN c.slug = 'panini_blockchain' THEN (SELECT min(n.last_complete_at) FROM p_names n)
          ELSE (SELECT min(r.last_clean_walk_at) FROM w_relevant r)
        END AS held_checked_at
    ) hs ON true
    WHERE tm.user_id = p_user_id
    ORDER BY tm.slot ASC
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(slabs.*) ORDER BY slot), '[]'::jsonb)
  INTO v_result FROM slabs;

  RETURN v_result;
END;
$function$;
