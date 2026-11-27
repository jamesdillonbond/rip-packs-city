-- audit_20261127_sold_pack_work_list
--
-- 2026-11-27 (PT, ~3:45 PM; Claude Code cloud; Trevor: "Keep going ... leaving nothing from this thread
-- unresolved. You have my approval to use any tools").
--
-- WHY (measured 11-27 afternoon):
-- 1. Both Sold-tab lanes rebuilt the whole sold-pack scope (40,405 packs; 9 s cold just to list them)
--    and then probed EVERY one of them on every tick: dispatch_sold_pack_open_tx_reads ran 30-120 s per
--    10-min tick (3 of 12 killed at the 120 s pg_cron cap), run_seed_sold_pack_pulls 55-120 s and was
--    still killed hourly -- for packs that cannot change (18.5k opened before any live Flow node, and
--    most of the rest already have their pulls).
-- 2. All Day sold packs opened on a readable spork with no pulls on record had no recurring lane (87
--    were read once by hand on 11-27); the open-tx lane read Top Shot only. A PackNFT id is per
--    CONTRACT (2,294 Golazos pack ids collide with All Day rips, packs.md 10-19), so every key here
--    carries the collection. [Comment corrected after apply, 11-27 ~3:45 PM PT: the applied text
--    wrongly called the ids unique across contracts; no code depended on it.]
--
-- WHAT:
-- * sold_pack_work(collection_id, pack_nft_id, depth, read_next_at, seed_next_at): every pack a saved
--   wallet sold (Top Shot + All Day, storefront + marketplace, a box's inner packs), refreshed hourly by
--   refresh_sold_pack_work() from run_seed_sold_pack_pulls. Each lane takes only DUE packs (bounded
--   batch) and re-schedules each one: no rip yet 6 h; nothing left to do (pulls on record, or opened on
--   a retired spork) 30 days; otherwise 1 h.
-- * sold_pack_open_tx_reads keyed by (collection_id, pack_nft_id); dispatch and collect take All Day too
--   (A.e4cf4bdc1751c65d.AllDay.Deposit / PackNFT.Deposit). Same routing (mainnet27 node / rest-mainnet),
--   same retry rule (a non-final outcome is asked again an hour on).
-- * seed_sold_pack_pulls works from the same list (its two legs unchanged in substance).
-- Bases (live prosrc read 11-27 ~3:40 PM): dispatch 20261127213526 splice, collect 20261127184816, seed
-- 20261127195213, run_seed 20261127194925.
--
-- REVERT: re-apply those four bodies (and run_sold_container_open_search's from
--   20261127185651 / 20261127194434 -- md5 43b75b72a85d7edb7a05cda28d990ff0); ALTER TABLE public.sold_pack_open_tx_reads DROP CONSTRAINT
--   sold_pack_open_tx_reads_pkey, ADD PRIMARY KEY (pack_nft_id) (only while no All Day row exists);
--   DROP FUNCTION public.refresh_sold_pack_work(); DROP TABLE public.sold_pack_work.

-- [Added after apply, 11-27 ~3:52 PM PT, for the lock-taking-DDL guard that landed at 2:30 PM: the
-- applied run had no lock_timeout. sold_pack_open_tx_reads is a ~1.3k-row lane table no user path
-- reads, so the ACCESS EXCLUSIVE it held through this file blocked nothing; a replay now gives up in 3 s.]
SET LOCAL lock_timeout = '3s';

-- 1. open-tx reads keyed by collection + pack
ALTER TABLE public.sold_pack_open_tx_reads ALTER COLUMN collection_id SET NOT NULL;
ALTER TABLE public.sold_pack_open_tx_reads DROP CONSTRAINT sold_pack_open_tx_reads_pkey;
ALTER TABLE public.sold_pack_open_tx_reads ADD PRIMARY KEY (collection_id, pack_nft_id);

-- 1b. the container search's insert names the old key; repoint it (md5-asserted splice)
DO $mig$
DECLARE
  v_src text; v_new text; v_args text;
  c_anchor constant text := 'ON CONFLICT (pack_nft_id) DO NOTHING;';
  c_new    constant text := 'ON CONFLICT (collection_id, pack_nft_id) DO NOTHING;';
BEGIN
  SELECT p.prosrc, pg_get_function_arguments(p.oid) INTO v_src, v_args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'run_sold_container_open_search';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'run_sold_container_open_search() not found';
  END IF;
  IF md5(v_src) <> '43b75b72a85d7edb7a05cda28d990ff0' THEN
    RAISE EXCEPTION 'base drifted: prosrc md5 %', md5(v_src);
  END IF;
  IF (length(v_src) - length(replace(v_src, c_anchor, ''))) / length(c_anchor) <> 1 THEN
    RAISE EXCEPTION 'anchor not unique';
  END IF;
  v_new := replace(v_src, c_anchor, c_new);
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.run_sold_container_open_search(%s) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''public'', ''pg_temp'' SET statement_timeout TO ''60s'' AS $f$%s$f$',
    v_args, v_new);
END
$mig$;
-- (the splice keeps the function's ACL; this restates it -- verified 11-27: anon / authenticated have no EXECUTE)
REVOKE ALL ON FUNCTION public.run_sold_container_open_search(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_sold_container_open_search(integer) TO service_role;

-- 2. the work list
CREATE TABLE IF NOT EXISTS public.sold_pack_work (
  collection_id  uuid NOT NULL REFERENCES public.collections(id),
  pack_nft_id    text NOT NULL,
  depth          integer NOT NULL DEFAULT 0,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  read_next_at   timestamptz NOT NULL DEFAULT now(),
  seed_next_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, pack_nft_id)
);
CREATE INDEX IF NOT EXISTS sold_pack_work_read_next_idx ON public.sold_pack_work (read_next_at);
CREATE INDEX IF NOT EXISTS sold_pack_work_seed_next_idx ON public.sold_pack_work (seed_next_at);
COMMENT ON TABLE public.sold_pack_work IS
  'Every Top Shot / All Day pack a saved wallet sold (+ a sold box''s inner packs), with when each Sold-tab lane next looks at it. Refreshed hourly by refresh_sold_pack_work(); read by dispatch_sold_pack_open_tx_reads and seed_sold_pack_pulls (audit_20261127_sold_pack_work_list).';
ALTER TABLE public.sold_pack_work ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sold_pack_work FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.sold_pack_work TO service_role;

CREATE OR REPLACE FUNCTION public.refresh_sold_pack_work()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_ad constant uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  v_n integer;
BEGIN
  WITH RECURSIVE sold AS (
    SELECT pp.collection_id, pp.pack_nft_id
      FROM public.pack_purchases pp
     WHERE pp.collection_id IN (v_ts, v_ad)
       AND pp.pack_nft_id ~ '^[0-9]+$'
       AND pp.custom_id IS DISTINCT FROM 'nba'
       AND pp.seller_address IN (SELECT DISTINCT wallet_addr FROM public.saved_wallets)
    UNION
    SELECT v_ts, h.pack_nft_id FROM public.topshot_pack_sales_history h
     WHERE h.purchased AND h.pack_nft_id ~ '^[0-9]+$'
       AND h.storefront_address IN (SELECT DISTINCT wallet_addr FROM public.saved_wallets)
    UNION
    SELECT v_ad, h.pack_nft_id FROM public.allday_pack_sales_history h
     WHERE h.purchased AND h.pack_nft_id ~ '^[0-9]+$'
       AND h.storefront_address IN (SELECT DISTINCT wallet_addr FROM public.saved_wallets)
  ), scope(collection_id, pack_nft_id, depth) AS (
    SELECT collection_id, pack_nft_id, 0 FROM sold
    UNION
    SELECT s.collection_id, b.pack_nft_id, s.depth + 1
      FROM scope s
      JOIN public.pack_box_contents b ON b.collection_id = s.collection_id AND b.box_pack_nft_id = s.pack_nft_id
     WHERE s.depth < 2
  ), ins AS (
    INSERT INTO public.sold_pack_work (collection_id, pack_nft_id, depth)
    SELECT DISTINCT ON (collection_id, pack_nft_id) collection_id, pack_nft_id, depth
      FROM scope ORDER BY collection_id, pack_nft_id, depth
    ON CONFLICT (collection_id, pack_nft_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM ins;
  RETURN v_n;
END
$fn$;
REVOKE ALL ON FUNCTION public.refresh_sold_pack_work() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_sold_pack_work() TO service_role;

-- 3. dispatcher: due packs only, Top Shot + All Day
CREATE OR REPLACE FUNCTION public.dispatch_sold_pack_open_tx_reads(p_max integer DEFAULT 30)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  x record;
  v_n integer := 0;
BEGIN
  DROP TABLE IF EXISTS pg_temp._sold_read_due;
  CREATE TEMP TABLE _sold_read_due ON COMMIT DROP AS
  SELECT w.collection_id, w.pack_nft_id, r.tx_hash, r.opener_address, r.block_height,
         (r.pack_nft_id IS NULL) AS no_rip,
         (r.pack_nft_id IS NOT NULL AND (
              r.tx_hash !~ '^[0-9a-f]{64}$'
              -- mainnet27 root: older blocks have no live Flow node (#181)
              OR r.block_height < 130290659
              OR r.opener_address !~ '^0x[0-9a-f]{16}$'
              OR EXISTS (SELECT 1 FROM public.moment_acquisitions ma
                          WHERE ma.source_pack_rip_id = r.id AND ma.collection_id = w.collection_id
                            AND ma.acquisition_method = 'pack_pull')
              OR EXISTS (SELECT 1 FROM public.pack_open_pulls o
                          WHERE o.collection_id = w.collection_id AND o.pack_nft_id = w.pack_nft_id)
              OR EXISTS (SELECT 1 FROM public.pack_box_contents b
                          WHERE b.collection_id = w.collection_id AND b.box_pack_nft_id = w.pack_nft_id)
              OR EXISTS (SELECT 1 FROM public.allday_pack_pull a
                          WHERE w.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
                            AND a.pack_nft_id = w.pack_nft_id)
              OR EXISTS (SELECT 1 FROM public.sold_pack_open_tx_reads q
                          WHERE q.collection_id = w.collection_id AND q.pack_nft_id = w.pack_nft_id
                            AND q.outcome IN ('pulls', 'contents', 'nothing_to_opener', 'bad_json')))) AS settled,
         EXISTS (SELECT 1 FROM public.sold_pack_open_tx_reads q
                  WHERE q.collection_id = w.collection_id AND q.pack_nft_id = w.pack_nft_id
                    AND (q.outcome IS NULL OR q.collected_at > now() - interval '1 hour')) AS waiting
    FROM (SELECT * FROM public.sold_pack_work
           WHERE read_next_at <= now()
           ORDER BY read_next_at
           LIMIT 2500) w
    -- per-id probe of pack_rips' (collection, pack) index; a plain join hashes every rip
    LEFT JOIN LATERAL (SELECT r0.* FROM public.pack_rips r0
                        WHERE r0.collection_id = w.collection_id AND r0.pack_nft_id = w.pack_nft_id
                        LIMIT 1) r ON true;

  FOR x IN
    SELECT * FROM _sold_read_due
     WHERE NOT no_rip AND NOT settled AND NOT waiting
     ORDER BY block_height DESC
     LIMIT GREATEST(p_max, 0)
  LOOP
    INSERT INTO public.sold_pack_open_tx_reads (collection_id, pack_nft_id, tx_hash, opener_address, request_id, dispatched_at)
    VALUES (x.collection_id, x.pack_nft_id, x.tx_hash, x.opener_address,
            net.http_get(CASE WHEN x.block_height <= 137390145
                              THEN 'http://access-001.mainnet27.nodes.onflow.org:8070'
                              ELSE 'https://rest-mainnet.onflow.org' END
                         || '/v1/transaction_results/' || x.tx_hash,
                         timeout_milliseconds := 20000),
            now())
    ON CONFLICT (collection_id, pack_nft_id) DO UPDATE
      SET request_id = EXCLUDED.request_id, dispatched_at = now(), collected_at = NULL, outcome = NULL, n_written = NULL;
    v_n := v_n + 1;
  END LOOP;

  UPDATE public.sold_pack_work w
     SET read_next_at = now() + CASE WHEN d.no_rip THEN interval '6 hours'
                                     WHEN d.settled THEN interval '30 days'
                                     ELSE interval '1 hour' END
    FROM _sold_read_due d
   WHERE w.collection_id = d.collection_id AND w.pack_nft_id = d.pack_nft_id;

  RETURN v_n;
END
$fn$;
REVOKE ALL ON FUNCTION public.dispatch_sold_pack_open_tx_reads(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_sold_pack_open_tx_reads(integer) TO service_role;

-- 4. collector: per-collection event types, keyed by collection + pack
CREATE OR REPLACE FUNCTION public.collect_sold_pack_open_tx_reads()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_ad constant uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  q record;
  v_body jsonb;
  v_pack_ev text;
  v_moment_ev text;
  v_packs integer;
  v_pulls integer;
  v_done integer := 0;
  v_written integer := 0;
BEGIN
  FOR q IN
    SELECT s.*, h.status_code, h.content, (h.id IS NULL) AS gone
      FROM public.sold_pack_open_tx_reads s
      LEFT JOIN net._http_response h ON h.id = s.request_id
     WHERE s.outcome IS NULL
       AND (h.id IS NOT NULL OR s.dispatched_at < now() - interval '30 minutes')
  LOOP
    IF q.gone THEN
      UPDATE public.sold_pack_open_tx_reads SET outcome = 'no_response', collected_at = now()
       WHERE collection_id = q.collection_id AND pack_nft_id = q.pack_nft_id;
      CONTINUE;
    END IF;
    IF q.status_code IS DISTINCT FROM 200 THEN
      UPDATE public.sold_pack_open_tx_reads SET outcome = 'http_' || coalesce(q.status_code::text, 'none'), collected_at = now()
       WHERE collection_id = q.collection_id AND pack_nft_id = q.pack_nft_id;
      CONTINUE;
    END IF;
    BEGIN
      v_body := q.content::jsonb;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.sold_pack_open_tx_reads SET outcome = 'bad_json', collected_at = now()
       WHERE collection_id = q.collection_id AND pack_nft_id = q.pack_nft_id;
      CONTINUE;
    END;

    IF q.collection_id = v_ad THEN
      v_pack_ev := 'A.e4cf4bdc1751c65d.PackNFT.Deposit';  v_moment_ev := 'A.e4cf4bdc1751c65d.AllDay.Deposit';
    ELSE
      v_pack_ev := 'A.0b2a3299cc857e29.PackNFT.Deposit';  v_moment_ev := 'A.0b2a3299cc857e29.TopShot.Deposit';
    END IF;

    -- decoded deposits to the opener, by kind
    WITH ev AS (
      SELECT e->>'type' AS t,
             convert_from(decode(e->>'payload', 'base64'), 'UTF8')::jsonb->'value'->'fields' AS f
        FROM jsonb_array_elements(coalesce(v_body->'events', '[]'::jsonb)) e
       WHERE e->>'type' IN (v_pack_ev, v_moment_ev)
    ), dep AS (
      SELECT t, f->0->'value'->>'value' AS id, f->1->'value'->'value'->>'value' AS to_addr FROM ev
    ), kids AS (
      INSERT INTO public.pack_box_contents (collection_id, box_pack_nft_id, pack_nft_id, opener_address)
      SELECT q.collection_id, q.pack_nft_id, d.id, q.opener_address
        FROM dep d
       WHERE d.t = v_pack_ev AND d.to_addr = q.opener_address
         AND d.id ~ '^[0-9]+$' AND d.id <> q.pack_nft_id
      ON CONFLICT DO NOTHING
      RETURNING 1
    ), pulls AS (
      INSERT INTO public.pack_open_pulls (collection_id, pack_nft_id, nft_id, opener_address, edition_id, resolved_via, resolved_at)
      SELECT q.collection_id, q.pack_nft_id, d.id, q.opener_address, m.edition_id,
             'chain_open_tx', CASE WHEN m.edition_id IS NOT NULL THEN now() END
        FROM dep d
        LEFT JOIN LATERAL (SELECT mo.edition_id FROM public.moments mo
                            WHERE mo.collection_id = q.collection_id AND mo.nft_id = d.id
                              AND mo.edition_id IS NOT NULL LIMIT 1) m ON true
       WHERE d.t = v_moment_ev AND d.to_addr = q.opener_address
         AND d.id ~ '^[0-9]+$'
      ON CONFLICT DO NOTHING
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM kids), (SELECT count(*) FROM pulls) INTO v_packs, v_pulls;

    UPDATE public.sold_pack_open_tx_reads
       SET collected_at = now(),
           outcome = CASE WHEN v_packs > 0 THEN 'contents' WHEN v_pulls > 0 THEN 'pulls' ELSE 'nothing_to_opener' END,
           n_written = v_packs + v_pulls
     WHERE collection_id = q.collection_id AND pack_nft_id = q.pack_nft_id;
    v_done := v_done + 1;
    v_written := v_written + v_packs + v_pulls;
  END LOOP;
  RETURN jsonb_build_object('collected', v_done, 'rows_written', v_written);
END
$fn$;
REVOKE ALL ON FUNCTION public.collect_sold_pack_open_tx_reads() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.collect_sold_pack_open_tx_reads() TO service_role;

-- 5. seed: due packs only
CREATE OR REPLACE FUNCTION public.seed_sold_pack_pulls(p_max integer DEFAULT 300)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_ad constant uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  v_n integer := 0;
  v_n2 integer := 0;
BEGIN
  DROP TABLE IF EXISTS pg_temp._sold_seed_due;
  CREATE TEMP TABLE _sold_seed_due ON COMMIT DROP AS
  SELECT w.collection_id, w.pack_nft_id, r.id AS rip_id, r.tx_hash, r.opener_address,
         (r.id IS NULL) AS no_rip,
         EXISTS (SELECT 1 FROM public.pack_open_pulls o
                  WHERE o.collection_id = w.collection_id AND o.pack_nft_id = w.pack_nft_id) AS has_rows,
         -- a linked pull that nothing names yet (same tx as the open: the v3 mis-link rule)
         EXISTS (SELECT 1 FROM public.moment_acquisitions ma
                  WHERE ma.source_pack_rip_id = r.id AND ma.collection_id = w.collection_id
                    AND ma.acquisition_method = 'pack_pull'
                    AND (r.tx_hash IS NULL OR ma.transaction_hash IS NULL OR ma.transaction_hash = r.tx_hash)
                    AND NOT EXISTS (SELECT 1 FROM public.moments m
                                     WHERE m.collection_id = ma.collection_id AND m.nft_id = ma.nft_id)
                    AND NOT EXISTS (SELECT 1 FROM public.allday_pack_pull a
                                     WHERE w.collection_id = v_ad AND a.pack_nft_id = w.pack_nft_id
                                       AND a.moment_nft_id = ma.nft_id AND a.edition_id IS NOT NULL)) AS ma_unnamed,
         (w.collection_id = v_ad AND EXISTS (SELECT 1 FROM public.allday_pack_pull a
                                              WHERE a.pack_nft_id = w.pack_nft_id AND a.edition_id IS NULL)) AS adp_unnamed
    FROM (SELECT * FROM public.sold_pack_work
           WHERE seed_next_at <= now()
           ORDER BY seed_next_at
           LIMIT 4000) w
    LEFT JOIN LATERAL (SELECT r0.* FROM public.pack_rips r0
                        WHERE r0.collection_id = w.collection_id AND r0.pack_nft_id = w.pack_nft_id
                        LIMIT 1) r ON true;

  -- leg 1: unnamed linked acquisitions (Top Shot and All Day)
  WITH cand AS MATERIALIZED (
    SELECT * FROM _sold_seed_due
     WHERE NOT no_rip AND NOT has_rows AND ma_unnamed AND opener_address ~ '^0x[0-9a-f]{16}$'
     LIMIT GREATEST(p_max, 0)
  ), ins AS (
    INSERT INTO public.pack_open_pulls (collection_id, pack_nft_id, nft_id, opener_address, edition_id, resolved_via, resolved_at)
    SELECT c.collection_id, c.pack_nft_id, ma.nft_id, c.opener_address, m.edition_id,
           CASE WHEN m.edition_id IS NOT NULL THEN 'moments' ELSE 'sold_pack_seed' END,
           CASE WHEN m.edition_id IS NOT NULL THEN now() END
      FROM cand c
      JOIN public.moment_acquisitions ma
        ON ma.source_pack_rip_id = c.rip_id AND ma.collection_id = c.collection_id
       AND ma.acquisition_method = 'pack_pull'
       AND (c.tx_hash IS NULL OR ma.transaction_hash IS NULL OR ma.transaction_hash = c.tx_hash)
      LEFT JOIN LATERAL (SELECT mo.edition_id FROM public.moments mo
                          WHERE mo.collection_id = c.collection_id AND mo.nft_id = ma.nft_id
                            AND mo.edition_id IS NOT NULL LIMIT 1) m ON true
     WHERE ma.nft_id ~ '^[0-9]{1,15}$'
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM ins;

  -- leg 2: All Day pull ids that live only in allday_pack_pull
  WITH cand AS MATERIALIZED (
    SELECT * FROM _sold_seed_due
     WHERE collection_id = v_ad AND NOT has_rows AND adp_unnamed
     LIMIT GREATEST(p_max, 0)
  ), ins AS (
    INSERT INTO public.pack_open_pulls (collection_id, pack_nft_id, nft_id, opener_address, edition_id, resolved_via, resolved_at)
    SELECT v_ad, a.pack_nft_id, a.moment_nft_id, lower(a.opener_address), a.edition_id,
           CASE WHEN a.edition_id IS NOT NULL THEN 'allday_pack_pull' ELSE 'sold_pack_seed' END,
           CASE WHEN a.edition_id IS NOT NULL THEN now() END
      FROM cand c
      JOIN public.allday_pack_pull a ON a.pack_nft_id = c.pack_nft_id
     WHERE a.moment_nft_id ~ '^[0-9]{1,15}$'
       AND a.opener_address ~* '^0x[0-9a-f]{16}$'
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_n2 FROM ins;

  -- re-schedule what was looked at: no rip yet 6 h; rows on record or nothing to seed 1 day
  UPDATE public.sold_pack_work w
     SET seed_next_at = now() + CASE WHEN d.no_rip THEN interval '6 hours' ELSE interval '1 day' END
    FROM _sold_seed_due d
   WHERE w.collection_id = d.collection_id AND w.pack_nft_id = d.pack_nft_id;

  RETURN v_n + v_n2;
END
$fn$;
COMMENT ON FUNCTION public.seed_sold_pack_pulls(integer) IS
  'Copies the unnamed linked pulls of packs saved wallets SOLD into pack_open_pulls so the existing naming lanes name them; works from sold_pack_work (due packs only). Run by run_seed_sold_pack_pulls (pg_cron rpc-sold-pack-pull-seed, hourly).';
REVOKE ALL ON FUNCTION public.seed_sold_pack_pulls(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seed_sold_pack_pulls(integer) TO service_role;

-- 6. hourly runner: refresh the list, then seed
CREATE OR REPLACE FUNCTION public.run_seed_sold_pack_pulls()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '90s'
AS $fn$
DECLARE
  v_new integer; v_n integer; v_err text;
BEGIN
  BEGIN
    v_new := public.refresh_sold_pack_work();
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := 'refresh: ' || left(SQLERRM, 280);
  END;
  BEGIN
    v_n := public.seed_sold_pack_pulls(300);
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := concat_ws('; ', v_err, 'seed: ' || left(SQLERRM, 280));
  END;
  PERFORM public.log_pipeline_run('sold-pack-pull-seed', v_err IS NULL,
    jsonb_build_object('pulls_seeded', v_n, 'work_added', v_new, 'error', v_err, 'via', 'pg_cron'));
  RETURN jsonb_build_object('pulls_seeded', v_n, 'work_added', v_new, 'error', v_err);
END
$fn$;
REVOKE ALL ON FUNCTION public.run_seed_sold_pack_pulls() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_seed_sold_pack_pulls() TO service_role;

-- 7. fill the list once now
SELECT public.refresh_sold_pack_work();
