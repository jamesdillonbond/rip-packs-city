-- audit_20261102: TRADE BLOCK MATCH NOTICES — at most one "a new listing fits something
-- you hold" email per collector per Pacific day (docs/strategy/features/trading.md §3, v2).
-- A row is the CLAIM on that day's notice: inserted before the send, so two listings
-- posted in the same minute cannot both email the same collector (the PRIMARY KEY makes
-- the second insert a 23505, which the sender reads as "already notified today").
--
-- `user_id` is the recipient, named so delete_user_account's catalog walk removes it.
-- Service role only. One small row per recipient-day; prune_trade_block() clears old ones.
--
-- Revert: DROP TABLE public.trade_block_match_notices;

CREATE TABLE IF NOT EXISTS public.trade_block_match_notices (
  user_id     uuid NOT NULL,
  -- the Pacific calendar day of the notice
  day         date NOT NULL,
  listing_id  uuid REFERENCES public.trade_block_listings (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);

ALTER TABLE public.trade_block_match_notices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trade_block_match_notices FROM anon, authenticated;

COMMENT ON TABLE public.trade_block_match_notices IS
  'Trade Block match emails (2026-11-02): one claim row per recipient per Pacific day, inserted before the send. Service role only.';
