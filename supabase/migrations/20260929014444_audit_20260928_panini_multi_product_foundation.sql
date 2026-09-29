-- audit_20260928_panini_multi_product_foundation
--
-- Panini goes multi-product (Trevor, 2026-09-28: "we should be adding all of these different
-- leagues, along with the rest of Panini NFT collections"). Until now the Panini plane was ONE
-- product — 2026 Panini NFT Prizm World Cup Soccer, card setId 2332 — and every object assumed it.
-- Measured before this migration: all 5,124 panini_editions rows and all 273,992
-- panini_card_serials rows are packcard-2332_*; panini_pack_state holds exactly the WC Hobby
-- (1038) and WC FOTL (1039) packs.
--
-- PHASE 1 (this file) = DISCOVERY + PACKS, with no card data from any other product yet:
--   · panini_products    — registry of card products (setId = field 1 of every psku). The runner
--                          reports every setId its grid walks see; walk_cards gates which products
--                          the per-card walk and the ingest route accept. Only 2332 is on.
--   · panini_pack_pages  — the pack pages the runner visits. Was a hardcoded 2-URL array in
--                          scripts/ingest-panini-runner.mjs; now seeded here, extended by the
--                          runner's link harvest, and each page records whether its last visit
--                          CAPTURED market stats (a page that never captures is visible, not silent).
--   · panini_pack_state  — product_name / sport / product_set_id / page_url per pack.
--
-- ⛔ THE SUBSTITUTION THIS CLOSES. panini_pack_ev_board CROSS JOINed every pack_state row with the
-- single WC model, so the first WNBA/NBA/NFL pack the runner captured would have published World
-- Cup EV under its name on the public Packs tab — every honesty helper satisfied, the SUBJECT
-- swapped. EV now applies only where product_set_id = 2332 (the one product the model is built
-- from); every other pack carries NULL EV and says so in model_note. panini_pack_ev_model is
-- scoped to 2332 editions for the same reason, ahead of Phase 2 bringing other products' cards in.

-- 1. Product registry ------------------------------------------------------------------------
create table public.panini_products (
  set_id          integer primary key,
  name            text,
  sport           text,
  walk_cards      boolean not null default false,
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz,
  last_grid_items integer,
  last_grid_sport text,
  note            text
);
alter table public.panini_products enable row level security;
revoke all on public.panini_products from anon, authenticated;
comment on table public.panini_products is
  'Panini card products keyed by psku setId (packcard-<setId>_...). Rows are created by the residential runner''s grid discovery via /api/cron/panini-ingest; walk_cards=true admits a product to the per-card walk and to panini_editions. Phase 1 (2026-09-28): only 2332 (WC Prizm) is walked.';

insert into public.panini_products (set_id, name, sport, walk_cards, last_seen_at, note)
values (2332, '2026 Panini NFT Prizm World Cup Soccer', 'SOCCER', true, now(),
        'The original Panini plane (verified live 2026-07-16). The only product panini_pack_ev_model prices.');

-- 2. Pack pages the runner visits --------------------------------------------------------------
create table public.panini_pack_pages (
  url               text primary key,
  source            text not null default 'manual' check (source in ('seed','manual','discovered')),
  enabled           boolean not null default true,
  first_seen_at     timestamptz not null default now(),
  last_walked_at    timestamptz,
  last_captured_at  timestamptz,
  last_pack_id      text,
  note              text
);
alter table public.panini_pack_pages enable row level security;
revoke all on public.panini_pack_pages from anon, authenticated;
comment on table public.panini_pack_pages is
  'Pack pages the Panini runner visits each walk (served to it by GET /api/cron/panini-ingest). last_walked_at = the runner opened it; last_captured_at = that visit produced getPackMarketStats. walked-but-never-captured means the page type does not fire the op — read it, do not assume the pack is covered.';

insert into public.panini_pack_pages (url, source, last_pack_id, note) values
  ('https://nft.paniniamerica.net/marketplace-details/subpack-5270763-1038.html', 'seed', '1038', 'WC Prizm Hobby — was PACK_URLS[0] in the runner'),
  ('https://nft.paniniamerica.net/marketplace-details/subpack-5294230-1039.html', 'seed', '1039', 'WC Prizm FOTL — was PACK_URLS[1] in the runner'),
  ('https://nft.paniniamerica.net/pack-2026_Panini_NFT_Prizm_WNBA_FOTL_Packs.html', 'manual', null, 'Trevor 2026-09-28. A /pack-<name>.html page, not a marketplace-details subpack page — whether it fires getPackMarketStats is unmeasured; last_captured_at answers it.');

-- 3. Product identity on pack state --------------------------------------------------------------
alter table public.panini_pack_state
  add column product_name   text,
  add column sport          text,
  add column product_set_id integer,
  add column page_url       text;

update public.panini_pack_state
   set product_name   = raw->>'collection_name',
       sport          = raw->>'sport',
       product_set_id = 2332
 where id in ('1038', '1039');

-- 4. The model prices WC Prizm only -----------------------------------------------------------------
create or replace view public.panini_pack_ev_model with (security_invoker = on) as
 WITH ed AS (
         SELECT
                CASE
                    WHEN (e.set_name ~~* 'Base Prizms Silver'::text) THEN 'silver'::text
                    WHEN (e.parallel_family = 'fotl_exclusive'::text) THEN 'fotl'::text
                    WHEN (e.parallel_family = 'base'::text) THEN 'base'::text
                    ELSE 'insert'::text
                END AS cls,
            COALESCE(e.still_in_packs, 0) AS remain,
            ( SELECT fs.fmv_usd
                   FROM panini_fmv_snapshots fs
                  WHERE (fs.edition_id = e.id)
                  ORDER BY fs.computed_at DESC
                 LIMIT 1) AS fmv
           FROM panini_editions e
          WHERE (e.external_id ~~ 'packcard-2332\_%'::text)
        ), agg AS (
         SELECT ed.cls,
            (sum((ed.fmv * (ed.remain)::numeric)) / (NULLIF(sum(ed.remain), 0))::numeric) AS sw,
            percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((
                CASE
                    WHEN (ed.remain > 0) THEN ed.fmv
                    ELSE NULL::numeric
                END)::double precision)) AS med
           FROM ed
          WHERE (ed.fmv IS NOT NULL)
          GROUP BY ed.cls
        ), p AS (
         SELECT max(agg.sw) FILTER (WHERE (agg.cls = 'silver'::text)) AS silver_sw,
            max(agg.med) FILTER (WHERE (agg.cls = 'silver'::text)) AS silver_med,
            max(agg.sw) FILTER (WHERE (agg.cls = 'base'::text)) AS base_sw,
            max(agg.med) FILTER (WHERE (agg.cls = 'base'::text)) AS base_med,
            max(agg.sw) FILTER (WHERE (agg.cls = 'insert'::text)) AS insert_sw,
            max(agg.med) FILTER (WHERE (agg.cls = 'insert'::text)) AS insert_med,
            max(agg.sw) FILTER (WHERE (agg.cls = 'fotl'::text)) AS fotl_sw,
            max(agg.med) FILTER (WHERE (agg.cls = 'fotl'::text)) AS fotl_med
           FROM agg
        )
 SELECT round(silver_sw) AS silver_ev,
    round(base_sw) AS base_parallel_ev,
    round(insert_sw) AS insert_ev,
    round(fotl_sw) AS fotl_exclusive_ev,
    round(((((3)::numeric * silver_sw) + (1.65 * base_sw)) + (0.35 * insert_sw))) AS hobby_actual_ev,
    round(((((3)::double precision * silver_med) + ((1.65)::double precision * base_med)) + ((0.35)::double precision * insert_med))) AS hobby_typical_ev,
    round((((((3)::numeric * silver_sw) + (1.65 * base_sw)) + (0.35 * insert_sw)) + fotl_sw)) AS fotl_actual_ev,
    round((((((3)::double precision * silver_med) + ((1.65)::double precision * base_med)) + ((0.35)::double precision * insert_med)) + fotl_med)) AS fotl_typical_ev,
    'panini-pack-ev-0.4 · REMAINING-BASIS (families weighted by still_in_packs, typical over pullable editions) · published odds insert 7/20 · FOTL = Hobby + 1 guaranteed exclusive · verified 2026-07-18'::text AS model_note
   FROM p;

-- 5. EV only where the model's product is the pack's product -------------------------------------
-- Columns 1..21 keep their names, order and types (CREATE OR REPLACE VIEW cannot reorder); the
-- four product columns are appended. ev_modeled is the discriminator a reader keys on: NULL EV with
-- ev_modeled=false means "no model for this product", never "worth nothing".
create or replace view public.panini_pack_ev_board with (security_invoker = on) as
 SELECT p.id,
    p.collection_id,
    p.pack_type,
    COALESCE(p.floor_usd, p.avg_sale_usd) AS pack_cost_usd,
    p.floor_usd,
    p.avg_sale_usd,
    p.recent_sale_usd,
    p.cards_per_pack,
    p.packs_total,
    p.packs_remaining,
        CASE
            WHEN (COALESCE(p.packs_total, 0) > 0) THEN round(((((p.packs_total - COALESCE(p.packs_remaining, p.packs_total)))::numeric / (p.packs_total)::numeric) * (100)::numeric), 1)
            ELSE NULL::numeric
        END AS packs_ripped_pct,
        CASE
            WHEN (p.product_set_id IS DISTINCT FROM 2332) THEN NULL::numeric
            WHEN (p.pack_type = 'fotl'::text) THEN m.fotl_actual_ev
            ELSE m.hobby_actual_ev
        END AS actual_ev_usd,
        CASE
            WHEN (p.product_set_id IS DISTINCT FROM 2332) THEN NULL::double precision
            WHEN (p.pack_type = 'fotl'::text) THEN m.fotl_typical_ev
            ELSE m.hobby_typical_ev
        END AS typical_ev_usd,
        CASE WHEN (p.product_set_id = 2332) THEN m.silver_ev END AS silver_ev,
        CASE WHEN (p.product_set_id = 2332) THEN m.base_parallel_ev END AS base_parallel_ev,
        CASE WHEN (p.product_set_id = 2332) THEN m.insert_ev END AS insert_ev,
        CASE WHEN (p.product_set_id = 2332) THEN m.fotl_exclusive_ev END AS fotl_exclusive_ev,
        CASE
            WHEN (p.product_set_id = 2332) THEN m.model_note
            ELSE 'not modeled · no pack-EV model exists for this product yet (card prices for it are not collected); EV is withheld, not zero'::text
        END AS model_note,
        CASE
            WHEN ((p.product_set_id = 2332) AND (COALESCE(p.floor_usd, p.avg_sale_usd) > (0)::numeric)) THEN round((
            CASE
                WHEN (p.pack_type = 'fotl'::text) THEN m.fotl_actual_ev
                ELSE m.hobby_actual_ev
            END - COALESCE(p.floor_usd, p.avg_sale_usd)))
            ELSE NULL::numeric
        END AS net_rip_edge_usd,
    p.updated_at,
    p.product_name,
    p.sport,
    p.product_set_id,
    (p.product_set_id = 2332) IS TRUE AS ev_modeled
   FROM (panini_pack_state p
     CROSS JOIN panini_pack_ev_model m);
