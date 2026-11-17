-- audit_20260826_upsert_pack_ask_state_change_detect_the_no_op_rewrite
--
-- ⚠ Applied to production via the Supabase MCP on 2026-08-26 PT (2026-08-27 03:00Z)
-- from a session with no git push. This file is the repo's record of it; the body
-- below is what is live. `migration-parity` matches on NAME.
--
-- `upsert_pack_ask_state` rewrote EVERY listed pack row on every tick, solely to
-- bump `last_checked_at`. Measured on the live table:
--
--   collection      listed   checked in 1h   CHANGED in 1h   changed in 24h
--   nba-top-shot     1,999    1,999 (100%)         7             77
--   nfl-all-day        982      982 (100%)         0             20
--
-- pg_stat_statements (window 15.05 d from the 2026-08-12 01:34Z reset):
--   562.6 calls/day · 386 MB WAL/day · 56,027 blocks dirtied/day · 587 s/day
--   99 blocks dirtied PER CALL, to maintain a 4 MB / 3,025-row table.
--
-- The worst WAL-per-unit-of-information ratio measured on this instance.
--
-- ── THE GUARD ──────────────────────────────────────────────────────────────────
-- One WHERE clause on the DO UPDATE. Every other column is provably unchanged when
-- it does not fire, because each CASE branch reduces to the existing value once
-- `is_listed = true` and `lowest_ask` is equal (prev_ask -> ELSE s.prev_ask,
-- ask_first_seen_at -> ELSE s.ask_first_seen_at, ask_changed_at ->
-- ELSE s.ask_changed_at, lowest_ask -> a value equal to itself, is_listed -> true).
-- ⚠ `pack_listing_id` is the one NOT covered by the ask comparison — it can change
-- while `lowest_ask` does not — so it is tested explicitly. Dropping it from the
-- predicate would silently stop tracking relistings at an unchanged price.
--
-- ── EQUIVALENCE, PROVEN OVER THE POPULATION ────────────────────────────────────
-- Both bodies were generated MECHANICALLY from `pg_get_functiondef()` (so the OLD
-- one could not drift by transcription), repointed at two independent copies of the
-- real table (3,025 rows each), and run on the same 2,000-row payload mutated to
-- exercise every branch: bulk unchanged · one changed ask · one changed
-- `pack_listing_id` AT THE SAME ASK · one relist · one brand-new dist · one drop.
--
--   return values                                     IDENTICAL
--   symmetric diff EXCLUDING last_checked_at          0 only-in-OLD, 0 only-in-NEW
--   symmetric diff INCLUDING last_checked_at          1,996 of 2,000 rows differ
--
-- ── WHY TOUCHING `last_checked_at` IS SAFE — six sources swept ─────────────────
-- repo grep 0 · pg_proc: 5 functions touch the table, only THIS one mentions the
-- column (it is the writer) · views: 3 read the table, none read the column ·
-- cron.job none · pg_trigger none · indexes 2, neither on it.
-- ⚠ The seventh source — a Cowork artifact — was NOT swept and cannot be from SQL.
-- That residual is why the column is kept and COMMENTed rather than dropped.
--
-- ⭐ The freshness answer never depended on it: `snapshot-pack-asks` writes a
-- `pipeline_runs` row on EVERY tick (277 in 24 h, plus 278 heartbeats), so
-- "when did we last sweep?" was already answerable there at one row per tick
-- instead of 2,981.
--
-- Verified after apply: proacl unchanged ({postgres=X/postgres,service_role=X/postgres}),
-- prosecdef true, proconfig search_path=public, column comment set, scratch schema dropped.
--
-- REVERT: re-apply the body without the WHERE clause and drop the COMMENT.
--   Restores 386 MB/day of WAL; there is no other difference.

DO $$
DECLARE
  v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'upsert_pack_ask_state';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'upsert_pack_ask_state is absent';
  END IF;

  -- Assert the PROPERTY (the no-op rewrite is guarded), not the exact spelling.
  IF v_src NOT ILIKE '%IS DISTINCT FROM EXCLUDED.lowest_ask%'
     OR v_src NOT ILIKE '%IS DISTINCT FROM EXCLUDED.pack_listing_id%' THEN
    RAISE EXCEPTION 'upsert_pack_ask_state lost its change-detection guard — it is '
                    'back to rewriting every listed row every tick (386 MB WAL/day)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_description d
    WHERE d.objoid = 'public.pack_ask_state'::regclass
      AND d.objsubid = (SELECT attnum FROM pg_attribute
                         WHERE attrelid = 'public.pack_ask_state'::regclass
                           AND attname = 'last_checked_at')
  ) THEN
    RAISE EXCEPTION 'the last_checked_at meaning-change comment is missing — a reader '
                    'would take a "last CHANGED" stamp for a freshness signal';
  END IF;
END $$;
