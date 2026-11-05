-- audit_20261104: Trade Block lines show RPC's FMV at any confidence (Trevor, 2026-11-04: the
-- picker read "not priced" on every LOW / STALE / ASK_ONLY row while the collection page shows
-- those FMVs; shipped in a54f425). An ask-derived FMV must still say so ("from asks",
-- lib/fmv-basis.ts), so each stored line carries that one bit. NULL = stored before this change
-- (basis unknown, no marker). The confidence tier itself is still never stored on a line.
-- Additive, nullable, no backfill (zero open listings / pending proposals on 2026-11-04).
alter table public.trade_block_items add column if not exists fmv_from_asks boolean;
alter table public.trade_block_proposal_items add column if not exists fmv_from_asks boolean;
comment on column public.trade_block_items.fmv_from_asks is 'true = fmv_usd is ask-derived (ASK_ONLY), rendered "from asks"; null = line stored before 2026-11-04.';
comment on column public.trade_block_proposal_items.fmv_from_asks is 'true = fmv_usd is ask-derived (ASK_ONLY), rendered "from asks"; null = line stored before 2026-11-04.';
