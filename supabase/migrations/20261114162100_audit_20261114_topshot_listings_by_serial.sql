-- audit_20261114_topshot_listings_by_serial
--
-- Feedback #12359 (mxtthxw): "filter live listings by a specific serial number across all editions".
-- A Sniper post-filter cannot answer it: the Sniper's Top Shot pool is the newest 200 of ts_listings,
-- and ts_listings is itself the Atlas 24 h CHANGE window, not the book. So this reads the open Atlas
-- listing rows for one serial and says, per row, how we know it is still listed.
--
-- (1) INDEX. idx_tame_open_listing_serial was built LIVE with CREATE INDEX CONCURRENTLY from one-off
--     pg_cron job 881 (2026-11-14 8:21 AM PT, postgres role statement_timeout 900s for the window, then
--     RESET; self-restoring net job 880). CIC cannot run inside a migration's transaction, so the
--     statement below is a no-op on production (matched by name) and the plain form for a fresh DB.
--
-- (2) get_topshot_listings_by_serial(p_serial, p_max_price_usd, p_tier, p_limit) → jsonb
--     { rows: [...], coverage: {...} }. Each open listing row (kind='listing', NOT completed,
--     nft_id set, price > 0, seen in the last 60 days) for p_serial, ONE per nft_id (the newest
--     listing, the ts_listings rule), classified:
--       confirmed_24h       last_seen_at within 24 h;
--       confirmed_verified  its edition's Atlas book was read COMPLETE within 7 days and this row was
--                           re-seen at that read (last_seen_at >= verified_at - 10 min).
--                           atlas_edition_verify_settle() closes every open row of a COMPLETE read
--                           that the read did not contain (read 2026-11-14), so a row older than its
--                           verify on a complete edition should not exist; if one does it is
--                           UNCONFIRMED, never counted as confirmed;
--       unconfirmed         anything else — "listed when last seen". On 09-26 a hand check found 20 %
--                           of such aged rows were actually closed (#149), so the UI never shows them
--                           as live.
--     Edition by topshot_atlas_edition_map (the same key rule as the ts_listings sync); FMV through
--     get_fmv_for_editions (per id), never fmv_current. Rows: confirmed first then unconfirmed, each by
--     price ascending, each capped at least(p_limit, 500). coverage counts are over the UNCAPPED set.
--
-- SECURITY INVOKER; service_role only — /api/topshot-serial-search calls it through supabaseAdmin.
-- anon-exec: false (get_topshot_listings_by_serial) — revoked FROM PUBLIC, anon, authenticated below; service_role only.
--
-- Revert: drop function public.get_topshot_listings_by_serial(int, numeric, text, int);
--         DROP INDEX CONCURRENTLY public.idx_tame_open_listing_serial;  (one-statement pg_cron job)

CREATE INDEX IF NOT EXISTS idx_tame_open_listing_serial
  ON public.topshot_atlas_market_events (product, serial_number, last_seen_at DESC)
  INCLUDE (atlas_edition_id, nft_id, price_cents, set_id_onchain, play_id_onchain, parallel, tier, listed_at, listing_resource_id)
  WHERE kind = 'listing' AND NOT completed AND nft_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.get_topshot_listings_by_serial(
  p_serial int,
  p_max_price_usd numeric DEFAULT NULL,
  p_tier text DEFAULT NULL,
  p_limit int DEFAULT 200
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public, pg_temp
AS $fn$
DECLARE
  c_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_limit int := least(greatest(coalesce(p_limit, 200), 1), 500);
  v_tier text := nullif(upper(btrim(coalesce(p_tier, ''))), '');
  v_max_cents bigint := CASE WHEN p_max_price_usd IS NULL OR p_max_price_usd <= 0 THEN NULL ELSE floor(p_max_price_usd * 100)::bigint END;
  v_out jsonb;
BEGIN
  IF p_serial IS NULL OR p_serial < 1 THEN
    RETURN jsonb_build_object('rows', '[]'::jsonb, 'coverage', NULL);
  END IF;

  WITH ev AS (
    SELECT DISTINCT ON (x.nft_id)
           x.nft_id, x.listing_resource_id, x.price_cents, x.listed_at, x.last_seen_at, x.serial_number,
           x.atlas_edition_id, x.set_id_onchain, x.play_id_onchain, x.parallel, x.tier
      FROM public.topshot_atlas_market_events x
     WHERE x.product = 'nba' AND x.kind = 'listing' AND NOT x.completed AND x.nft_id IS NOT NULL
       AND x.serial_number = p_serial
       AND x.last_seen_at > now() - interval '60 days'
       AND x.price_cents > 0
     ORDER BY x.nft_id, x.listed_at DESC NULLS LAST, x.last_seen_at DESC
  ),
  cls AS (
    SELECT ev.*,
           CASE
             WHEN ev.last_seen_at > now() - interval '24 hours' THEN 'confirmed_24h'
             WHEN v.complete AND v.verified_at > now() - interval '7 days'
                  AND ev.last_seen_at >= v.verified_at - interval '10 minutes' THEN 'confirmed_verified'
             ELSE 'unconfirmed'
           END AS confirmation,
           v.complete AS book_complete,
           v.verified_at AS book_verified_at
      FROM ev
      LEFT JOIN public.topshot_atlas_edition_verified v ON v.atlas_edition_id = ev.atlas_edition_id
  ),
  filt AS (
    SELECT c.*, m.rpc_edition_id, m.external_id AS map_external_id
      FROM cls c
      LEFT JOIN public.topshot_atlas_edition_map m ON m.atlas_edition_id = c.atlas_edition_id
     WHERE (v_max_cents IS NULL OR c.price_cents <= v_max_cents)
       AND (v_tier IS NULL OR upper(c.tier) = v_tier)
  ),
  ranked AS (
    SELECT f.*,
           row_number() OVER (PARTITION BY (f.confirmation = 'unconfirmed') ORDER BY f.price_cents, f.nft_id) AS rn
      FROM filt f
  ),
  picked AS (
    SELECT r.* FROM ranked r WHERE r.rn <= v_limit
  ),
  fmv AS (
    SELECT g.edition_id, g.fmv_usd
      FROM public.get_fmv_for_editions(c_ts, ARRAY(SELECT DISTINCT p.rpc_edition_id FROM picked p WHERE p.rpc_edition_id IS NOT NULL)) g
  ),
  out_rows AS (
    SELECT jsonb_build_object(
             'nft_id', p.nft_id,
             'listing_resource_id', p.listing_resource_id,
             'price_usd', round(p.price_cents::numeric / 100, 2),
             'serial_number', p.serial_number,
             'confirmation', p.confirmation,
             'listed_at', p.listed_at,
             'last_seen_at', p.last_seen_at,
             'book_verified_at', CASE WHEN p.book_complete THEN p.book_verified_at END,
             'edition_id', p.rpc_edition_id,
             'external_id', coalesce(e.external_id::text, p.map_external_id),
             'player_name', coalesce(e.player_name, e.team_name),
             'set_name', e.set_name,
             'tier', coalesce(p.tier, e.tier::text),
             'parallel', p.parallel,
             'circulation_count', e.circulation_count,
             'fmv_usd', f.fmv_usd
           ) AS j,
           (p.confirmation = 'unconfirmed') AS is_unconf,
           p.price_cents, p.nft_id
      FROM picked p
      LEFT JOIN public.editions e ON e.id = p.rpc_edition_id
      LEFT JOIN fmv f ON f.edition_id = p.rpc_edition_id
  )
  SELECT jsonb_build_object(
    'rows', coalesce((SELECT jsonb_agg(o.j ORDER BY o.is_unconf, o.price_cents, o.nft_id) FROM out_rows o), '[]'::jsonb),
    'coverage', jsonb_build_object(
      'serial', p_serial,
      'confirmed_count', (SELECT count(*) FROM filt WHERE confirmation <> 'unconfirmed'),
      'confirmed_24h', (SELECT count(*) FROM filt WHERE confirmation = 'confirmed_24h'),
      'confirmed_verified', (SELECT count(*) FROM filt WHERE confirmation = 'confirmed_verified'),
      'unconfirmed_count', (SELECT count(*) FROM filt WHERE confirmation = 'unconfirmed'),
      'editions_with_listing', (SELECT count(DISTINCT atlas_edition_id) FROM filt),
      'editions_verified_7d', (SELECT count(DISTINCT atlas_edition_id) FROM filt
                                WHERE book_complete AND book_verified_at > now() - interval '7 days'),
      'returned_confirmed', (SELECT count(*) FROM picked WHERE confirmation <> 'unconfirmed'),
      'returned_unconfirmed', (SELECT count(*) FROM picked WHERE confirmation = 'unconfirmed'),
      'window_hours', 24,
      'verify_days', 7,
      'lookback_days', 60
    )
  ) INTO v_out;

  RETURN v_out;
END
$fn$;

REVOKE EXECUTE ON FUNCTION public.get_topshot_listings_by_serial(int, numeric, text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_topshot_listings_by_serial(int, numeric, text, int) TO postgres, service_role;

COMMENT ON FUNCTION public.get_topshot_listings_by_serial(int, numeric, text, int) IS
  'Feedback #12359: open Top Shot listings of one serial across all editions, each classed confirmed_24h / confirmed_verified (complete Atlas book read <= 7 d, row re-seen) / unconfirmed, plus uncapped coverage counts. service_role only.';
