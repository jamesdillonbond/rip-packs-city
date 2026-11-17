-- DB invariant: public.topshot_parallel_sales_followup(p_days, p_resolved_days) → jsonb — keeps Top
-- Shot PARALLEL moments' sales off their BASE edition (Trevor 11-14; the #171 residual). Pins:
--   QUEUE: an NFT sold within p_days on a base edition THAT HAS PARALLELS, with no subedition row,
--          gets a pending row (subedition_id NULL, base = that edition); an NFT already in the map is
--          never touched; a base edition with no parallels queues nothing; an old sale queues nothing.
--   RE-KEY: a sale on a base edition moves to <base>::<sub> only when the chain map says
--          subedition_id > 0, resolved within p_resolved_days, the base matches, and the target
--          edition exists — never for subedition 0, never onto a missing edition, never when the
--          map's base differs; every move is logged first.
--   LOG: a pipeline_runs row with the counts (rows_written = sales moved).
--   v2 (20261115011709): both windows also key on INGESTION — a late-ingested sale is queued, and a
--          sale ingested in p_days moves whenever its NFT was resolved (promote_unmapped_sales bypassed
--          the map). WRITE TIME: topshot_sales_follow_subedition_trg() files a new sale of a resolved
--          parallel on its subedition, for every writer.
-- A regression either leaves parallel prices in the Standard printing's FMV or moves Standard
-- moments onto a parallel.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261115011709_audit_20261114_topshot_parallel_sales_stay_on_their_subedition.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE editions (
  id            uuid PRIMARY KEY,
  collection_id uuid,
  external_id   text
);

CREATE TABLE sales (
  id            uuid,
  sold_at       timestamptz,
  collection_id uuid,
  nft_id        text,
  edition_id    uuid,
  ingested_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE topshot_moment_subeditions (
  nft_id           text PRIMARY KEY,
  base_external_id text NOT NULL,
  subedition_id    integer,
  resolved_at      timestamptz,
  queued_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE topshot_parallel_sales_rekey_log (
  sale_id        uuid        NOT NULL,
  sold_at        timestamptz NOT NULL,
  nft_id         text        NOT NULL,
  old_edition_id uuid        NOT NULL,
  new_edition_id uuid        NOT NULL,
  subedition_id  integer     NOT NULL,
  rekeyed_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE _runs (pipeline text, rows_written integer, ok boolean, error text, extra jsonb);
CREATE OR REPLACE FUNCTION log_pipeline_run(p_pipeline text, p_started_at timestamptz, p_rows_found integer DEFAULT 0,
  p_rows_written integer DEFAULT 0, p_rows_skipped integer DEFAULT 0, p_ok boolean DEFAULT true, p_error text DEFAULT NULL,
  p_collection_slug text DEFAULT NULL, p_cursor_before text DEFAULT NULL, p_cursor_after text DEFAULT NULL, p_extra jsonb DEFAULT NULL)
RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO _runs VALUES (p_pipeline, p_rows_written, p_ok, p_error, p_extra) RETURNING 1::bigint;
$$;

-- >>> BEGIN verbatim topshot_parallel_sales_followup (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.topshot_parallel_sales_followup(p_days integer DEFAULT 2, p_resolved_days integer DEFAULT 3)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_ts      constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_floor   timestamptz := now() - make_interval(days => GREATEST(p_days, 30));
  v_since   timestamptz := now() - make_interval(days => p_days);
  v_queued  integer;
  v_moved   integer;
  v_err     text;
BEGIN
  BEGIN
    -- 1. QUEUE unmapped NFTs sold OR ingested in the window on a base edition that has parallels.
    WITH par AS MATERIALIZED (
      SELECT DISTINCT split_part(external_id, '::', 1) AS base
        FROM editions
       WHERE collection_id = v_ts AND external_id LIKE '%::%'
    ), cand AS (
      SELECT DISTINCT ON (s.nft_id) s.nft_id, e.external_id AS base
        FROM sales s
        JOIN editions e ON e.id = s.edition_id
        JOIN par ON par.base = e.external_id
       WHERE s.collection_id = v_ts
         AND s.sold_at > v_floor
         AND (s.sold_at > v_since OR s.ingested_at > v_since)
         AND s.nft_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM topshot_moment_subeditions m WHERE m.nft_id = s.nft_id)
       ORDER BY s.nft_id, s.sold_at DESC
    ), ins AS (
      INSERT INTO topshot_moment_subeditions (nft_id, base_external_id, subedition_id, queued_at)
      SELECT nft_id, base, NULL, now() FROM cand
      ON CONFLICT (nft_id) DO NOTHING
      RETURNING 1
    )
    SELECT count(*) INTO v_queued FROM ins;

    -- 2. RE-KEY sales of chain-confirmed parallels off their base edition (logged first):
    --    a. every sale of an NFT the chain answered for in the last p_resolved_days;
    --    b. every sale INGESTED in the last p_days, whenever its NFT was answered.
    WITH par AS MATERIALIZED (
      SELECT DISTINCT split_part(external_id, '::', 1) AS base
        FROM editions
       WHERE collection_id = v_ts AND external_id LIKE '%::%'
    ), recent AS MATERIALIZED (
      SELECT s.id, s.sold_at, s.nft_id, s.edition_id, e.external_id AS base
        FROM sales s
        JOIN editions e ON e.id = s.edition_id
        JOIN par ON par.base = e.external_id
       WHERE s.collection_id = v_ts
         AND s.sold_at > v_floor
         AND s.ingested_at > v_since
         AND s.nft_id IS NOT NULL
    ), mv AS (
      SELECT s.id, s.sold_at, s.nft_id, s.edition_id AS old_id, te.id AS new_id, ms.subedition_id
        FROM topshot_moment_subeditions ms
        JOIN sales s     ON s.nft_id = ms.nft_id AND s.collection_id = v_ts
        JOIN editions be ON be.id = s.edition_id
                        AND be.external_id NOT LIKE '%::%'
                        AND be.external_id = ms.base_external_id
        JOIN editions te ON te.collection_id = v_ts
                        AND te.external_id = be.external_id || '::' || ms.subedition_id
       WHERE ms.subedition_id > 0
         AND ms.resolved_at > now() - make_interval(days => p_resolved_days)
      UNION
      SELECT r.id, r.sold_at, r.nft_id, r.edition_id, te.id, ms.subedition_id
        FROM recent r
        JOIN topshot_moment_subeditions ms ON ms.nft_id = r.nft_id
                                          AND ms.subedition_id > 0
                                          AND ms.base_external_id = r.base
        JOIN editions te ON te.collection_id = v_ts
                        AND te.external_id = r.base || '::' || ms.subedition_id
    ), logged AS (
      INSERT INTO topshot_parallel_sales_rekey_log (sale_id, sold_at, nft_id, old_edition_id, new_edition_id, subedition_id)
      SELECT id, sold_at, nft_id, old_id, new_id, subedition_id FROM mv
      RETURNING sale_id, sold_at, old_edition_id, new_edition_id
    ), upd AS (
      UPDATE sales s SET edition_id = l.new_edition_id
        FROM logged l
       WHERE s.id = l.sale_id AND s.sold_at = l.sold_at AND s.edition_id = l.old_edition_id
      RETURNING 1
    )
    SELECT count(*) INTO v_moved FROM upd;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := SQLERRM;
  END;

  PERFORM log_pipeline_run(
    'topshot-parallel-sales-followup', v_started,
    NULL,
    CASE WHEN v_err IS NULL THEN v_moved END,
    NULL,
    v_err IS NULL, v_err, 'nba_top_shot', NULL, NULL,
    jsonb_build_object('queued', CASE WHEN v_err IS NULL THEN v_queued END, 'sales_rekeyed', CASE WHEN v_err IS NULL THEN v_moved END,
                       'p_days', p_days, 'p_resolved_days', p_resolved_days, 'version', 2));

  IF v_err IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', v_err);
  END IF;
  RETURN jsonb_build_object('ok', true, 'queued', v_queued, 'sales_rekeyed', v_moved);
END
$function$;
-- <<< END verbatim topshot_parallel_sales_followup <<<

-- >>> BEGIN verbatim topshot_sales_follow_subedition_trg (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.topshot_sales_follow_subedition_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_sub    smallint;
  v_base   text;
  v_target uuid;
BEGIN
  IF NEW.collection_id IS DISTINCT FROM '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
     OR NEW.nft_id IS NULL OR NEW.edition_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT m.subedition_id, m.base_external_id INTO v_sub, v_base
    FROM public.topshot_moment_subeditions m
   WHERE m.nft_id = NEW.nft_id AND m.subedition_id > 0;
  IF v_sub IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT te.id INTO v_target
    FROM public.editions be
    JOIN public.editions te ON te.collection_id = be.collection_id
                           AND te.external_id = be.external_id || '::' || v_sub
   WHERE be.id = NEW.edition_id
     AND be.collection_id = NEW.collection_id
     AND be.external_id = v_base;
  IF v_target IS NOT NULL THEN
    NEW.edition_id := v_target;
  END IF;
  RETURN NEW;
END
$function$;
-- <<< END verbatim topshot_sales_follow_subedition_trg <<<

-- Base A has parallels ::17 and ::0 (synthetic, makes the > 0 guard load-bearing); base B has none.
INSERT INTO editions (id, collection_id, external_id) VALUES
  ('00000000-0000-0000-0000-0000000000a0', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '281:1'),
  ('00000000-0000-0000-0000-0000000000a7', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '281:1::17'),
  ('00000000-0000-0000-0000-0000000000a9', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '281:1::0'),
  ('00000000-0000-0000-0000-0000000000b0', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '281:2');

INSERT INTO sales (id, sold_at, collection_id, nft_id, edition_id, ingested_at) VALUES
  -- queue candidates (ingested when they sold unless stated)
  ('00000000-0000-0000-0000-000000000001', now() - interval '1 hour',  '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'q-new',  '00000000-0000-0000-0000-0000000000a0', now() - interval '1 hour'),  -- queued
  ('00000000-0000-0000-0000-000000000002', now() - interval '1 hour',  '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'q-nopar','00000000-0000-0000-0000-0000000000b0', now() - interval '1 hour'), -- base without parallels: not queued
  ('00000000-0000-0000-0000-000000000003', now() - interval '10 days', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'q-old',  '00000000-0000-0000-0000-0000000000a0', now() - interval '10 days'), -- outside p_days: not queued
  ('00000000-0000-0000-0000-000000000004', now() - interval '10 days', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'q-late', '00000000-0000-0000-0000-0000000000a0', now() - interval '1 hour'),  -- sold long ago, INGESTED now: queued
  ('00000000-0000-0000-0000-000000000005', now() - interval '10 days', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'q-stale','00000000-0000-0000-0000-0000000000a0', now() - interval '10 days'), -- sold and ingested long ago: not queued
  -- re-key candidates
  ('00000000-0000-0000-0000-000000000011', now() - interval '20 days', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'r-par',  '00000000-0000-0000-0000-0000000000a0', now() - interval '20 days'), -- moves to ::17
  ('00000000-0000-0000-0000-000000000012', now() - interval '20 days', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'r-std',  '00000000-0000-0000-0000-0000000000a0', now() - interval '1 hour'),  -- subedition 0: stays, even freshly ingested
  ('00000000-0000-0000-0000-000000000013', now() - interval '20 days', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'r-miss', '00000000-0000-0000-0000-0000000000a0', now() - interval '1 hour'),  -- ::18 does not exist: stays
  ('00000000-0000-0000-0000-000000000014', now() - interval '20 days', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'r-stale','00000000-0000-0000-0000-0000000000a0', now() - interval '20 days'), -- resolved AND ingested long ago: stays
  ('00000000-0000-0000-0000-000000000015', now() - interval '20 days', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'r-base', '00000000-0000-0000-0000-0000000000a0', now() - interval '1 hour'),  -- map base differs: stays
  ('00000000-0000-0000-0000-000000000016', now() - interval '20 days', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'r-late', '00000000-0000-0000-0000-0000000000a0', now() - interval '1 hour');  -- resolved long ago, INGESTED now: moves

INSERT INTO topshot_moment_subeditions (nft_id, base_external_id, subedition_id, resolved_at) VALUES
  ('r-par',   '281:1', 17, now() - interval '1 day'),
  ('r-std',   '281:1', 0,  now() - interval '1 day'),
  ('r-miss',  '281:1', 18, now() - interval '1 day'),
  ('r-stale', '281:1', 17, now() - interval '30 days'),
  ('r-base',  '999:9', 17, now() - interval '1 day'),
  ('r-late',  '281:1', 17, now() - interval '40 days'),
  ('q-old',   '281:1', NULL, NULL);  -- already queued: must not be duplicated or altered

SELECT _assert_eq((topshot_parallel_sales_followup(2, 3))::text,
                  '{"ok": true, "queued": 2, "sales_rekeyed": 2}', 'two NFTs queued, two sales re-keyed');

SELECT _assert_eq((SELECT base_external_id || '|' || coalesce(subedition_id::text, 'null') FROM topshot_moment_subeditions WHERE nft_id = 'q-new'),
                  '281:1|null', 'q-new queued as pending under its base');
SELECT _assert_eq((SELECT base_external_id || '|' || coalesce(subedition_id::text, 'null') FROM topshot_moment_subeditions WHERE nft_id = 'q-late'),
                  '281:1|null', 'a late-INGESTED old sale is queued (the window keys on ingestion too)');
SELECT _assert((SELECT count(*) = 0 FROM topshot_moment_subeditions WHERE nft_id = 'q-stale'), 'sold and ingested outside p_days: not queued');
SELECT _assert((SELECT count(*) = 0 FROM topshot_moment_subeditions WHERE nft_id = 'q-nopar'), 'a base with no parallels queues nothing');
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE nft_id = 'r-par'),  '00000000-0000-0000-0000-0000000000a7', 'chain-confirmed parallel moves to ::17');
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE nft_id = 'r-late'), '00000000-0000-0000-0000-0000000000a7', 'an OLD resolution with a NEW sale moves (the bypass-writer case)');
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE nft_id = 'r-std'),  '00000000-0000-0000-0000-0000000000a0', 'subedition 0 stays on base (never onto ::0)');
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE nft_id = 'r-miss'), '00000000-0000-0000-0000-0000000000a0', 'missing target edition: stays');
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE nft_id = 'r-stale'),'00000000-0000-0000-0000-0000000000a0', 'resolved and ingested outside the windows: stays');
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE nft_id = 'r-base'), '00000000-0000-0000-0000-0000000000a0', 'map base differs: stays');
SELECT _assert_eq((SELECT string_agg(nft_id || '|' || old_edition_id || '|' || new_edition_id || '|' || subedition_id, ',' ORDER BY nft_id) FROM topshot_parallel_sales_rekey_log),
                  'r-late|00000000-0000-0000-0000-0000000000a0|00000000-0000-0000-0000-0000000000a7|17,r-par|00000000-0000-0000-0000-0000000000a0|00000000-0000-0000-0000-0000000000a7|17', 'each move is logged once');
SELECT _assert_eq((SELECT pipeline || '|' || rows_written || '|' || ok || '|' || (extra->>'queued') FROM _runs),
                  'topshot-parallel-sales-followup|2|true|2', 'pipeline run logged with its counts');

-- The wide window (backlog mode) picks up the stale resolution too.
SELECT _assert_eq((topshot_parallel_sales_followup(30, 3650)->>'sales_rekeyed'), '1', 'backlog run re-keys the older resolution');
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE nft_id = 'r-stale'),'00000000-0000-0000-0000-0000000000a7', 'r-stale moved in backlog mode');

-- WRITE TIME: the trigger files a new sale of a chain-confirmed parallel on its subedition, whichever writer inserts it.
CREATE TRIGGER sales_topshot_follow_subedition_trg BEFORE INSERT ON sales
  FOR EACH ROW EXECUTE FUNCTION public.topshot_sales_follow_subedition_trg();
INSERT INTO sales (id, sold_at, collection_id, nft_id, edition_id) VALUES
  ('00000000-0000-0000-0000-000000000021', now(), '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'r-par',  '00000000-0000-0000-0000-0000000000a0'),  -- parallel: lands on ::17
  ('00000000-0000-0000-0000-000000000022', now(), '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'r-std',  '00000000-0000-0000-0000-0000000000a0'),  -- subedition 0: stays
  ('00000000-0000-0000-0000-000000000023', now(), '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'r-miss', '00000000-0000-0000-0000-0000000000a0'),  -- target missing: stays
  ('00000000-0000-0000-0000-000000000024', now(), '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'r-base', '00000000-0000-0000-0000-0000000000a0'),  -- map base differs: stays
  ('00000000-0000-0000-0000-000000000025', now(), '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'q-new',  '00000000-0000-0000-0000-0000000000a0'),  -- pending (NULL): stays
  ('00000000-0000-0000-0000-000000000026', now(), '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nobody', '00000000-0000-0000-0000-0000000000a0'),  -- not in the map: stays
  ('00000000-0000-0000-0000-000000000027', now(), 'dee28451-5d62-409e-a1ad-a83f763ac070', 'r-par', '00000000-0000-0000-0000-0000000000a0'), -- another collection: untouched
  ('00000000-0000-0000-0000-000000000028', now(), '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'r-par',  '00000000-0000-0000-0000-0000000000a7'); -- already on ::17: stays
SELECT _assert_eq((SELECT string_agg(right(id::text, 2) || '=' || right(edition_id::text, 2), ',' ORDER BY id) FROM sales WHERE id::text LIKE '%00000000002_'),
                  '21=a7,22=a0,23=a0,24=a0,25=a0,26=a0,27=a0,28=a7', 'the trigger moves only a chain-confirmed Top Shot parallel off its base');

SELECT '✓ topshot_parallel_sales_followup invariants pass' AS result;
ROLLBACK;
