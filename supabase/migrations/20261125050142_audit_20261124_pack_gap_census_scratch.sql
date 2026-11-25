-- Scratch census table for the 2026-11-24 pack-information gap audit (Trevor: "make sure there are no gaps anywhere in this pack information"). Read-only snapshot of get_wallet_pack_history rows; safe to drop.
create table if not exists public.audit_20261124_pack_gap_census (
  wallet text not null,
  run text not null,
  pack jsonb not null,
  captured_at timestamptz not null default now()
);
alter table public.audit_20261124_pack_gap_census enable row level security;
revoke all on public.audit_20261124_pack_gap_census from anon, authenticated;