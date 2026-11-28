-- audit_20261127_entity_top_fans
--
-- Trevor 2026-11-27: "Each team and player should have top fans on their hubs … top collectors by
-- Moment/Pin/Card count, FMV, and special serial count owned (only count each Moment/pin/card once, if
-- they have multiple special serials on it like a 1/1 that is both #1 and perfect)."
--
-- One precompute for every collection, read by the per-collection team/player pages AND the
-- aggregated hubs (/teams/<league>/<slug>, /players/<slug>) through ONE reader, so the hub and the page
-- it links to cannot disagree.
--
-- OWNER SOURCES (the best census each collection has — stated on the page, never implied complete):
--   nba_top_shot     wallet_moments_cache (wallets RPC has walked) ∪ topshot_ownership (the on-chain
--                    ownership index, walk_missed_at IS NULL), one row per Moment id, newer observation wins
--   nfl_all_day, laliga_golazos, ufc_strike   wallet_moments_cache (wallets RPC has walked)
--   candy_mlb        wallet_moments_cache — Candy's daily full wallet census (as get_candy_player_top_collectors)
--   panini_blockchain panini_card_serials — every serial Panini's serials API has returned, by OWNER USERNAME
--   disney_pinnacle  mv_pinnacle_render_owners (as get_pinnacle_character_top_collectors) — no serials, so
--                    special_items is NULL (not tracked), never 0
-- System accounts are not fans: flowty_excluded_addresses (Flow), candy_treasury_wallet +
-- candy_holder_board_exclusions (Candy), blank owner (Panini: in packs / unknown), is_system (Pinnacle).
--
-- SPECIAL SERIAL = #1, perfect (serial = the edition's circulation), or jersey (serial = editions.jersey_number);
-- Panini uses its own panini_card_serials.is_special (same three). count(*) FILTER (a OR b OR c), so an item
-- that is #1 AND perfect (a 1/1) counts ONCE.
--
-- FMV = the edition's current FMV × items (edition_fmv_current; candy_fmv_current for Candy;
-- pinnacle_catalog.fmv_usd for Pinnacle). fmv_items says how many of the items carried a price.
--
-- ENTITY KEYS (the same predicates the entity pages use):
--   team      slug of editions.team_name (reader expands through team_franchise_slugs, as get_team_top_editions);
--             Pinnacle: slug of each franchise trait, ™®© stripped
--   player    editions.player_id, or 'name:'||player_name when player_id is NULL (reader adds same-name ids that
--             are not edition_player_is_other_person, as get_player_editions); Pinnacle: lower(btrim(character)),
--             plus the joined forms of a multi-character pin
--   franchise Panini only: panini_edition_team_keys.franchise_keys ('NBA:blazers'), as get_panini_franchise_panel
--
-- STORAGE: only owners ranked <= 25 by ANY of the three metrics are kept per entity (the Panini player grain
-- alone is 2.2M owner rows); per-entity totals live in entity_top_fans_totals.

CREATE TABLE IF NOT EXISTS public.entity_top_fans (
  collection_id  uuid    NOT NULL,
  entity_kind    text    NOT NULL CHECK (entity_kind IN ('team', 'player', 'franchise')),
  entity_key     text    NOT NULL,
  owner          text    NOT NULL,
  items          integer NOT NULL,
  special_items  integer,
  fmv_usd        numeric,
  fmv_items      integer NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, entity_kind, entity_key, owner)
);

CREATE TABLE IF NOT EXISTS public.entity_top_fans_totals (
  collection_id  uuid    NOT NULL,
  entity_kind    text    NOT NULL CHECK (entity_kind IN ('team', 'player', 'franchise')),
  entity_key     text    NOT NULL,
  holders        integer NOT NULL,
  items          bigint  NOT NULL,
  special_items  bigint,
  PRIMARY KEY (collection_id, entity_kind, entity_key)
);

CREATE TABLE IF NOT EXISTS public.entity_top_fans_runs (
  collection_id  uuid PRIMARY KEY,
  refreshed_at   timestamptz NOT NULL,
  source         text NOT NULL,
  items          bigint NOT NULL,
  owners         integer NOT NULL
);

ALTER TABLE public.entity_top_fans        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entity_top_fans_totals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entity_top_fans_runs   ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.entity_top_fans, public.entity_top_fans_totals, public.entity_top_fans_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.entity_top_fans, public.entity_top_fans_totals, public.entity_top_fans_runs TO service_role;

-- ── Refresh, one collection per call (one transaction: readers see the old set until COMMIT) ──────────────
CREATE OR REPLACE FUNCTION public.refresh_entity_top_fans(p_collection_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_slug    text;
  v_source  text;
  v_rows    integer := 0;
  v_items   bigint := 0;
  v_owners  integer := 0;
  c_keep    CONSTANT integer := 25;
BEGIN
  SELECT slug INTO v_slug FROM collections WHERE id = p_collection_id;
  IF v_slug IS NULL THEN
    RAISE EXCEPTION 'refresh_entity_top_fans: unknown collection %', p_collection_id;
  END IF;

  DROP TABLE IF EXISTS _etf_agg;
  CREATE TEMP TABLE _etf_agg (
    entity_kind text, entity_key text, owner text,
    items integer, special_items integer, fmv_usd numeric, fmv_items integer
  ) ON COMMIT DROP;

  IF v_slug = 'disney_pinnacle' THEN
    v_source := 'mv_pinnacle_render_owners';
    INSERT INTO _etf_agg
    SELECT k.kind, k.key, m.owner,
           sum(m.copies)::int, NULL::int,
           sum(m.copies * pc.fmv_usd) FILTER (WHERE pc.fmv_usd > 0),
           coalesce(sum(m.copies) FILTER (WHERE pc.fmv_usd > 0), 0)::int
      FROM mv_pinnacle_render_owners m
      JOIN pinnacle_catalog pc ON pc.render_id = m.render_id
     CROSS JOIN LATERAL (
       SELECT DISTINCT kk.kind, kk.key FROM (
         SELECT 'player'::text AS kind, lower(btrim(c)) AS key FROM unnest(pc.characters) c
         UNION ALL
         SELECT 'player', lower(array_to_string(pc.characters, ' & ')) WHERE cardinality(pc.characters) > 1
         UNION ALL
         SELECT 'player', lower(array_to_string(pc.characters, ' ')) WHERE cardinality(pc.characters) > 1
         UNION ALL
         SELECT 'team', regexp_replace(lower(btrim(regexp_replace(fr, '[™®©]', '', 'g'))), '[^a-z0-9]+', '-', 'g')
           FROM unnest(pc.franchises) fr
          WHERE btrim(regexp_replace(fr, '[™®©]', '', 'g')) <> ''
       ) kk WHERE kk.key IS NOT NULL AND kk.key <> ''
     ) k
     WHERE NOT m.is_system
     GROUP BY 1, 2, 3;
    SELECT coalesce(sum(m.copies), 0), count(DISTINCT m.owner) INTO v_items, v_owners
      FROM mv_pinnacle_render_owners m WHERE NOT m.is_system;
  ELSE
    DROP TABLE IF EXISTS _etf_hold;
    CREATE TEMP TABLE _etf_hold (owner text, edition_id uuid, items integer, special_items integer) ON COMMIT DROP;

    IF v_slug = 'nba_top_shot' THEN
      v_source := 'wallet_moments_cache+topshot_ownership';
      INSERT INTO _etf_hold
      SELECT u.owner, e.id, count(*)::int,
             (count(*) FILTER (WHERE u.serial = 1 OR u.serial = e.circulation_count OR u.serial = e.jersey_number))::int
        FROM (
          SELECT DISTINCT ON (x.nft) x.nft, x.owner, x.ek, x.serial
            FROM (
              SELECT w.moment_id AS nft, w.wallet_address AS owner, w.edition_key AS ek, w.serial_number AS serial, w.last_seen_at AS ts
                FROM wallet_moments_cache w
               WHERE w.collection_id = p_collection_id
              UNION ALL
              SELECT o.nft_id, o.owner_address, o.edition_external_id, o.serial_number, o.observed_at
                FROM topshot_ownership o
               WHERE o.walk_missed_at IS NULL
            ) x
           ORDER BY x.nft, x.ts DESC NULLS LAST
        ) u
        JOIN editions e ON e.collection_id = p_collection_id AND e.external_id = u.ek
       WHERE NOT EXISTS (SELECT 1 FROM flowty_excluded_addresses xa WHERE lower(xa.address) = u.owner)
       GROUP BY 1, 2;
    ELSIF v_slug IN ('nfl_all_day', 'laliga_golazos', 'ufc_strike') THEN
      v_source := 'wallet_moments_cache';
      INSERT INTO _etf_hold
      SELECT u.owner, e.id, count(*)::int,
             (count(*) FILTER (WHERE u.serial = 1 OR u.serial = e.circulation_count OR u.serial = e.jersey_number))::int
        FROM (
          SELECT DISTINCT ON (w.moment_id) w.moment_id, w.wallet_address AS owner, w.edition_key AS ek, w.serial_number AS serial
            FROM wallet_moments_cache w
           WHERE w.collection_id = p_collection_id
           ORDER BY w.moment_id, w.last_seen_at DESC NULLS LAST
        ) u
        JOIN editions e ON e.collection_id = p_collection_id AND e.external_id = u.ek
       WHERE NOT EXISTS (SELECT 1 FROM flowty_excluded_addresses xa WHERE lower(xa.address) = lower(u.owner))
       GROUP BY 1, 2;
    ELSIF v_slug = 'candy_mlb' THEN
      -- ⛔ Solana keys are CASE-SENSITIVE: never lower() them.
      v_source := 'wallet_moments_cache (candy census)';
      INSERT INTO _etf_hold
      SELECT w.wallet_address, e.id, count(*)::int,
             (count(*) FILTER (WHERE w.serial_number = 1 OR w.serial_number = e.circulation_count OR w.serial_number = e.jersey_number))::int
        FROM wallet_moments_cache w
        JOIN editions e ON e.collection_id = p_collection_id AND e.external_id = w.edition_key
       WHERE w.collection_id = p_collection_id
         AND w.wallet_address NOT IN (SELECT wallet_address FROM candy_treasury_wallet
                                      UNION SELECT wallet_address FROM candy_holder_board_exclusions)
       GROUP BY 1, 2;
    ELSIF v_slug = 'panini_blockchain' THEN
      v_source := 'panini_card_serials';
      INSERT INTO _etf_hold
      SELECT s.owner, e.id, count(*)::int, (count(*) FILTER (WHERE s.is_special))::int
        FROM panini_card_serials s
        JOIN editions e ON e.collection_id = p_collection_id AND e.external_id = s.edition_external_id
       WHERE s.owner <> '' AND s.serial_state IS DISTINCT FROM 'BURNT'
       GROUP BY 1, 2;
    ELSE
      RAISE EXCEPTION 'refresh_entity_top_fans: no owner source for %', v_slug;
    END IF;

    SELECT coalesce(sum(items), 0), count(DISTINCT owner) INTO v_items, v_owners FROM _etf_hold;

    INSERT INTO _etf_agg
    SELECT k.kind, k.key, h.owner,
           sum(h.items)::int, sum(h.special_items)::int,
           sum(h.items * f.fmv) FILTER (WHERE f.fmv > 0),
           coalesce(sum(h.items) FILTER (WHERE f.fmv > 0), 0)::int
      FROM _etf_hold h
      JOIN editions e ON e.id = h.edition_id
      LEFT JOIN LATERAL (
        SELECT CASE WHEN v_slug = 'candy_mlb'
                    THEN (SELECT cf.fmv_usd FROM candy_fmv_current cf WHERE cf.edition_id = h.edition_id LIMIT 1)
                    ELSE (SELECT ef.fmv_usd FROM edition_fmv_current ef WHERE ef.edition_id = h.edition_id LIMIT 1)
               END AS fmv
      ) f ON true
     CROSS JOIN LATERAL (
       SELECT 'player'::text AS kind, coalesce(e.player_id::text, 'name:' || e.player_name) AS key
        WHERE e.player_id IS NOT NULL OR e.player_name IS NOT NULL
       UNION ALL
       SELECT 'team', regexp_replace(lower(trim(e.team_name)), '[^a-z0-9]+', '-', 'g')
        WHERE e.team_name IS NOT NULL AND trim(e.team_name) <> ''
       UNION ALL
       SELECT 'franchise', fk
         FROM panini_edition_team_keys t CROSS JOIN LATERAL unnest(t.franchise_keys) fk
        WHERE v_slug = 'panini_blockchain' AND t.external_id = e.external_id
     ) k
     GROUP BY 1, 2, 3;
  END IF;

  DELETE FROM entity_top_fans        WHERE collection_id = p_collection_id;
  DELETE FROM entity_top_fans_totals WHERE collection_id = p_collection_id;

  INSERT INTO entity_top_fans_totals (collection_id, entity_kind, entity_key, holders, items, special_items)
  SELECT p_collection_id, a.entity_kind, a.entity_key, count(*)::int, sum(a.items),
         CASE WHEN v_slug = 'disney_pinnacle' THEN NULL ELSE sum(a.special_items) END
    FROM _etf_agg a
   GROUP BY 2, 3;

  INSERT INTO entity_top_fans (collection_id, entity_kind, entity_key, owner, items, special_items, fmv_usd, fmv_items)
  SELECT p_collection_id, r.entity_kind, r.entity_key, r.owner, r.items, r.special_items, round(r.fmv_usd, 2), r.fmv_items
    FROM (
      SELECT a.*,
             row_number() OVER (PARTITION BY a.entity_kind, a.entity_key ORDER BY a.items DESC, a.fmv_usd DESC NULLS LAST, a.owner) AS r_items,
             row_number() OVER (PARTITION BY a.entity_kind, a.entity_key ORDER BY a.fmv_usd DESC NULLS LAST, a.items DESC, a.owner) AS r_fmv,
             row_number() OVER (PARTITION BY a.entity_kind, a.entity_key ORDER BY a.special_items DESC NULLS LAST, a.fmv_usd DESC NULLS LAST, a.owner) AS r_special
        FROM _etf_agg a
    ) r
   WHERE r.r_items <= c_keep OR r.r_fmv <= c_keep OR (r.r_special <= c_keep AND coalesce(r.special_items, 0) > 0);
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  INSERT INTO entity_top_fans_runs (collection_id, refreshed_at, source, items, owners)
  VALUES (p_collection_id, now(), v_source, v_items, v_owners)
  ON CONFLICT (collection_id) DO UPDATE
    SET refreshed_at = EXCLUDED.refreshed_at, source = EXCLUDED.source, items = EXCLUDED.items, owners = EXCLUDED.owners;

  PERFORM public.log_pipeline_run('entity-top-fans', v_started, v_items::int, v_rows, 0, v_rows > 0,
    CASE WHEN v_rows > 0 THEN NULL ELSE 'refresh produced no rows' END,
    v_slug, NULL, NULL, jsonb_build_object('source', v_source, 'owners', v_owners, 'migration', 'audit_20261127_entity_top_fans'));
  RETURN v_rows;
EXCEPTION WHEN query_canceled OR OTHERS THEN
  -- Bounded after the catch: one log call, then exit. The whole refresh rolled back, so the previous set stands.
  PERFORM public.log_pipeline_run('entity-top-fans', v_started, 0, 0, 0, false, SQLERRM,
    v_slug, NULL, NULL, jsonb_build_object('sqlstate', SQLSTATE, 'migration', 'audit_20261127_entity_top_fans'));
  RETURN -1;
END;
$$;

-- anon-exec: revoked (refresh_entity_top_fans) — new SECDEF writer; service_role + cron_heavy only.
REVOKE EXECUTE ON FUNCTION public.refresh_entity_top_fans(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_entity_top_fans(uuid) TO postgres, service_role, cron_heavy;

-- ── Reader ─────────────────────────────────────────────────────────────────────────────────────────────────
-- p_kind 'team'      p_key = the team page slug (Pinnacle: franchise slug)
-- p_kind 'player'    p_key = players.id (uuid text), p_name = players.name  (Pinnacle: p_name = character)
-- p_kind 'franchise' p_key = 'NBA:blazers' (Panini only)
-- Returns NULL when the collection has never been refreshed (could not ask ≠ none), else
-- {refreshed_at, source, special_tracked, holders, items, special_items, rows:[…]} where rows = the union of the
-- top p_limit owners by items, by FMV and by special serials (the page sorts by the chosen metric).
CREATE OR REPLACE FUNCTION public.get_entity_top_fans(
  p_collection_id uuid, p_kind text, p_key text, p_name text DEFAULT NULL, p_limit integer DEFAULT 10)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '8s'
AS $$
DECLARE
  v_pinnacle CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_limit    integer := least(greatest(coalesce(p_limit, 10), 1), 25);
  v_run      entity_top_fans_runs%ROWTYPE;
  v_keys     text[];
  v_pid      uuid;
  v_tot_n    integer;
  v_out      jsonb;
BEGIN
  IF p_collection_id IS NULL OR p_kind NOT IN ('team', 'player', 'franchise') OR coalesce(p_key, '') = '' THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_run FROM entity_top_fans_runs WHERE collection_id = p_collection_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF p_kind = 'team' THEN
    IF p_collection_id = v_pinnacle THEN
      v_keys := ARRAY[p_key];
    ELSE
      v_keys := ARRAY(SELECT DISTINCT s FROM unnest(public.team_franchise_slugs(p_collection_id, p_key) || ARRAY[p_key]) s);
    END IF;
  ELSIF p_kind = 'player' THEN
    IF p_collection_id = v_pinnacle THEN
      v_keys := ARRAY[lower(btrim(coalesce(p_name, p_key)))];
    ELSE
      IF p_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN v_pid := p_key::uuid; END IF;
      v_keys := ARRAY[p_key]
        || CASE WHEN p_name IS NULL THEN ARRAY[]::text[] ELSE ARRAY['name:' || p_name] END
        || CASE WHEN p_name IS NULL OR v_pid IS NULL THEN ARRAY[]::text[] ELSE
             ARRAY(SELECT p2.id::text FROM players p2
                    WHERE p2.collection_id = p_collection_id AND p2.name = p_name AND p2.id <> v_pid
                      AND NOT public.edition_player_is_other_person(p2.id, v_pid)) END;
    END IF;
  ELSE
    v_keys := ARRAY[p_key];
  END IF;

  SELECT count(*) INTO v_tot_n FROM entity_top_fans_totals t
   WHERE t.collection_id = p_collection_id AND t.entity_kind = p_kind AND t.entity_key = ANY (v_keys);

  WITH agg AS (
    SELECT f.owner, sum(f.items)::int AS items, sum(f.special_items)::int AS special_items,
           round(sum(f.fmv_usd), 2) AS fmv_usd, sum(f.fmv_items)::int AS fmv_items
      FROM entity_top_fans f
     WHERE f.collection_id = p_collection_id AND f.entity_kind = p_kind AND f.entity_key = ANY (v_keys)
     GROUP BY f.owner
  ), ranked AS (
    SELECT a.*,
           row_number() OVER (ORDER BY a.items DESC, a.fmv_usd DESC NULLS LAST, a.owner) AS r_items,
           row_number() OVER (ORDER BY a.fmv_usd DESC NULLS LAST, a.items DESC, a.owner) AS r_fmv,
           row_number() OVER (ORDER BY a.special_items DESC NULLS LAST, a.fmv_usd DESC NULLS LAST, a.owner) AS r_special
      FROM agg a
  ), top AS (
    SELECT * FROM ranked
     WHERE r_items <= v_limit OR r_fmv <= v_limit OR (r_special <= v_limit AND coalesce(special_items, 0) > 0)
  )
  SELECT jsonb_build_object(
    'refreshed_at',    v_run.refreshed_at,
    'source',          v_run.source,
    'special_tracked', p_collection_id <> v_pinnacle,
    -- holders/items are exact for one key; across several labels an owner can be counted under each, so no total.
    'holders',         CASE WHEN v_tot_n <= 1 THEN coalesce((SELECT sum(t.holders) FROM entity_top_fans_totals t
                              WHERE t.collection_id = p_collection_id AND t.entity_kind = p_kind AND t.entity_key = ANY (v_keys)), 0) END,
    'items',           coalesce((SELECT sum(t.items) FROM entity_top_fans_totals t
                              WHERE t.collection_id = p_collection_id AND t.entity_kind = p_kind AND t.entity_key = ANY (v_keys)), 0),
    'rows', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'owner', t.owner,
               'username', CASE WHEN p_collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid THEN t.owner ELSE wu.username END,
               'items', t.items, 'special_items', t.special_items, 'fmv_usd', t.fmv_usd, 'fmv_items', t.fmv_items)
             ORDER BY t.r_fmv)
        FROM top t
        LEFT JOIN LATERAL (SELECT u.username FROM wallet_usernames u WHERE u.wallet_addr = t.owner AND u.username IS NOT NULL LIMIT 1) wu ON true
    ), '[]'::jsonb)
  ) INTO v_out;
  RETURN v_out;
END;
$$;

-- anon-exec: revoked (get_entity_top_fans) — new SECDEF reader; pages call it with the service-role client.
REVOKE EXECUTE ON FUNCTION public.get_entity_top_fans(uuid, text, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_entity_top_fans(uuid, text, text, text, integer) TO postgres, service_role;
