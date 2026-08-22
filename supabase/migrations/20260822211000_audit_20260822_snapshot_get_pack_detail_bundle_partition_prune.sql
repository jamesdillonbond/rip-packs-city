-- Snapshot migration: public.get_pack_detail_bundle(uuid,text,text).
--
-- Commits the CURRENT LIVE definition verbatim (pg_get_functiondef read 2026-08-22;
-- byte-identical, md5 89f96e0d48a420b39c0f4c3f02fa5905 — verified against the
-- database's own md5, not by eye). Applying it is a NO-OP against prod.
--
-- WHY IT EXISTS. `db-pin-staleness` had reported this pin STALE on every run since
-- 2026-08-10 (known-issues #24). It is the LAST of the six. Three changes:
--
--   1. `SECURITY DEFINER` → `STABLE SECURITY DEFINER`. Accurate: the function only
--      reads, so the planner may treat it as stable within a statement.
--   2. `SET statement_timeout TO '30s'` REMOVED. ⚠ This is a cleanup, not a
--      behaviour change — CLAUDE.md records that a function-level
--      `SET statement_timeout` is INERT (195 functions declare one and none binds).
--      Removing an inert declaration takes away nothing that was in force.
--   3. `and fs.computed_at <= now()` added to the per-edition FMV lookup, to hand
--      the planner the partition key so it prunes the empty future partition.
--
-- ⚠ ON (3): its comment calls the predicate "a no-op on the RESULT", and that is a
-- claim about the DATA, not about the code. Verified against prod 2026-08-22: ZERO
-- rows in fmv_snapshots carry `computed_at > now()`, with a positive control —
-- 14,192 snapshots written in the trailing 24h, max computed_at 37 seconds old — so
-- the zero means "none are future-dated" rather than "the predicate matched
-- nothing". What the predicate actually DOES is exclude a future row, and the
-- pinned test now asserts exactly that, so clock skew or a back-dated writer shows
-- up as a red test rather than as a wrong hero image on a public pack page.
--
-- ── anon-execute decision (guard: __tests__/migration-new-function-states-its-anon-exec-decision.test.ts) ──
-- anon-exec: unchanged — get_pack_detail_bundle is ALREADY revoked in prod. Verified
-- 2026-08-22 with has_function_privilege (not the acl text): anon EXECUTE false,
-- authenticated EXECUTE false, service_role EXECUTE true.
-- ⚠ Deliberately a MARKER and not a REVOKE: byte-identical snapshot, and CREATE OR
-- REPLACE FUNCTION does NOT reset a function's ACL, so a REVOKE here would CHANGE
-- production while presenting itself as a no-op.
--
-- REVERT: none needed — a no-op capture of what prod already runs.

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
