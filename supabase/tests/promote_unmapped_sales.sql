-- DB invariant: public.promote_unmapped_sales — the drainer that moves a resolved
-- staging row from `unmapped_sales` into the canonical, FMV-feeding `sales` table.
-- Its correctness rests on:
--   (a) edition-resolution PRECEDENCE: set:play hint (e1) → edition_id hint (e2) →
--       nft_edition_map (e3), via COALESCE(e1,e2,e3). A wrong edition here feeds a
--       wrong FMV.
--   (b) only rows whose edition RESOLVES are promoted; the rest stay unresolved and
--       are counted in still_unresolved.
--   (c) serial COALESCE(us.serial_number, nem.serial, 0) — the sale carries the
--       best-known serial, defaulting to 0 (not NULL) for the sales schema.
--   (d) a promoted row is marked resolved_at (only when a row actually inserted).
--   (e) the unconditional 7-day archive of already-resolved staging rows.
--
-- fmv_from_sales + log_pipeline_run are external; stubbed here as no-ops so the
-- test stays self-contained. The function DDL below is a VERBATIM copy of the
-- committed migration
-- (supabase/migrations/20260427040000_promote_unmapped_sales_archive_resolved.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.collections (id uuid PRIMARY KEY, slug text);
INSERT INTO public.collections (id, slug) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nba_top_shot');

CREATE TABLE public.editions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id uuid NOT NULL,
  external_id text NOT NULL
);
INSERT INTO public.editions (id, collection_id, external_id) VALUES
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '5:12'),   -- set:play hint target (e1)
  ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ext-e2'), -- edition_id hint target (e2)
  ('33333333-3333-3333-3333-333333333333', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ext-e3'); -- nft_edition_map target (e3)

CREATE TABLE public.nft_edition_map (
  collection_id uuid NOT NULL,
  nft_id text NOT NULL,
  edition_external_id text,
  serial_number integer
);
INSERT INTO public.nft_edition_map (collection_id, nft_id, edition_external_id, serial_number) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nftViaMap', 'ext-e3', 77);

CREATE TABLE public.unmapped_sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id uuid NOT NULL,
  nft_id text,
  resolution_hint jsonb,
  serial_number integer,
  price_usd numeric,
  price_native numeric,
  currency text,
  seller_address text,
  buyer_address text,
  marketplace text,
  transaction_hash text,
  block_height bigint,
  sold_at timestamptz,
  source text,
  resolved_at timestamptz
);
INSERT INTO public.unmapped_sales
  (id, collection_id, nft_id, resolution_hint, serial_number, price_usd, sold_at, transaction_hash) VALUES
  -- resolves via e1 (set:play hint); own serial present
  ('a0000000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nftSetPlay',
     '{"set_id_onchain":"5","play_id_onchain":"12"}'::jsonb, 3, 100, '2026-01-01', 'tx1'),
  -- resolves via e3 (nft_edition_map); own serial NULL → falls back to map serial 77
  ('a0000000-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nftViaMap',
     NULL, NULL, 200, '2026-01-02', 'tx2'),
  -- unresolvable (no hint, no map) → stays unmapped
  ('a0000000-0000-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nftGhost',
     NULL, NULL, 300, '2026-01-03', 'tx3'),
  -- already resolved > 7 days ago → archive candidate
  ('a0000000-0000-0000-0000-000000000004', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nftOld',
     NULL, NULL, 50, '2025-06-01', 'tx4');
UPDATE public.unmapped_sales SET resolved_at = now() - interval '30 days'
  WHERE id = 'a0000000-0000-0000-0000-000000000004';

CREATE TABLE public.sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  moment_id text,
  edition_id uuid,
  collection_id uuid,
  serial_number integer,
  price_usd numeric,
  price_native numeric,
  currency text,
  seller_address text,
  buyer_address text,
  marketplace text,
  transaction_hash text,
  block_height bigint,
  sold_at timestamptz,
  nft_id text,
  collection text,
  source text
);

-- Stubbed dependencies (no-op) so the test is self-contained.
CREATE FUNCTION public.fmv_from_sales(p_collection_id uuid) RETURNS jsonb
  LANGUAGE sql AS $$ SELECT '{"stub":true}'::jsonb $$;
CREATE FUNCTION public.log_pipeline_run(
  p_pipeline text, p_started_at timestamptz,
  p_rows_written integer DEFAULT 0, p_collection_slug text DEFAULT NULL, p_extra jsonb DEFAULT NULL
) RETURNS void LANGUAGE sql AS $$ SELECT $$;

-- >>> BEGIN verbatim promote_unmapped_sales (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.promote_unmapped_sales(
  p_collection_id uuid DEFAULT NULL::uuid,
  p_limit integer DEFAULT 1000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_promoted     integer := 0;
  v_still_unres  integer := 0;
  v_archived     integer := 0;
  v_fmv_result   jsonb;
  v_run          jsonb;
  v_started_at   timestamptz := clock_timestamp();
BEGIN
  WITH resolved AS (
    SELECT DISTINCT ON (us.id)
           us.id AS unmapped_id,
           COALESCE(e1.id, e2.id, e3.id) AS edition_id,
           nem.serial_number AS map_serial
    FROM public.unmapped_sales us
    LEFT JOIN public.editions e1 ON e1.collection_id = us.collection_id
      AND us.resolution_hint ? 'set_id_onchain' AND us.resolution_hint ? 'play_id_onchain'
      AND e1.external_id = (us.resolution_hint->>'set_id_onchain') || ':' || (us.resolution_hint->>'play_id_onchain')
    LEFT JOIN public.editions e2 ON e2.collection_id = us.collection_id
      AND us.resolution_hint ? 'edition_id'
      AND e2.external_id = us.resolution_hint->>'edition_id'
    LEFT JOIN public.nft_edition_map nem ON nem.collection_id = us.collection_id
      AND nem.nft_id = us.nft_id
    LEFT JOIN public.editions e3 ON e3.collection_id = us.collection_id
      AND e3.external_id = nem.edition_external_id
    WHERE us.resolved_at IS NULL
      AND COALESCE(e1.id, e2.id, e3.id) IS NOT NULL
      AND (p_collection_id IS NULL OR us.collection_id = p_collection_id)
    LIMIT p_limit
  ),
  inserted AS (
    INSERT INTO public.sales (
      moment_id, edition_id, collection_id, serial_number,
      price_usd, price_native, currency,
      seller_address, buyer_address, marketplace,
      transaction_hash, block_height, sold_at, nft_id, collection, source
    )
    SELECT
      NULL, r.edition_id, us.collection_id,
      COALESCE(us.serial_number, r.map_serial, 0),
      us.price_usd, us.price_native, COALESCE(us.currency, 'USD'),
      us.seller_address, us.buyer_address, us.marketplace,
      us.transaction_hash, us.block_height, us.sold_at, us.nft_id,
      (SELECT slug FROM public.collections WHERE id = us.collection_id),
      COALESCE(us.source, 'promoted_from_unmapped')
    FROM public.unmapped_sales us
    JOIN resolved r ON r.unmapped_id = us.id
    ON CONFLICT DO NOTHING
    RETURNING id
  ),
  mark_resolved AS (
    UPDATE public.unmapped_sales us
    SET resolved_at = now()
    FROM resolved r
    WHERE us.id = r.unmapped_id
      AND EXISTS (SELECT 1 FROM inserted)
    RETURNING us.id
  )
  SELECT count(*) INTO v_promoted FROM mark_resolved;

  SELECT count(*) INTO v_still_unres
  FROM public.unmapped_sales
  WHERE resolved_at IS NULL
    AND (p_collection_id IS NULL OR collection_id = p_collection_id);

  -- Auto-refresh sales-based FMV when we promoted any sales
  IF v_promoted > 0 AND p_collection_id IS NOT NULL THEN
    SELECT public.fmv_from_sales(p_collection_id) INTO v_fmv_result;
  END IF;

  -- Archive: delete resolved staging rows older than 7 days. The canonical
  -- sale already lives in public.sales (or a sales_YYYY partition). We keep
  -- a 7-day window of resolved rows for debugging recently-promoted sales.
  -- Runs unconditionally per invocation so the staging table doesn't
  -- accumulate even when no new promotions happen this tick.
  WITH del AS (
    DELETE FROM public.unmapped_sales
    WHERE resolved_at IS NOT NULL
      AND resolved_at < now() - interval '7 days'
      AND (p_collection_id IS NULL OR collection_id = p_collection_id)
    RETURNING 1
  )
  SELECT count(*) INTO v_archived FROM del;

  v_run := jsonb_build_object(
    'promoted', v_promoted,
    'still_unresolved', v_still_unres,
    'archived', v_archived,
    'fmv_refresh', COALESCE(v_fmv_result, 'null'::jsonb),
    'duration_ms', EXTRACT(milliseconds FROM (clock_timestamp() - v_started_at))::integer
  );

  PERFORM public.log_pipeline_run(
    'promote_unmapped_sales', v_started_at,
    p_rows_written := v_promoted,
    p_collection_slug := (SELECT slug FROM public.collections WHERE id = p_collection_id),
    p_extra := v_run
  );

  RETURN v_run;
END;
$function$;
-- <<< END verbatim promote_unmapped_sales <<<

-- Run the drain scoped to the collection (also exercises the fmv_from_sales leg).
SELECT public.promote_unmapped_sales('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') AS run \gset

-- (1) Exactly the 2 resolvable rows promoted (SetPlay via e1, ViaMap via e3);
-- the ghost stays unresolved (counted), the old resolved row is archived.
SELECT _assert_eq((:'run'::jsonb->>'promoted'), '2', 'both resolvable rows promoted');
SELECT _assert_eq((:'run'::jsonb->>'still_unresolved'), '1', 'the unresolvable ghost stays unresolved');
SELECT _assert_eq((:'run'::jsonb->>'archived'), '1', 'the >7d-old resolved row is archived (deleted)');
SELECT _assert_eq((:'run'::jsonb->>'fmv_refresh'), '{"stub": true}', 'fmv refresh fired (collection-scoped promotion)');

-- (2) Edition-resolution precedence + serial COALESCE landed in `sales`.
SELECT _assert_eq(
  (SELECT edition_id::text FROM public.sales WHERE nft_id='nftSetPlay'),
  '11111111-1111-1111-1111-111111111111', 'set:play hint resolves to e1');
SELECT _assert_eq(
  (SELECT serial_number::text FROM public.sales WHERE nft_id='nftSetPlay'),
  '3', 'own serial wins when present');
SELECT _assert_eq(
  (SELECT edition_id::text FROM public.sales WHERE nft_id='nftViaMap'),
  '33333333-3333-3333-3333-333333333333', 'nft_edition_map resolves to e3');
SELECT _assert_eq(
  (SELECT serial_number::text FROM public.sales WHERE nft_id='nftViaMap'),
  '77', 'null own serial falls back to the map serial');

-- (3) The two promoted staging rows are now marked resolved; the ghost is not.
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.unmapped_sales WHERE nft_id IN ('nftSetPlay','nftViaMap') AND resolved_at IS NOT NULL),
  '2', 'promoted rows marked resolved_at');
SELECT _assert_eq(
  (SELECT resolved_at IS NULL FROM public.unmapped_sales WHERE nft_id='nftGhost')::text,
  'true', 'the unresolvable ghost keeps resolved_at NULL');

-- (4) The ghost never produced a sale row.
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.sales WHERE nft_id='nftGhost'),
  '0', 'an unresolved row never lands in sales');

SELECT '✓ promote_unmapped_sales invariants pass' AS result;
ROLLBACK;
