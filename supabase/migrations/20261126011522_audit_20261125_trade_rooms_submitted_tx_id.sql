-- audit_20261125_trade_rooms_submitted_tx_id
--
-- 2026-11-25 (Claude Code cloud; Trevor: "work through everything you can in this thread, leaving nothing unresolved").
-- WHY. trading.md Open 6 item 1 (11-24 security review). The initiator's browser learns the swap's tx id the moment
-- the wallet submits it, but the room stored nothing until the client's `sealed` call after the seal was read. A tab
-- closed in between left the room honestly `signing` (cancel refused) and UNSEALABLE: no tx id to verify. The client
-- also told a SealUnconfirmed user to "use Check the chain again below" on a signing room, where that button is
-- never rendered.
-- WHAT. One nullable column, written by the new `submitted` action while the room is `signing`. `verify` seals the
-- room from it ONLY when the chain shows every Moment landed AND assertSealTx proves the id is this room's trade
-- (final, error-free, both wallets, script + arguments). It is a pointer for that check, never itself a seal.
-- REVERT: ALTER TABLE public.trade_rooms DROP COLUMN submitted_tx_id;

ALTER TABLE public.trade_rooms
  ADD COLUMN IF NOT EXISTS submitted_tx_id text
  CHECK (submitted_tx_id IS NULL OR submitted_tx_id ~ '^[0-9a-f]{64}$');
