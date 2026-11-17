-- audit_20261110_sniper_deal_reads_hash_join_the_listed_pool
--
-- Claude Code cloud, 2026-11-10 ~12:30 PM PT (applied 12:29 PM PT). Planner settings only — no body change.
--
-- WHY: the sniper deal reads (/api/sniper-feed's Top Shot augment + the warm cron; the market page's _v3; All Day)
-- rank EVERY listed edition of the collection by discount (Top Shot 13,849 rows). The planner joined that pool as
-- nested loops / a merge join in key order: per-row probes of edition_fmv_current (4 buffers each, 55k) plus a
-- random-heap walk of badge_editions (20k) — 90-94k buffers per call for tables that are ~10k pages in total.
-- Two runtime-error misses of the 8 s budget in 24 h (4:27 AM PT 11-10, during a spell) were that footprint cold.
-- Hash joins over the three small tables (measured with session settings, then live through this config):
--   get_topshot_sniper_deals     default board  93,875 -> 12,322 buffers (218 -> 147 ms warm)
--   get_topshot_sniper_deals_v3  default board  93,981 -> 12,031 buffers (288 -> 144 ms warm)
--   get_allday_sniper_deals      default board  45,376 -> 17,493 buffers (1,530 ms part-cold -> 230 ms)
--   team pick (Lakers, p_limit 1000, the route's narrow case)  8,854 -> 8,530 (neutral)
-- The per-row LATERALs (latest snapshot per ranked row) stay nested loops — a LATERAL has no other plan.
--
-- EQUIVALENCE: same rows under both plans except exact TIES on both sort keys at a LIMIT cut (Top Shot 9 rows,
-- all discount 0.0 at a $0.18 ask, at the inner ranking's cut; All Day 3 rows, 0.0 at $0.30, the outer boundary).
-- Which tied edition fills the last slot was already plan-dependent; no ordering contract covers it.
-- Caution read first (database.md, the wmc x pinnacle_nft_map case): forcing hash there doubled the time because
-- the join spilled; here every side fits in memory (hash 852 kB / 982 kB, 1 batch).
--
-- REVERT:
--   alter function public.get_topshot_sniper_deals(numeric,numeric,text,text,text,integer,text[],text[],text,numeric) reset enable_nestloop reset enable_mergejoin;
--   alter function public.get_topshot_sniper_deals_v3(numeric,numeric,text,text,text,integer,text[],text[],text,numeric,text[],text[],boolean,text,text) reset enable_nestloop reset enable_mergejoin;
--   alter function public.get_allday_sniper_deals(numeric,numeric,text,text,text,integer,text) reset enable_nestloop reset enable_mergejoin;

alter function public.get_topshot_sniper_deals(numeric,numeric,text,text,text,integer,text[],text[],text,numeric)
  set enable_nestloop = off set enable_mergejoin = off;
alter function public.get_topshot_sniper_deals_v3(numeric,numeric,text,text,text,integer,text[],text[],text,numeric,text[],text[],boolean,text,text)
  set enable_nestloop = off set enable_mergejoin = off;
alter function public.get_allday_sniper_deals(numeric,numeric,text,text,text,integer,text)
  set enable_nestloop = off set enable_mergejoin = off;
