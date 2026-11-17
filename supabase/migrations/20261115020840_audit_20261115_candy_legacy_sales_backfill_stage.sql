-- 2026-11-14 PT. Candy legacy collections: one-time backfill of Magic Eden sales the
-- collections-market lane skipped. Its first walk per collection looked back only 30 days
-- (FIRST_WALK_LOOKBACK_MS) and ran 11-08/09, inside Candy's 10-12 -> 11-06 market lock, so
-- every pre-lock sale ME still serves (Aug-Oct 2026) was never offered to the drain.
-- This table holds the ME buyNow rows pulled 11-14 (353 symbols, offsets <= 15,000).
-- They are parked through candy_park_unresolved_sale (reason queued_collections_walk) so the
-- candy-sales-indexer drain stays the ONE writer of Candy `sales`.
-- Revert: rows written from this backfill are sales whose transaction_hash is in this table
-- and whose candy_sales_unresolved row has skip_reason 'queued_collections_walk' and
-- first_seen_at >= the park time recorded in parked_at.
create table if not exists public.audit_20261115_candy_legacy_sales_backfill (
  signature text not null,
  token_mint text not null,
  block_time timestamptz not null,
  price_sol numeric,
  buyer text,
  seller text,
  me_symbol text not null,
  already_known text,          -- 'sales' | 'queue' | null (new)
  parked_at timestamptz,
  primary key (signature, token_mint)
);
alter table public.audit_20261115_candy_legacy_sales_backfill enable row level security;
revoke all on public.audit_20261115_candy_legacy_sales_backfill from anon, authenticated;