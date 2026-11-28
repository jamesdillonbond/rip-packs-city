-- audit_20261127_top_collector_census
--
-- Trevor 2026-11-27: "We need to have this for every possible wallet, not just the ones we've captured. I
-- don't think I should be the top collector for blazers." The Top Collector Leaderboard for Top Shot, All Day,
-- Golazos and Pinnacle was built from the wallets RPC walks; the full census comes from Dune
-- (lib/dune/top-collector-census.ts, route /api/cron/top-collector-census-dune). This adds the DB half:
--
--   top_collector_census_map(collection)      rows (ek, kind, key, fmv, circ, jersey) uploaded to Dune: the
--                                             edition key AS THE MINT EVENT SPELLS IT, each entity it belongs
--                                             to (same keys as refresh_entity_top_fans), and kind='exclude'
--                                             rows for system accounts. Top Shot ek = set:play:sub (0 = Standard;
--                                             editions.external_id spells a parallel set:play::sub).
--   top_collector_census_map_csv(collection)  the same as ONE text value (no PostgREST row clamp).
--   entity_top_fans_census_stage              one run's result rows, keyed by run_id.
--   stage_top_collector_census(run, coll, rows) appends a page; returns rows written.
--   finalize_top_collector_census(run, coll, expected) one transaction: refuses a stage that is empty or not
--                                             exactly the expected row count (the previous set stays), else
--                                             swaps the leaderboard in as source 'dune_census'.
--   refresh_entity_top_fans                   skips a collection whose set is a Dune census (the walked rebuild
--                                             would replace every holder with the known subset).
--   get_entity_top_fans                       gains census_complete (dune_census, Panini serials, Candy census).
--
-- Written in a second session from the shipped route and generator: the first draft was never applied and
-- never left its sandbox (docs/features/top-fans.md). Nothing runs it until the Dune cycle (first run 12/15).
--
-- Revert:
--   re-apply refresh_entity_top_fans from 20261128010040 and get_entity_top_fans from 20261128000240;
--   DROP FUNCTION public.finalize_top_collector_census(uuid, uuid, integer), public.stage_top_collector_census(uuid, uuid, jsonb),
--     public.top_collector_census_map_csv(uuid), public.top_collector_census_map(uuid);
--   DROP TABLE public.entity_top_fans_census_stage;
--   then for any collection already swapped in: SELECT public.refresh_entity_top_fans('<id>') after deleting its
--   entity_top_fans_runs row (the skip keys on source = 'dune_census').

CREATE TABLE IF NOT EXISTS public.entity_top_fans_census_stage (
  run_id          uuid    NOT NULL,
  collection_id   uuid    NOT NULL,
  entity_kind     text    NOT NULL CHECK (entity_kind IN ('team', 'player')),
  entity_key      text    NOT NULL,
  owner           text    NOT NULL,
  items           integer NOT NULL,
  special_items   integer NOT NULL DEFAULT 0,
  fmv_usd         numeric,
  fmv_items       integer NOT NULL DEFAULT 0,
  holders         integer NOT NULL DEFAULT 0,
  entity_items    bigint  NOT NULL DEFAULT 0,
  entity_special  bigint  NOT NULL DEFAULT 0,
  staged_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, entity_kind, entity_key, owner)
);
CREATE INDEX IF NOT EXISTS entity_top_fans_census_stage_staged_at_idx ON public.entity_top_fans_census_stage (staged_at);
ALTER TABLE public.entity_top_fans_census_stage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.entity_top_fans_census_stage FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.entity_top_fans_census_stage TO service_role;

-- ── The map uploaded to Dune ───────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.top_collector_census_map(p_collection_id uuid)
RETURNS TABLE (ek text, kind text, key text, fmv numeric, circ integer, jersey integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_slug text;
BEGIN
  SELECT c.slug INTO v_slug FROM collections c WHERE c.id = p_collection_id;
  IF v_slug IS NULL OR v_slug NOT IN ('nba_top_shot', 'nfl_all_day', 'laliga_golazos', 'disney_pinnacle') THEN
    RAISE EXCEPTION 'top_collector_census_map: no census for collection %', p_collection_id;
  END IF;

  IF v_slug = 'disney_pinnacle' THEN
    RETURN QUERY
    SELECT pc.render_id::text, k.kind, k.key, pc.fmv_usd::numeric, NULL::integer, NULL::integer
      FROM pinnacle_catalog pc
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
     WHERE pc.render_id IS NOT NULL;
    RETURN QUERY
    SELECT ''::text, 'exclude'::text, lower(x.addr), NULL::numeric, NULL::integer, NULL::integer
      FROM (SELECT address AS addr FROM flowty_excluded_addresses
            UNION SELECT DISTINCT m.owner FROM mv_pinnacle_render_owners m WHERE m.is_system) x
     WHERE x.addr IS NOT NULL;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT CASE WHEN v_slug = 'nba_top_shot'
              THEN CASE WHEN e.external_id LIKE '%::%' THEN replace(e.external_id, '::', ':') ELSE e.external_id || ':0' END
              ELSE e.external_id END,
         k.kind, k.key,
         (SELECT ef.fmv_usd FROM edition_fmv_current ef WHERE ef.edition_id = e.id LIMIT 1)::numeric,
         e.circulation_count::integer, e.jersey_number::integer
    FROM editions e
   CROSS JOIN LATERAL (
     SELECT 'player'::text AS kind, coalesce(e.player_id::text, 'name:' || e.player_name) AS key
      WHERE e.player_id IS NOT NULL OR e.player_name IS NOT NULL
     UNION ALL
     SELECT 'team', regexp_replace(lower(trim(e.team_name)), '[^a-z0-9]+', '-', 'g')
      WHERE e.team_name IS NOT NULL AND trim(e.team_name) <> ''
   ) k
   WHERE e.collection_id = p_collection_id AND e.external_id IS NOT NULL;
  RETURN QUERY
  SELECT ''::text, 'exclude'::text, lower(xa.address), NULL::numeric, NULL::integer, NULL::integer
    FROM flowty_excluded_addresses xa WHERE xa.address IS NOT NULL;
END;
$$;
-- anon-exec: revoked (top_collector_census_map) — new SECDEF reader; the census route calls it with the service role.
REVOKE EXECUTE ON FUNCTION public.top_collector_census_map(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.top_collector_census_map(uuid) TO postgres, service_role;

CREATE OR REPLACE FUNCTION public.top_collector_census_map_csv(p_collection_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '60s'
AS $$
  -- Every field quoted (keys can hold commas: "Simba, Timon & Pumbaa"), as lib/dune/top-collector-census.ts mapCsv.
  SELECT 'ek,kind,key,fmv,circ,jersey' || E'\n' || coalesce(string_agg(
           concat_ws(',',
             CASE WHEN m.ek     IS NULL OR m.ek  = '' THEN '' ELSE '"' || replace(m.ek,  '"', '""') || '"' END,
             '"' || replace(m.kind, '"', '""') || '"',
             '"' || replace(m.key,  '"', '""') || '"',
             CASE WHEN m.fmv    IS NULL THEN '' ELSE '"' || m.fmv::text    || '"' END,
             CASE WHEN m.circ   IS NULL THEN '' ELSE '"' || m.circ::text   || '"' END,
             CASE WHEN m.jersey IS NULL THEN '' ELSE '"' || m.jersey::text || '"' END),
           E'\n' ORDER BY m.kind, m.key, m.ek), '') || E'\n'
    FROM public.top_collector_census_map(p_collection_id) m
$$;
-- anon-exec: revoked (top_collector_census_map_csv) — new SECDEF reader; service role only.
REVOKE EXECUTE ON FUNCTION public.top_collector_census_map_csv(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.top_collector_census_map_csv(uuid) TO postgres, service_role;

-- ── Stage one page of the Dune result ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.stage_top_collector_census(p_run_id uuid, p_collection_id uuid, p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n integer := 0;
BEGIN
  IF p_run_id IS NULL OR p_collection_id IS NULL OR p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'stage_top_collector_census: run, collection and a rows array are required';
  END IF;
  IF p_collection_id NOT IN (SELECT id FROM collections WHERE slug IN ('nba_top_shot', 'nfl_all_day', 'laliga_golazos', 'disney_pinnacle')) THEN
    RAISE EXCEPTION 'stage_top_collector_census: no census for collection %', p_collection_id;
  END IF;
  INSERT INTO entity_top_fans_census_stage
    (run_id, collection_id, entity_kind, entity_key, owner, items, special_items, fmv_usd, fmv_items, holders, entity_items, entity_special)
  SELECT p_run_id, p_collection_id, r.entity_kind, r.entity_key, lower(r.owner), r.items,
         coalesce(r.special_items, 0), r.fmv_usd, coalesce(r.fmv_items, 0),
         coalesce(r.holders, 0), coalesce(r.entity_items, 0), coalesce(r.entity_special, 0)
    FROM jsonb_to_recordset(p_rows) AS r(entity_kind text, entity_key text, owner text, items integer, special_items integer,
                                         fmv_usd numeric, fmv_items integer, holders integer, entity_items bigint, entity_special bigint)
   WHERE r.entity_kind IN ('team', 'player') AND coalesce(r.entity_key, '') <> '' AND r.owner ~* '^0x[0-9a-f]{16}$' AND r.items IS NOT NULL
  ON CONFLICT (run_id, entity_kind, entity_key, owner) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
-- anon-exec: revoked (stage_top_collector_census) — new SECDEF writer; service role only.
REVOKE EXECUTE ON FUNCTION public.stage_top_collector_census(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stage_top_collector_census(uuid, uuid, jsonb) TO postgres, service_role;

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
  v_queued  integer := 0;
BEGIN
  SELECT slug INTO v_slug FROM collections WHERE id = p_collection_id;
  IF v_slug IS NULL THEN
    RAISE EXCEPTION 'refresh_entity_top_fans: unknown collection %', p_collection_id;
  END IF;

  -- A full Dune census owns this collection's leaderboard once it lands (audit_20261127_top_collector_census):
  -- the walked-wallet rebuild below would replace every holder with the subset RPC happens to know.
  IF EXISTS (SELECT 1 FROM entity_top_fans_runs r WHERE r.collection_id = p_collection_id AND r.source = 'dune_census') THEN
    PERFORM public.log_pipeline_run('entity-top-fans', v_started, 0, 0, 0, true, NULL,
      v_slug, NULL, NULL, jsonb_build_object('skipped', 'dune_census_owns_this_collection', 'migration', 'audit_20261127_top_collector_census'));
    RETURN 0;
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

  -- Usernames for the owners now on a leaderboard (Trevor 11-27: "figure out usernames for those pinnacle
  -- users"). Dispatched to Atlas SearchUserProfiles and queued in member_wallet_username_requests, which the
  -- username job (pg_cron 650, every 10 min) already drains. Its own block: a failure here never rolls back
  -- the refresh.
  BEGIN
    v_queued := public.queue_top_collector_usernames(p_collection_id);
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_queued := -1;
  END;

  PERFORM public.log_pipeline_run('entity-top-fans', v_started, v_items::int, v_rows, 0, v_rows > 0,
    CASE WHEN v_rows > 0 THEN NULL ELSE 'refresh produced no rows' END,
    v_slug, NULL, NULL, jsonb_build_object('source', v_source, 'owners', v_owners, 'usernames_queued', v_queued, 'migration', 'audit_20261127_top_collector_usernames'));
  RETURN v_rows;
EXCEPTION WHEN query_canceled OR OTHERS THEN
  -- Bounded after the catch: one log call, then exit. The whole refresh rolled back, so the previous set stands.
  PERFORM public.log_pipeline_run('entity-top-fans', v_started, 0, 0, 0, false, SQLERRM,
    v_slug, NULL, NULL, jsonb_build_object('sqlstate', SQLSTATE, 'migration', 'audit_20261127_entity_top_fans'));
  RETURN -1;
END;
$$;
-- anon-exec: unchanged (refresh_entity_top_fans) — CREATE OR REPLACE of an existing fn; ACL preserved (revoked in 20261128000240).

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
    -- true only when the owner source is a census of EVERY holder; the page ranks only then.
    'census_complete', v_run.source IN ('dune_census', 'panini_card_serials', 'wallet_moments_cache (candy census)'),
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
-- anon-exec: unchanged (get_entity_top_fans) — CREATE OR REPLACE of an existing fn; ACL preserved (revoked in 20261128000240).

-- ── Swap the census in ─────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.finalize_top_collector_census(p_run_id uuid, p_collection_id uuid, p_expected_rows integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_slug     text;
  v_staged   integer;
  v_rows     integer;
  v_entities integer;
  v_owners   integer;
  v_items    bigint;
  v_queued   integer := NULL;
  v_qerr     text := NULL;
BEGIN
  SELECT slug INTO v_slug FROM collections WHERE id = p_collection_id;
  IF v_slug IS NULL OR v_slug NOT IN ('nba_top_shot', 'nfl_all_day', 'laliga_golazos', 'disney_pinnacle') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no census for this collection');
  END IF;

  SELECT count(*) INTO v_staged FROM entity_top_fans_census_stage WHERE run_id = p_run_id AND collection_id = p_collection_id;
  -- A short or empty stage is refused: the previous leaderboard stays (an absent census is not "no fans").
  IF v_staged = 0 OR p_expected_rows IS NULL OR v_staged <> p_expected_rows THEN
    DELETE FROM entity_top_fans_census_stage WHERE run_id = p_run_id;
    RETURN jsonb_build_object('ok', false, 'error', format('stage holds %s rows, expected %s', v_staged, p_expected_rows));
  END IF;

  DELETE FROM entity_top_fans        WHERE collection_id = p_collection_id;
  DELETE FROM entity_top_fans_totals WHERE collection_id = p_collection_id;

  INSERT INTO entity_top_fans_totals (collection_id, entity_kind, entity_key, holders, items, special_items)
  SELECT p_collection_id, s.entity_kind, s.entity_key, max(s.holders), max(s.entity_items),
         CASE WHEN v_slug = 'disney_pinnacle' THEN NULL ELSE max(s.entity_special) END
    FROM entity_top_fans_census_stage s
   WHERE s.run_id = p_run_id
   GROUP BY s.entity_kind, s.entity_key;
  GET DIAGNOSTICS v_entities = ROW_COUNT;

  -- Pinnacle has no serial numbers in RPC's model: special serials are NOT TRACKED (NULL), never 0.
  INSERT INTO entity_top_fans (collection_id, entity_kind, entity_key, owner, items, special_items, fmv_usd, fmv_items)
  SELECT p_collection_id, s.entity_kind, s.entity_key, s.owner, s.items,
         CASE WHEN v_slug = 'disney_pinnacle' THEN NULL ELSE s.special_items END,
         round(s.fmv_usd, 2), s.fmv_items
    FROM entity_top_fans_census_stage s
   WHERE s.run_id = p_run_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- runs.items / runs.owners: for a census these describe the LEADERBOARD set (top rows per entity), not the
  -- whole collection — Dune returns only the ranked rows. Nothing renders them.
  SELECT count(DISTINCT s.owner), coalesce(sum(s.items), 0) INTO v_owners, v_items
    FROM entity_top_fans_census_stage s WHERE s.run_id = p_run_id;
  INSERT INTO entity_top_fans_runs (collection_id, refreshed_at, source, items, owners)
  VALUES (p_collection_id, now(), 'dune_census', v_items, v_owners)
  ON CONFLICT (collection_id) DO UPDATE
    SET refreshed_at = EXCLUDED.refreshed_at, source = EXCLUDED.source, items = EXCLUDED.items, owners = EXCLUDED.owners;

  DELETE FROM entity_top_fans_census_stage WHERE run_id = p_run_id OR staged_at < now() - interval '2 days';

  -- Name the new owners (most were never walked, so no username lane has seen them). A failure here must not
  -- undo the swap, so it is caught and reported.
  BEGIN
    v_queued := public.queue_top_collector_usernames(p_collection_id);
  EXCEPTION WHEN OTHERS THEN
    v_qerr := SQLERRM;
  END;

  RETURN jsonb_build_object('ok', true, 'rows', v_rows, 'entities', v_entities, 'owners', v_owners,
                            'usernames_queued', v_queued, 'usernames_error', v_qerr);
END;
$$;
-- anon-exec: revoked (finalize_top_collector_census) — new SECDEF writer; service role only.
REVOKE EXECUTE ON FUNCTION public.finalize_top_collector_census(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_top_collector_census(uuid, uuid, integer) TO postgres, service_role;
