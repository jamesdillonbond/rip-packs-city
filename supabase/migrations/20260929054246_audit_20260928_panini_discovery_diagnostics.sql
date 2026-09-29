-- audit_20260928_panini_discovery_diagnostics
--
-- The first multi-product walk (2026-09-28 10:10 PM PT) answered two questions and raised two:
--   · all four ?sport= values work: 129 card products sighted (16 Soccer, 60 Basketball, 49 Football,
--     4 Baseball) — but a setId says nothing about WHICH product it is, so none can be named or chosen;
--   · the WNBA FOTL /pack-<name>.html page was walked and captured NOTHING (no getPackMarketStats), and
--     the pack-link harvest found 0 links — so where a non-WC pack's market data lives is unknown.
-- These columns hold the evidence the next walk brings back. Additive only; no reader changes.
alter table public.panini_products
  add column sample jsonb;
comment on column public.panini_products.sample is
  'One grid item seen for this setId on the latest walk ({psku, athlete, team, cardset, rarity}) — how a setId is identified (e.g. WNBA teams in team) so it can be named and chosen. Written by the runner via /api/cron/panini-ingest.';

alter table public.panini_pack_pages
  add column last_ops jsonb,
  add column last_pack_like jsonb;
comment on column public.panini_pack_pages.last_ops is
  'The /onepanini operations the latest visit to this page fired, {opName: count}. For a page that walks but never captures, this names the operation that DOES carry its data.';
comment on column public.panini_pack_pages.last_pack_like is
  'On the latest visit: the op name and field names of the first response object that looked like pack data (carried pack_sku or total_pack_qty), whatever operation it came from.';
