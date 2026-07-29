-- DB invariant: public.get_pack_detail_bundle — the pack detail-page read (pack
-- row, dist fallback, corrected AllDay EV, hero editions, has_pool). The hero
-- strip's hit_probability drives what a buyer thinks a pack can pull, so its
-- normalization and the drop_weight>0 pool gate are load-bearing.
--
-- Pins (standard / non-AllDay path):
--   * pack_row + dist_fallback are surfaced;
--   * hero_editions = top-5 pool editions by latest FMV (fmv>0), each carrying
--     hit_probability = drop_weight / SUM(all drop_weight>0 in the pool) — so the
--     probabilities are shares of the WHOLE pool, not of the top-5;
--   * a zero-weight edition never enters the pool (drop_weight>0 gate);
--   * has_pool reflects whether any positive-weight pool row exists.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260725010200_audit_20260725_get_pack_detail_bundle_hero_fast.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- The AllDay branch reads v_allday_pack_info; we drive the non-AllDay path, so
-- defer body validation rather than fixture that view. The embedded DDL is
-- byte-verified against live, so it is valid.
SET LOCAL check_function_bodies = off;

-- ── minimal fixtures ─────────────────────────────────────────────────────────
CREATE TABLE public.pack_table_rows (collection_id uuid, dist_id text, label text);
CREATE TABLE public.pack_distributions (
  collection_id uuid, dist_id text, metadata jsonb, image_url text, title text);
CREATE TABLE public.pack_drop_pool (
  collection_id uuid, dist_id text, edition_id uuid, drop_weight numeric);
CREATE TABLE public.editions (
  id uuid PRIMARY KEY, external_id text, player_name text, set_name text,
  tier text, thumbnail_url text);
CREATE TABLE public.fmv_snapshots (edition_id uuid, fmv_usd numeric, computed_at timestamptz);
CREATE TABLE public.wallet_moments_cache (
  collection_id uuid, edition_key text, moment_id text);

-- >>> BEGIN verbatim get_pack_detail_bundle (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.get_pack_detail_bundle(p_collection_id uuid, p_dist_id text, p_collection_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
declare
  v_pack_row      jsonb;
  v_dist_fallback jsonb;
  v_corrected_ev  jsonb;
  v_hero          jsonb;
  v_has_pool      boolean;
begin
  select to_jsonb(t) into v_pack_row
  from public.pack_table_rows t
  where t.collection_id = p_collection_id and t.dist_id = p_dist_id
  limit 1;

  select jsonb_build_object('metadata', d.metadata, 'image_url', d.image_url, 'title', d.title)
    into v_dist_fallback
  from public.pack_distributions d
  where d.collection_id = p_collection_id and d.dist_id = p_dist_id
  limit 1;

  -- AllDay corrected EV (odds/median-robust cross-check) — AllDay only.
  if p_collection_slug = 'nfl-all-day' then
    select jsonb_build_object(
             'corrected_gross_ev', v.corrected_gross_ev,
             'corrected_net_ev', v.corrected_net_ev,
             'corrected_value_ratio', v.corrected_value_ratio,
             'ev_method', v.ev_method,
             'has_published_odds', v.has_published_odds,
             'stale_value_share_pct', v.stale_value_share_pct,
             'low_confidence_ev', v.low_confidence_ev,
             'opened_count', v.opened_count,
             'packnft_total', v.packnft_total,
             'opened_pct_of_minted', v.opened_pct_of_minted
           )
      into v_corrected_ev
    from public.v_allday_pack_info v
    where v.dist_id = p_dist_id
    limit 1;
  end if;

  -- Top-5 pool editions by FMV — powers the hero montage + Top-pulls strip.
  -- Optimized (see migration header): score FMV once/edition in a MATERIALIZED
  -- CTE, fold total_weight over the same set, then join editions + the rep-nft
  -- lookup only for the final 5 rows.
  with scored as materialized (
    select pdp.edition_id, pdp.drop_weight,
           (select fs.fmv_usd from public.fmv_snapshots fs
              where fs.edition_id = pdp.edition_id order by fs.computed_at desc limit 1) as fmv_usd
    from public.pack_drop_pool pdp
    where pdp.collection_id = p_collection_id and pdp.dist_id = p_dist_id
      and pdp.drop_weight > 0
  ),
  tw as (
    select nullif(sum(drop_weight), 0) as total_weight from scored
  ),
  top5 as (
    select edition_id, drop_weight, fmv_usd
    from scored
    where fmv_usd is not null and fmv_usd > 0
    order by fmv_usd desc
    limit 5
  )
  select coalesce(jsonb_agg(row_to_json(h)::jsonb order by h.fmv_usd desc), '[]'::jsonb)
    into v_hero
  from (
    select coalesce(e.external_id, e.id::text) as route_slug,
           e.player_name, e.set_name, e.tier::text as tier, e.thumbnail_url,
           (select w.moment_id from public.wallet_moments_cache w
              where w.collection_id = p_collection_id and w.edition_key = e.external_id
                and w.moment_id ~ '^[0-9]+$' limit 1) as rep_nft_id,
           t.fmv_usd::float8 as fmv_usd,
           (t.drop_weight / tw.total_weight)::float8 as hit_probability
    from top5 t
    cross join tw
    join public.editions e on e.id = t.edition_id
  ) h;

  select exists(
    select 1 from public.pack_drop_pool
    where collection_id = p_collection_id and dist_id = p_dist_id and drop_weight > 0
  ) into v_has_pool;

  return jsonb_build_object(
    'pack_row', v_pack_row,
    'dist_fallback', v_dist_fallback,
    'corrected_ev', v_corrected_ev,
    'hero_editions', coalesce(v_hero, '[]'::jsonb),
    'has_pool', coalesce(v_has_pool, false)
  );
end;
$function$;
-- <<< END verbatim get_pack_detail_bundle <<<

\set TS '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''
\set eA '''aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'''
\set eB '''bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'''
\set eC '''cccccccc-cccc-cccc-cccc-cccccccccccc'''
\set eD '''dddddddd-dddd-dddd-dddd-dddddddddddd'''

INSERT INTO public.pack_table_rows (collection_id, dist_id, label) VALUES (:TS::uuid, 'd1', 'Pack One');
INSERT INTO public.pack_distributions (collection_id, dist_id, metadata, image_url, title) VALUES
  (:TS::uuid, 'd1', '{"retail_price_usd":10}'::jsonb, 'img', 'Pack One');

INSERT INTO public.editions (id, external_id, player_name, set_name, tier, thumbnail_url) VALUES
  (:eA::uuid, '1:1', 'Dame', 'Base', 'RARE',  'tA'),
  (:eB::uuid, '2:2', 'Ant',  'Base', 'COMMON','tB'),
  (:eC::uuid, '3:3', 'Book', 'Base', 'COMMON','tC'),
  (:eD::uuid, '4:4', 'Zero', 'Base', 'COMMON','tD');

-- pool: A/B/C positive weight (total 1.0); D zero-weight -> excluded everywhere.
INSERT INTO public.pack_drop_pool (collection_id, dist_id, edition_id, drop_weight) VALUES
  (:TS::uuid, 'd1', :eA::uuid, 0.5),
  (:TS::uuid, 'd1', :eB::uuid, 0.3),
  (:TS::uuid, 'd1', :eC::uuid, 0.2),
  (:TS::uuid, 'd1', :eD::uuid, 0);

INSERT INTO public.fmv_snapshots (edition_id, fmv_usd, computed_at) VALUES
  (:eA::uuid, 100, now()), (:eB::uuid, 50, now()), (:eC::uuid, 25, now()), (:eD::uuid, 999, now());

-- ── 1. pack_row + has_pool ───────────────────────────────────────────────────
SELECT _assert(public.get_pack_detail_bundle(:TS::uuid,'d1','nba-top-shot') -> 'pack_row' <> 'null'::jsonb, 'pack_row surfaced');
SELECT _assert_eq((public.get_pack_detail_bundle(:TS::uuid,'d1','nba-top-shot') ->> 'has_pool'), 'true', 'has_pool true when positive-weight rows exist');

-- ── 2. hero_editions: top-5 by FMV, zero-weight D excluded ───────────────────
SELECT _assert_eq(jsonb_array_length(public.get_pack_detail_bundle(:TS::uuid,'d1','nba-top-shot') -> 'hero_editions')::text, '3', 'hero_editions = 3 (zero-weight D excluded)');
SELECT _assert_eq((public.get_pack_detail_bundle(:TS::uuid,'d1','nba-top-shot') -> 'hero_editions' -> 0 ->> 'player_name'), 'Dame', 'top hero is highest FMV (Dame)');

-- ── 3. hit_probability = share of the WHOLE pool (0.5 / 1.0) ──────────────────
SELECT _assert_eq((public.get_pack_detail_bundle(:TS::uuid,'d1','nba-top-shot') -> 'hero_editions' -> 0 ->> 'hit_probability'), '0.5', 'hit_probability = drop_weight / total pool weight');

-- ── 4. no-pool dist -> has_pool false, hero empty ────────────────────────────
SELECT _assert_eq((public.get_pack_detail_bundle(:TS::uuid,'d-none','nba-top-shot') ->> 'has_pool'), 'false', 'unknown dist -> has_pool false');
SELECT _assert_eq((public.get_pack_detail_bundle(:TS::uuid,'d-none','nba-top-shot') -> 'hero_editions')::text, '[]', 'unknown dist -> hero_editions []');

SELECT '✓ get_pack_detail_bundle: all assertions passed' AS result;

ROLLBACK;
