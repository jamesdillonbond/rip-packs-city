-- backfill_allday_edition_jersey(jsonb) is a SECURITY DEFINER bulk writer over
-- editions.jersey_number (nfl_all_day) with NO authorization check of any kind --
-- any authenticated user could rewrite jersey numbers on any AllDay edition, which
-- feeds the jersey-match arm of the public special-serials board.
--
-- Its only caller is app/api/cron/allday-badge-ingest/route.ts via supabaseAdmin
-- (service_role). 0 DB function callers, 0 cron.job callers. The `authenticated`
-- grant is drift: the defining migration (20260710181203) revoked ALL from PUBLIC
-- and anon and granted EXECUTE to service_role only.
--
-- Function body UNCHANGED -- the SQL invariant pin
-- (supabase/tests/backfill_allday_edition_jersey.sql) and its drift-guard entry
-- still point at 20260710181203 and stay valid.
--
-- Revert:
--   GRANT EXECUTE ON FUNCTION public.backfill_allday_edition_jersey(jsonb) TO authenticated;
--   INSERT INTO public.secdef_anon_exec_allowlist (identity, note, approved_at)
--   VALUES ('backfill_allday_edition_jersey(jsonb)', 'baseline 2026-07-20 (handoff item 4)', '2026-07-21');

REVOKE EXECUTE ON FUNCTION public.backfill_allday_edition_jersey(jsonb) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.backfill_allday_edition_jersey(jsonb) FROM PUBLIC;

-- The drift sentinel only flags functions that ARE client-executable, so the
-- allowlist row is now inert. Prune it rather than leave a stale entry.
DELETE FROM public.secdef_anon_exec_allowlist
WHERE identity = 'backfill_allday_edition_jersey(jsonb)';
