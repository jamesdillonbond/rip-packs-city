-- DB invariant: public.get_edition_recent_sales — the edition page's recent
-- sales table. Added 2026-10-02 with the sub_names rewrite. Claims:
--
--   1. Rows are the edition's sales, newest first, cut at p_limit / p_offset.
--   2. A Top Shot sale's `parallel`: subedition 0 -> 'Standard'; > 0 -> the
--      cataloged Top Shot subedition name; an uncataloged id -> 'Parallel #N';
--      another collection's edition carrying the same subedition id never
--      names it (the body scoped nothing before 2026-10-02).
--   3. #142: a sale whose serial exceeds max(edition circulation, base +
--      parallels total) is refused; one within the base+parallels total stays.
--   4. Non-Top-Shot collections carry parallel = null.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20261003033402_audit_20261002_edition_recent_sales_sub_names_reads_only_the_page_s_subeditions.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.editions (id uuid PRIMARY KEY, collection_id uuid, external_id varchar(100), subedition_id int, subedition_name text, circulation_count int);
CREATE TABLE public.sales (edition_id uuid, serial_number int, price_usd numeric, marketplace text, source text, buyer_address text, seller_address text, nft_id text, transaction_hash text, sold_at timestamptz);
CREATE TABLE public.topshot_moment_subeditions (nft_id text PRIMARY KEY, subedition_id int);
CREATE TABLE public.pinnacle_sales (edition_id text, serial_number int, sale_price_usd numeric, source text, buyer_address text, seller_address text, nft_id text, sold_at timestamptz);

-- >>> BEGIN verbatim >>>
CREATE OR REPLACE FUNCTION public.get_edition_recent_sales(p_collection_id uuid, p_route_slug text, p_limit integer DEFAULT 30, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_pinnacle_uuid CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_topshot_uuid  CONSTANT uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_safe_limit    int  := LEAST(GREATEST(COALESCE(p_limit, 30), 1), 200);
  v_safe_offset   int  := GREATEST(COALESCE(p_offset, 0), 0);
  result jsonb;
BEGIN
  IF p_collection_id = v_pinnacle_uuid THEN
    WITH recent AS (
      SELECT
        ps.serial_number,
        ps.sale_price_usd                  AS price_usd,
        NULL::text                         AS marketplace,
        ps.source                          AS source,
        ps.buyer_address,
        ps.seller_address,
        ps.nft_id,
        NULL::text                         AS transaction_hash,
        ps.sold_at
      FROM pinnacle_sales ps
      WHERE ps.edition_id = p_route_slug
      ORDER BY ps.sold_at DESC
      LIMIT v_safe_limit OFFSET v_safe_offset
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(recent.*) ORDER BY recent.sold_at DESC), '[]'::jsonb)
    INTO result
    FROM recent;
  ELSE
    WITH ed AS (
      SELECT id, external_id, subedition_name, circulation_count FROM editions
      WHERE collection_id = p_collection_id
        AND (external_id = p_route_slug OR id::text = p_route_slug)
      LIMIT 1
    ),
    recent AS (
      SELECT
        sa.serial_number,
        sa.price_usd,
        sa.marketplace::text                     AS marketplace,
        sa.source                                AS source,
        sa.buyer_address::text                   AS buyer_address,
        sa.seller_address::text                  AS seller_address,
        sa.nft_id::text                          AS nft_id,
        sa.transaction_hash::text                AS transaction_hash,
        sa.sold_at,
        ed.external_id                           AS ed_external_id,
        ed.subedition_name                       AS ed_subedition_name
      FROM ed
      JOIN sales sa ON sa.edition_id = ed.id
      -- 2026-09-25 (#142): refuse a sale whose serial cannot exist in this
      -- edition. The ceiling is base + parallels (serials are shared across a
      -- (set, play) and its subeditions — 20260922200554), which equals the
      -- chain's getNumMomentsInEdition. Subtractive and NULL-escaping; the
      -- total is an InitPlan, reached only for a serial above the row's own
      -- circulation, so a normal page load never pays for it.
      WHERE sa.serial_number IS NULL
         OR ed.circulation_count IS NULL OR ed.circulation_count <= 0
         OR sa.serial_number <= ed.circulation_count
         OR sa.serial_number <= (
              SELECT sum(e2.circulation_count) FROM editions e2
              WHERE e2.collection_id = p_collection_id
                AND e2.circulation_count > 0
                AND split_part(e2.external_id, '::', 1) = split_part((SELECT external_id FROM ed), '::', 1))
      ORDER BY sa.sold_at DESC
      LIMIT v_safe_limit OFFSET v_safe_offset
    ),
    -- subedition_id -> printing name, from the cataloged :: editions.
    -- 2026-10-02: only the subedition ids this page's sales carry, Top Shot
    -- editions only, name as tiebreak (was: every edition with a subedition in
    -- every collection, ~2.1k buffers per call, arbitrary name on a tie).
    sub_names AS (
      SELECT DISTINCT ON (e.subedition_id) e.subedition_id, e.subedition_name
      FROM editions e
      WHERE p_collection_id = v_topshot_uuid
        AND e.collection_id = v_topshot_uuid
        AND e.subedition_id IN (
              SELECT t.subedition_id
              FROM recent r2
              JOIN topshot_moment_subeditions t ON t.nft_id = r2.nft_id
              WHERE t.subedition_id > 0)
        AND e.subedition_name IS NOT NULL
      ORDER BY e.subedition_id, e.subedition_name
    ),
    enriched AS (
      SELECT
        r.serial_number, r.price_usd, r.marketplace, r.source,
        r.buyer_address, r.seller_address, r.nft_id, r.transaction_hash, r.sold_at,
        CASE WHEN p_collection_id = v_topshot_uuid THEN
          COALESCE(
            CASE WHEN tms.subedition_id > 0
                   THEN COALESCE(sn.subedition_name, 'Parallel #' || tms.subedition_id)
                 WHEN tms.subedition_id = 0 THEN 'Standard'
            END,
            NULLIF(r.ed_subedition_name, ''),
            CASE WHEN r.ed_external_id ~ '^[0-9]+:[0-9]+$' THEN 'Standard' END
          )
        END AS parallel
      FROM recent r
      LEFT JOIN topshot_moment_subeditions tms
        ON p_collection_id = v_topshot_uuid AND tms.nft_id = r.nft_id
      LEFT JOIN sub_names sn ON sn.subedition_id = tms.subedition_id
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(enriched.*) ORDER BY enriched.sold_at DESC), '[]'::jsonb)
    INTO result
    FROM enriched;
  END IF;

  RETURN result;
END;
$function$;-- <<< END verbatim <<<

INSERT INTO public.editions VALUES
  ('00000000-0000-0000-0000-0000000000a1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '10:20',    NULL, NULL,          100),  -- base
  ('00000000-0000-0000-0000-0000000000a2', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '10:20::3', 3,    'Cosmic',      50),   -- parallel, ceiling 150
  ('00000000-0000-0000-0000-0000000000a3', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '11:20::3', 3,    'Cosmic',      10),
  ('00000000-0000-0000-0000-0000000000b1', 'dee28451-5d62-409e-a1ad-a83f763ac070', '77',       3,    'AAA-not-top-shot', 5),   -- other collection, same id
  ('00000000-0000-0000-0000-0000000000b2', 'dee28451-5d62-409e-a1ad-a83f763ac070', '78',       NULL, NULL,          10);
INSERT INTO public.topshot_moment_subeditions VALUES ('n1', 0), ('n2', 3), ('n3', 9);
INSERT INTO public.sales VALUES
  ('00000000-0000-0000-0000-0000000000a1', 5,   1, 'm', 's', 'b', 'x', 'n1', 't1', '2026-10-01 05:00+00'),
  ('00000000-0000-0000-0000-0000000000a1', 120, 2, 'm', 's', 'b', 'x', 'n2', 't2', '2026-10-01 04:00+00'),  -- above base 100, within 150
  ('00000000-0000-0000-0000-0000000000a1', 7,   3, 'm', 's', 'b', 'x', 'n3', 't3', '2026-10-01 03:00+00'),  -- uncataloged subedition 9
  ('00000000-0000-0000-0000-0000000000a1', 999, 4, 'm', 's', 'b', 'x', 'n4', 't4', '2026-10-01 02:00+00'),  -- above 150: refused
  ('00000000-0000-0000-0000-0000000000a1', 8,   5, 'm', 's', 'b', 'x', 'n5', 't5', '2026-10-01 01:00+00'),  -- no tms row
  ('00000000-0000-0000-0000-0000000000b2', 1,   6, 'm', 's', 'b', 'x', 'n2', 't6', '2026-10-01 05:00+00');  -- All Day sale, nft id shared by chance

DO $$
DECLARE v jsonb;
BEGIN
  v := public.get_edition_recent_sales('95f28a17-224a-4025-96ad-adf8a4c63bfd', '10:20', 30, 0);
  PERFORM _assert_eq(jsonb_array_length(v)::text, '4', 'the serial-999 sale is refused (claim 3)');
  PERFORM _assert_eq((SELECT string_agg(e->>'transaction_hash', ',' ORDER BY o) FROM jsonb_array_elements(v) WITH ORDINALITY x(e, o)),
                     't1,t2,t3,t5', 'newest first; serial 120 kept under the 150 base+parallels ceiling (claims 1, 3)');
  PERFORM _assert_eq((SELECT string_agg(coalesce(e->>'parallel', 'NULL'), ',' ORDER BY o) FROM jsonb_array_elements(v) WITH ORDINALITY x(e, o)),
                     'Standard,Cosmic,Parallel #9,Standard', 'parallel: 0 -> Standard, 3 -> the Top Shot name, 9 -> fallback, no tms row on a base id -> Standard (claim 2)');
  PERFORM _assert_eq((SELECT string_agg(e->>'transaction_hash', ',' ORDER BY o) FROM jsonb_array_elements(public.get_edition_recent_sales('95f28a17-224a-4025-96ad-adf8a4c63bfd', '10:20', 2, 1)) WITH ORDINALITY x(e, o)),
                     't2,t3', 'limit/offset (claim 1)');
  v := public.get_edition_recent_sales('dee28451-5d62-409e-a1ad-a83f763ac070', '78', 30, 0);
  PERFORM _assert((SELECT count(*) = 1 AND bool_and(e->'parallel' = 'null'::jsonb) FROM jsonb_array_elements(v) e),
                  'a non-Top-Shot sale carries parallel = null (claim 4)');
END $$;

ROLLBACK;
