-- audit_20261112_panini_ask_cap_comment_names_every_tier — 2026-11-12 ~10:55 AM PT (Cowork cloud; Trevor: "Keep going and do it all").
-- The function's COMMENT still described the 10-26 LOW-only cap after 20261112183500 widened it to every sale tier.
-- Comment only: prosrc (and its pin) unchanged.
-- Revert: none needed.
comment on function public.fmv_snapshots_cap_panini_low_to_live_ask() is
  'BEFORE INSERT guard on fmv_snapshots (2026-10-26 #202; widened 2026-11-12): a Panini LOW / MEDIUM / HIGH / STALE fmv_usd is capped at the edition''s lowest live ask (listed serials re-read in 7 days, the panini_market_board ask) and algo_version gains _askcap. The name still says "low": it is pinned and triggered under it. 11-12 all-tier shadow read (14 d): on the 76 sales the wider cap changes, within ±25 % 11.8 -> 30.3, ratio 2.17 -> 1.40; no tier loses. Pin: supabase/tests/fmv_snapshots_cap_panini_low_to_live_ask.sql.';
