-- DRAFT (2026-11-22) — Panini digital edition -> physical card crosswalk.
-- NOT a migration. Read-only view body; safe to run as a SELECT against prod.
-- Purpose: give every Panini Blockchain edition the key its PAPER twin is searched and priced by
-- (physical product, subset, parallel, the PERSON), so a licensed sold-sales feed (HobbyCardIndex,
-- once Trevor opts in) can be compared card-for-card with RPC's digital FMV / sales.
--
-- Rules (mirror RPC identity rules — a name is not a person):
--   * person = ESPN athlete id from panini_espn_crosswalk (box-score verdict) first, then
--     espn_search_crosswalk; an 'ambiguous' / 'family_ambiguous' verdict STAYS ambiguous and is never
--     compared (Adrian Peterson x2, Mark Ingram Sr/II).
--   * physical product = the Panini NFT product name minus " NFT " (the NFT lines are licensed
--     reprints of the paper programs: "2024-25 Panini NFT Prizm Basketball" ->
--     "2024-25 Panini Prizm Basketball"). The 2021 "Blockchain ... Packs" products carry the paper
--     year/program in set_name ("BC 2020-21 Prizm Base ...").
--   * product_class: physical_line (program on the known paper list), sticker, digital_only
--     (Best of, Emoji, Rookie Royalty, Bad Eggs, Moonbirds, entertainment packs),
--     unverified (anything else, incl. Instant: paper Panini Instant exists but the digital
--     Instant sets are not confirmed as its twins — never compared until confirmed).
--   * card_number: the paper card number, read from the edition key (see the ed CTE).
--   * parallel existence on paper is NOT asserted here. The feed's catalogue search confirms it;
--     until then physical_parallel is a search token, and digital print runs (mint_cap) differ from
--     paper (/424 digital Silver vs unnumbered paper Silver), so only numbered parallels with the
--     same /N are apples-to-apples.
--   * Card numbers checked against published paper checklists (checklistinsider.com, read
--     2026-11-22 ~10:40 PM PT), 23 of 23 matching the edition-key number:
--       2026 Prizm FIFA World Cup base: Yamal #70, Messi #10, Haaland #333, Ronaldo #367,
--         G. Mora #290, Diomande #257, Estevao #87. Inserts: Color Blast Messi #10 / Yamal #11;
--         National Landmarks Messi #10 / Yamal #6 / Ronaldo #7; National Pride Messi #10 /
--         Yamal #1; Phenomenon Messi #19 / Yamal #1; Prizmania Messi #10; Scorers Club Messi
--         #15; New Era Yamal #12; Trophy Hunting Ronaldo #17.
--       2026 Prizm WNBA base: Miles #131 AND #145, Fudd #35 AND #144, Flau'jae Johnson #136 AND
--         #150, Awa Fam #132 AND #146 (two paper cards each, as the keys say), Clark #82,
--         Bueckers #57, A'ja Wilson #14.
--     The same pages confirm the parallel names exist on paper (Choice Nebula 1/1, Old Glory /94,
--     Aguila /70, Maple Leaf /86, Plum Blossom /8, Cherry Blossom /20, Preferred Genesis;
--     WNBA Gold /10, Gold Vinyl 1/1). Paper print runs still differ from the digital mint caps.
create or replace view public.panini_physical_crosswalk_draft as
with ed as (
  select pe.external_id, pe.player_name, pe.parallel, pe.set_name, pe.parallel_family, pe.mint_cap,
         pe.tier, pp.set_id as product_set_id, pp.name as digital_product,
         case when pp.last_grid_sport ilike '%basketball%' then 'basketball'
              else lower(pp.last_grid_sport) end as sport,
         -- The PERSON key: the Panini players row the edition points at (its canonical
         -- name: "Stephen Curry" -> Steph Curry, "Patrick Mahomes II" -> Patrick Mahomes,
         -- via player_name_aliases), falling back to the label. A multi-player card
         -- ("Cristiano Ronaldo | Bruno Fernandes") is NOT one person, whatever row it points at.
         public.rpc_name_slug(case when pe.player_name ~ ' [|&/] ' then pe.player_name
                                   else coalesce(pl.name, pe.player_name) end) as name_slug,
         (pe.player_name ~ ' [|&/] ') as multi_person,
         -- The last '_' segment of the edition key is the PAPER card number (verified
         -- 2026-11-22: 2020-21 Prizm Edwards #258 / LaMelo #278, 2023-24 Prizm Wembanyama
         -- #136, 2024 Prizm WNBA Caitlin Clark #22 AND #145 — two different paper cards).
         -- Numeric on 50,724 of 54,843 editions; the rest are stickers / entertainment.
         nullif(substring(pe.external_id from '_(\d{1,4})$'), '') as card_number
    from public.panini_editions pe
    join public.panini_products pp on pp.set_id = pe.product_set_id
    left join public.editions e on e.external_id = pe.external_id
                               and e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'  -- panini_blockchain
    left join public.players pl on pl.id = e.player_id
), xw as (
  -- Crosswalk keys are market-cap group keys, which keep the dash a trailing "." leaves
  -- ("michael-penix-jr-"); rpc_name_slug trims it. Compare trimmed.
  select trim(both '-' from name_slug) as k, sport, espn_id, matched_by from public.panini_espn_crosswalk
), qw as (
  select trim(both '-' from name_slug) as k, sport, espn_id, matched_by from public.espn_search_crosswalk
   where collection_slug = 'panini_blockchain'
), prod as (
  select ed.*,
         -- BC reprints: "BC 2020-21 Prizm Base Prizms Blue Wave"
         substring(ed.set_name from '^BC (\d{4}(?:-\d{2})?) ') as bc_year,
         substring(ed.set_name from '^BC \d{4}(?:-\d{2})? (Prizm|Select|Donruss Optic|Optic|Donruss|Mosaic|Hoops) ') as bc_program,
         case when ed.set_name ~ '^BC ' then regexp_replace(ed.set_name, '^BC \d{4}(?:-\d{2})? (Prizm|Select|Donruss Optic|Optic|Donruss|Mosaic|Hoops) ?', '')
              else ed.parallel end as par_raw
    from ed
), cls as (
  select prod.*,
         case
           when bc_year is not null and bc_program is not null then
             bc_year || ' Panini ' || bc_program || ' ' ||
             case when digital_product ~ ' NBA ' then 'Basketball' when digital_product ~ ' NFL ' then 'Football'
                  when digital_product ~ ' BB ' then 'Baseball' else '' end
           else regexp_replace(digital_product, ' NFT ', ' ')
         end as physical_product,
         case
           when digital_product ~* 'sticker' then 'sticker'
           when digital_product ~* '(best of|emoji|rookie royalty|bad eggs|moonbirds|rolling stones|entertainment)'
                and bc_year is null then 'digital_only'
           when bc_year is not null and bc_program is not null then 'physical_line'
           when digital_product ~* ' NFT (Prizm|Select|Donruss Optic|Donruss|Hoops|Mosaic|Flawless|Obsidian|Spectra|Origins|Court Kings|Silhouette|Score)( |$)'
             then 'physical_line'
           when digital_product ~* ' NFL (Prizm|Donruss Optic)$' then 'physical_line'
           else 'unverified'
         end as product_class
    from prod
), split as (
  select cls.*,
         case when par_raw ~ ' Prizms? ' then split_part(regexp_replace(par_raw, ' Prizms? ', '|'), '|', 1)
              when par_raw ~ ' - '       then split_part(par_raw, ' - ', 1)
              when par_raw ~ '^Base '    then 'Base'
              when coalesce(par_raw, '') = '' then 'Base'
              else par_raw end as physical_subset,
         case when par_raw ~ ' Prizms? ' then split_part(regexp_replace(par_raw, ' Prizms? ', '|'), '|', 2)
              when par_raw ~ ' - '       then split_part(par_raw, ' - ', 2)
              when par_raw ~ '^Base '    then regexp_replace(par_raw, '^Base ', '')
              else 'Base' end as physical_parallel
    from cls
), person as (
  select s.*,
         case when s.multi_person then null else coalesce(x.espn_id, q.espn_id) end as espn_id,
         case when s.multi_person then 'multi_person'                 -- a card of several people
              when x.espn_id is not null then 'linked'
              when x.k is not null then 'ambiguous'                      -- box-score verdict wins, never picked
              when q.espn_id is not null then 'linked_search'
              when q.matched_by in ('ambiguous', 'too_common', 'unverifiable') then 'ambiguous'
              else 'unlinked' end as person_status
    from split s
    left join xw x on x.k = s.name_slug and x.sport = s.sport
    left join qw q on q.k = s.name_slug and q.sport = s.sport
)
select external_id, product_set_id, digital_product, product_class, physical_product,
       card_number, physical_subset, physical_parallel, mint_cap as digital_mint_cap, parallel_family, tier,
       sport, player_name, name_slug, espn_id, person_status,
       (product_class = 'physical_line' and person_status in ('linked', 'linked_search')) as comparable,
       trim(physical_product || ' ' || coalesce('#' || card_number || ' ', '') || player_name || ' ' ||
            case when physical_subset <> 'Base' then physical_subset || ' ' else '' end ||
            case when physical_parallel <> 'Base' then physical_parallel else '' end) as physical_search_query
  from person;

-- ---------------------------------------------------------------------------
-- Links (DRAFT, needs the physical_cards / physical_value_cache tables from
-- docs/physical/physical-holdings-draft.sql applied first — landed in the repo 2026-11-22
-- (4d35938) as a draft; not applied).
-- One row per digital edition -> paper card the matcher accepted
-- (lib/physical/panini-crosswalk.ts matchPaperCard: exactly one survivor) or a
-- human confirmed. Ambiguous / none results are NOT stored as links.
-- Licensed data: physical_cards rows sourced from 'hci' go when the plan ends,
-- and these links cascade with them.
create table if not exists public.panini_physical_links (
  external_id       text not null,                 -- panini_editions.external_id
  physical_card_id  uuid not null references public.physical_cards(id) on delete cascade,
  match_method      text not null check (match_method in ('feed_search', 'manual')),
  print_run_match   boolean,                       -- null = paper print run unknown
  matched_at        timestamptz not null default now(),
  primary key (external_id, physical_card_id)
);
-- One paper card per digital edition.
create unique index if not exists panini_physical_links_one_per_edition on public.panini_physical_links (external_id);
alter table public.panini_physical_links enable row level security;
revoke all on table public.panini_physical_links from public, anon, authenticated;
grant all on table public.panini_physical_links to service_role;

-- Digital vs paper, card for card. INTERNAL until the physical backtest passes
-- (accuracy gate) — service_role only, no public route reads it.
--   digital: latest Panini FMV (never its confidence) + median of the last 90 days' sales
--   paper:   licensed value range per grader/grade (raw and PSA 10 are the two rows a
--            comparison shows); an unpriced side is NULL, never 0.
create or replace view public.panini_digital_vs_physical_draft
with (security_invoker = true) as
-- panini_fmv_snapshots is keyed by panini_editions.id (1:1 with external_id, measured
-- 2026-11-22: 54,836 / 54,836), panini_sales by external_id. Both reads are per link
-- through idx_panini_fmv_edition_time / idx_panini_sales_edition_sold — never a
-- DISTINCT ON over the whole snapshot table.
select l.external_id, l.physical_card_id, l.print_run_match,
       pc.name as paper_card, v.grader, v.grade,
       f.fmv_usd as digital_fmv_usd, s.median_90d_usd as digital_median_90d_usd, s.sales_90d as digital_sales_90d,
       v.point_usd as paper_point_usd, v.low_usd as paper_low_usd, v.high_usd as paper_high_usd,
       v.sales_used as paper_sales_used, v.stale as paper_stale, v.source as paper_source,
       case when f.fmv_usd > 0 and v.point_usd > 0 then round(f.fmv_usd / v.point_usd, 3) end as digital_to_paper_ratio
  from public.panini_physical_links l
  join public.panini_editions pe on pe.external_id = l.external_id
  join public.physical_cards pc on pc.id = l.physical_card_id
  left join public.physical_value_cache v on v.card_id = l.physical_card_id
  left join lateral (
    select fs.fmv_usd from public.panini_fmv_snapshots fs
     where fs.edition_id = pe.id order by fs.computed_at desc limit 1
  ) f on true
  left join lateral (
    select percentile_cont(0.5) within group (order by ps.amount_usd) as median_90d_usd, count(*) as sales_90d
      from public.panini_sales ps
     where ps.edition_external_id = l.external_id and ps.sold_at > now() - interval '90 days' and ps.amount_usd > 0
  ) s on true;
revoke all on public.panini_digital_vs_physical_draft from public, anon, authenticated;
grant select on public.panini_digital_vs_physical_draft to service_role;
