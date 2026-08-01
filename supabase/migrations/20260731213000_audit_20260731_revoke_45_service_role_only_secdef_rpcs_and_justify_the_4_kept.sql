-- Baseline audit of the SECDEF client-exec allowlist. Every one of the 49 rows
-- carried the same bulk note 'baseline 2026-07-20 (handoff item 4)' -- an import,
-- not per-function reasoning. This resolves each one against its actual callers.
--
-- METHOD (repo-side, exhaustive): every literal .rpc("name") call site, every
-- dynamic .rpc(var) call site, every direct /rest/v1/rpc/ fetch, and all of
-- components/**. Then, per call site, which client it uses.
--
-- KEY FACT that drove the result: in this repo `supabase` is NOT reliably the
-- anon client. lib/supabase.ts exports BOTH, and 9+ files import
-- `supabaseAdmin as supabase`, so an identifier named `supabase` is usually the
-- SERVICE ROLE client. Resolving each binding (rather than trusting the name)
-- showed the entire browser/anon + session RPC surface is exactly TWO functions;
-- components/** makes ZERO direct .rpc() calls.
--
-- KEPT (4) -- these grants are load-bearing; notes below record why:
--   get_trophy_slab_data_by_username(text)  anon      -- called through supabaseAnon
--   get_my_fan_teams()                      auth      -- called through the session client
--   serial_fmv_estimate(...) x2             anon+auth -- reached INDIRECTLY via the
--     SECURITY INVOKER fn get_wallet_moments_with_fmv (anon-executable) and via the
--     anon-SELECTable security_invoker view topshot_underpriced_serials_board; an
--     invoker caller runs the callee as the CALLER, so revoking breaks the chain.
--
-- REVOKED (45) -- every caller uses the service-role client, so the anon/authenticated
-- grants are unused reachability. Per CLAUDE.md, a SECDEF fn reached only by
-- service_role clients or by other SECDEF fns should be REVOKED, not allowlisted.
-- Bodies untouched, so all SQL invariant pins + the drift guard stay valid.
--
-- Two of the 45 are notable:
--   save_fast_break_lineup -- the 2026-07-31 ledger said it had a "legitimate
--     authenticated client path"; it does not. Its only caller
--     (app/api/fast-break/lineup/route.ts:176) uses `supabaseAdmin as supabase`
--     behind requireUser(). Its internal auth.uid() guard is unchanged and remains
--     correct; only the unused grant goes.
--   get_player_recent_sales -- no caller anywhere in the repo.
--
-- Revert: GRANT EXECUTE ON FUNCTION public.<sig> TO anon, authenticated;  for any
-- sig below, and re-INSERT its row into secdef_anon_exec_allowlist with note
-- 'baseline 2026-07-20 (handoff item 4)'.

REVOKE EXECUTE ON FUNCTION public.aggregate_saved_wallet_stats(uuid,text) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_active_challenges(text,uuid) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_allday_market_listings(numeric,numeric,text,text,text,integer) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_allday_set_detail(text,uuid,uuid) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_allday_set_progress(text,uuid) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_allday_sniper_deals(numeric,numeric,text,text,text,integer) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_challenge_plan(text,uuid) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_daily_marketplace_volume_pinnacle(timestamp with time zone) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_daily_marketplace_volume(uuid,timestamp with time zone) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_edition_high_offer(uuid) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_edition_insight_links(uuid,text) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_edition_offers(uuid,integer) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_edition_parallels(uuid) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_edition_special_serials(uuid) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_insider_signals_top_n(text,integer) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_insights_hub_stats() FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_moment_best_offer(uuid,integer) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_moment_detail(text) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_pack_ev_contributors(text,integer) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_pack_for_simulator(uuid,text) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_pack_lifecycle(text) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_pinnacle_edition_fmv_collapsed(text) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_player_recent_sales(uuid,integer) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_serial_offers(uuid,text[]) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_set_tier_mix(uuid) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_team_fan_leaderboard(league_t) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_teams_for_league(league_t) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_top_deals(text,text,text,numeric,numeric,boolean,integer,uuid) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_topshot_rookie_collectors(text,integer) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_topshot_set_completers() FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_topshot_set_detail(text,uuid,uuid) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_topshot_set_progress(text,uuid) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_topshot_sniper_deals(numeric,numeric,text,text,text,integer) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_trophy_slab_data(uuid) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_ufc_set_progress(text,uuid) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_user_top_owned_moments(uuid,integer,text,uuid) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_wallet_collection_snapshot(text) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_wallet_pack_history(text,text,text,integer,integer) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_wallet_pack_summary(text) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_wallet_squeeze_exposure(text) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_wallet_tc_report(text) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.optimize_fast_break_lineup(uuid,date) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.pinnacle_serial_fmv_estimate(integer,integer,numeric) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.resolve_moment_id(text) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.save_fast_break_lineup(uuid,text,uuid,date,jsonb,uuid,jsonb) FROM anon, authenticated, PUBLIC;

-- Their allowlist rows are now inert (the drift check only flags fns that ARE
-- client-executable). Prune rather than leave residue for the next auditor.
DELETE FROM public.secdef_anon_exec_allowlist
WHERE identity NOT IN (
  'get_trophy_slab_data_by_username(text)',
  'get_my_fan_teams()',
  'serial_fmv_estimate(uuid,integer,integer,text,numeric,text)',
  'serial_fmv_estimate(uuid,integer,integer,text,numeric,text,integer)');

-- Replace the bulk baseline note on the 4 survivors with a real per-function reason.
UPDATE public.secdef_anon_exec_allowlist SET note =
  'anon REQUIRED: read through the anon client (supabaseAnon) by app/api/profile/trophy-slabs (public branch) + app/api/profile/trophy-case/pdf. Public profile data, no PII beyond the username the caller supplied.'
WHERE identity = 'get_trophy_slab_data_by_username(text)';

UPDATE public.secdef_anon_exec_allowlist SET note =
  'authenticated REQUIRED (anon already revoked): read through the SESSION client in app/my-teams/page.tsx; the body is scoped by auth.uid() so a JWT caller only ever sees its own follows.'
WHERE identity = 'get_my_fan_teams()';

UPDATE public.secdef_anon_exec_allowlist SET note =
  'anon+authenticated REQUIRED INDIRECTLY: reached via the SECURITY INVOKER fn get_wallet_moments_with_fmv and the anon-SELECTable security_invoker view topshot_underpriced_serials_board. An invoker caller executes the callee AS THE CALLER, so revoking breaks the wallet-moments read and the public board. Pure pricing math, no identity data.'
WHERE identity LIKE 'serial_fmv_estimate(%';
