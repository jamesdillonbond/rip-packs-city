-- DB invariant: public.promote_unmapped_sales — the drainer that moves a resolved
-- staging row from `unmapped_sales` into the canonical, FMV-feeding `sales` table.
-- Its correctness rests on:
--   (a) edition-resolution PRECEDENCE: set:play hint → edition_id hint →
--       nft_edition_map → wallet_moments_cache. A wrong edition here feeds a
--       wrong FMV.
--   (b) only rows whose edition RESOLVES are promoted; the rest stay unresolved
--       and are counted in still_unresolved.
--   (c) serial COALESCE(own, map/wmc serial, 0) — the sale carries the
--       best-known serial, defaulting to 0 (not NULL) for the sales schema.
--   (d) the price guard: a 0-price row NEVER enters sales (it would pollute FMV).
--   (e) the attempted-marker skip: a row parked behind a future
--       `promote_recheck_after` is not re-examined.
--   (f) the FOUR per-row outcomes, which is where this function has historically
--       lied. `promoted` / `already_in_sales` / `merged_cross_source` all mark
--       the staging row resolved; only `insert_vanished` parks it. The
--       `merged_cross_source` arm exists because
--       trg_zzz_allday_cross_source_dedup SUPPRESSES an insert silently
--       (RETURN NULL, no error, zero rows) after folding the incoming
--       buyer/seller/serial into a cross-source twin — before 2026-07-31 such
--       rows fell to the ELSE arm and were mislabelled a tx-hash collision, then
--       parked for 30 days, forever.
--   (g) the unconditional 7-day archive of already-resolved staging rows.
--
-- log_pipeline_run is external; stubbed here as a no-op so the test stays
-- self-contained. allday_sales_cross_source_dedup IS installed verbatim (not
-- stubbed) — the suppression path is the point of (f), so a fake trigger would
-- pin nothing. Both function DDLs below are VERBATIM copies of their committed
-- migrations; __tests__/db-invariants-drift-guard.test.ts fails CI if either
-- copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- The dedup trigger's economic key uses date_trunc('day', timestamptz), which is
-- session-TimeZone dependent. Pin it so the twin and the incoming row land on the
-- same calendar day no matter where the runner is.
SET LOCAL TimeZone = 'UTC';

CREATE TABLE public.collections (id uuid PRIMARY KEY, slug text);
INSERT INTO public.collections (id, slug) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nba_top_shot'),
  -- The real AllDay id: both the dedup trigger and the classifier hardcode it.
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'nfl_all_day');

CREATE TABLE public.editions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id uuid NOT NULL,
  external_id text NOT NULL
);
INSERT INTO public.editions (id, collection_id, external_id) VALUES
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '5:12'),    -- set:play hint target
  ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ext-e2'),  -- edition_id hint target
  ('33333333-3333-3333-3333-333333333333', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ext-e3'),  -- nft_edition_map target
  ('44444444-4444-4444-4444-444444444444', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ext-wmc'), -- wallet_moments_cache target
  ('55555555-5555-5555-5555-555555555555', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'ad-ext-1');

CREATE TABLE public.nft_edition_map (
  collection_id uuid NOT NULL,
  nft_id text NOT NULL,
  edition_external_id text,
  serial_number integer
);
INSERT INTO public.nft_edition_map (collection_id, nft_id, edition_external_id, serial_number) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nftViaMap',  'ext-e3', 77),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nftAlready', 'ext-e2', NULL),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nftVanish',  'ext-e2', NULL),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nftBlocked', 'ext-e2', NULL),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nftZero',    'ext-e2', NULL),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'nftMerged',  'ad-ext-1', NULL);

CREATE TABLE public.wallet_moments_cache (
  collection_id uuid NOT NULL,
  moment_id text NOT NULL,
  edition_key text,
  serial_number integer
);
INSERT INTO public.wallet_moments_cache (collection_id, moment_id, edition_key, serial_number) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nftViaWmc', 'ext-wmc', 55);

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
-- ⚠ Every fixture row carries a NON-NULL resolution_hint, matching production
-- (0 of 93,734 live rows have a NULL hint, verified 2026-07-31). This is
-- load-bearing: the recheck-horizon guard is
-- `NOT (hint ? 'promote_recheck_after' AND (…)::timestamptz > now())`, and with
-- a NULL hint both operands are NULL, so `NOT (NULL AND NULL)` is NULL and the
-- row silently fails the WHERE. A NULL-hint row could therefore never be
-- promoted — inert in prod, but it makes a fixture that uses NULL untestable.
INSERT INTO public.unmapped_sales
  (id, collection_id, nft_id, resolution_hint, serial_number, price_usd, sold_at,
   transaction_hash, source, buyer_address) VALUES
  -- resolves via the set:play hint; own serial present
  ('a0000000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nftSetPlay',
     '{"set_id_onchain":"5","play_id_onchain":"12"}'::jsonb, 3, 100, '2026-01-01', 'tx1', NULL, NULL),
  -- resolves via nft_edition_map; own serial NULL → falls back to map serial 77
  ('a0000000-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nftViaMap',
     '{}'::jsonb, NULL, 200, '2026-01-02', 'tx2', NULL, NULL),
  -- resolves via wallet_moments_cache (path 4); serial falls back to wmc 55
  ('a0000000-0000-0000-0000-000000000005', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nftViaWmc',
     '{}'::jsonb, NULL, 250, '2026-01-05', 'tx5', NULL, NULL),
  -- unresolvable (no usable hint, no map, no wmc) → never even a candidate
  ('a0000000-0000-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nftGhost',
     '{}'::jsonb, NULL, 300, '2026-01-03', 'tx3', NULL, NULL),
  -- already resolved > 7 days ago → archive candidate
  ('a0000000-0000-0000-0000-000000000004', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nftOld',
     '{}'::jsonb, NULL, 50, '2025-06-01', 'tx4', NULL, NULL),
  -- the canonical sale is already in `sales` under the SAME tx + nft
  ('a0000000-0000-0000-0000-000000000006', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nftAlready',
     '{}'::jsonb, NULL, 400, '2026-01-06', 'tx6', NULL, NULL),
  -- AllDay: a cross-source twin already exists under a DIFFERENT tx → the dedup
  -- trigger will absorb this row's buyer/serial and suppress the insert
  ('a0000000-0000-0000-0000-000000000007', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'nftMerged',
     '{}'::jsonb, 12, 239, '2026-02-06 18:44:00+00', 'tx7', 'onchain_dapper_v1', '0xbuyerfromincoming'),
  -- ON CONFLICT swallows this row (see the unique index below) and no
  -- same-tx+same-nft row exists → the honest `insert_vanished` outcome
  ('a0000000-0000-0000-0000-000000000008', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nftVanish',
     '{}'::jsonb, NULL, 500, '2026-01-08', 'txVanish', NULL, NULL),
  -- parked behind a future recheck horizon → must not be re-examined
  ('a0000000-0000-0000-0000-000000000009', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nftBlocked',
     jsonb_build_object('promote_blocked', 'sales_insert_vanished_unexplained',
                        'promote_recheck_after', to_char(now() + interval '10 days', 'YYYY-MM-DD"T"HH24:MI:SSOF')),
     NULL, 600, '2026-01-09', 'tx8', NULL, NULL),
  -- price 0 (V1 decode budget exhausted) → must never enter sales
  ('a0000000-0000-0000-0000-00000000000a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nftZero',
     '{}'::jsonb, NULL, 0, '2026-01-10', 'tx9', NULL, NULL);
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
  source text,
  ingested_at timestamptz DEFAULT now()
);

-- Pre-existing canonical rows.
INSERT INTO public.sales
  (id, edition_id, collection_id, serial_number, price_usd, transaction_hash, sold_at, nft_id, collection, source) VALUES
  -- same tx AND same nft as the nftAlready staging row → `already_in_sales`
  ('5a1e0000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 9, 400, 'tx6', '2026-01-06', 'nftAlready', 'nba_top_shot', 'onchain'),
  -- same tx as nftVanish but a DIFFERENT nft → not `already_in_sales`
  ('5a1e0000-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 1, 500, 'txVanish', '2026-01-08', 'someOtherNft', 'nba_top_shot', 'onchain'),
  -- the AllDay cross-source twin: same nft + day + rounded price, DIFFERENT
  -- source, different tx. Buyer + serial deliberately missing so the merge shows.
  ('5a1e0000-0000-0000-0000-000000000003', '55555555-5555-5555-5555-555555555555',
   'dee28451-5d62-409e-a1ad-a83f763ac070', NULL, 239.00, 'txTwin', '2026-02-06 18:10:00+00', 'nftMerged',
   'nfl_all_day', 'allday_studio_history_v1');

-- Reproduces the pre-2026-07-31 tx-hash-only unique index (widened in aa609eb1
-- to (transaction_hash, nft_id, sold_at) NULLS NOT DISTINCT). Every fixture
-- tx_hash is distinct, so the only row it swallows is nftVanish — whose tx is
-- already taken by a DIFFERENT nft. Nothing inserts, no same-tx+same-nft row
-- exists, no dedup twin → the ELSE arm, which is exactly what this index used
-- to cause in production.
CREATE UNIQUE INDEX sales_tx_hash_uniq ON public.sales (transaction_hash);

-- Stubbed dependency (no-op) so the test is self-contained.
CREATE FUNCTION public.log_pipeline_run(
  p_pipeline text, p_started_at timestamptz,
  p_rows_found integer DEFAULT 0, p_rows_written integer DEFAULT 0,
  p_ok boolean DEFAULT true, p_collection_slug text DEFAULT NULL, p_extra jsonb DEFAULT NULL
) RETURNS void LANGUAGE sql AS $$ SELECT $$;

-- >>> BEGIN verbatim allday_sales_cross_source_dedup (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.allday_sales_cross_source_dedup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $body$
DECLARE
  ad_id constant uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  twin  record;
BEGIN
  -- Only AllDay rows carrying the fields the economic key needs.
  IF NEW.collection_id IS DISTINCT FROM ad_id
     OR NEW.nft_id IS NULL
     OR NEW.price_usd IS NULL
     OR NEW.sold_at IS NULL THEN
    RETURN NEW;
  END IF;

  -- Richest existing cross-source twin (same nft, rounded price, calendar day).
  SELECT s.id INTO twin
  FROM sales s
  WHERE s.collection_id = ad_id
    AND s.nft_id = NEW.nft_id
    AND date_trunc('day', s.sold_at) = date_trunc('day', NEW.sold_at)
    AND round(s.price_usd::numeric, 2) = round(NEW.price_usd::numeric, 2)
    AND s.source IS DISTINCT FROM NEW.source
  ORDER BY (CASE WHEN s.buyer_address  IS NOT NULL THEN 1 ELSE 0 END
          + CASE WHEN s.seller_address IS NOT NULL THEN 1 ELSE 0 END
          + CASE WHEN COALESCE(s.serial_number, 0) > 0 THEN 1 ELSE 0 END) DESC,
           s.ingested_at ASC NULLS LAST, s.id ASC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NEW;  -- no cross-source twin; normal insert
  END IF;

  -- Collapse to one row: fill the surviving twin's gaps from the incoming row,
  -- then suppress the incoming insert.
  UPDATE sales s
  SET buyer_address  = COALESCE(s.buyer_address,  NEW.buyer_address),
      seller_address = COALESCE(s.seller_address, NEW.seller_address),
      serial_number  = COALESCE(NULLIF(s.serial_number, 0), NULLIF(NEW.serial_number, 0), s.serial_number)
  WHERE s.id = twin.id;

  RETURN NULL;
END
$body$;
-- <<< END verbatim allday_sales_cross_source_dedup <<<

CREATE TRIGGER trg_zzz_allday_cross_source_dedup
BEFORE INSERT ON public.sales
FOR EACH ROW EXECUTE FUNCTION public.allday_sales_cross_source_dedup();

-- >>> BEGIN verbatim promote_unmapped_sales (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.promote_unmapped_sales(p_collection_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 1000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_eligible     integer := 0;
  v_promoted     integer := 0;
  v_dedup        integer := 0;
  v_merged       integer := 0;
  v_blocked      integer := 0;
  v_still_unres  integer := 0;
  v_archived     integer := 0;
  v_ok           boolean := true;
  v_run          jsonb;
  v_started_at   timestamptz := clock_timestamp();
  -- Mirrors the hardcoded constant in allday_sales_cross_source_dedup(). That
  -- BEFORE INSERT trigger is the ONLY insert-suppressing trigger on
  -- public.sales, and it fires for this collection alone.
  c_allday       constant uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
BEGIN
  -- ── CONCURRENCY GUARD (2026-08-29) ─────────────────────────────────────────
  -- This drain is NOT claim-based: the `candidates` CTE selects `resolved_at IS
  -- NULL ... LIMIT 1000` with no FOR UPDATE SKIP LOCKED and no in-flight marker,
  -- so two concurrent instances pick the SAME rows and both do the whole scan.
  -- The work is idempotent (ON CONFLICT DO NOTHING + `AND us.resolved_at IS
  -- NULL`), so an overlap is SAFE -- it is simply 100% duplicated IO on an
  -- instance whose binding constraint is disk IO.
  -- Measured 24 h to 2026-08-29 13:25Z: 307 runs, avg gap 278 s, p95 duration
  -- 196,353 ms, max 297,164 ms, and **76 runs still executing when the next one
  -- started -- 74 of them the same collection against itself**.
  -- ⚠ The key is SCOPED TO p_collection_id on purpose: `nfl_all_day` (229 runs,
  -- avg 65,864 ms) and `laliga_golazos` (78 runs, avg 959 ms) touch disjoint
  -- rows and must NOT serialise against each other. Golazos recorded ZERO
  -- overlaps; a function-wide key would have made it wait on AllDay for nothing.
  -- ⛔ KNOWN GAP, stated rather than hidden: an all-collections call
  -- (p_collection_id IS NULL) overlaps every scoped call and this key does not
  -- see that. There were ZERO such calls in the measured window, and all eight
  -- repo call sites pass an explicit collection id.
  IF NOT pg_try_advisory_xact_lock(
       hashtext('promote_unmapped_sales:' || COALESCE(p_collection_id::text, 'ALL'))::bigint) THEN
    -- Record the skip HONESTLY. rows_* are NULL, not 0: nothing was measured,
    -- and `log_pipeline_run` only stopped coalescing NULL to 0 on 2026-08-29
    -- (migration 20260829040000) -- before that this shape was not expressible.
    PERFORM public.log_pipeline_run(
      'promote_unmapped_sales', v_started_at,
      p_rows_found := NULL,
      p_rows_written := NULL,
      p_rows_skipped := NULL,
      p_ok := true,
      p_collection_slug := (SELECT slug FROM public.collections WHERE id = p_collection_id),
      p_extra := jsonb_build_object(
        'note', 'skipped_concurrent_run',
        'scope', COALESCE(p_collection_id::text, 'ALL'))
    );
    -- Explicit NULLs rather than absent keys so a caller inspecting the object
    -- can tell a skip from a drain of nothing. ⚠ app/api/admin/recover-v1-budget-
    -- exhausted/route.ts reads `pr?.promoted ?? 0`, so it still sees 0 either
    -- way; that route is manually invoked and cannot realistically race.
    RETURN jsonb_build_object(
      'skipped', 'concurrent_run',
      'scope', COALESCE(p_collection_id::text, 'ALL'),
      'eligible', NULL,
      'promoted', NULL);
  END IF;

  WITH candidates AS (
    SELECT us.id, us.collection_id, us.nft_id, us.resolution_hint,
           us.price_usd, us.price_native, us.currency,
           us.seller_address, us.buyer_address, us.marketplace,
           us.transaction_hash, us.block_height, us.sold_at,
           us.serial_number, us.source
    FROM public.unmapped_sales us
    WHERE us.resolved_at IS NULL
      -- Skip price-uncertain rows: V1 Dapper sales whose tx-decode budget was
      -- exhausted land here with price_usd = 0 (NOT NULL), so the guard must be
      -- "> 0", not just "IS NOT NULL". A 0/NULL-price sale must never enter
      -- public.sales -- it pollutes FMV. They wait here until a real price is
      -- recovered (decodeV1SaleTx re-run), then promote on a later run.
      AND COALESCE(us.price_usd, 0) > 0
      AND (p_collection_id IS NULL OR us.collection_id = p_collection_id)
      -- FIX 2: attempted-marker skip. Rows proven un-promotable (see mark_blocked)
      -- carry a recheck horizon; do not re-examine them until it passes.
      AND NOT (us.resolution_hint ? 'promote_recheck_after'
               AND (us.resolution_hint->>'promote_recheck_after')::timestamptz > now())
      AND (
        EXISTS (
          SELECT 1 FROM public.nft_edition_map nem
          WHERE nem.collection_id = us.collection_id AND nem.nft_id = us.nft_id
        )
        OR (us.resolution_hint ? 'edition_id'
            AND EXISTS (SELECT 1 FROM public.editions e
                        WHERE e.collection_id = us.collection_id
                          AND e.external_id = us.resolution_hint->>'edition_id'))
        OR (us.resolution_hint ? 'set_id_onchain' AND us.resolution_hint ? 'play_id_onchain'
            AND EXISTS (SELECT 1 FROM public.editions e
                        WHERE e.collection_id = us.collection_id
                          AND e.external_id = (us.resolution_hint->>'set_id_onchain') || ':' || (us.resolution_hint->>'play_id_onchain')))
        -- Path 4 (added 2026-05-24): resolve via wallet_moments_cache.
        OR EXISTS (
          SELECT 1 FROM public.wallet_moments_cache w
          JOIN public.editions e
            ON e.external_id = w.edition_key AND e.collection_id = w.collection_id
          WHERE w.moment_id = us.nft_id AND w.collection_id = us.collection_id
        )
      )
    LIMIT p_limit
  ),
  resolved AS (
    SELECT
      c.*,
      COALESCE(
        (SELECT e.id FROM public.editions e
          WHERE e.collection_id = c.collection_id
            AND c.resolution_hint ? 'set_id_onchain' AND c.resolution_hint ? 'play_id_onchain'
            AND e.external_id = (c.resolution_hint->>'set_id_onchain') || ':' || (c.resolution_hint->>'play_id_onchain')
          LIMIT 1),
        (SELECT e.id FROM public.editions e
          WHERE e.collection_id = c.collection_id
            AND c.resolution_hint ? 'edition_id'
            AND e.external_id = c.resolution_hint->>'edition_id'
          LIMIT 1),
        (SELECT e.id
           FROM public.nft_edition_map nem
           JOIN public.editions e
             ON e.collection_id = nem.collection_id AND e.external_id = nem.edition_external_id
          WHERE nem.collection_id = c.collection_id AND nem.nft_id = c.nft_id
          LIMIT 1),
        (SELECT e.id
           FROM public.wallet_moments_cache w
           JOIN public.editions e
             ON e.external_id = w.edition_key AND e.collection_id = w.collection_id
          WHERE w.moment_id = c.nft_id AND w.collection_id = c.collection_id
          LIMIT 1)
      ) AS edition_id,
      COALESCE(
        (SELECT nem.serial_number FROM public.nft_edition_map nem
          WHERE nem.collection_id = c.collection_id AND nem.nft_id = c.nft_id
          LIMIT 1),
        (SELECT w.serial_number FROM public.wallet_moments_cache w
          WHERE w.moment_id = c.nft_id AND w.collection_id = c.collection_id
          LIMIT 1)
      ) AS map_serial
    FROM candidates c
  ),
  resolved_with_edition AS (
    SELECT * FROM resolved WHERE edition_id IS NOT NULL
  ),
  inserted AS (
    INSERT INTO public.sales (
      moment_id, edition_id, collection_id, serial_number,
      price_usd, price_native, currency,
      seller_address, buyer_address, marketplace,
      transaction_hash, block_height, sold_at, nft_id, collection, source
    )
    SELECT
      NULL,
      r.edition_id,
      r.collection_id,
      COALESCE(r.serial_number, r.map_serial, 0),
      r.price_usd, r.price_native, COALESCE(r.currency, 'USD'),
      r.seller_address, r.buyer_address, r.marketplace,
      r.transaction_hash, r.block_height, r.sold_at, r.nft_id,
      (SELECT slug FROM public.collections WHERE id = r.collection_id),
      COALESCE(r.source, 'promoted_from_unmapped')
    FROM resolved_with_edition r
    ON CONFLICT DO NOTHING
    RETURNING transaction_hash, nft_id
  ),
  -- FIX 1: per-row outcome. Note CTEs read the pre-statement snapshot of
  -- public.sales, so the `already_in_sales` test cannot see rows `inserted` just
  -- wrote -- which is exactly right: those are covered by the `promoted` arm.
  classified AS (
    SELECT r.id, r.transaction_hash, r.nft_id,
           CASE
             WHEN EXISTS (SELECT 1 FROM inserted i
                           WHERE i.transaction_hash = r.transaction_hash
                             AND i.nft_id IS NOT DISTINCT FROM r.nft_id)
               THEN 'promoted'
             WHEN EXISTS (SELECT 1 FROM public.sales s
                           WHERE s.transaction_hash = r.transaction_hash
                             AND s.nft_id IS NOT DISTINCT FROM r.nft_id)
               THEN 'already_in_sales'
             -- FIX 4 (2026-07-31): the insert was SUPPRESSED, not rejected.
             -- trg_zzz_allday_cross_source_dedup found a cross-source economic
             -- twin, merged this row's buyer/seller/serial into it and RETURN
             -- NULLed -- silently, with no error and no inserted row. The sale
             -- IS recorded, on the twin under a different tx_hash, so this
             -- staging row is resolved in substance. Predicate mirrors the
             -- trigger's guard + economic key exactly, including the source
             -- COALESCE the INSERT above applies.
             WHEN r.collection_id = c_allday
                  AND r.nft_id IS NOT NULL
                  AND r.price_usd IS NOT NULL
                  AND r.sold_at IS NOT NULL
                  AND EXISTS (SELECT 1 FROM public.sales s
                               WHERE s.collection_id = c_allday
                                 AND s.nft_id = r.nft_id
                                 AND date_trunc('day', s.sold_at) = date_trunc('day', r.sold_at)
                                 AND round(s.price_usd::numeric, 2) = round(r.price_usd::numeric, 2)
                                 AND s.source IS DISTINCT FROM COALESCE(r.source, 'promoted_from_unmapped'))
               THEN 'merged_cross_source'
             -- Nothing inserted, and none of the three explanations hold. Since
             -- the 2026-07-31 index widening a same-tx different-nft row IS
             -- storable, so this is no longer a tx-hash collision -- it is an
             -- unexplained disappearance, and saying so is the honest signal.
             ELSE 'insert_vanished'
           END AS outcome
      FROM resolved_with_edition r
  ),
  mark_done AS (
    UPDATE public.unmapped_sales us
       SET resolved_at = now()
      FROM classified c
     WHERE us.id = c.id
       AND us.resolved_at IS NULL
       AND c.outcome IN ('promoted', 'already_in_sales', 'merged_cross_source')
    RETURNING us.id, c.outcome
  ),
  mark_blocked AS (
    UPDATE public.unmapped_sales us
       SET resolution_hint = COALESCE(us.resolution_hint, '{}'::jsonb)
             || jsonb_build_object(
                  'promote_blocked', 'sales_insert_vanished_unexplained',
                  'promote_blocked_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'),
                  'promote_recheck_after', to_char(now() + interval '30 days', 'YYYY-MM-DD"T"HH24:MI:SSOF'))
      FROM classified c
     WHERE us.id = c.id
       AND us.resolved_at IS NULL
       AND c.outcome = 'insert_vanished'
    RETURNING us.id
  )
  SELECT
    (SELECT count(*) FROM classified),
    (SELECT count(*) FROM mark_done WHERE outcome = 'promoted'),
    (SELECT count(*) FROM mark_done WHERE outcome = 'already_in_sales'),
    (SELECT count(*) FROM mark_done WHERE outcome = 'merged_cross_source'),
    (SELECT count(*) FROM mark_blocked)
  INTO v_eligible, v_promoted, v_dedup, v_merged, v_blocked;

  SELECT count(*) INTO v_still_unres
  FROM public.unmapped_sales
  WHERE resolved_at IS NULL
    AND (p_collection_id IS NULL OR collection_id = p_collection_id);

  -- fmv_from_sales() call removed 2026-05-25: it was a retired no-op since
  -- 2026-05-24. fmv-recalc '1.7.0' is the sole sales-path FMV owner; promoted
  -- sales self-heal as fmv-recalc's sweep reaches them.

  WITH del AS (
    DELETE FROM public.unmapped_sales
    WHERE resolved_at IS NOT NULL
      AND resolved_at < now() - interval '7 days'
      AND (p_collection_id IS NULL OR collection_id = p_collection_id)
    RETURNING 1
  )
  SELECT count(*) INTO v_archived FROM del;

  -- FIX 3: honest signal. Only the true silent-failure signature reds the run:
  -- there was work to do and absolutely nothing changed.
  IF v_eligible > 0 AND v_promoted = 0 AND v_dedup = 0 AND v_merged = 0 AND v_blocked = 0 THEN
    v_ok := false;
  END IF;

  v_run := jsonb_build_object(
    'eligible', v_eligible,
    'promoted', v_promoted,
    'deduped_already_in_sales', v_dedup,
    'merged_cross_source', v_merged,
    'blocked_insert_vanished', v_blocked,
    'still_unresolved', v_still_unres,
    'open_backlog', v_still_unres,
    'resolve_ratio', CASE WHEN v_eligible > 0
                          THEN round(v_promoted::numeric / v_eligible, 4)
                          ELSE NULL END,
    'archived', v_archived,
    'duration_ms', EXTRACT(milliseconds FROM (clock_timestamp() - v_started_at))::integer
  );

  PERFORM public.log_pipeline_run(
    'promote_unmapped_sales', v_started_at,
    p_rows_found := v_eligible,
    p_rows_written := v_promoted,
    p_ok := v_ok,
    p_collection_slug := (SELECT slug FROM public.collections WHERE id = p_collection_id),
    p_extra := v_run
  );

  RETURN v_run;
END;
$function$;

-- The tx-hash-collision class no longer exists (idx_sales_tx_nft_sold, aa609eb1),
-- so every surviving marker is stale by construction. Clearing it (and the
-- 30-day recheck horizon it carries) lets the next tick reclassify these rows
-- through the new `merged_cross_source` arm instead of leaving them parked.
UPDATE public.unmapped_sales
   SET resolution_hint = resolution_hint - 'promote_blocked' - 'promote_blocked_at' - 'promote_recheck_after'
 WHERE resolved_at IS NULL
   AND resolution_hint->>'promote_blocked' = 'sales_tx_hash_unique_collision';
-- <<< END verbatim promote_unmapped_sales <<<

-- ⚠ WHAT THIS FILE CANNOT COVER, SAID PLAINLY RATHER THAN FAKED.
-- The 2026-08-29 concurrency guard (`pg_try_advisory_xact_lock`, scoped to
-- p_collection_id) has a SKIP branch that no assertion below reaches, and none
-- can: this runner gives each test file a single psql session inside a single
-- transaction, and an advisory lock is RE-ENTRANT within one transaction — a
-- second acquisition of the same key by the same xact SUCCEEDS. Forcing the skip
-- needs a genuinely concurrent session, which this harness has no way to open.
-- Shadowing the builtin is also impossible: pg_catalog is searched first
-- implicitly, so a `public.pg_try_advisory_xact_lock` would never be chosen.
--
-- ⛔ So do NOT add an assertion here that LOOKS like it covers the skip — a test
-- whose title promises more than it checks is the vacuous shape this repo counts.
-- What actually covers it is production: the guard writes a `pipeline_runs` row
-- with `extra->>'note' = 'skipped_concurrent_run'` and rows_* NULL, exactly like
-- refresh_wmc_fmv_changed's `skipped_concurrent_refresh`. Query for those rows.
--
-- ✅ What the assertions below DO establish is the other half and it is not
-- nothing: that the guard does not break the normal path — every pre-existing
-- invariant still holds with the lock acquired at the top of BEGIN.

-- Unscoped drain so both collections are exercised in one run.
SELECT public.promote_unmapped_sales() AS run \gset

-- (1) Per-outcome accounting. 6 rows classify: 3 promote, 1 was already in
-- sales, 1 is absorbed by the dedup trigger, 1 vanishes. nftGhost and nftZero
-- never become candidates; nftBlocked is skipped by the recheck horizon.
SELECT _assert_eq((:'run'::jsonb->>'eligible'), '6', 'six resolvable rows classified');
SELECT _assert_eq((:'run'::jsonb->>'promoted'), '3', 'three rows promoted');
SELECT _assert_eq((:'run'::jsonb->>'deduped_already_in_sales'), '1', 'the same-tx+same-nft row counts as already_in_sales');
SELECT _assert_eq((:'run'::jsonb->>'merged_cross_source'), '1', 'the trigger-suppressed row counts as merged_cross_source');
SELECT _assert_eq((:'run'::jsonb->>'blocked_insert_vanished'), '1', 'only the truly unexplained row is blocked');
SELECT _assert_eq((:'run'::jsonb->>'still_unresolved'), '4', 'ghost + vanished + horizon-parked + zero-price stay unresolved');
SELECT _assert_eq((:'run'::jsonb->>'archived'), '1', 'the >7d-old resolved row is archived (deleted)');
SELECT _assert_eq((:'run'::jsonb->>'resolve_ratio'), '0.5000', 'resolve_ratio is promoted/eligible');

-- (2) Edition-resolution precedence + serial COALESCE landed in `sales`.
SELECT _assert_eq(
  (SELECT edition_id::text FROM public.sales WHERE nft_id='nftSetPlay'),
  '11111111-1111-1111-1111-111111111111', 'set:play hint wins the precedence ladder');
SELECT _assert_eq(
  (SELECT serial_number::text FROM public.sales WHERE nft_id='nftSetPlay'),
  '3', 'own serial wins when present');
SELECT _assert_eq(
  (SELECT edition_id::text FROM public.sales WHERE nft_id='nftViaMap'),
  '33333333-3333-3333-3333-333333333333', 'nft_edition_map resolves the edition');
SELECT _assert_eq(
  (SELECT serial_number::text FROM public.sales WHERE nft_id='nftViaMap'),
  '77', 'null own serial falls back to the map serial');
SELECT _assert_eq(
  (SELECT edition_id::text FROM public.sales WHERE nft_id='nftViaWmc'),
  '44444444-4444-4444-4444-444444444444', 'wallet_moments_cache resolves the edition (path 4)');
SELECT _assert_eq(
  (SELECT serial_number::text FROM public.sales WHERE nft_id='nftViaWmc'),
  '55', 'null own serial falls back to the wmc serial');

-- (3) The three promoted rows plus already_in_sales plus merged are all marked
-- resolved; the ghost and the horizon-parked row are not.
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.unmapped_sales
    WHERE nft_id IN ('nftSetPlay','nftViaMap','nftViaWmc','nftAlready','nftMerged')
      AND resolved_at IS NOT NULL),
  '5', 'promoted + already_in_sales + merged rows are all marked resolved_at');
SELECT _assert_eq(
  (SELECT resolved_at IS NULL FROM public.unmapped_sales WHERE nft_id='nftGhost')::text,
  'true', 'the unresolvable ghost keeps resolved_at NULL');

-- (4) THE REGRESSION PIN (2026-07-31): a trigger-suppressed row is resolved, not
-- blocked, and it produced no duplicate sale — the twin absorbed its buyer and
-- serial instead.
SELECT _assert_eq(
  (SELECT resolved_at IS NOT NULL FROM public.unmapped_sales WHERE nft_id='nftMerged')::text,
  'true', 'the trigger-suppressed row is marked resolved, not parked');
-- COALESCE because an untouched row's resolution_hint is NULL, and `NULL ? key`
-- is NULL, not false.
SELECT _assert_eq(
  (SELECT COALESCE(resolution_hint ? 'promote_blocked', false)::text FROM public.unmapped_sales WHERE nft_id='nftMerged'),
  'false', 'the trigger-suppressed row carries NO promote_blocked marker');
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.sales WHERE nft_id='nftMerged'),
  '1', 'the merge produced no duplicate sale row');
SELECT _assert_eq(
  (SELECT buyer_address FROM public.sales WHERE nft_id='nftMerged'),
  '0xbuyerfromincoming', 'the surviving twin absorbed the incoming buyer');
SELECT _assert_eq(
  (SELECT serial_number::text FROM public.sales WHERE nft_id='nftMerged'),
  '12', 'the surviving twin absorbed the incoming serial');

-- (5) The genuinely-unexplained row is parked, and the marker says what it means.
SELECT _assert_eq(
  (SELECT resolution_hint->>'promote_blocked' FROM public.unmapped_sales WHERE nft_id='nftVanish'),
  'sales_insert_vanished_unexplained', 'the ELSE arm no longer claims a tx-hash collision');
SELECT _assert_eq(
  (SELECT (resolution_hint ? 'promote_recheck_after')::text FROM public.unmapped_sales WHERE nft_id='nftVanish'),
  'true', 'a blocked row carries a recheck horizon');
SELECT _assert_eq(
  (SELECT resolved_at IS NULL FROM public.unmapped_sales WHERE nft_id='nftVanish')::text,
  'true', 'a blocked row is NOT marked resolved');

-- (6) Guards: the ghost never became a sale; the 0-price row never entered
-- sales; the horizon-parked row was not touched.
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.sales WHERE nft_id='nftGhost'),
  '0', 'an unresolved row never lands in sales');
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.sales WHERE nft_id='nftZero'),
  '0', 'a 0-price row never lands in sales (it would pollute FMV)');
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.sales WHERE nft_id='nftBlocked'),
  '0', 'a row behind a future recheck horizon is not re-examined');
SELECT _assert_eq(
  (SELECT resolution_hint->>'promote_blocked' FROM public.unmapped_sales WHERE nft_id='nftBlocked'),
  'sales_insert_vanished_unexplained', 'the horizon-parked row keeps its original marker');

SELECT '✓ promote_unmapped_sales invariants pass' AS result;
ROLLBACK;
