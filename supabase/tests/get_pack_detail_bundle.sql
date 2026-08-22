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
-- Pins (AllDay path, added 2026-08-09 with the lean-view repoint):
--   * the corrected_ev block is populated ONLY for p_collection_slug='nfl-all-day';
--   * it is sourced from v_allday_pack_detail_ev, so a future edit that points the
--     branch back at the fat v_allday_pack_info (or at nothing) fails here;
--   * opened_pct_of_minted is CLAMPED at 100 even when opened_count > total_minted,
--     which is the whole reason that expression carries a LEAST().
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260809170000_audit_20260809_allday_pack_detail_ev_lean_view.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

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

-- AllDay corrected-EV source, reproduced as a REAL VIEW over fixture base tables
-- (not stubbed as a table) so the opened_pct_of_minted expression is actually
-- evaluated here — live data never exercises its LEAST() clamp (measured
-- 2026-08-09: 0 AllDay dists have opened_count > total_minted), so this is the
-- only place that branch is covered.
--
-- ⚠ This view copy is NOT drift-guarded: db-invariants-drift-guard.test.ts matches
-- `CREATE OR REPLACE FUNCTION public.<name>` only, so it compares the FUNCTION
-- below and nothing else. If v_allday_pack_detail_ev changes in
-- 20260809170000_audit_20260809_allday_pack_detail_ev_lean_view.sql, update this
-- copy by hand — nothing will fail for you.
CREATE TABLE public.allday_pack_supply (
  dist_id text PRIMARY KEY, total_minted bigint, slots int,
  opened_count bigint, packnft_total bigint, opened_updated_at timestamptz);
CREATE TABLE public.v_allday_pack_ev_corrected (
  dist_id text PRIMARY KEY, best_gross_ev numeric, best_net_ev numeric,
  best_value_ratio numeric, ev_method text, has_published_odds boolean,
  stale_value_share_pct numeric, low_confidence_ev boolean);

CREATE VIEW public.v_allday_pack_detail_ev AS
SELECT d.dist_id,
       c.best_gross_ev                        AS corrected_gross_ev,
       c.best_net_ev                          AS corrected_net_ev,
       c.best_value_ratio                     AS corrected_value_ratio,
       c.ev_method,
       c.has_published_odds,
       c.stale_value_share_pct,
       c.low_confidence_ev,
       s.opened_count,
       s.packnft_total,
       CASE
         WHEN s.total_minted > 0 AND s.opened_count IS NOT NULL
           THEN round(LEAST(100.0, 100.0 * s.opened_count::numeric / s.total_minted::numeric), 1)
         ELSE NULL::numeric
       END                                    AS opened_pct_of_minted
  FROM public.pack_distributions d
  LEFT JOIN public.allday_pack_supply s        ON s.dist_id = d.dist_id
  LEFT JOIN public.v_allday_pack_ev_corrected c ON c.dist_id = d.dist_id
 WHERE d.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid;

-- >>> BEGIN verbatim get_pack_detail_bundle (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.get_pack_detail_bundle(p_collection_id uuid, p_dist_id text, p_collection_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
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
  -- Reads the LEAN v_allday_pack_detail_ev (see migration header): identical columns
  -- and values to v_allday_pack_info, without its 1.19M-cost pack_ev_latest join.
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
    from public.v_allday_pack_detail_ev v
    where v.dist_id = p_dist_id
    limit 1;
  end if;

  -- Top-5 pool editions by FMV — powers the hero montage + Top-pulls strip.
  -- Optimized (see migration header): score FMV once/edition in a MATERIALIZED
  -- CTE, fold total_weight over the same set, then join editions + the rep-nft
  -- lookup only for the final 5 rows.
  with scored as materialized (
    select pdp.edition_id, pdp.drop_weight,
           -- `computed_at <= now()` is a no-op on the RESULT (no snapshot is
           -- computed in the future) but it hands the planner the partition key,
           -- which prunes the empty future partition at runtime. See header.
           (select fs.fmv_usd from public.fmv_snapshots fs
              where fs.edition_id = pdp.edition_id and fs.computed_at <= now()
              order by fs.computed_at desc limit 1) as fmv_usd
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

-- ── 5. AllDay branch: corrected_ev sourced from v_allday_pack_detail_ev ───────
-- Added 2026-08-09. Before this the AllDay leg had NO coverage at all (the test
-- deferred body validation rather than fixture the view), so the branch could be
-- repointed or dropped with every assertion still green.
\set AD '''dee28451-5d62-409e-a1ad-a83f763ac070'''

INSERT INTO public.pack_table_rows (collection_id, dist_id, label) VALUES (:AD::uuid, 'a1', 'AllDay Pack');
INSERT INTO public.pack_distributions (collection_id, dist_id, metadata, image_url, title) VALUES
  (:AD::uuid, 'a1', '{"retail_price_usd":25}'::jsonb, 'imgA', 'AllDay Pack'),
  (:AD::uuid, 'a2', '{"retail_price_usd":25}'::jsonb, 'imgB', 'AllDay Overrun');

INSERT INTO public.v_allday_pack_ev_corrected
  (dist_id, best_gross_ev, best_net_ev, best_value_ratio, ev_method,
   has_published_odds, stale_value_share_pct, low_confidence_ev) VALUES
  ('a1', 41.5, 16.5, 1.66, 'circulation_weighted', true,  3.2, false),
  ('a2', 10.0,  1.0, 1.10, 'median',               false, 0.0, true);

INSERT INTO public.allday_pack_supply (dist_id, total_minted, slots, opened_count, packnft_total) VALUES
  ('a1', 1000, 5,  900, 1000),
  -- clamp case: opened_count EXCEEDS total_minted, so the raw ratio is 110.0.
  -- LEAST() must pull it back to 100.0. No live dist reaches this branch.
  ('a2', 1000, 5, 1100, 1000);

SELECT _assert(
  (public.get_pack_detail_bundle(:AD::uuid,'a1','nfl-all-day') -> 'corrected_ev') <> 'null'::jsonb,
  'AllDay slug -> corrected_ev populated from v_allday_pack_detail_ev');
SELECT _assert_eq(
  (public.get_pack_detail_bundle(:AD::uuid,'a1','nfl-all-day') -> 'corrected_ev' ->> 'corrected_gross_ev'),
  '41.5', 'corrected_gross_ev passes through unrounded');
SELECT _assert_eq(
  (public.get_pack_detail_bundle(:AD::uuid,'a1','nfl-all-day') -> 'corrected_ev' ->> 'ev_method'),
  'circulation_weighted', 'ev_method passes through');
SELECT _assert_eq(
  (public.get_pack_detail_bundle(:AD::uuid,'a2','nfl-all-day') -> 'corrected_ev' ->> 'opened_pct_of_minted'),
  '100.0', 'opened_pct_of_minted is clamped at 100 when opened_count > total_minted');

-- The branch is slug-gated: the SAME dist read as a non-AllDay collection must not
-- surface corrected_ev. This is what makes the `if p_collection_slug` gate load-bearing.
SELECT _assert_eq(
  (public.get_pack_detail_bundle(:AD::uuid,'a1','nba-top-shot') -> 'corrected_ev')::text,
  'null', 'non-AllDay slug -> corrected_ev stays null even for an AllDay dist');

-- ── A FUTURE-DATED SNAPSHOT MUST NOT WIN THE HERO SLOT ──────────────────────
-- Added when this pin was re-pointed 2026-08-22. The live body gained
-- `and fs.computed_at <= now()` inside the per-edition FMV lookup. Its comment
-- calls that "a no-op on the RESULT", and the REASON given is that no snapshot is
-- computed in the future — the predicate exists to hand the planner the partition
-- key so it prunes the empty future partition at runtime.
--
-- ⚠ "No-op" is therefore a claim about the DATA, not about the code. Verified
-- against prod 2026-08-22: zero rows in fmv_snapshots have computed_at > now(),
-- with a positive control (14,192 snapshots written in the trailing 24h, max
-- computed_at 37 seconds old) so the zero means "none are future-dated" rather
-- than "the predicate matched nothing".
--
-- What the predicate actually DOES is exclude a future row, and that is what is
-- pinned here — so if clock skew or a back-dated writer ever produces one, this
-- test says which behaviour the hero montage has rather than leaving it to be
-- rediscovered from a wrong picture on a public pack page.
INSERT INTO public.fmv_snapshots (edition_id, fmv_usd, computed_at)
VALUES (:eB::uuid, 5000, now() + interval '1 day');

SELECT _assert_eq(
  (public.get_pack_detail_bundle(:TS::uuid,'d1','nba-top-shot') -> 'hero_editions' -> 0 ->> 'player_name'),
  'Dame',
  'a future-dated snapshot does NOT win the hero slot — Ant''s 5000 is dated tomorrow,
   so Dame''s 100 still leads');
SELECT _assert_eq(
  (SELECT h ->> 'fmv_usd' FROM jsonb_array_elements(
     public.get_pack_detail_bundle(:TS::uuid,'d1','nba-top-shot') -> 'hero_editions') h
   WHERE h ->> 'player_name' = 'Ant'),
  '50',
  'and Ant keeps its LATEST NON-FUTURE fmv (50), not the future 5000');

SELECT '✓ get_pack_detail_bundle: all assertions passed' AS result;

ROLLBACK;
