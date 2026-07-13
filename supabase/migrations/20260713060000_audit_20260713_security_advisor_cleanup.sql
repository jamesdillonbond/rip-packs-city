-- Security-advisor cleanup (resolves all 4 ERRORs + 11 fixable WARNs).
--
-- Verified before applying:
--   * All 4 views + all 9 MVs below are read ONLY server-side via the
--     service_role client (supabaseAdmin / SUPABASE_SERVICE_ROLE_KEY).
--     service_role has rolbypassrls=true, so security_invoker / grant changes
--     do not affect any existing read path. No anon/authenticated PostgREST
--     reader exists in the codebase.
--   * check_secdef_anon_execute_violations() = [] — the 115 remaining
--     "SECDEF executable by anon/authenticated" WARNs are intentional public
--     RPCs (deliberately NOT touched here).
--
-- Reversal at the bottom of this comment block:
--   ALTER VIEW ... RESET (security_invoker);  GRANT SELECT ... TO anon, authenticated;
--   ALTER FUNCTION ... RESET search_path;
--   GRANT SELECT ON <mv> TO anon, authenticated;

-- 1) ERROR: security_definer_view (4) ---------------------------------------
-- Make the views honor the querying role's RLS (security_invoker) and drop the
-- vestigial anon/authenticated API exposure. These are internal EV-pipeline /
-- ops-health surfaces, never meant to be read directly by the public REST role.
ALTER VIEW public.topshot_pack_ev_targets SET (security_invoker = on);
ALTER VIEW public.pack_ev_latest          SET (security_invoker = on);
ALTER VIEW public.v_rpc_trust_health      SET (security_invoker = on);
ALTER VIEW public.pack_table_rows         SET (security_invoker = on);

REVOKE SELECT ON public.topshot_pack_ev_targets FROM anon, authenticated;
REVOKE SELECT ON public.pack_ev_latest          FROM anon, authenticated;
REVOKE SELECT ON public.v_rpc_trust_health      FROM anon, authenticated;
REVOKE SELECT ON public.pack_table_rows         FROM anon, authenticated;

-- 2) WARN: function_search_path_mutable (2) ---------------------------------
-- Pin a non-mutable search_path so the functions can't be hijacked via a
-- role-mutable search_path. Neither is SECURITY DEFINER, but the linter (and
-- good hygiene) still wants an explicit path.
ALTER FUNCTION public.badge_editions_block_topshot_uuid_key()
  SET search_path = 'public', 'pg_temp';
ALTER FUNCTION public.resolve_ufc_edition_by_studio_meta(text, bigint)
  SET search_path = 'public', 'pg_temp';

-- 3) WARN: materialized_view_in_api (9) -------------------------------------
-- Remove these analytics/EV MVs from the anon-facing PostgREST surface. Every
-- consumer reads them via service_role (or via a SECURITY DEFINER RPC that runs
-- as owner), so revoking anon/authenticated SELECT changes no live read path.
REVOKE SELECT ON public.mv_insights_new_collectors_summary   FROM anon, authenticated;
REVOKE SELECT ON public.topshot_rookie_collector_leaderboard_mv FROM anon, authenticated;
REVOKE SELECT ON public.mv_insights_new_collectors_spend     FROM anon, authenticated;
REVOKE SELECT ON public.mv_insights_new_collectors_cohorts   FROM anon, authenticated;
REVOKE SELECT ON public.topshot_set_completers_mv            FROM anon, authenticated;
REVOKE SELECT ON public.mv_pack_ev_latest                    FROM anon, authenticated;
REVOKE SELECT ON public.mv_allday_pack_ev_corrected          FROM anon, authenticated;
REVOKE SELECT ON public.mv_topshot_set_play_catalog          FROM anon, authenticated;
REVOKE SELECT ON public.mv_insights_new_collectors_gateway   FROM anon, authenticated;
