-- 2026-08-09 — kill the 1.19M-cost `pack_ev_latest` scan behind every AllDay pack page.
--
-- SYMPTOM: `/[collection]/pack/dist/[distId]` was the top PUBLIC-PAGE 5xx source —
-- 81 hard 500s in 24h, and **every single one was `/nfl-all-day/`**. The page throws
-- (by design, since 2026-07-14) rather than silently 404ing a real dist when its shell
-- RPC fails, so a `get_pack_detail_bundle` statement timeout renders a visible error
-- boundary. `rpcWithRetry` correctly refuses to retry 57014, so it throws first try.
--
-- ROOT CAUSE — the documented "compute-for-all-then-filter" anti-pattern, third instance
-- (after `get_allday_market_editions` and the `ed_med` median, both 2026-08-08).
-- `EXPLAIN` of the AllDay leg `select ... from v_allday_pack_info where dist_id = '7132'`:
--
--   Limit                                                   (cost=1195280.71..1195359.58)
--     ...
--     ->  Subquery Scan on pack_ev_latest                   (cost=0.42..1195279.56 rows=1)
--           Filter: (collection_id = <allday> AND dist_id = '7132')     <-- ABOVE the Unique
--           ->  Unique                                      (cost=0.42..1195215.88 rows=4245)
--                 ->  Index Scan on pack_ev_history h       (cost=0.42..1194916.91 rows=119591)
--                       SubPlan 2 -> Seq Scan on pack_distributions
--
-- `v_allday_pack_info` LEFT JOINs `ev1`, a `DISTINCT ON` subquery over the `pack_ev_latest`
-- view. The dist_id predicate lands ABOVE that `Unique`, so it cannot be pushed down: the
-- query materializes the latest EV for ALL 4,245 packs out of 119,591 history rows (plus a
-- seq-scan subplan) and then discards all but one. Postgres cannot prune the join either —
-- LEFT JOIN removal only applies to a base relation with a unique index on the join key, and
-- `ev1` is a subquery. Every other leg of the view is a cheap index scan (cost 2.5–72).
--
-- THE KEY OBSERVATION: **not one of the columns any caller reads comes from that node.**
-- All four consumers select only `corrected_*` / `ev_method` / `has_published_odds` /
-- `stale_value_share_pct` / `low_confidence_ev` (all from `c` = mv_allday_pack_ev_corrected)
-- and `opened_count` / `packnft_total` / `opened_pct_of_minted` (all from `s` =
-- allday_pack_supply). The 1.19M-cost scan was pure waste on every AllDay pack page view:
--   * get_pack_detail_bundle          (this migration)
--   * app/(collections)/[collection]/pack/dist/[distId]/page.tsx  fetchAllDayCorrectedEv
--   * app/api/og/pack/route.tsx                                   fetchAllDayCorrectedOg
--   * app/api/packs/route.ts                                      corrected-EV merge
--
-- FIX: a lean view exposing exactly those 11 columns, reading only the three cheap indexed
-- relations. Same rows, same values, ~158,000x less planner cost:
--
--   Limit                                                              (cost=0.84..7.54)
--     ->  Nested Loop Left Join
--           ->  Index Only Scan using idx_pack_distributions_market_cover on pack_distributions
--           ->  Index Scan using allday_pack_supply_pkey on allday_pack_supply
--           ->  Index Scan using mv_allday_pack_ev_corrected_dist on mv_allday_pack_ev_corrected
--
-- OUTPUT-IDENTICAL, VERIFIED — not asserted, measured. A full-set EXCEPT diff of the 11
-- columns, old view vs new, across EVERY AllDay dist:
--     old_rows 3052 | new_rows 3052 | old_not_in_new 0 | new_not_in_old 0
-- The WHERE clause reproduces `v_allday_pack_info`'s hardcoded AllDay uuid rather than
-- parameterizing, so row EXISTENCE semantics (driven by `pack_distributions`) are identical
-- too — a dist with no pack_distributions row yields no row in either.
--
-- `v_allday_pack_info` IS DELIBERATELY LEFT IN PLACE, not modified and not dropped. It still
-- legitimately exposes `pack_price` / `modeled_gross_ev` / `value_ratio` / `edition_count` /
-- `pullable_editions` etc. from `ev1`+`pool`, and `sync_allday_pack_dist_totals` still reads
-- it. Narrowing it would be a breaking change for a non-hot writer to save nothing.
--
-- GRANTS: service_role only. All four consumers bind the service-role key (verified by
-- resolving each binding, not the identifier name — `supabase` in app/api/packs/route.ts is
-- a createClient(SUPABASE_SERVICE_ROLE_KEY) and `sb` in the page is `supabaseAdmin`). anon /
-- authenticated are revoked EXPLICITLY, because Supabase's default per-role grant survives
-- `REVOKE ... FROM PUBLIC`. `security_invoker = on` matches repo convention and keeps
-- check_public_security_invariants() quiet; it also means an anon caller could not read the
-- underlying mv_allday_pack_ev_corrected anyway (already anon-revoked).
--
-- REVERT:
--   DROP VIEW public.v_allday_pack_detail_ev;
--   -- then re-apply the get_pack_detail_bundle body from
--   -- supabase/migrations/20260725010200_audit_20260725_get_pack_detail_bundle_hero_fast.sql
--   -- and revert the code commit (git revert <sha>) so the 3 route/page call sites point
--   -- back at v_allday_pack_info.

CREATE OR REPLACE VIEW public.v_allday_pack_detail_ev AS
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

ALTER VIEW public.v_allday_pack_detail_ev SET (security_invoker = on);

COMMENT ON VIEW public.v_allday_pack_detail_ev IS
  'Lean AllDay per-dist corrected-EV + opened-supply read (11 cols). Output-identical to the same columns of v_allday_pack_info (verified: 0-row EXCEPT diff over all 3,052 AllDay dists) but skips that view''s ev1 LEFT JOIN over pack_ev_latest, whose dist_id predicate cannot push below its DISTINCT ON — that node alone cost 1,195,280 and produced no column any caller reads. Per-dist cost 7.54. Use THIS for per-dist reads; v_allday_pack_info remains correct for the modeled-EV/pool columns it alone exposes.';

REVOKE ALL ON public.v_allday_pack_detail_ev FROM PUBLIC;
REVOKE ALL ON public.v_allday_pack_detail_ev FROM anon, authenticated;
GRANT SELECT ON public.v_allday_pack_detail_ev TO service_role;

-- ── get_pack_detail_bundle: point the AllDay leg at the lean view ────────────
-- Body is otherwise byte-identical to 20260725010200 (the hero/pool/pack_row legs are
-- untouched). supabase/tests/get_pack_detail_bundle.sql carries a verbatim copy and
-- __tests__/db-invariants-drift-guard.test.ts fails CI if the two diverge, so that test
-- file is updated in the same commit.
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
