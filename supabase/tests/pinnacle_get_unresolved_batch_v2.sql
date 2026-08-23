-- DB invariant: public.pinnacle_get_unresolved_batch_v2 — the Pinnacle NFT
-- resolver's candidate feed, read every run by supabase/functions/pinnacle-nft-resolver.
--
-- WHY IT MATTERS. This function decides WHICH Pins get an edition. Everything
-- downstream of a resolved Pin — FMV coverage, a nameable sale, a nameable trade
-- — is gated on appearing here, and a Pin that never appears is invisible
-- forever while every pipeline reports healthy. That is exactly how traded Pins
-- sat at 7.8% resolved against sales at 68.9% until 2026-08-22: the function
-- read `pinnacle_sales` and `wallet_moments_cache` only, so a Pin that had only
-- ever TRADED was outside its population BY CONSTRUCTION.
--
-- ⚠ THE PROPERTY MOST LIKELY TO REGRESS SILENTLY IS LEG **ORDER**, WHICH IS WHY
-- IT IS PINNED FIRST. The batch is capped at `p_limit` and the outer LIMIT
-- truncates from the BOTTOM, so the UNION ALL order IS the priority:
--
--     sales (buyer hint) → sales_owner (ownership hint) → trades → wmc
--
-- A resolved SALE feeds FMV, the roadmap's headline metric. A resolved TRADE
-- does not. Reordering these legs — or switching to a plain UNION, which does
-- not preserve order — would silently starve pricing to resolve trades, with no
-- error and no count anywhere going red.
--
-- THE OTHER PROPERTIES:
--   1. Every hint is NON-NULL. A row with a null hint is a wasted batch slot:
--      the resolver counts it as `no_hint_skipped` and resolves nothing.
--   2. One nft_id consumes ONE slot. Each leg dedupes against every prior leg,
--      so a Pin that is simultaneously an unresolved sale, an unresolved trade
--      and an unmapped wmc holding cannot eat three slots of a limited batch.
--   3. A sale with a buyer hint is offered ONCE and keeps the BUYER hint.
--      ⚠ Its `buyer_address IS NULL` clause is an intent marker, NOT the
--      enforcer — mutation testing proved removing it changes no output, because
--      the cross-leg dedup plus the shared `LIMIT p_limit` already make the
--      poaching state unreachable. Section 5 explains it in full. Do not "fix"
--      this by strengthening the assertion; the property is genuinely enforced
--      elsewhere.
--   4. A Pin already in `pinnacle_nft_map` is not offered by the trade or wmc
--      legs — the map is the resolver's output, so re-offering it is a loop.
--      ⚠ The SALES legs deliberately do NOT check the map: a sale row can be
--      unresolved while the map covers the nft, and closing that is the
--      PROMOTION step's job (backfill_pinnacle_sale_editions), not the
--      resolver's. Asserted so nobody "fixes" the asymmetry.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260822220000_pinnacle_resolver_ownership_hint_leg.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.collections (id uuid, slug text);
CREATE TABLE public.pinnacle_sales (
  nft_id text, edition_id text, buyer_address text, sold_at timestamptz
);
CREATE TABLE public.pinnacle_ownership_snapshots (nft_id text, owner text);
CREATE TABLE public.pinnacle_trade_events (
  nft_id text, edition_id text, to_wallet text, traded_at timestamptz
);
CREATE TABLE public.pinnacle_nft_map (nft_id text, edition_key text);
CREATE TABLE public.wallet_moments_cache (
  moment_id text, wallet_address text, collection_id uuid
);

\set PIN '''7dd9dd11-e8b6-45c4-ac99-71331f959714'''
INSERT INTO public.collections (id, slug) VALUES (:PIN::uuid, 'disney_pinnacle');

-- >>> BEGIN verbatim pinnacle_get_unresolved_batch_v2 (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.pinnacle_get_unresolved_batch_v2(p_limit integer DEFAULT 50)
 RETURNS TABLE(nft_id text, source text, hint_address text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH
  sales_targets AS (
    SELECT DISTINCT ON (ps.nft_id)
      ps.nft_id,
      'sales'::text AS source,
      ps.buyer_address AS hint_address,
      ps.sold_at
    FROM pinnacle_sales ps
    WHERE ps.edition_id IS NULL
      AND ps.nft_id IS NOT NULL
      AND ps.buyer_address IS NOT NULL
    ORDER BY ps.nft_id, ps.sold_at DESC
    LIMIT p_limit
  ),
  sales_owner_targets AS (
    SELECT DISTINCT ON (ps.nft_id)
      ps.nft_id,
      'sales_owner'::text AS source,
      o.owner AS hint_address,
      ps.sold_at
    FROM pinnacle_sales ps
    JOIN pinnacle_ownership_snapshots o ON o.nft_id = ps.nft_id
    WHERE ps.edition_id IS NULL
      AND ps.nft_id IS NOT NULL
      AND ps.buyer_address IS NULL
      AND o.owner IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM sales_targets st WHERE st.nft_id = ps.nft_id)
    ORDER BY ps.nft_id, ps.sold_at DESC
    LIMIT p_limit
  ),
  trade_targets AS (
    SELECT DISTINCT ON (t.nft_id)
      t.nft_id,
      'trade'::text AS source,
      t.to_wallet AS hint_address,
      t.traded_at
    FROM pinnacle_trade_events t
    WHERE t.edition_id IS NULL
      AND t.nft_id IS NOT NULL
      AND t.to_wallet IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM pinnacle_nft_map m WHERE m.nft_id = t.nft_id)
      AND NOT EXISTS (SELECT 1 FROM sales_targets st WHERE st.nft_id = t.nft_id)
      AND NOT EXISTS (SELECT 1 FROM sales_owner_targets so WHERE so.nft_id = t.nft_id)
    ORDER BY t.nft_id, t.traded_at DESC
    LIMIT p_limit
  ),
  wmc_targets AS (
    SELECT
      wmc.moment_id AS nft_id,
      'wmc'::text AS source,
      wmc.wallet_address AS hint_address
    FROM wallet_moments_cache wmc
    WHERE wmc.collection_id = (SELECT id FROM collections WHERE slug = 'disney_pinnacle')
      AND NOT EXISTS (SELECT 1 FROM pinnacle_nft_map m WHERE m.nft_id = wmc.moment_id)
      AND NOT EXISTS (SELECT 1 FROM sales_targets st WHERE st.nft_id = wmc.moment_id)
      AND NOT EXISTS (SELECT 1 FROM sales_owner_targets so WHERE so.nft_id = wmc.moment_id)
      AND NOT EXISTS (SELECT 1 FROM trade_targets tt WHERE tt.nft_id = wmc.moment_id)
    LIMIT p_limit
  )
  SELECT nft_id, source, hint_address FROM sales_targets
  UNION ALL
  SELECT nft_id, source, hint_address FROM sales_owner_targets
  UNION ALL
  SELECT nft_id, source, hint_address FROM trade_targets
  UNION ALL
  SELECT nft_id, source, hint_address FROM wmc_targets
  LIMIT p_limit;
$function$;
-- <<< END verbatim pinnacle_get_unresolved_batch_v2 <<<

-- One candidate of each kind, all distinct Pins.
INSERT INTO public.pinnacle_sales (nft_id, edition_id, buyer_address, sold_at) VALUES
  ('s1', NULL, '0xBUYER1', '2026-05-01T00:00:00Z'),   -- sales leg
  ('s2', NULL, NULL,       '2026-05-02T00:00:00Z'),   -- sales_owner leg (owner known)
  ('s3', NULL, NULL,       '2026-05-03T00:00:00Z'),   -- NULL buyer AND no owner -> invisible
  ('s4', 'ed-4', '0xBUYER4','2026-05-04T00:00:00Z');  -- already resolved -> never offered
INSERT INTO public.pinnacle_ownership_snapshots (nft_id, owner) VALUES ('s2', '0xOWNER2');
INSERT INTO public.pinnacle_trade_events (nft_id, edition_id, to_wallet, traded_at) VALUES
  ('t1', NULL, '0xTAKER1', '2026-05-05T00:00:00Z'),   -- trade leg
  ('t2', NULL, '0xTAKER2', '2026-05-06T00:00:00Z');   -- already mapped -> not offered
INSERT INTO public.pinnacle_nft_map (nft_id, edition_key) VALUES ('t2', 'ed-t2');
INSERT INTO public.wallet_moments_cache (moment_id, wallet_address, collection_id) VALUES
  ('w1', '0xHOLDER1', :PIN::uuid),                    -- wmc leg
  ('x1', '0xHOLDER9', '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid);  -- other collection

-- ── 1. LEG ORDER IS THE PRIORITY ────────────────────────────────────────────
-- ⚠ THE ASSERTION THIS FILE EXISTS FOR. The outer LIMIT truncates from the
-- bottom, so order decides who gets a scarce slot. Pricing must outrank trades.
SELECT _assert_eq(
  (SELECT string_agg(source, '>' ORDER BY ord)
     FROM (SELECT source, row_number() OVER () ord
             FROM public.pinnacle_get_unresolved_batch_v2(50)) q),
  'sales>sales_owner>trade>wmc',
  'legs are emitted sales > sales_owner > trade > wmc — a resolved SALE feeds FMV, a resolved TRADE does not'
);

-- The order claim above is only meaningful if the LIMIT actually bites, so prove
-- truncation drops from the BOTTOM: at p_limit=2 only the two sales legs survive.
SELECT _assert_eq(
  (SELECT string_agg(source, ',' ORDER BY source)
     FROM public.pinnacle_get_unresolved_batch_v2(2)),
  'sales,sales_owner',
  'a tight limit keeps the PRICING legs and drops trade/wmc — truncation is from the bottom'
);

SELECT _assert_eq(
  (SELECT count(*)::text FROM public.pinnacle_get_unresolved_batch_v2(1)),
  '1',
  'p_limit is respected exactly'
);

-- ── 2. EVERY HINT IS NON-NULL ───────────────────────────────────────────────
-- A null hint is a wasted slot: the resolver skips it as `no_hint_skipped`.
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.pinnacle_get_unresolved_batch_v2(50) WHERE hint_address IS NULL),
  '0',
  'no candidate is offered without a hint address'
);

SELECT _assert_eq(
  (SELECT hint_address FROM public.pinnacle_get_unresolved_batch_v2(50) WHERE nft_id = 's2'),
  '0xOWNER2',
  'the sales_owner leg hints with the ownership snapshot, not a null buyer'
);

-- ── 3. WHAT MUST NOT BE OFFERED ─────────────────────────────────────────────
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.pinnacle_get_unresolved_batch_v2(50) WHERE nft_id = 's4'),
  '0',
  'an already-resolved sale is never offered'
);
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.pinnacle_get_unresolved_batch_v2(50) WHERE nft_id = 's3'),
  '0',
  'a sale with neither a buyer nor a known owner has no hint and is not offered'
);
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.pinnacle_get_unresolved_batch_v2(50) WHERE nft_id = 't2'),
  '0',
  'a trade whose Pin is already in pinnacle_nft_map is not re-offered — the map is the output'
);
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.pinnacle_get_unresolved_batch_v2(50) WHERE nft_id = 'x1'),
  '0',
  'the wmc leg is scoped to Disney Pinnacle'
);

-- ── 4. ONE PIN, ONE SLOT ────────────────────────────────────────────────────
-- ⚠ The same Pin is an unresolved sale, an unresolved trade AND an unmapped wmc
-- holding. Without the cross-leg NOT EXISTS chain it would eat three slots of a
-- limited batch, starving three other Pins — and every count would still look
-- healthy.
INSERT INTO public.pinnacle_sales (nft_id, edition_id, buyer_address, sold_at)
  VALUES ('dup', NULL, '0xBUYERD', '2026-05-07T00:00:00Z');
INSERT INTO public.pinnacle_trade_events (nft_id, edition_id, to_wallet, traded_at)
  VALUES ('dup', NULL, '0xTAKERD', '2026-05-08T00:00:00Z');
INSERT INTO public.wallet_moments_cache (moment_id, wallet_address, collection_id)
  VALUES ('dup', '0xHOLDERD', :PIN::uuid);

SELECT _assert_eq(
  (SELECT count(*)::text FROM public.pinnacle_get_unresolved_batch_v2(50) WHERE nft_id = 'dup'),
  '1',
  'a Pin appearing in three populations consumes exactly ONE batch slot'
);
SELECT _assert_eq(
  (SELECT source FROM public.pinnacle_get_unresolved_batch_v2(50) WHERE nft_id = 'dup'),
  'sales',
  'and it is claimed by the HIGHEST-priority leg that can see it'
);

-- ── 5. A SALE WITH A BUYER HINT KEEPS IT, AND IS OFFERED ONCE ───────────────
-- ⚠ READ THE NEXT PARAGRAPH BEFORE STRENGTHENING THIS. Mutation testing found
-- these two assertions do NOT catch removal of `sales_owner_targets`'s
-- `ps.buyer_address IS NULL` clause — the mutant stays GREEN — and that is
-- recorded here rather than papered over, because a comfortable assertion that
-- catches nothing is the defect class this repo tracks hardest.
--
-- The reason is worth knowing: the clause is REDUNDANT GIVEN THE DEDUP and
-- cannot change the output. `sales_owner_targets` already excludes anything in
-- `sales_targets`, and `sales_targets` carries the SAME `LIMIT p_limit` as the
-- outer query — so either every buyer-hint sale fits in `sales_targets` (and the
-- dedup excludes them all), or `sales_targets` alone fills the batch and nothing
-- below it is visible anyway. There is no reachable state where a buyer-hint
-- sale could be claimed by the ownership leg. The clause stays as an intent
-- marker; the DEDUP is the enforcer.
--
-- What these two DO pin is the observable contract, which is worth pinning on
-- its own: the higher-priority leg claims the Pin, and the hint that reaches the
-- resolver is the buyer's, not the owner snapshot's.
INSERT INTO public.pinnacle_ownership_snapshots (nft_id, owner) VALUES ('s1', '0xOWNER1');
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.pinnacle_get_unresolved_batch_v2(50) WHERE nft_id = 's1'),
  '1',
  'a sale with a buyer hint is offered ONCE even when an owner snapshot also exists'
);
SELECT _assert_eq(
  (SELECT hint_address FROM public.pinnacle_get_unresolved_batch_v2(50) WHERE nft_id = 's1'),
  '0xBUYER1',
  'and the hint that reaches the resolver is the BUYER, not the ownership snapshot'
);
-- The mutation that DOES break this pair is removing the cross-leg dedup, which
-- section 4 already covers — proved: dropping it reds "consumes exactly ONE
-- batch slot".)

ROLLBACK;
