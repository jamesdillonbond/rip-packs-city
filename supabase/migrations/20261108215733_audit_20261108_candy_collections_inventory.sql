-- audit_20261108_candy_collections_inventory
--
-- Trevor 2026-11-08: "we need to track and measure all of this" — every Candy collection,
-- MLB and non-MLB, test/prototype collections listed but not catalogued.
--
-- THE INVENTORY. Every Candy item is a Metaplex Core asset in a Core collection whose update
-- authority is Candy's (7wixES…, rotated from BhA2Bfd8… in the October security response;
-- 0 collections still read BhA2Bfd8…). Read on chain 2026-11-08 with one
-- getProgramAccounts(Core, key = Collection, update_authority = 7wixES…): 401 collections,
-- 1,402,126 live items (Core `current_size`; `num_minted` kept beside it). RPC tracked 5.
-- Largest: 2022 Leadoff ICONs 379,025 · 2023 Team Series ICONs 35,453 · 2022 Play of the Day
-- 30,066 · 2022 All-Star ICONs 29,912 · 2021 All-Star ICONs 28,401 · 2026 Base 27,876.
--
-- candy_collections: one row per collection — address, on-chain name / uri / num_minted /
-- current_size, kind (mlb | other | test — a NAME-BASED HINT, editable; test = names with
-- "test"/"prototype": 3 collections, 8,501 items), the `sets` row its editions carry, the
-- edition-key prefix, `census` (walked by the daily editions census: the 5 registry sets
-- today), registry_key (lib/chains/solana/candy-sets.ts), discovered/refreshed stamps.
-- One `sets` row per non-test, non-registry collection (uuid5 of the address, stable).
--
-- What reads it: lib/candy/collections.ts (the live wallet read registers every non-test
-- collection, so a pasted wallet's 2021–2025 ICONs, DC, pins… are catalogued and shown,
-- unpriced until their markets are indexed) and candy_collection_coverage (the measure:
-- on-chain items vs items RPC holds rows for, editions, holders, listings, sales).
--
-- The holder board now counts only census-walked collections (`census`): a wallet whose
-- older collectibles were read live must not outrank a wallet nobody has searched.
--
-- How it is filled: candy_collections_discover_begin() POSTs that getProgramAccounts to the
-- public Solana RPC via pg_net; candy_collections_discover_collect() parses the Core
-- Collection accounts (key 1 · update authority 32 · name u32+bytes · uri u32+bytes ·
-- num_minted u32 · current_size u32), upserts the inventory, creates the `sets` row and
-- edition prefix for each new collection, and logs `candy-collections-discover` to
-- pipeline_runs. pg_cron daily (begin 09:07 UTC, collect 09:12 UTC). A failed or empty
-- response changes NOTHING and logs ok:false — an absent collection is never deleted.
--
-- anon-exec: intentional — new functions, REVOKEd from PUBLIC/anon/authenticated below; service_role only (candy_collections_discover_begin, candy_collections_discover_collect)
--
-- Rollback: SELECT cron.unschedule('rpc-candy-collections-discover-begin'), cron.unschedule('rpc-candy-collections-discover-collect');
--   DROP FUNCTION candy_collections_discover_collect(), candy_collections_discover_begin();
--   DROP TABLE candy_collections_discover_requests; DROP VIEW candy_collection_coverage; re-apply mv_candy_holder_board /
--   candy_holder_board from their creating migration (definition = this one minus the
--   `census_keys` filter); DROP TABLE candy_collections; the new sets rows can stay.

CREATE TABLE public.candy_collections (
  address        text PRIMARY KEY,
  name           text NOT NULL,
  uri            text,
  num_minted     integer,
  current_size   integer,
  kind           text NOT NULL CHECK (kind IN ('mlb', 'other', 'test')),
  set_id         uuid REFERENCES public.sets(id),
  edition_prefix text UNIQUE,
  census         boolean NOT NULL DEFAULT false,
  registry_key   text UNIQUE,
  discovered_at  timestamptz NOT NULL DEFAULT now(),
  refreshed_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'test' OR set_id IS NOT NULL)
);
ALTER TABLE public.candy_collections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.candy_collections FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.candy_collections TO service_role;
COMMENT ON TABLE public.candy_collections IS
  'Every Candy Metaplex Core collection (update authority 7wixES…), from getProgramAccounts. kind is a name-based hint. census = walked by the daily editions census. See audit_20261108_candy_collections_inventory.';

CREATE TABLE public.candy_collections_discover_requests (
  request_id   bigint PRIMARY KEY,
  requested_at timestamptz NOT NULL DEFAULT now(),
  collected_at timestamptz
);
ALTER TABLE public.candy_collections_discover_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.candy_collections_discover_requests FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.candy_collections_discover_requests TO service_role;

CREATE OR REPLACE FUNCTION public.candy_collections_discover_begin()
RETURNS bigint
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE v_id bigint;
BEGIN
  v_id := net.http_post(
    url := 'https://api.mainnet-beta.solana.com',
    body := jsonb_build_object(
      'jsonrpc', '2.0', 'id', 1, 'method', 'getProgramAccounts',
      'params', jsonb_build_array(
        'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d',
        jsonb_build_object('encoding', 'base64', 'filters', jsonb_build_array(
          jsonb_build_object('memcmp', jsonb_build_object('offset', 0, 'bytes', '6')),
          jsonb_build_object('memcmp', jsonb_build_object('offset', 1, 'bytes', '7wixESeixiY4f2A6JaDKNewNoiip9Tk9s5u1dze7nRwL'))
        ))
      )
    ),
    headers := '{"Content-Type": "application/json"}'::jsonb,
    timeout_milliseconds := 60000);
  INSERT INTO public.candy_collections_discover_requests (request_id) VALUES (v_id);
  RETURN v_id;
END
$$;

CREATE OR REPLACE FUNCTION public.candy_collections_discover_collect()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_req  record;
  v_resp record;
  v_body jsonb;
  v_acc  jsonb;
  v_data bytea;
  v_nl int; v_ul int; v_o int;
  v_name text; v_uri text; v_minted bigint; v_size bigint;
  v_addr text; v_kind text; v_prefix text; v_set uuid;
  v_seen int := 0; v_new int := 0; v_bad int := 0;
  v_started timestamptz := clock_timestamp();
  v_err text := null;
BEGIN
  SELECT * INTO v_req FROM candy_collections_discover_requests
   WHERE collected_at IS NULL ORDER BY requested_at DESC LIMIT 1;
  IF v_req IS NULL THEN
    v_err := 'no pending request';
  ELSE
    SELECT * INTO v_resp FROM net._http_response WHERE id = v_req.request_id;
    IF v_resp IS NULL THEN
      v_err := 'response not arrived (request ' || v_req.request_id || ')';
    ELSIF v_resp.status_code IS DISTINCT FROM 200 THEN
      v_err := 'HTTP ' || coalesce(v_resp.status_code::text, 'null') || ': ' || left(coalesce(v_resp.error_msg, v_resp.content, ''), 200);
    ELSE
      v_body := v_resp.content::jsonb;
      IF v_body ? 'error' OR jsonb_typeof(v_body->'result') IS DISTINCT FROM 'array' THEN
        v_err := 'rpc error: ' || left(coalesce(v_body->>'error', v_resp.content), 200);
      ELSIF jsonb_array_length(v_body->'result') = 0 THEN
        v_err := 'empty result — inventory left unchanged';
      ELSE
        FOR v_acc IN SELECT * FROM jsonb_array_elements(v_body->'result') LOOP
          BEGIN
            v_addr := v_acc->>'pubkey';
            v_data := decode(v_acc->'account'->'data'->>0, 'base64');
            v_nl := get_byte(v_data,33) + (get_byte(v_data,34) << 8) + (get_byte(v_data,35) << 16) + (get_byte(v_data,36) << 24);
            v_name := btrim(replace(convert_from(substring(v_data from 38 for v_nl), 'UTF8'), chr(0), ''));
            v_o := 37 + v_nl;
            v_ul := get_byte(v_data,v_o) + (get_byte(v_data,v_o+1) << 8) + (get_byte(v_data,v_o+2) << 16) + (get_byte(v_data,v_o+3) << 24);
            v_uri := convert_from(substring(v_data from v_o + 5 for v_ul), 'UTF8');
            v_o := v_o + 4 + v_ul;
            v_minted := get_byte(v_data,v_o) + (get_byte(v_data,v_o+1) << 8) + (get_byte(v_data,v_o+2) << 16) + (get_byte(v_data,v_o+3)::bigint << 24);
            v_size := get_byte(v_data,v_o+4) + (get_byte(v_data,v_o+5) << 8) + (get_byte(v_data,v_o+6) << 16) + (get_byte(v_data,v_o+7)::bigint << 24);
            v_seen := v_seen + 1;
            IF EXISTS (SELECT 1 FROM candy_collections WHERE address = v_addr) THEN
              UPDATE candy_collections SET name = v_name, uri = v_uri, num_minted = v_minted, current_size = v_size, refreshed_at = now()
               WHERE address = v_addr;
            ELSE
              v_kind := CASE
                WHEN v_name ~* '\m(test|prototype)\M' THEN 'test'
                WHEN v_name ~* '(football|nascar)' THEN 'other'
                WHEN v_name ~* '(MLB|ICONs?\M|All-Star|Leadoff|Play of the Day|Plays of the Week|Hall of Fame|Uncut Diamond|Digi-Cast|Opening Day|World Series|Team Ball|Rookie|\mBase [12]\M|\mGems\M|Tickets|Showstopper|Jersey|Baseball|Starting 9|Tokyo Series|Speedway|Tricons|Candy Celebratory|ICON Chasers|Code Breaker)' THEN 'mlb'
                ELSE 'other' END;
              v_prefix := NULL; v_set := NULL;
              IF v_kind <> 'test' THEN
                v_prefix := 'c:' || coalesce(nullif(btrim(left(regexp_replace(regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g'), '-+', '-', 'g'), 48), '-'), ''), left(v_addr, 8));
                IF EXISTS (SELECT 1 FROM candy_collections WHERE edition_prefix = v_prefix) THEN
                  v_prefix := v_prefix || '-' || lower(left(v_addr, 4));
                END IF;
                v_set := extensions.uuid_generate_v5(extensions.uuid_ns_url(), 'candy-collection:' || v_addr);
                INSERT INTO sets (id, external_id, collection_id, name, series)
                VALUES (v_set, 'candy-coll-' || v_addr, '209ade70-32c5-4470-bc7c-4793d660f713'::uuid, v_name, NULL)
                ON CONFLICT (id) DO NOTHING;
              END IF;
              INSERT INTO candy_collections (address, name, uri, num_minted, current_size, kind, set_id, edition_prefix)
              VALUES (v_addr, v_name, v_uri, v_minted, v_size, v_kind, v_set, v_prefix);
              v_new := v_new + 1;
            END IF;
          EXCEPTION WHEN OTHERS THEN
            v_bad := v_bad + 1;
          END;
        END LOOP;
      END IF;
    END IF;
    UPDATE candy_collections_discover_requests SET collected_at = now() WHERE request_id = v_req.request_id
      AND (v_err IS NULL OR v_err NOT LIKE 'response not arrived%');
  END IF;
  PERFORM log_pipeline_run('candy-collections-discover', v_started, v_seen, v_new, v_bad, v_err IS NULL AND v_bad = 0, v_err,
    'candy_mlb', NULL::text, NULL::text, jsonb_build_object('seen', v_seen, 'new', v_new, 'unparsed', v_bad));
  RETURN jsonb_build_object('seen', v_seen, 'new', v_new, 'unparsed', v_bad, 'error', v_err);
END
$$;

REVOKE ALL ON FUNCTION public.candy_collections_discover_begin() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.candy_collections_discover_collect() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.candy_collections_discover_begin() TO service_role;
GRANT EXECUTE ON FUNCTION public.candy_collections_discover_collect() TO service_role;

-- The five registry sets, before the first discovery (they keep their own keys and set ids).
INSERT INTO public.candy_collections (address, name, kind, set_id, edition_prefix, census, registry_key) VALUES
  ('JkJA4yUBweFQdKAWNDhoFj8zHMZrQ1uZEYfjbkc3p8n', '2026 MLB Base Series ICONs', 'mlb', '381ae129-7dc7-47f4-9022-dd9e0fc21e39', NULL, true, 'base26'),
  ('YTAPbbkLY6cqskMCtBfQXtN1x1a8smiKiM99svzQAvX', '2026 MLB All-Star Game ICONs', 'mlb', '8608ae96-10c5-4bf6-aedf-b0d4dc0bfe66', 'asg26', true, 'asg26'),
  ('8BvHMsQZ2vihNBWFw3NcLYdpJzKsuz3kSrJUUwC5Lx4K', '2026 MLB Gold Series ICONs', 'mlb', '02fe803a-05b0-4af3-82b5-402e157d8d64', 'gold26', true, 'gold26'),
  ('BYSfa4LYpChyhLqvcB9o1vPp9riGUECPuaQ8tkw1ii5G', '2026 MLB Base Series Collection Quest Rewards', 'mlb', '29417ac1-1fb9-4346-bb08-e50253b618c8', 'quest26', true, 'quest26'),
  ('5ENXADdhd29JgJA1rN7Fhf3CBgLD825LdwngncJgv5ck', '2024 MLB Team Balls', 'mlb', '362e7419-2983-490d-9165-16d41f12e2ec', 'ball24', true, 'ball24');

-- THE MEASURE: per collection, what is on chain vs what RPC holds.
CREATE VIEW public.candy_collection_coverage WITH (security_invoker = on) AS
WITH held AS (
  SELECT e.set_id, count(*) AS held_rows, count(DISTINCT w.wallet_address) AS holders,
         count(DISTINCT e.id) AS editions_held, max(w.last_seen_at) AS last_seen_at
    FROM wallet_moments_cache w
    JOIN editions e ON e.collection_id = w.collection_id AND e.external_id = w.edition_key
   WHERE w.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
   GROUP BY e.set_id
), eds AS (
  SELECT set_id, count(*) AS editions FROM editions
   WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid GROUP BY set_id
), asks AS (
  SELECT e.set_id, count(*) AS active_asks FROM candy_listings l JOIN editions e ON e.id = l.edition_id
   WHERE l.is_active GROUP BY e.set_id
), sold AS (
  SELECT e.set_id, count(*) AS sales, max(s.sold_at) AS last_sale_at FROM sales s JOIN editions e ON e.id = s.edition_id
   WHERE s.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid GROUP BY e.set_id
)
SELECT c.address, c.name, c.kind, c.census, c.registry_key,
       c.current_size AS onchain_items, c.num_minted,
       COALESCE(h.held_rows, 0) AS rpc_items,
       round(100.0 * COALESCE(h.held_rows, 0) / NULLIF(c.current_size, 0), 1) AS rpc_items_pct,
       COALESCE(h.holders, 0) AS rpc_holders,
       COALESCE(eds.editions, 0) AS editions,
       COALESCE(asks.active_asks, 0) AS active_asks,
       COALESCE(sold.sales, 0) AS sales, sold.last_sale_at,
       h.last_seen_at, c.refreshed_at
  FROM candy_collections c
  LEFT JOIN held h ON h.set_id = c.set_id
  LEFT JOIN eds ON eds.set_id = c.set_id
  LEFT JOIN asks ON asks.set_id = c.set_id
  LEFT JOIN sold ON sold.set_id = c.set_id;
REVOKE ALL ON public.candy_collection_coverage FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.candy_collection_coverage TO service_role;

-- Holder board: census-walked collections only.
DROP MATERIALIZED VIEW public.mv_candy_holder_board CASCADE;
CREATE MATERIALIZED VIEW public.mv_candy_holder_board AS
 WITH census_keys AS MATERIALIZED (
         SELECT (e.external_id)::text AS edition_key
           FROM editions e
          WHERE e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
            AND e.set_id IN (SELECT cc.set_id FROM candy_collections cc WHERE cc.census)
        ), held AS MATERIALIZED (
         SELECT wallet_moments_cache.wallet_address,
            wallet_moments_cache.edition_key
           FROM wallet_moments_cache
          WHERE (wallet_moments_cache.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
            AND wallet_moments_cache.edition_key IN (SELECT census_keys.edition_key FROM census_keys)
        ), treas AS MATERIALIZED (
         SELECT COALESCE(( SELECT candy_packs.owner
                   FROM candy_packs
                  WHERE (candy_packs.owner IS NOT NULL)
                  GROUP BY candy_packs.owner
                  ORDER BY (count(*)) DESC, candy_packs.owner
                 LIMIT 1), ( SELECT held_1.wallet_address
                   FROM held held_1
                  GROUP BY held_1.wallet_address
                  ORDER BY (count(*)) DESC
                 LIMIT 1)) AS wallet_address
        ), excluded AS MATERIALIZED (
         SELECT x.wallet_address
           FROM candy_holder_board_exclusions x
          WHERE ((NOT (EXISTS ( SELECT 1
                   FROM sales s
                  WHERE ((s.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid) AND ((s.buyer_address)::text = x.wallet_address))))) AND (NOT (EXISTS ( SELECT 1
                   FROM sales s
                  WHERE ((s.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid) AND ((s.seller_address)::text = x.wallet_address))))) AND (NOT (EXISTS ( SELECT 1
                   FROM candy_listings l
                  WHERE (l.seller = x.wallet_address)))) AND (NOT (EXISTS ( SELECT 1
                   FROM candy_offers o
                  WHERE (o.buyer = x.wallet_address)))) AND (NOT (EXISTS ( SELECT 1
                   FROM candy_pack_sales p
                  WHERE ((p.buyer = x.wallet_address) OR (p.seller = x.wallet_address))))))
        ), key_fmv AS MATERIALIZED (
         SELECT (e.external_id)::text AS edition_key,
            c.fmv_usd
           FROM (editions e
             LEFT JOIN ( SELECT DISTINCT ON (fmv_snapshots.edition_id) fmv_snapshots.edition_id,
                    fmv_snapshots.fmv_usd
                   FROM fmv_snapshots
                  WHERE (fmv_snapshots.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
                  ORDER BY fmv_snapshots.edition_id, fmv_snapshots.computed_at DESC) c ON ((c.edition_id = e.id)))
          WHERE (e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
        )
 SELECT h.wallet_address,
    count(*) AS serials,
    count(DISTINCT h.edition_key) AS editions,
    round(sum(k.fmv_usd), 2) AS est_fmv_usd,
    count(*) FILTER (WHERE (k.fmv_usd IS NOT NULL)) AS priced_serials
   FROM (held h
     LEFT JOIN key_fmv k ON ((k.edition_key = h.edition_key)))
  WHERE ((h.wallet_address <> ( SELECT treas.wallet_address
           FROM treas)) AND (NOT (EXISTS ( SELECT 1
           FROM excluded ex
          WHERE (ex.wallet_address = h.wallet_address)))))
  GROUP BY h.wallet_address;
CREATE UNIQUE INDEX mv_candy_holder_board_wallet_uidx ON public.mv_candy_holder_board USING btree (wallet_address);
REVOKE ALL ON public.mv_candy_holder_board FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.mv_candy_holder_board TO service_role;
GRANT MAINTAIN ON public.mv_candy_holder_board TO anon, authenticated;

CREATE VIEW public.candy_holder_board WITH (security_invoker = on) AS
 SELECT wallet_address,
    serials,
    editions,
    est_fmv_usd,
    priced_serials
   FROM mv_candy_holder_board;
REVOKE ALL ON public.candy_holder_board FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.candy_holder_board TO service_role;

SELECT cron.schedule('rpc-candy-collections-discover-begin', '7 9 * * *', 'SELECT public.candy_collections_discover_begin()');
SELECT cron.schedule('rpc-candy-collections-discover-collect', '12 9 * * *', 'SELECT public.candy_collections_discover_collect()');
