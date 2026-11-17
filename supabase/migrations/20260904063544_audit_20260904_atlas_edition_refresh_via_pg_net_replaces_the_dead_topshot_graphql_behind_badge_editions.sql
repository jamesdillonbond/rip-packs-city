-- audit_20260904_atlas_edition_refresh_via_pg_net_replaces_the_dead_topshot_graphql_behind_badge_editions
-- Applied to prod via MCP apply_migration 2026-09-04 06:35Z (version 20260904063544).
--
-- FINDING (2026-09-04 audit of all 15,183 Top Shot Moments in the founder wallet against Dapper's
-- Atlas API): every Top Shot fact RPC keeps in badge_editions — low ask, highest offer, average
-- sale, badges, minted / burned / effective supply — has been FROZEN since 2026-08-28 15:16Z. The
-- feed behind it (app/api/badge-sync — Top Shot GraphQL on public-api.nbatopshot.com) answers 530
-- on every tick (topshot-badge-set-backfill: 25 failed runs in 7 d, 0 rows; topshot-badge-sync and
-- -catalog last ran 08-30). Measured cost on the wallet: 1,431 editions with a badge_editions
-- low_ask that no longer matches Top Shot's; 92 Moments carrying Rookie Mint / Rookie Year /
-- Championship Year badges on Top Shot with NO badge row here; the moment page's "Top Shot ask"
-- was a week old on every Moment. badge_editions is read by 23 functions (sniper deals, hot
-- floors, set progress, best offer, market pulse, collection stats, …).
--
-- FIX: Atlas SearchEditions (one call = up to 100 editions of one set, with every field above
-- plus `parallel`) fetched by pg_net from this database — a GetEdition probe answered 200 from
-- here at 06:20Z; Cloudflare-worker and Vercel egress are WAF-blocked, pg_net is not (08-31
-- finding). Two tiny pg_cron jobs, both as postgres: dispatch 8 calls / 2 min (in-progress walks
-- first, then least-recently-dispatched sets; ~266 sets → full catalog ≈ 1 h at 0.07 req/s) and a
-- drain on the odd minutes that parses net._http_response, upserts badge_editions keyed exactly as
-- the GraphQL rows were (set:play, set:play::N via editions.subedition_name; id = set+play+N so
-- get_badge_premium's split_part(id,'+') key still resolves) and refreshes topshot_atlas_edition_map
-- through the parallel-exact upsert (20260904055030). First measured tick: 3 requests → 260 rows,
-- 2.5 s; LeBron 5:133 low_ask 16.00 (08-28) → 1,950.00 (= Atlas lowAskCents 195000), badges
-- Championship Year + Top Shot Debut (= Atlas). Logs `atlas-editions-refresh` per non-empty
-- drain with requests / rows / errors / sets_complete.
-- ⚠ pg_net answers a BATCH when its slowest request finishes: with jobid 55 (allday-pack-opens
--   backfill, 90 s timeout on every tick since 02:16Z) in the queue, a dispatch answered only after
--   that 90 s wall. Jobid 55 was unscheduled the same pass (ledger); the drain tolerates late
--   answers regardless (a request is only errored after 10 min without one).
-- anon-exec: no — atlas_editions_dispatch(integer) and atlas_editions_drain() are writers;
--   REVOKE … FROM PUBLIC, anon, authenticated; GRANT postgres, service_role, cron_heavy.
-- REVERT: SELECT cron.unschedule('rpc-atlas-editions-dispatch'); SELECT cron.unschedule('rpc-atlas-editions-drain');
--   DROP FUNCTION public.atlas_editions_dispatch(integer), public.atlas_editions_drain();
--   DROP TABLE public.atlas_edition_requests, public.atlas_set_refresh_state. badge_editions rows
--   are overwritten in place (no old-value audit — the old values were a week stale by design of
--   the defect); the GraphQL route is untouched and would resume if its host ever returns.

-- ── Atlas edition refresh (Top Shot) — pg_net dispatcher + drainer ─────────────────────────────
-- Replaces the dead Top Shot GraphQL feed behind badge_editions (asks, offers, avg sale, badges,
-- minted/burned/effective supply, parallels) with Dapper's public Atlas API, which Supabase's pg_net
-- CAN reach (a GetEdition probe answered 200 from this database 2026-09-04 06:20Z; the 08-31 finding
-- "pg_net reaches Atlas at ~90%" stands). One SearchEditions call = up to 100 editions of one set.

CREATE TABLE IF NOT EXISTS public.atlas_set_refresh_state (
  set_id_onchain     integer PRIMARY KEY,
  next_offset        integer NOT NULL DEFAULT 0,
  total_count        integer,
  last_dispatched_at timestamptz,
  last_completed_at  timestamptz,
  pages_ok           integer NOT NULL DEFAULT 0,
  pages_err          integer NOT NULL DEFAULT 0,
  last_error         text
);
ALTER TABLE public.atlas_set_refresh_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.atlas_set_refresh_state FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.atlas_set_refresh_state TO postgres, service_role, cron_heavy;

CREATE TABLE IF NOT EXISTS public.atlas_edition_requests (
  request_id     bigint PRIMARY KEY,
  set_id_onchain integer NOT NULL,
  offset_at      integer NOT NULL,
  dispatched_at  timestamptz NOT NULL DEFAULT now(),
  drained_at     timestamptz,
  status_code    integer,
  rows_upserted  integer,
  error          text
);
CREATE INDEX IF NOT EXISTS idx_atlas_edition_requests_open ON public.atlas_edition_requests (dispatched_at) WHERE drained_at IS NULL;
ALTER TABLE public.atlas_edition_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.atlas_edition_requests FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.atlas_edition_requests TO postgres, service_role, cron_heavy;

-- Dispatcher: fires p_calls SearchEditions requests, one per set, in-progress walks first, then the
-- least recently dispatched. A set with an undrained request younger than 10 min is in flight.
CREATE OR REPLACE FUNCTION public.atlas_editions_dispatch(p_calls integer DEFAULT 8)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  r record;
  v_req bigint;
  v_n integer := 0;
BEGIN
  -- Seed: every Top Shot set the catalog knows.
  INSERT INTO public.atlas_set_refresh_state (set_id_onchain)
  SELECT DISTINCT e.set_id_onchain FROM public.editions e
   WHERE e.collection_id = v_ts AND e.set_id_onchain IS NOT NULL
  ON CONFLICT (set_id_onchain) DO NOTHING;

  FOR r IN
    SELECT s.set_id_onchain, s.next_offset
      FROM public.atlas_set_refresh_state s
     WHERE NOT EXISTS (SELECT 1 FROM public.atlas_edition_requests q
                        WHERE q.set_id_onchain = s.set_id_onchain AND q.drained_at IS NULL
                          AND q.dispatched_at > now() - interval '10 minutes')
     ORDER BY (s.next_offset > 0) DESC, s.last_dispatched_at ASC NULLS FIRST, s.set_id_onchain
     LIMIT GREATEST(p_calls, 0)
  LOOP
    v_req := net.http_post(
      url     := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.EditionService/SearchEditions',
      body    := jsonb_build_object('product', 'nba', 'setId', jsonb_build_array(r.set_id_onchain::text),
                                    'limit', '100', 'offset', r.next_offset::text),
      headers := '{"content-type":"application/json","connect-protocol-version":"1","origin":"https://nbatopshot.com","referer":"https://nbatopshot.com/","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"}'::jsonb,
      timeout_milliseconds := 20000);
    INSERT INTO public.atlas_edition_requests (request_id, set_id_onchain, offset_at) VALUES (v_req, r.set_id_onchain, r.next_offset);
    UPDATE public.atlas_set_refresh_state SET last_dispatched_at = now() WHERE set_id_onchain = r.set_id_onchain;
    v_n := v_n + 1;
  END LOOP;
  RETURN jsonb_build_object('dispatched', v_n);
END
$function$;
REVOKE EXECUTE ON FUNCTION public.atlas_editions_dispatch(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atlas_editions_dispatch(integer) TO postgres, service_role, cron_heavy;

-- Drainer: for every dispatched request whose response has landed, upsert badge_editions and advance
-- (or complete) the set's walk. Keyed exactly like the GraphQL rows were: external_id = set:play for
-- the Standard printing, set:play::N for a parallel (N from editions.subedition_name), and
-- id = set+play+N so get_badge_premium's split_part(id,'+') key stays valid. Badges come from Atlas
-- `badges[]` titles (Rookie Mint is a set-play tag, everything else a play tag — the GraphQL shape).
CREATE OR REPLACE FUNCTION public.atlas_editions_drain()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_started timestamptz := clock_timestamp();
  q record;
  v_body jsonb;
  v_n integer;
  v_page integer;
  v_total integer;
  v_more boolean;
  v_reqs integer := 0;
  v_rows integer := 0;
  v_errs integer := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('atlas_editions_drain')::bigint) THEN
    RETURN jsonb_build_object('skipped', 'concurrent');
  END IF;

  DROP TABLE IF EXISTS _atlas_submap;
  CREATE TEMP TABLE _atlas_submap ON COMMIT DROP AS
    SELECT DISTINCT e.subedition_name AS name, e.subedition_id AS id
      FROM public.editions e
     WHERE e.collection_id = v_ts AND e.subedition_id IS NOT NULL AND e.subedition_name IS NOT NULL;

  FOR q IN
    SELECT a.request_id, a.set_id_onchain, a.offset_at, r.status_code, r.content, r.error_msg, r.timed_out
      FROM public.atlas_edition_requests a
      LEFT JOIN net._http_response r ON r.id = a.request_id
     WHERE a.drained_at IS NULL
       AND (r.id IS NOT NULL OR a.dispatched_at < now() - interval '10 minutes')
     ORDER BY a.dispatched_at
     LIMIT 50
  LOOP
    v_reqs := v_reqs + 1;
    BEGIN
      IF q.status_code IS NULL OR q.status_code <> 200 OR q.timed_out THEN
        RAISE EXCEPTION 'atlas % (%): %', COALESCE(q.status_code::text, 'no-response'), COALESCE(q.error_msg, ''), left(COALESCE(q.content, ''), 120);
      END IF;
      v_body := q.content::jsonb;
      IF jsonb_typeof(v_body->'editions') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'atlas 200 without editions[]: %', left(q.content, 160);
      END IF;
      v_page  := jsonb_array_length(v_body->'editions');
      v_total := NULLIF(v_body->'pagination'->>'totalCount', '')::int;
      v_more  := COALESCE((v_body->'pagination'->>'hasMore')::boolean, v_page >= 100);

      WITH e AS (
        SELECT x.ed,
               (x.ed->>'setId')::int AS set_id, (x.ed->>'editionTemplateId')::int AS play_id,
               COALESCE(NULLIF(x.ed->>'parallel',''), 'Standard') AS parallel,
               x.ed->'editionTemplate'->'metadata' AS m
          FROM jsonb_array_elements(v_body->'editions') AS x(ed)
      ),
      keyed AS (
        SELECT e.*,
               CASE WHEN e.parallel = 'Standard' THEN 0 ELSE sm.id END AS par_id
          FROM e LEFT JOIN _atlas_submap sm ON sm.name = e.parallel
      ),
      rows_ AS (
        SELECT
          k.set_id || '+' || k.play_id || '+' || k.par_id::text                                   AS id,
          v_ts                                                                                   AS collection_id,
          k.set_id || ':' || k.play_id || CASE WHEN k.par_id > 0 THEN '::' || k.par_id::text ELSE '' END AS external_id,
          NULLIF(k.m->>'PlayerId','')                                                            AS player_id,
          NULLIF(k.m->>'FullName','')                                                            AS player_name,
          NULLIF(k.m->>'TeamAtMoment','')                                                        AS team,
          NULLIF(k.m->>'TeamAtMomentNBAID','')                                                   AS team_nba_id,
          NULLIF(k.m->>'NbaSeason','')                                                           AS season,
          NULLIF(k.ed->'set'->>'name','')                                                        AS set_name,
          k.ed->>'tier'                                                                          AS tier,
          k.par_id                                                                               AS parallel_id,
          CASE WHEN k.par_id > 0 THEN k.parallel ELSE '' END                                     AS parallel_name,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('id', b->>'slugV2', 'title', b->>'title'))
                      FROM jsonb_array_elements(COALESCE(k.ed->'badges','[]'::jsonb)) b
                     WHERE COALESCE((b->>'visible')::boolean, true) AND b->>'slugV2' <> 'ROOKIE_MINT'), '[]'::jsonb) AS play_tags,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('id', b->>'slugV2', 'title', b->>'title'))
                      FROM jsonb_array_elements(COALESCE(k.ed->'badges','[]'::jsonb)) b
                     WHERE b->>'slugV2' = 'ROOKIE_MINT'), '[]'::jsonb)                           AS set_play_tags,
          (SELECT array_agg(b->>'slugV2') FROM jsonb_array_elements(COALESCE(k.ed->'badges','[]'::jsonb)) b) AS slugs,
          NULLIF((k.ed->>'lowAskCents')::numeric, 0) / 100.0                                     AS low_ask,
          NULLIF((k.ed->>'highestOfferCents')::numeric, 0) / 100.0                               AS highest_offer,
          NULLIF((k.ed->>'averageSalePriceCents')::numeric, 0) / 100.0                           AS avg_sale_price,
          COALESCE((k.ed->>'numMinted')::int, 0)                                                 AS circulation_count,
          NULLIF(k.ed->>'effectiveSupply','')::int                                               AS effective_supply,
          COALESCE((k.ed->>'numBurned')::int, 0)                                                 AS burned,
          COALESCE((k.ed->>'numLocked')::int, 0)                                                 AS locked,
          COALESCE((k.ed->>'numOwned')::int, 0)                                                  AS owned,
          NULLIF(k.ed->>'numHiddenInPacks','')::int                                              AS hidden_in_packs,
          NULLIF(k.ed->'metadata'->>'assetPathPrefix','')                                        AS asset_path_prefix
        FROM keyed k
        WHERE k.set_id IS NOT NULL AND k.play_id IS NOT NULL AND k.par_id IS NOT NULL   -- an unknown parallel name is skipped, never mis-keyed
      ),
      scored AS (
        SELECT r.*,
               ('ROOKIE_YEAR' = ANY(r.slugs) AND 'ROOKIE_PREMIERE' = ANY(r.slugs) AND 'TOP_SHOT_DEBUT' = ANY(r.slugs)) AS is3,
               ('ROOKIE_MINT' = ANY(r.slugs)) AS rm
          FROM rows_ r
      ),
      up AS (
        INSERT INTO public.badge_editions AS be
          (id, collection_id, external_id, player_id, player_name, team, team_nba_id, season, set_name, series_number,
           tier, parallel_id, parallel_name, play_tags, set_play_tags, is_three_star_rookie, has_rookie_mint, badge_score,
           low_ask, highest_offer, avg_sale_price, circulation_count, effective_supply, burned, locked, owned, hidden_in_packs,
           burn_rate_pct, lock_rate_pct, flow_retired, asset_path_prefix, updated_at)
        SELECT s.id, s.collection_id, s.external_id, s.player_id, s.player_name, s.team, s.team_nba_id, s.season, s.set_name,
               (SELECT ed.series FROM public.editions ed WHERE ed.collection_id = v_ts AND ed.external_id = s.external_id LIMIT 1),
               s.tier, s.parallel_id, s.parallel_name, s.play_tags, s.set_play_tags, COALESCE(s.is3,false), COALESCE(s.rm,false),
               (CASE WHEN 'ROOKIE_YEAR'        = ANY(s.slugs) THEN 1 ELSE 0 END) +
               (CASE WHEN 'ROOKIE_PREMIERE'    = ANY(s.slugs) THEN 1 ELSE 0 END) +
               (CASE WHEN 'TOP_SHOT_DEBUT'     = ANY(s.slugs) THEN 1 ELSE 0 END) +
               (CASE WHEN 'ROOKIE_MINT'        = ANY(s.slugs) THEN 1 ELSE 0 END) +
               (CASE WHEN COALESCE(s.is3,false) AND COALESCE(s.rm,false) THEN 4 ELSE 0 END) +
               (CASE WHEN 'ROOKIE_OF_THE_YEAR' = ANY(s.slugs) THEN 3 ELSE 0 END) +
               (CASE WHEN 'CHAMPIONSHIP_YEAR'  = ANY(s.slugs) THEN 2 ELSE 0 END),
               s.low_ask, s.highest_offer, s.avg_sale_price, s.circulation_count, s.effective_supply, s.burned, s.locked, s.owned, s.hidden_in_packs,
               CASE WHEN s.circulation_count > 0 THEN round(100.0 * s.burned / s.circulation_count, 2) ELSE 0 END,
               CASE WHEN s.circulation_count > 0 THEN round(100.0 * s.locked / s.circulation_count, 2) ELSE 0 END,
               false, s.asset_path_prefix, now()
          FROM scored s
        ON CONFLICT (external_id, collection_id) DO UPDATE SET
          player_id = COALESCE(EXCLUDED.player_id, be.player_id),
          player_name = COALESCE(EXCLUDED.player_name, be.player_name),
          team = COALESCE(EXCLUDED.team, be.team),
          team_nba_id = COALESCE(EXCLUDED.team_nba_id, be.team_nba_id),
          season = COALESCE(EXCLUDED.season, be.season),
          set_name = COALESCE(EXCLUDED.set_name, be.set_name),
          series_number = COALESCE(EXCLUDED.series_number, be.series_number),
          tier = COALESCE(EXCLUDED.tier, be.tier),
          parallel_id = EXCLUDED.parallel_id,
          parallel_name = EXCLUDED.parallel_name,
          play_tags = EXCLUDED.play_tags,
          set_play_tags = EXCLUDED.set_play_tags,
          is_three_star_rookie = EXCLUDED.is_three_star_rookie,
          has_rookie_mint = EXCLUDED.has_rookie_mint,
          badge_score = EXCLUDED.badge_score,
          low_ask = EXCLUDED.low_ask,
          highest_offer = EXCLUDED.highest_offer,
          avg_sale_price = EXCLUDED.avg_sale_price,
          circulation_count = EXCLUDED.circulation_count,
          effective_supply = EXCLUDED.effective_supply,
          burned = EXCLUDED.burned,
          locked = EXCLUDED.locked,
          owned = EXCLUDED.owned,
          hidden_in_packs = EXCLUDED.hidden_in_packs,
          burn_rate_pct = EXCLUDED.burn_rate_pct,
          lock_rate_pct = EXCLUDED.lock_rate_pct,
          asset_path_prefix = COALESCE(EXCLUDED.asset_path_prefix, be.asset_path_prefix),
          updated_at = now()
        RETURNING 1
      )
      SELECT count(*)::int INTO v_n FROM up;

      -- Keep the RPC ↔ Atlas edition map current on the same page (the June one-off never re-ran;
      -- 20260904055030 made the join parallel-exact).
      PERFORM public.upsert_topshot_atlas_edition_map((
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'atlas_edition_id', ed->>'id', 'set_id_onchain', ed->>'setId', 'play_id_onchain', ed->>'editionTemplateId',
                 'num_minted', ed->>'numMinted', 'tier', ed->>'tier', 'parallel', COALESCE(NULLIF(ed->>'parallel',''), 'Standard'))), '[]'::jsonb)
          FROM jsonb_array_elements(v_body->'editions') ed));

      UPDATE public.atlas_set_refresh_state
         SET next_offset = CASE WHEN v_more AND v_page > 0 THEN q.offset_at + v_page ELSE 0 END,
             total_count = COALESCE(v_total, total_count),
             last_completed_at = CASE WHEN v_more AND v_page > 0 THEN last_completed_at ELSE now() END,
             pages_ok = pages_ok + 1,
             last_error = NULL
       WHERE set_id_onchain = q.set_id_onchain;
      UPDATE public.atlas_edition_requests SET drained_at = now(), status_code = q.status_code, rows_upserted = v_n WHERE request_id = q.request_id;
      v_rows := v_rows + COALESCE(v_n, 0);
    EXCEPTION WHEN OTHERS THEN
      v_errs := v_errs + 1;
      UPDATE public.atlas_set_refresh_state
         SET pages_err = pages_err + 1, last_error = left(SQLERRM, 300)
       WHERE set_id_onchain = q.set_id_onchain;
      UPDATE public.atlas_edition_requests SET drained_at = now(), status_code = q.status_code, error = left(SQLERRM, 300) WHERE request_id = q.request_id;
    END;
  END LOOP;

  -- Retention: keep a day of request bookkeeping.
  DELETE FROM public.atlas_edition_requests WHERE drained_at < now() - interval '24 hours';

  -- A tick with nothing to drain writes no run row (the dispatcher fires every 2 min; 720 empty
  -- rows/day would be noise). An EMPTY 200 page is treated as the end of that set's walk — under
  -- Atlas's known soft-throttle (200 with empty results) that costs one cycle, never a row: nothing
  -- is written from an empty page, and the next cycle re-walks the set.
  IF v_reqs > 0 THEN
  PERFORM public.log_pipeline_run('atlas-editions-refresh', v_started, v_reqs, v_rows, v_errs, v_errs = 0 OR v_rows > 0,
                                  CASE WHEN v_errs > 0 THEN v_errs || ' request(s) failed — see atlas_set_refresh_state.last_error' END,
                                  'nba_top_shot', NULL, NULL,
                                  jsonb_build_object('duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int,
                                                     'requests', v_reqs, 'rows', v_rows, 'errors', v_errs, 'via', 'pg_cron',
                                                     'sets_complete', (SELECT count(*) FROM public.atlas_set_refresh_state WHERE last_completed_at IS NOT NULL),
                                                     'sets_total', (SELECT count(*) FROM public.atlas_set_refresh_state)));
  END IF;
  RETURN jsonb_build_object('requests', v_reqs, 'rows', v_rows, 'errors', v_errs);
END
$function$;
REVOKE EXECUTE ON FUNCTION public.atlas_editions_drain() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atlas_editions_drain() TO postgres, service_role, cron_heavy;

-- Cadence: 8 calls every 2 min (~240/h → the ~266-set catalog walks in about an hour, at 0.07 req/s —
-- far below the burst Atlas has been seen to soft-throttle), drained on the odd minutes.
SELECT cron.schedule('rpc-atlas-editions-dispatch', '*/2 * * * *', $$SELECT public.atlas_editions_dispatch(8)$$);
SELECT cron.schedule('rpc-atlas-editions-drain',    '1-59/2 * * * *', $$SELECT public.atlas_editions_drain()$$);
