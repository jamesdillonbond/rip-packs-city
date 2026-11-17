-- audit_20260928_trophy_still_held_state
--
-- Trevor 2026-09-28 ("Do all of it"): a sold trophy stayed pinned with nothing saying so.
--
-- WHY A NEW STAMP. wallet_moments_cache DOES retire sold moments on the five Flow collections
-- (lib/chains/flow/wmc-unseen-delete.ts deleteUnseenWmcRows, called only on complete passes),
-- but NO existing stamp proves a wallet was cleanly re-read: seeded_wallets.
-- last_refreshed_per_collection and wallet_backfill_state.last_scanned_at are both written on
-- timeouts, empty scans and degraded runs too (and the jsonb one keeps only the LAST collection).
-- Absence from wmc after one of those would be read as "sold" when the walk simply did not finish.
--
-- (1) wmc_clean_walks (wallet_address, collection_id, last_clean_walk_at). Written ONLY by
--     deleteUnseenWmcRows when it actually ran: a non-empty observed set, not skipped as
--     suspiciously large, no delete error. Candy MLB never calls it, so Candy trophies stay
--     'unknown' (its refresh is add-only). A partial cached-id read can only UNDER-delete, which
--     leaves a sold row in place -> 'held', the fail-open direction.
--
-- (2) get_trophy_slab_data gains held_state ('held' | 'not_held' | 'unknown') and held_checked_at.
--     'held'     — the moment is under one of the user's saved wallets (Panini: on a linked
--                  username's walked profile, or its serial seen under the name after that walk).
--     'not_held' — absent, AND every relevant wallet has a clean walk after the pin and within
--                  13 days (prune_stale_wmc drops rows unseen for 14 days; a clean walk refreshes
--                  held rows), or — Panini — every linked username has a COMPLETE public walk
--                  after the pin (panini_collector_walk_ingest retires unheld cards only then).
--     'unknown'  — anything else. Never shown as sold.
--     Everything else in the body is byte-identical to 20260927174800 (live md5 matched before replace).
--
-- anon-exec: unchanged (get_trophy_slab_data) — CREATE OR REPLACE keeps its ACL; the new table is service-role only.
--
-- REVERT:
--   re-run the get_trophy_slab_data body in 20260927174800_audit_20260927_trophy_slab_acquisition_is_scoped_to_the_trophys_collection.sql;
--   DROP TABLE IF EXISTS public.wmc_clean_walks;

CREATE TABLE IF NOT EXISTS public.wmc_clean_walks (
  wallet_address     text        NOT NULL,
  collection_id      uuid        NOT NULL REFERENCES public.collections(id),
  last_clean_walk_at timestamptz NOT NULL,
  observed_count     integer,
  PRIMARY KEY (wallet_address, collection_id)
);
ALTER TABLE public.wmc_clean_walks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wmc_clean_walks FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.wmc_clean_walks TO service_role;
COMMENT ON TABLE public.wmc_clean_walks IS
  'Per (wallet, collection): the last walk that ran delete-not-seen on wallet_moments_cache (lib/chains/flow/wmc-unseen-delete.ts). The ONLY stamp that proves absence from wmc means not held. Read by get_trophy_slab_data held_state.';

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
