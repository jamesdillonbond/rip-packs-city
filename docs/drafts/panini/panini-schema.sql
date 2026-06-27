-- ============================================================================
-- Panini Blockchain — DRAFT schema (NOT APPLIED). Do NOT run until Panini's
-- sequenced go-live. Project bxcqstmqfzmuolpuynti.
-- Mirrors the Pinnacle side-table precedent (pinnacle_editions / pinnacle_fmv_snapshots)
-- because Panini's parallel/insert schema diverges from the generic editions table.
-- Honors RPC conventions: RLS ON, anon SELECT-only, service_role writes,
-- security_invoker views, no anon EXECUTE on SECDEF fns.
-- Collection: panini_blockchain = d1a0a7f5-609a-49f4-a1a7-4eaac55b020b
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Editions (one row per player × parallel/insert)
-- ---------------------------------------------------------------------------
create table if not exists public.panini_editions (
  id                 text primary key,                         -- Panini edition id (from feed)
  external_id        text not null,                            -- stable RPC key e.g. '<setId>:<playerId>:<parallelId>'
  collection_id      uuid not null default 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b',
  player_name        text,
  nation             text,
  set_name           text,                                     -- e.g. 'Base', 'Color Blast', 'Scorers Club'
  parallel           text,                                     -- 'Silver','Red','Blue','Cracked Ice','Gold','Zebra','Black','Aguila',...
  parallel_family    text,                                     -- base | fotl_exclusive | tiered_insert | non_tiered_insert | craft | challenge
  rarity_label       text,                                     -- Panini label: Uncommon/Rare/Ultra Rare/Epic/Legendary
  tier               public.tier_type,                         -- mapped: COMMON/RARE/LEGENDARY/ULTIMATE
  mint_cap           integer,                                  -- serial cap (#/N)
  pulled_count       integer default 0,                        -- = getCardMarketStats.with_collectors_count (pulled / owned)
  still_in_packs     integer default 0,                        -- = getCardMarketStats.unopened_pack_count — AUTHORITATIVE (fed by the feed, NOT derived; cap = pulled + still_in_packs + burned)
  for_sale_count     integer default 0,                        -- = getCardMarketStats.for_sale_count (currently listed)
  burned_count       integer default 0,                        -- = getCardMarketStats.burned_count
  is_fotl_exclusive  boolean default false,
  serial_low_ask_usd numeric,                                  -- floor ask if exposed
  thumbnail_url      text,
  video_url          text,
  first_minted_at    timestamptz,
  last_seen_at       timestamptz,
  created_at         timestamptz default now(),
  updated_at         timestamptz default now(),
  unique (external_id, collection_id)
);
create index if not exists idx_panini_editions_player   on public.panini_editions (player_name);
create index if not exists idx_panini_editions_set       on public.panini_editions (set_name);
create index if not exists idx_panini_editions_squeeze   on public.panini_editions (still_in_packs) where mint_cap is not null;

alter table public.panini_editions enable row level security;
drop policy if exists panini_editions_anon_read on public.panini_editions;
create policy panini_editions_anon_read on public.panini_editions for select to anon, authenticated using (true);
-- writes: service_role only (no anon/auth INSERT/UPDATE/DELETE policy => denied under RLS)

-- ---------------------------------------------------------------------------
-- 2. FMV snapshots (own table, per the Pinnacle precedent — keep out of the
--    uuid-keyed fmv_snapshots partition set). History rows are intentional.
-- ---------------------------------------------------------------------------
create table if not exists public.panini_fmv_snapshots (
  id            bigint generated always as identity primary key,
  edition_id    text not null references public.panini_editions(id) on delete cascade,
  fmv_usd       numeric,
  confidence    public.fmv_confidence not null,                -- HIGH/MEDIUM/LOW/ASK_ONLY/SALES_ONLY/STALE/NO_DATA
  serial_fmv    jsonb,                                         -- optional per-serial estimate payload
  algo_version  text not null default 'panini-1.0.0',
  computed_at   timestamptz not null default now()
);
create index if not exists idx_panini_fmv_edition_time on public.panini_fmv_snapshots (edition_id, computed_at desc);

alter table public.panini_fmv_snapshots enable row level security;
drop policy if exists panini_fmv_anon_read on public.panini_fmv_snapshots;
create policy panini_fmv_anon_read on public.panini_fmv_snapshots for select to anon, authenticated using (true);

-- ---------------------------------------------------------------------------
-- 3. Pack state (FOTL / Hobby residual — pack-level "still in packs" + EV inputs)
--    Per-edition residual lives on panini_editions.still_in_packs; this is the
--    pack-level rollup that powers pack-EV + the "% packs ripped" headline.
-- ---------------------------------------------------------------------------
create table if not exists public.panini_pack_state (
  id              text primary key,                            -- pack/dist id from feed
  collection_id   uuid not null default 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b',
  pack_type       text,                                        -- 'fotl' | 'hobby' | 'craft'
  price_usd       numeric,
  cards_per_pack  integer,
  packs_total     integer,
  packs_remaining integer,
  gross_ev_usd    numeric,                                     -- computed: Σ edition_fmv × per-slot pull prob
  net_ev_usd      numeric,                                     -- gross_ev − price
  updated_at      timestamptz default now()
);
alter table public.panini_pack_state enable row level security;
drop policy if exists panini_pack_state_anon_read on public.panini_pack_state;
create policy panini_pack_state_anon_read on public.panini_pack_state for select to anon, authenticated using (true);

-- ---------------------------------------------------------------------------
-- 4. Plane B — Ethereum/OpenSea bridge registration (reuse the evm_* indexer).
--    DISCOVERED 2026-06-27 via the marketplace getPublicChainSettings call:
--      bridge contract   = 0x23ae7a05f598fc234ee9dbef04033080dea8ab19  (Ethereum mainnet, chain_id 1)
--      OpenSea collection = paniniblockchain   (explorer: etherscan.io)
--      bridge is ACTIVE (settings.network_provider_active = true)
--    This is the MASTER Panini bridge contract — every optionally-bridged Panini card
--    (all sports/sets) lives in this one contract; the WC2026 Prizm cards, IF bridged,
--    are token_ids within it. OpenSea floor ~0.0008 ETH = THIN secondary volume, so
--    Plane B is a provenance / secondary-sales backfill, NOT the primary source
--    (circulation + pack-state stay on the marketplace API = Plane A).
--    Still to confirm before wiring (both blocked from Cowork — Etherscan/OpenSea):
--      (a) token standard (ERC-721 vs 1155) + the contract's deploy block (start_block),
--      (b) whether WC2026 Prizm token_ids are actually bridged in yet + how many.
--    Apply ONLY at go-live, and only after an ETH-mainnet RPC is configured for the
--    evm indexer (new infra cost — weigh against the thin volume).
-- ---------------------------------------------------------------------------
-- insert into public.evm_chains (chain_id, slug, name, rpc_url, explorer_url, native_currency_symbol, is_active)
-- values (1, 'ethereum_mainnet', 'Ethereum Mainnet', '<ETH_MAINNET_RPC_URL>', 'https://etherscan.io', 'ETH', true)
-- on conflict do nothing;
--
-- insert into public.evm_nft_contracts (chain_id, contract_address, label, start_block, is_active)
-- values (1, '0x23ae7a05f598fc234ee9dbef04033080dea8ab19', 'panini_blockchain', <DEPLOY_BLOCK — etherscan lookup, ~Mar 2026 bridge launch>, true)
-- on conflict do nothing;

-- ---------------------------------------------------------------------------
-- ROLLBACK (full teardown if abandoned):
--   drop table if exists public.panini_pack_state;
--   drop table if exists public.panini_fmv_snapshots;
--   drop table if exists public.panini_editions;
--   -- (do NOT delete the panini_blockchain collections row — it predates this)
-- ---------------------------------------------------------------------------
