-- audit_20260927_panini_collector_walk
--
-- WHY. The Panini Collection tab (20260927183808) can only show cards RPC has SEEN under a
-- username, and RPC learns a holder only from a LISTING. Trevor's own account holds 146 NFTs and
-- 12 unopened packs (his Panini profile, 2026-09-27) and RPC had seen 0 of them — a listing-fed
-- view is close to empty for anyone who does not sell.
--
-- Panini publishes every collector's cards on a PUBLIC profile page
-- (nft.paniniamerica.net/public-profile/collections.html?nickname=<username>), served by the
-- site's own GraphQL ops userCollectedNftsV2(nickname) — one row per CARD with url_key (= our
-- panini_card_serials.sku), start_seq (serial), end_seq (cap), and total_size — plus
-- UnopenedPacksStats(nickname). scripts/panini-collector-walk.mjs opens that page in the runner's
-- real browser on Trevor's box and reads those responses (the site signs its own requests; RPC
-- never forges one), then posts here through /api/cron/panini-collector-walk.
--
-- WHO IS WALKED: usernames a user linked to their own RPC profile (saved_collector_identities),
-- plus an explicit list configured on the box. Nobody is walked because a stranger typed a name.
--
-- HONESTY:
--   · A walk is COMPLETE only when the DB agrees it is: the walker claimed complete AND the profile
--     read as public AND it reported a total AND the payload carries at least that many distinct
--     cards. The walker's own claim is not enough. Only a complete walk retires holdings, and it
--     retires by SET (url_keys absent from this payload) — never by comparing the box's clock to
--     the DB's, which would retire a card this walk just wrote whenever the box runs ahead.
--   · A partial walk only adds/refreshes; the walk row says whether the holdings are complete and
--     as of when, and the tab shows both.
--   · profile_state records what the page said (public / private / not_found / unknown) so an
--     empty result from a private profile is never read as "holds nothing".
--   · The tab shows the walk's own timestamp — these are holdings as of that walk.
--   · A walk that could not read the pack count keeps the last known one, not a NULL/0.
--   · The holdings table keeps the profile's own labels (athlete, cardset, sport, image_url) so a
--     card from a sport RPC has not catalogued (NBA, NFL, …) still renders; RPC's catalogue wins
--     where it has the edition. The edition key is RPC's serial row's when RPC has read the card,
--     else the profile's psku (the same packcard-… key as the marketplace grid).
--   · A listing RPC read under a DIFFERENT holder is not this collector's listing.
--
-- anon-exec: revoked below — service-role only (public.panini_collector_walk_ingest)
-- anon-exec: revoked below — service-role only (public.panini_collector_walk_targets)
-- anon-exec: revoked below — service-role only (public.panini_profile_holdings)

CREATE TABLE IF NOT EXISTS public.panini_user_holdings (
  username       text        NOT NULL,
  url_key        text        NOT NULL,
  psku           text,
  serial_number  integer,
  mint_cap       integer,
  athlete        text,
  cardset        text,
  sport          text,
  image_url      text,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (username, url_key)
);
CREATE INDEX IF NOT EXISTS idx_panini_user_holdings_psku ON public.panini_user_holdings (psku);

CREATE TABLE IF NOT EXISTS public.panini_collector_walks (
  username           text PRIMARY KEY,
  last_walk_at       timestamptz,
  last_complete_at   timestamptz,
  profile_state      text CHECK (profile_state IN ('public', 'private', 'not_found', 'unknown')),
  reported_total     integer,
  cards_collected    integer,
  unopened_packs     integer,
  last_error         text
);

ALTER TABLE public.panini_user_holdings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.panini_collector_walks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.panini_user_holdings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.panini_collector_walks FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.panini_user_holdings TO service_role;
GRANT ALL ON public.panini_collector_walks TO service_role;

-- Linked usernames (opt-in), stalest complete walk first. `nickname` is the spelling the user
-- entered (Panini's page is queried with it); `username` is the folded key (lib/address.ts).
CREATE OR REPLACE FUNCTION public.panini_collector_walk_targets()
RETURNS TABLE (username text, nickname text, last_complete_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT DISTINCT ON (lower(btrim(s.identity_value)))
         lower(btrim(s.identity_value)) AS username, btrim(s.identity_value) AS nickname, w.last_complete_at
  FROM saved_collector_identities s
  LEFT JOIN panini_collector_walks w ON w.username = lower(btrim(s.identity_value))
  WHERE s.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'
    AND s.identity_kind = 'username'
    AND lower(btrim(s.identity_value)) ~ '^[a-z0-9_.-]{2,16}$'
  ORDER BY lower(btrim(s.identity_value)), s.created_at
$$;

-- One walk of one username, in ONE call. p: { username, walk_started_at, complete, profile_state,
-- reported_total, unopened_packs, error,
-- holdings: [{url_key, psku, serial_number, mint_cap, athlete, cardset, sport, image_url}] }.
-- Returns what it WROTE: { written, retired, collected, complete }.
CREATE OR REPLACE FUNCTION public.panini_collector_walk_ingest(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_user      text := lower(btrim(p->>'username'));
  v_started   timestamptz := (p->>'walk_started_at')::timestamptz;
  v_state     text := coalesce(nullif(p->>'profile_state', ''), 'unknown');
  v_total     int := CASE WHEN (p->>'reported_total') ~ '^[0-9]{1,7}$' THEN (p->>'reported_total')::int END;
  v_packs     int := CASE WHEN (p->>'unopened_packs') ~ '^[0-9]{1,7}$' THEN (p->>'unopened_packs')::int END;
  v_keys      text[];
  v_complete  boolean;
  v_written   int := 0;
  v_retired   int := 0;
  v_collected int;
BEGIN
  IF v_user IS NULL OR v_user !~ '^[a-z0-9_.-]{2,16}$' THEN
    RAISE EXCEPTION 'panini_collector_walk_ingest: invalid username';
  END IF;
  IF v_started IS NULL THEN
    RAISE EXCEPTION 'panini_collector_walk_ingest: walk_started_at required';
  END IF;
  IF v_state NOT IN ('public', 'private', 'not_found', 'unknown') THEN
    RAISE EXCEPTION 'panini_collector_walk_ingest: invalid profile_state';
  END IF;

  SELECT coalesce(array_agg(DISTINCT h->>'url_key'), '{}')
    INTO v_keys
    FROM jsonb_array_elements(coalesce(p->'holdings', '[]'::jsonb)) h
   WHERE coalesce(h->>'url_key', '') <> '';

  v_complete := coalesce((p->>'complete')::boolean, false)
                AND v_state = 'public'
                AND v_total IS NOT NULL
                AND cardinality(v_keys) >= v_total;

  WITH src AS (
    SELECT DISTINCT ON (h->>'url_key')
           h->>'url_key' AS url_key,
           nullif(h->>'psku', '') AS psku,
           CASE WHEN (h->>'serial_number') ~ '^[0-9]{1,9}$' THEN (h->>'serial_number')::int END AS serial_number,
           CASE WHEN (h->>'mint_cap') ~ '^[0-9]{1,9}$' THEN (h->>'mint_cap')::int END AS mint_cap,
           left(nullif(btrim(h->>'athlete'), ''), 200) AS athlete,
           left(nullif(btrim(h->>'cardset'), ''), 200) AS cardset,
           left(nullif(btrim(h->>'sport'), ''), 40) AS sport,
           left(nullif(btrim(h->>'image_url'), ''), 500) AS image_url
    FROM jsonb_array_elements(coalesce(p->'holdings', '[]'::jsonb)) h
    WHERE coalesce(h->>'url_key', '') <> ''
  )
  INSERT INTO panini_user_holdings AS t (username, url_key, psku, serial_number, mint_cap, athlete, cardset,
                                         sport, image_url, first_seen_at, last_seen_at)
  SELECT v_user, url_key, psku, serial_number, mint_cap, athlete, cardset, sport, image_url, v_started, v_started
  FROM src
  ON CONFLICT (username, url_key) DO UPDATE
    SET psku = coalesce(excluded.psku, t.psku),
        serial_number = coalesce(excluded.serial_number, t.serial_number),
        mint_cap = coalesce(excluded.mint_cap, t.mint_cap),
        athlete = coalesce(excluded.athlete, t.athlete),
        cardset = coalesce(excluded.cardset, t.cardset),
        sport = coalesce(excluded.sport, t.sport),
        image_url = coalesce(excluded.image_url, t.image_url),
        last_seen_at = greatest(t.last_seen_at, excluded.last_seen_at);
  GET DIAGNOSTICS v_written = ROW_COUNT;

  IF v_complete THEN
    DELETE FROM panini_user_holdings
     WHERE username = v_user AND NOT (url_key = ANY (v_keys));
    GET DIAGNOSTICS v_retired = ROW_COUNT;
  END IF;

  SELECT count(*) INTO v_collected FROM panini_user_holdings WHERE username = v_user;

  INSERT INTO panini_collector_walks AS w (username, last_walk_at, last_complete_at, profile_state,
                                           reported_total, cards_collected, unopened_packs, last_error)
  VALUES (v_user, v_started, CASE WHEN v_complete THEN v_started END, v_state, v_total, v_collected,
          v_packs, nullif(p->>'error', ''))
  ON CONFLICT (username) DO UPDATE
    SET last_walk_at = excluded.last_walk_at,
        last_complete_at = coalesce(excluded.last_complete_at, w.last_complete_at),
        profile_state = excluded.profile_state,
        reported_total = coalesce(excluded.reported_total, w.reported_total),
        cards_collected = excluded.cards_collected,
        unopened_packs = coalesce(excluded.unopened_packs, w.unopened_packs),
        last_error = excluded.last_error;

  RETURN jsonb_build_object('written', v_written, 'retired', v_retired, 'collected', v_collected, 'complete', v_complete);
END
$$;

-- The Collection tab's read of a WALKED username: the walk row (null = never walked) and the cards
-- it holds, priced by EDITION FMV like panini_owner_cards; a card with no FMV is counted, not $0.
CREATE OR REPLACE FUNCTION public.panini_profile_holdings(p_username text, p_limit int DEFAULT 200)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH u AS (SELECT lower(btrim(p_username)) AS username),
  walk AS (SELECT w.* FROM panini_collector_walks w, u WHERE w.username = u.username),
  held AS (
    SELECT h.url_key, coalesce(s.edition_external_id, h.psku) AS psku, h.serial_number, h.mint_cap, h.last_seen_at,
           (s.is_listed AND lower(s.owner) = u.username) AS is_listed,
           CASE WHEN s.is_listed AND lower(s.owner) = u.username THEN s.price_usd END AS price_usd,
           s.is_number_one, s.is_jersey_mint, s.is_perfect_mint,
           coalesce(s.is_special, false) AS is_special,
           coalesce(pe.player_name, h.athlete) AS player_name,
           coalesce(pe.set_name, h.cardset) AS set_name,
           pe.tier::text AS tier, h.sport,
           public.panini_asset_url(coalesce(pe.thumbnail_url, h.image_url)) AS thumbnail_url,
           (pe.external_id IS NOT NULL) AS catalogued,
           f.fmv_usd, f.confidence::text AS confidence
    FROM panini_user_holdings h
    JOIN u ON u.username = h.username
    LEFT JOIN panini_card_serials s ON s.sku = h.url_key
    LEFT JOIN panini_editions pe ON pe.external_id = coalesce(s.edition_external_id, h.psku)
    LEFT JOIN editions e
      ON e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'
     AND e.external_id = coalesce(s.edition_external_id, h.psku)
    LEFT JOIN edition_fmv_current f ON f.edition_id = e.id
  )
  SELECT jsonb_build_object(
    'username', (SELECT username FROM u),
    'walk', (SELECT jsonb_build_object(
               'last_walk_at', last_walk_at, 'last_complete_at', last_complete_at,
               'profile_state', profile_state, 'reported_total', reported_total,
               'cards_collected', cards_collected, 'unopened_packs', unopened_packs,
               'last_error', last_error) FROM walk),
    'cards_held',       (SELECT count(*) FROM held),
    'editions',         (SELECT count(DISTINCT psku) FROM held),
    'catalogued_cards', (SELECT count(*) FROM held WHERE catalogued),
    'special_serials',  (SELECT count(*) FROM held WHERE is_special),
    'listed_now',       (SELECT count(*) FROM held WHERE is_listed IS TRUE),
    'fmv_held_usd',     (SELECT round(sum(fmv_usd), 2) FROM held WHERE fmv_usd > 0),
    'fmv_priced_cards', (SELECT count(*) FROM held WHERE fmv_usd > 0),
    'cards', COALESCE((
      SELECT jsonb_agg(to_jsonb(c.*) ORDER BY c.fmv_usd DESC NULLS LAST, c.sku)
      FROM (
        SELECT url_key AS sku, psku AS edition_external_id, serial_number, mint_cap,
               coalesce(is_listed, false) AS is_listed, price_usd AS ask_usd,
               NULL::numeric AS last_sale_usd, NULL::timestamptz AS last_sale_at,
               last_seen_at AS captured_at, is_number_one, is_jersey_mint, is_perfect_mint,
               player_name, set_name, tier, sport, catalogued, thumbnail_url, fmv_usd, confidence
        FROM held
        ORDER BY fmv_usd DESC NULLS LAST, url_key
        LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500)
      ) c
    ), '[]'::jsonb)
  )
$$;

COMMENT ON FUNCTION public.panini_profile_holdings(text, int) IS
  'Panini Collection tab: cards a collector-walk read off the username''s public Panini profile (as of walk.last_walk_at; complete only as of walk.last_complete_at), with edition FMV.';

REVOKE ALL ON FUNCTION public.panini_collector_walk_targets() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.panini_collector_walk_ingest(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.panini_profile_holdings(text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.panini_collector_walk_targets() TO service_role;
GRANT EXECUTE ON FUNCTION public.panini_collector_walk_ingest(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.panini_profile_holdings(text, int) TO service_role;
