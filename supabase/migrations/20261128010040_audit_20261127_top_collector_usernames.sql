-- audit_20261127_top_collector_usernames
--
-- Trevor 2026-11-27: "We also need to figure out usernames for those pinnacle users." The top owners of a
-- Pinnacle character come from the mint/ownership map, never from a sale, so no username lane ever asked
-- about them (679 of 840 Pinnacle leaderboard owners had no name). Atlas SearchUserProfiles resolves them
-- (one Dapper username across products): a one-off dispatch at 4:38 PM PT named 838 of 840.
--
-- queue_top_collector_usernames(collection_id) dispatches the same Atlas call for every leaderboard owner
-- still without a username (or a >14-day-old miss), 20 per request, and queues the requests in
-- member_wallet_username_requests — the existing username job (pg_cron 650) collects them. Called at the
-- end of refresh_entity_top_fans, so every refresh names its new owners. Flow (0x…) owners only; Panini
-- owners are already usernames; Candy has no Dapper profiles.
--
-- Revert: re-apply refresh_entity_top_fans from 20261128000240; DROP FUNCTION public.queue_top_collector_usernames(uuid);

CREATE OR REPLACE FUNCTION public.queue_top_collector_usernames(p_collection_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n   integer := 0;
  r     record;
  v_req bigint;
BEGIN
  FOR r IN
    WITH t AS (
      SELECT DISTINCT f.owner
        FROM entity_top_fans f
        LEFT JOIN wallet_usernames wu ON wu.wallet_addr = f.owner
       WHERE f.collection_id = p_collection_id
         AND f.owner ~ '^0x[0-9a-f]{16}$'
         AND (wu.wallet_addr IS NULL
              OR (wu.username IS NULL AND (wu.last_attempted_at IS NULL OR wu.last_attempted_at < now() - interval '14 days')))
         AND NOT EXISTS (SELECT 1 FROM member_wallet_username_requests q
                          WHERE q.drained_at IS NULL AND f.owner = ANY (q.wallets))
    )
    SELECT array_agg(owner ORDER BY owner) AS w
      FROM (SELECT owner, (row_number() OVER (ORDER BY owner) - 1) / 20 AS g FROM t) x
     GROUP BY g
     LIMIT 60
  LOOP
    v_req := net.http_post(
      url := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.ProfileService/SearchUserProfiles',
      body := jsonb_build_object('product', 'nba', 'flow_addresses', to_jsonb(r.w)),
      headers := public.atlas_market_headers('nba'),
      timeout_milliseconds := 15000);
    INSERT INTO member_wallet_username_requests (request_id, wallets) VALUES (v_req, r.w);
    v_n := v_n + cardinality(r.w);
  END LOOP;
  RETURN v_n;
END;
$$;

-- anon-exec: revoked (queue_top_collector_usernames) — new SECDEF function that makes outbound requests.
REVOKE EXECUTE ON FUNCTION public.queue_top_collector_usernames(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.queue_top_collector_usernames(uuid) TO postgres, service_role, cron_heavy;

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
