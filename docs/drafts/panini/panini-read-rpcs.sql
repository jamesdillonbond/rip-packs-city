-- ============================================================================
-- Panini Blockchain — DRAFT read surfaces (NOT APPLIED). Apply AFTER panini-schema.sql.
-- Public read pattern = security_invoker views granted to anon (mirrors
-- topshot_squeeze_board), NOT SECDEF functions — avoids the anon-EXECUTE footgun.
-- Latest-FMV-per-edition via LEFT JOIN LATERAL ... ORDER BY computed_at DESC LIMIT 1
-- (uses idx_panini_fmv_edition_time) — never DISTINCT ON over the whole snapshot
-- table (the AF1 anti-pattern that timed out in prod).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Squeeze board — per edition, ranked by how drained the pack supply is.
--    rip_pct = pulled / cap (high = most copies already pulled from packs);
--    still_in_packs = remaining sealed supply (the scarcity signal).
--    "Squeeze" = high rip_pct + low remaining + real FMV.
-- ---------------------------------------------------------------------------
create or replace view public.panini_squeeze_board
with (security_invoker = on) as
select
  e.id,
  e.external_id,
  e.collection_id,
  e.player_name,
  e.nation,
  e.set_name,
  e.parallel,
  e.parallel_family,
  e.rarity_label,
  e.tier,
  e.mint_cap,
  e.pulled_count,
  e.still_in_packs,
  case when coalesce(e.mint_cap,0) > 0
       then round((e.pulled_count::numeric / e.mint_cap) * 100, 1)
       else null end                              as rip_pct,
  e.is_fotl_exclusive,
  f.fmv_usd,
  f.confidence                                    as fmv_confidence,
  e.serial_low_ask_usd,
  e.thumbnail_url
from public.panini_editions e
left join lateral (
  select s.fmv_usd, s.confidence
  from public.panini_fmv_snapshots s
  where s.edition_id = e.id
  order by s.computed_at desc
  limit 1
) f on true
where e.mint_cap is not null;

grant select on public.panini_squeeze_board to anon, authenticated, service_role;

-- Suggested consumer query (public route does the ranking + filters, keeps the
-- view cheap):
--   select * from public.panini_squeeze_board
--   where (%(set)s is null or set_name = %(set)s)
--     and (%(tier)s is null or tier = %(tier)s)
--     and rip_pct >= coalesce(%(min_rip)s, 0)
--   order by rip_pct desc nulls last, still_in_packs asc
--   limit 200;

-- ---------------------------------------------------------------------------
-- 2. Pack-EV board — per pack (FOTL / Hobby / craft), gross/net EV + % ripped.
--    EV inputs are precomputed into panini_pack_state by the circulation-refresh
--    rollup (see docs/drafts/panini/panini-methodology.md §1); this view just
--    presents them honestly with a coverage caveat.
-- ---------------------------------------------------------------------------
create or replace view public.panini_pack_ev_board
with (security_invoker = on) as
select
  p.id,
  p.collection_id,
  p.pack_type,
  p.price_usd,
  p.cards_per_pack,
  p.packs_total,
  p.packs_remaining,
  case when coalesce(p.packs_total,0) > 0
       then round(((p.packs_total - coalesce(p.packs_remaining, p.packs_total))::numeric
                   / p.packs_total) * 100, 1)
       else null end                              as packs_ripped_pct,
  p.gross_ev_usd,
  p.net_ev_usd,
  case when p.price_usd > 0 and p.gross_ev_usd is not null
       then round((p.gross_ev_usd / p.price_usd), 2)
       else null end                              as ev_ratio,
  p.updated_at
from public.panini_pack_state p;

grant select on public.panini_pack_ev_board to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Optional: top chases per pack (highest-FMV pullable editions) for the
--    pack-reality "top chases" strip — add once panini_editions↔pack pool
--    mapping is captured at discovery. Stub left intentionally unbuilt.
-- ---------------------------------------------------------------------------

-- ROLLBACK:
--   drop view if exists public.panini_pack_ev_board;
--   drop view if exists public.panini_squeeze_board;
