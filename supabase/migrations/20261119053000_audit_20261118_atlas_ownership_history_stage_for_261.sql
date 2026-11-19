-- audit_20261118_atlas_ownership_history_stage_for_261
--
-- 2026-11-18 (PT, ~9:00 PM; Claude Code cloud; Trevor: "Do all of them") -- item 2 of the Atlas port; #261.
-- #261 (acquisition dates for held moments) was blocked on Dune credits until 12-14. Atlas
-- NFTService/GetNftOwnershipHistory {product, nftId} answers anonymously with every owner of an NFT:
-- {flowAddress, depositedAt, acquisitionType ACQUISITION_TYPE_PURCHASE|TRANSFER|UNSPECIFIED}.
-- Measured 11-18: Top Shot 52052219 -- the prior owner's pack pull is 06-08 00:00:26Z in Atlas vs
-- 00:00:23Z in our moment_acquisitions (3 s apart), and the CURRENT saved-wallet owner's 06-08 PURCHASE
-- had no row at all; All Day / Golazos / Pinnacle histories answer back to 2022.
--
-- REVIEW-ONLY, like the 11-14 Dune stage (topshot_dune_acquisition_stage): this writes
-- atlas_ownership_stage and NOTHING ELSE. moment_acquisitions is untouched; importing is Trevor's call.
-- Population at install (saved wallets, held, no DATED acquisition row): All Day 20,692 · Top Shot 13,296
-- · Pinnacle 7,595 · Golazos 157. One call per NFT, 15 a minute (one small batch per tick -- Cloudflare in
-- front of Atlas escalates on bursts) => ~46 h; All Day / Golazos / Pinnacle first, Top Shot last.
-- Each request is recorded in atlas_ondemand_requests, which check_edge_fn_http_failures already joins,
-- so a Cloudflare 403 is attributed ('atlas-ondemand') rather than paging as unknown.
--
-- REVERT: SELECT cron.unschedule('rpc-atlas-ownership-stage'); DROP FUNCTION public.run_atlas_ownership_stage_lane();
-- DROP FUNCTION public.seed_atlas_ownership_stage(integer); DROP VIEW public.v_atlas_ownership_stage_summary;
-- DROP TABLE public.atlas_ownership_stage;

CREATE TABLE IF NOT EXISTS public.atlas_ownership_stage (
  collection_id uuid NOT NULL,
  nft_id text NOT NULL,
  wallet text NOT NULL,
  product text NOT NULL CHECK (product IN ('nba', 'nfl', 'laliga', 'disney')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_flight', 'ok', 'no_record_for_wallet', 'not_found', 'failed')),
  attempts int NOT NULL DEFAULT 0,
  request_id bigint,
  dispatched_at timestamptz,
  fetched_at timestamptz,
  deposited_at timestamptz,          -- THIS wallet's most recent arrival of the NFT (its acquisition)
  acquisition_type text,             -- Atlas ACQUISITION_TYPE_* of that arrival
  prior_owner text,                  -- the owner immediately before that arrival, '0x'-prefixed
  first_owner text,                  -- the oldest owner Atlas knows (mint / primary)
  first_deposited_at timestamptz,
  n_owners int,
  last_error text,
  seeded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, nft_id, wallet)
);
CREATE INDEX IF NOT EXISTS atlas_ownership_stage_pending_idx ON public.atlas_ownership_stage (attempts, seeded_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS atlas_ownership_stage_inflight_idx ON public.atlas_ownership_stage (request_id) WHERE status = 'in_flight';
ALTER TABLE public.atlas_ownership_stage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.atlas_ownership_stage FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.atlas_ownership_stage TO service_role;

-- Seed: saved-wallet holdings with no DATED acquisition row (any source), not already staged.
CREATE OR REPLACE FUNCTION public.seed_atlas_ownership_stage(p_limit integer DEFAULT 50000)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '300s' AS $f$
DECLARE v_n int;
BEGIN
  INSERT INTO public.atlas_ownership_stage (collection_id, nft_id, wallet, product)
  SELECT w.collection_id, w.moment_id, w.wallet_address,
         CASE c.slug WHEN 'nba_top_shot' THEN 'nba' WHEN 'nfl_all_day' THEN 'nfl'
                     WHEN 'laliga_golazos' THEN 'laliga' WHEN 'disney_pinnacle' THEN 'disney' END
  FROM public.wallet_moments_cache w
  JOIN public.collections c ON c.id = w.collection_id
   AND c.slug IN ('nba_top_shot', 'nfl_all_day', 'laliga_golazos', 'disney_pinnacle')
  WHERE w.wallet_address IN (SELECT DISTINCT lower(trim(wallet_addr)) FROM public.saved_wallets
                              WHERE lower(trim(wallet_addr)) ~ '^0x[0-9a-f]{16}$')
    AND w.moment_id ~ '^[0-9]{1,20}$'
    AND NOT EXISTS (SELECT 1 FROM public.moment_acquisitions a
                     WHERE a.collection_id = w.collection_id AND a.nft_id = w.moment_id
                       AND a.wallet = w.wallet_address AND a.acquired_date IS NOT NULL)
  ORDER BY (c.slug = 'nba_top_shot'), w.wallet_address, w.moment_id
  LIMIT greatest(0, coalesce(p_limit, 50000))
  ON CONFLICT (collection_id, nft_id, wallet) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('seeded', v_n, 'staged_total', (SELECT count(*) FROM public.atlas_ownership_stage));
END
$f$;

CREATE OR REPLACE FUNCTION public.run_atlas_ownership_stage_lane(p_batch integer DEFAULT 15)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'net', 'pg_temp'
SET statement_timeout TO '50s' AS $f$
DECLARE
  v_started timestamptz := clock_timestamp();
  r record;
  j jsonb;
  v_bare text;
  v_mine record;
  v_ok int := 0; v_norec int := 0; v_nf int := 0; v_retry int := 0; v_failed int := 0; v_expired int := 0;
  v_sent int := 0; v_req bigint;
  v_last_error text;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('run_atlas_ownership_stage_lane')) THEN
    RETURN jsonb_build_object('skipped', 'concurrent');
  END IF;

  -- (1) Collect every landed response.
  FOR r IN
    SELECT s.collection_id, s.nft_id, s.wallet, s.attempts, h.status_code, h.content, h.timed_out
    FROM public.atlas_ownership_stage s
    JOIN net._http_response h ON h.id = s.request_id
    WHERE s.status = 'in_flight'
  LOOP
    j := NULL;
    IF r.status_code = 200 AND NOT coalesce(r.timed_out, false) AND pg_input_is_valid(r.content, 'jsonb') THEN
      j := r.content::jsonb;
    END IF;
    IF j IS NOT NULL AND jsonb_typeof(j->'ownershipHistory') = 'array' THEN
      v_bare := substr(r.wallet, 3);
      -- This wallet's most recent arrival, and the owner record just before it.
      SELECT (x->>'depositedAt')::timestamptz AS at, x->>'acquisitionType' AS typ INTO v_mine
        FROM jsonb_array_elements(j->'ownershipHistory') x
       WHERE lower(x->>'flowAddress') = v_bare AND x->>'depositedAt' IS NOT NULL
       ORDER BY (x->>'depositedAt')::timestamptz DESC LIMIT 1;
      IF v_mine.at IS NULL THEN
        -- Atlas does not list this wallet as an owner: the index lags, or the NFT moved since our cache.
        UPDATE public.atlas_ownership_stage SET status = 'no_record_for_wallet', fetched_at = now(),
               n_owners = jsonb_array_length(j->'ownershipHistory'), last_error = NULL
         WHERE collection_id = r.collection_id AND nft_id = r.nft_id AND wallet = r.wallet;
        v_norec := v_norec + 1;
      ELSE
        UPDATE public.atlas_ownership_stage s SET
               status = 'ok', fetched_at = now(), last_error = NULL,
               deposited_at = v_mine.at,
               acquisition_type = v_mine.typ,
               prior_owner = (SELECT '0x' || lower(x->>'flowAddress') FROM jsonb_array_elements(j->'ownershipHistory') x
                               WHERE (x->>'depositedAt')::timestamptz < v_mine.at
                               ORDER BY (x->>'depositedAt')::timestamptz DESC LIMIT 1),
               first_owner = (SELECT '0x' || lower(x->>'flowAddress') FROM jsonb_array_elements(j->'ownershipHistory') x
                               ORDER BY (x->>'depositedAt')::timestamptz ASC LIMIT 1),
               first_deposited_at = (SELECT min((x->>'depositedAt')::timestamptz) FROM jsonb_array_elements(j->'ownershipHistory') x),
               n_owners = jsonb_array_length(j->'ownershipHistory')
         WHERE s.collection_id = r.collection_id AND s.nft_id = r.nft_id AND s.wallet = r.wallet;
        v_ok := v_ok + 1;
      END IF;
    ELSIF r.status_code = 404 AND r.content LIKE '%"not_found"%' THEN
      UPDATE public.atlas_ownership_stage SET status = 'not_found', fetched_at = now(), last_error = NULL
       WHERE collection_id = r.collection_id AND nft_id = r.nft_id AND wallet = r.wallet;
      v_nf := v_nf + 1;
    ELSE
      -- Cloudflare challenge (HTML 403), 5xx, timeout, or an undecodable 200: retry later, up to 5 tries.
      v_last_error := 'HTTP ' || coalesce(r.status_code::text, 'none') || ': ' || left(regexp_replace(coalesce(r.content, ''), '\s+', ' ', 'g'), 80);
      UPDATE public.atlas_ownership_stage SET
             status = CASE WHEN r.attempts >= 5 THEN 'failed' ELSE 'pending' END,
             request_id = NULL, last_error = v_last_error
       WHERE collection_id = r.collection_id AND nft_id = r.nft_id AND wallet = r.wallet;
      IF r.attempts >= 5 THEN v_failed := v_failed + 1; ELSE v_retry := v_retry + 1; END IF;
    END IF;
  END LOOP;

  -- (2) A request with no response after 10 minutes is retried (pg_net drops responses after its TTL).
  UPDATE public.atlas_ownership_stage s SET status = CASE WHEN s.attempts >= 5 THEN 'failed' ELSE 'pending' END,
         request_id = NULL, last_error = 'no response in 10 min'
   WHERE s.status = 'in_flight' AND s.dispatched_at < now() - interval '10 minutes'
     AND NOT EXISTS (SELECT 1 FROM net._http_response h WHERE h.id = s.request_id);
  GET DIAGNOSTICS v_expired = ROW_COUNT;

  -- (3) Dispatch the next small batch: fewest attempts first, then All Day / Golazos / Pinnacle before Top Shot.
  FOR r IN
    SELECT collection_id, nft_id, wallet, product FROM public.atlas_ownership_stage
     WHERE status = 'pending'
     ORDER BY attempts, (product = 'nba'), seeded_at, nft_id
     LIMIT least(greatest(coalesce(p_batch, 15), 0), 40)
     FOR UPDATE SKIP LOCKED
  LOOP
    v_req := net.http_post(
      url := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.NFTService/GetNftOwnershipHistory',
      body := jsonb_build_object('product', r.product, 'nftId', r.nft_id),
      headers := public.atlas_market_headers(r.product),
      timeout_milliseconds := 20000);
    INSERT INTO public.atlas_ondemand_requests (request_id, fn) VALUES (v_req, 'ownership:' || r.product)
    ON CONFLICT (request_id) DO NOTHING;
    UPDATE public.atlas_ownership_stage SET status = 'in_flight', request_id = v_req, dispatched_at = now(),
           attempts = attempts + 1
     WHERE collection_id = r.collection_id AND nft_id = r.nft_id AND wallet = r.wallet;
    v_sent := v_sent + 1;
  END LOOP;

  -- ok means every response this tick was READ (a retry-able challenge is not a failure of the lane;
  -- a row exhausting its 5 tries is). rows_written = staged answers recorded this tick.
  PERFORM public.log_pipeline_run('atlas-ownership-stage', v_started,
    v_ok + v_norec + v_nf + v_retry + v_failed, v_ok + v_norec + v_nf, v_retry + v_failed,
    (v_failed = 0), v_last_error, NULL, NULL, NULL,
    jsonb_build_object('ok', v_ok, 'no_record_for_wallet', v_norec, 'not_found', v_nf, 'retry', v_retry,
                       'failed', v_failed, 'expired', v_expired, 'dispatched', v_sent,
                       'pending', (SELECT count(*) FROM public.atlas_ownership_stage WHERE status = 'pending')));
  RETURN jsonb_build_object('ok', v_ok, 'no_record_for_wallet', v_norec, 'not_found', v_nf, 'retry', v_retry,
                            'failed', v_failed, 'expired', v_expired, 'dispatched', v_sent);
END
$f$;

REVOKE ALL ON FUNCTION public.seed_atlas_ownership_stage(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.run_atlas_ownership_stage_lane(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seed_atlas_ownership_stage(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.run_atlas_ownership_stage_lane(integer) TO service_role;

-- What Trevor reviews before any import: per collection, status x Atlas acquisition type.
CREATE OR REPLACE VIEW public.v_atlas_ownership_stage_summary WITH (security_invoker = on) AS
SELECT c.slug AS collection, s.status, coalesce(s.acquisition_type, '-') AS acquisition_type,
       count(*) AS n, min(s.deposited_at) AS oldest_arrival, max(s.deposited_at) AS newest_arrival
FROM public.atlas_ownership_stage s JOIN public.collections c ON c.id = s.collection_id
GROUP BY 1, 2, 3;
REVOKE ALL ON TABLE public.v_atlas_ownership_stage_summary FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.v_atlas_ownership_stage_summary TO service_role;

SELECT public.seed_atlas_ownership_stage(50000);
SELECT cron.schedule('rpc-atlas-ownership-stage', '* * * * *', 'SELECT public.run_atlas_ownership_stage_lane(15)');
