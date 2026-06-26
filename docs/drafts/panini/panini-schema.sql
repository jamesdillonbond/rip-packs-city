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
  pulled_count       integer default 0,                        -- circulation: cards opened out of packs (Plane A feed)
  still_in_packs     integer generated always as (greatest(coalesce(mint_cap,0) - coalesce(pulled_count,0), 0)) stored,
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
--    COMMENTED OUT: needs the WC2026 bridge contract address + deploy block,
--    and the WC2026 set is NOT bridge-enabled yet (launch = Bad Eggs only).
--    Apply ONLY once the set is bridgeable and the contract is known.
-- ---------------------------------------------------------------------------
-- insert into public.evm_chains (chain_id, slug, name, rpc_url, explorer_url, native_currency_symbol, is_active)
-- values (1, 'ethereum_mainnet', 'Ethereum Mainnet', '<ETH_RPC_URL>', 'https://etherscan.io', 'ETH', true)
-- on conflict do nothing;
--
-- insert into public.evm_nft_contracts (chain_id, contract_address, label, start_block, is_active)
-- values (1, '<PANINI_BRIDGE_CONTRACT_TBD>', 'panini_blockchain', <DEPLOY_BLOCK_TBD>, true)
-- on conflict do nothing;

-- ---------------------------------------------------------------------------
-- ROLLBACK (full teardown if abandoned):
--   drop table if exists public.panini_pack_state;
--   drop table if exists public.panini_fmv_snapshots;
--   drop table if exists public.panini_editions;
--   -- (do NOT delete the panini_blockchain collections row — it predates this)
-- ---------------------------------------------------------------------------
