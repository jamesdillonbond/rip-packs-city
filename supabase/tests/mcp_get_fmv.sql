-- DB invariant: public.mcp_get_fmv — the concierge/MCP FMV lookup. Given an
-- edition key + collection slug (+ optional serial) it returns a jsonb estimate
-- from the latest fmv_snapshots row, with a `gaps` array flagging missing
-- signals. This is money math shown to users through the AI concierge, so the
-- pins that matter are: the input guards return a typed `error` (never a
-- fabricated price), the serial-multiplier LADDER (1→12x, ≤10→4.5x, ≤23→2.8x,
-- else 1.0x) and adjusted_fmv = fmv × mult, latest-snapshot-wins, and the gaps
-- flags (no-snapshot, missing asks, the Pinnacle direct-ask caveat). A silent
-- mis-order of the ladder or a swallowed guard misprices every serial lookup.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260711185416_audit_20260711_fmv_snapshots_rename_wap_to_asp.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- ── minimal fixtures (only the columns the function reads) ────────────────────
-- confidence is the fmv_confidence enum in prod; the function only reads it as
-- ::text, so a plain text column is faithful and keeps the test self-contained.
CREATE TABLE public.collections (id uuid PRIMARY KEY, slug text);
CREATE TABLE public.editions (id uuid PRIMARY KEY, collection_id uuid, external_id text);
CREATE TABLE public.fmv_snapshots (
  edition_id uuid, computed_at timestamptz,
  fmv_usd numeric, asp_usd numeric, asp_without_outliers numeric,
  floor_price_usd numeric, ask_proxy_fmv numeric,
  sales_count_7d integer, sales_count_30d integer, unique_buyers_30d integer,
  days_since_sale integer, top_shot_ask numeric, flowty_ask numeric,
  cross_market_ask numeric, liquidity_rating text, confidence text,
  algo_version text);

INSERT INTO public.collections (id, slug) VALUES
  ('11111111-1111-1111-1111-111111111111', 'nba_top_shot'),
  ('22222222-2222-2222-2222-222222222222', 'disney_pinnacle');
INSERT INTO public.editions (id, collection_id, external_id) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', '73:2785'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'p:1');
-- edition 'cccc' exists but has NO snapshot (gaps path); pinnacle edition too.
INSERT INTO public.editions (id, collection_id, external_id) VALUES
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '11111111-1111-1111-1111-111111111111', '99:1');
-- two snapshots for the TS edition — the LATER computed_at must win.
INSERT INTO public.fmv_snapshots
  (edition_id, computed_at, fmv_usd, top_shot_ask, flowty_ask, liquidity_rating, confidence)
VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2026-07-01', 50, 55, 60, 'HIGH', 'MEDIUM'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2026-07-20', 100, 110, 120, 'HIGH', 'HIGH');

-- >>> BEGIN verbatim mcp_get_fmv (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.mcp_get_fmv(p_edition_key text, p_collection_slug text, p_serial integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_slug text := lower(trim(p_collection_slug));
  v_collection_id uuid;
  v_edition_id uuid;
  v_snap public.fmv_snapshots%rowtype;
  v_gaps text[] := array[]::text[];
  v_serial_mult numeric;
  v_adjusted numeric;
begin
  if p_edition_key is null or p_edition_key = '' then
    return jsonb_build_object('error', 'edition_key_required',
                              'gaps', to_jsonb(array['edition_key_required']));
  end if;

  select id into v_collection_id from public.collections where slug = v_slug;
  if v_collection_id is null then
    return jsonb_build_object('error', 'unknown_collection_slug',
                              'collection_slug', v_slug,
                              'gaps', to_jsonb(array['unknown_collection_slug_' || coalesce(v_slug,'null')]));
  end if;

  select id into v_edition_id from public.editions
   where collection_id = v_collection_id and external_id = p_edition_key;
  if v_edition_id is null then
    return jsonb_build_object('error', 'edition_not_found',
                              'edition_key', p_edition_key,
                              'collection_slug', v_slug,
                              'gaps', to_jsonb(array['edition_not_found_' || p_edition_key]));
  end if;

  select * into v_snap from public.fmv_snapshots
   where edition_id = v_edition_id
   order by computed_at desc
   limit 1;

  v_gaps := array_append(v_gaps, 'percentile_distribution_not_persisted');
  if v_snap.edition_id is null then
    v_gaps := array_append(v_gaps, 'no_fmv_snapshot_for_edition');
  end if;
  if v_snap.top_shot_ask is null then
    v_gaps := array_append(v_gaps, 'top_shot_ask_unavailable');
  end if;
  if v_snap.flowty_ask is null then
    v_gaps := array_append(v_gaps, 'flowty_ask_unavailable');
  end if;
  if v_snap.liquidity_rating is null then
    v_gaps := array_append(v_gaps, 'liquidity_rating_unavailable');
  end if;
  if v_slug = 'disney_pinnacle' then
    v_gaps := array_append(v_gaps, 'pinnacle_direct_ask_not_yet_in_fmv_snapshots');
  end if;

  if p_serial is not null then
    v_serial_mult := case
      when p_serial = 1 then 12.0
      when p_serial <= 10 then 4.5
      when p_serial <= 23 then 2.8
      else 1.0
    end;
    v_adjusted := coalesce(v_snap.fmv_usd, 0) * v_serial_mult;
  end if;

  return jsonb_build_object(
    'edition_id', v_edition_id,
    'collection_slug', v_slug,
    'external_id', p_edition_key,
    'fmv_usd', v_snap.fmv_usd,
    'wap_usd', v_snap.asp_usd,
    'wap_without_outliers', v_snap.asp_without_outliers,
    'floor_price_usd', v_snap.floor_price_usd,
    'ask_proxy_fmv', v_snap.ask_proxy_fmv,
    'sales_count_7d', v_snap.sales_count_7d,
    'sales_count_30d', v_snap.sales_count_30d,
    'unique_buyers_30d', v_snap.unique_buyers_30d,
    'days_since_sale', v_snap.days_since_sale,
    'top_shot_ask', v_snap.top_shot_ask,
    'flowty_ask', v_snap.flowty_ask,
    'cross_market_ask', v_snap.cross_market_ask,
    'liquidity_rating', v_snap.liquidity_rating,
    'confidence', v_snap.confidence::text,
    'algo_version', v_snap.algo_version,
    'computed_at', v_snap.computed_at,
    'serial', p_serial,
    'serial_mult', v_serial_mult,
    'adjusted_fmv', v_adjusted,
    'gaps', to_jsonb(v_gaps)
  );
end;
$function$;
-- <<< END verbatim mcp_get_fmv <<<

-- ── input guards return a typed error, never a price ─────────────────────────
SELECT _assert_eq(
  public.mcp_get_fmv(NULL, 'nba_top_shot') ->> 'error', 'edition_key_required',
  'null edition_key → edition_key_required');
SELECT _assert_eq(
  public.mcp_get_fmv('', 'nba_top_shot') ->> 'error', 'edition_key_required',
  'empty edition_key → edition_key_required');
SELECT _assert_eq(
  public.mcp_get_fmv('73:2785', 'no_such_collection') ->> 'error', 'unknown_collection_slug',
  'unknown slug → unknown_collection_slug');
SELECT _assert_eq(
  public.mcp_get_fmv('does:not:exist', 'nba_top_shot') ->> 'error', 'edition_not_found',
  'unknown edition_key → edition_not_found');
-- the slug is lower/trim-normalized before the lookup
SELECT _assert_eq(
  public.mcp_get_fmv('73:2785', '  NBA_TOP_SHOT ') ->> 'error', NULL,
  'slug is lower+trim normalized → resolves, no error');

-- ── latest snapshot wins ─────────────────────────────────────────────────────
SELECT _assert_eq(
  public.mcp_get_fmv('73:2785', 'nba_top_shot') ->> 'fmv_usd', '100',
  'latest computed_at snapshot wins (100, not the older 50)');
SELECT _assert_eq(
  public.mcp_get_fmv('73:2785', 'nba_top_shot') ->> 'confidence', 'HIGH',
  'confidence returned from the latest snapshot');

-- ── serial-multiplier ladder + adjusted_fmv = fmv × mult ─────────────────────
SELECT _assert_eq(public.mcp_get_fmv('73:2785','nba_top_shot', 1)  ->> 'serial_mult', '12.0', 'serial #1 → 12x');
SELECT _assert_eq(public.mcp_get_fmv('73:2785','nba_top_shot', 1)  ->> 'adjusted_fmv', '1200.0', 'serial #1 adjusted = 100 × 12');
SELECT _assert_eq(public.mcp_get_fmv('73:2785','nba_top_shot', 10) ->> 'serial_mult', '4.5',  'serial ≤10 → 4.5x');
SELECT _assert_eq(public.mcp_get_fmv('73:2785','nba_top_shot', 23) ->> 'serial_mult', '2.8',  'serial ≤23 → 2.8x');
SELECT _assert_eq(public.mcp_get_fmv('73:2785','nba_top_shot', 24) ->> 'serial_mult', '1.0',  'serial >23 → 1.0x');
-- no serial passed → no multiplier, no adjusted_fmv
SELECT _assert(
  (public.mcp_get_fmv('73:2785','nba_top_shot') ->> 'serial_mult') IS NULL,
  'no serial → serial_mult null (no adjustment applied)');

-- ── gaps flags ───────────────────────────────────────────────────────────────
-- a priced edition still always flags the not-persisted percentile distribution
SELECT _assert(
  public.mcp_get_fmv('73:2785','nba_top_shot') -> 'gaps' ? 'percentile_distribution_not_persisted',
  'gaps always include percentile_distribution_not_persisted');
-- an edition with no snapshot flags no_fmv_snapshot_for_edition and returns null fmv
SELECT _assert(
  public.mcp_get_fmv('99:1','nba_top_shot') -> 'gaps' ? 'no_fmv_snapshot_for_edition',
  'edition with no snapshot → no_fmv_snapshot_for_edition gap');
SELECT _assert(
  (public.mcp_get_fmv('99:1','nba_top_shot') ->> 'fmv_usd') IS NULL,
  'edition with no snapshot → fmv_usd null (no fabricated price)');
-- missing asks are flagged individually (the pinnacle edition has none)
SELECT _assert(
  public.mcp_get_fmv('p:1','disney_pinnacle') -> 'gaps' ? 'top_shot_ask_unavailable',
  'missing top_shot_ask flagged');
-- Pinnacle carries its direct-ask caveat
SELECT _assert(
  public.mcp_get_fmv('p:1','disney_pinnacle') -> 'gaps' ? 'pinnacle_direct_ask_not_yet_in_fmv_snapshots',
  'disney_pinnacle slug → pinnacle direct-ask caveat gap');

SELECT '✓ mcp_get_fmv: all assertions passed' AS result;

ROLLBACK;
