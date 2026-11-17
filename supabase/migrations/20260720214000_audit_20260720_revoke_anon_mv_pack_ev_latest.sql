-- Item 2 of the 2026-07-20 security-advisor cleanup handoff.
-- Advisor: materialized_view_in_api. Verified no anon PostgREST read path exists
-- (all 8 readers of pack_table_rows / mv_pack_ev_latest use service_role); the
-- public pack board is served via service_role API routes, so this cannot break it.
-- Trevor approved the revoke 2026-07-20.
-- Revert: GRANT SELECT ON public.mv_pack_ev_latest TO anon, authenticated;
REVOKE SELECT ON public.mv_pack_ev_latest FROM anon, authenticated;
