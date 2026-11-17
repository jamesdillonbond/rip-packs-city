-- The `portfolios` anon write-grant is dead residue of the removed portfolio feature (inbox
-- 2026-09-19T0117Z; handoff 2026-09-19 thread-close open item 5). Applied from Cowork cloud
-- 2026-09-19 ~5:2x PM PT. ⚠ That session's push tooling is its own concern; this file commits
-- as usual.
--
-- MEASURED before writing (all re-taken live 2026-09-19 5:2x PM PT):
--   * `portfolios` holds 0 rows; `portfolio_moments` (its only FK) holds 0 rows; zero repo
--     references outside the table name inside snapshot_all_user_portfolios' NAME.
--   * anon AND authenticated held INSERT, UPDATE, DELETE (plus SELECT) — the only member of the
--     anon write-grant set with DELETE/UPDATE, and its RLS policy `own_portfolio` (cmd ALL,
--     {public}) compares wallet_address to a `wallet` JWT claim that NOTHING sets, so it fails
--     closed by accident of a dead feature, not by design.
--   * The one pg_cron job in this table's neighbourhood, jobid 490 `rpc-portfolio-snapshot-retry`
--     (postgres), runs snapshot_all_user_portfolios(), whose body (read 2026-09-19) writes
--     `portfolio_snapshots` only and never touches `portfolios`. postgres is also the table
--     OWNER, so this REVOKE cannot orphan it (CLAUDE.md's orphaned-caller rule, checked, n/a).
--
-- Deliberately NOT dropped: retiring `portfolios` + `portfolio_moments` is destructive and is
-- Trevor's call (option b in the filing). This is option (a): the grant goes, the table stays.
--
-- EXIT CONDITION: the anon write-grant set reads FOUR objects, all INSERT-only
-- (email_subscribers, funnel_events, outbound_clicks, support_conversations), and jobid 490's
-- next tick (11:17Z) still writes a portfolio_snapshots row.
--   ✅ First half verified 5:18 PM PT, same minute as the apply: the set reads exactly
--      email_subscribers:INSERT, funnel_events:INSERT, outbound_clicks:INSERT,
--      support_conversations:INSERT.
-- FALSIFIER: jobid 490 logs a permission error, or portfolio_snapshots stops growing.
--
-- REVERT (restores the dead grant exactly as it was):
--   GRANT INSERT, UPDATE, DELETE ON public.portfolios TO anon, authenticated;

REVOKE INSERT, UPDATE, DELETE ON public.portfolios FROM PUBLIC, anon, authenticated;

DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n
    FROM information_schema.role_table_grants g
   WHERE g.table_schema = 'public' AND g.table_name = 'portfolios'
     AND g.grantee IN ('anon', 'authenticated')
     AND g.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'portfolios still carries % anon/authenticated write grant(s)', v_n;
  END IF;
  IF NOT has_table_privilege('postgres', 'public.portfolios', 'INSERT') THEN
    RAISE EXCEPTION 'postgres lost INSERT on portfolios — jobid 490 neighbourhood';
  END IF;
END $$;
