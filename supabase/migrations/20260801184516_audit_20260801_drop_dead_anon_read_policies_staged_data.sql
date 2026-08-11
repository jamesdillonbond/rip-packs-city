-- ============================================================================
-- audit_20260801_drop_dead_anon_read_policies_staged_data   (F-9, P3)
--
-- WHAT WAS EXPOSED
--   Seven tables carried SELECT policies with qual=true for anon/authenticated:
--     panini_card_serials   panini_serials_anon_read     {anon,authenticated}
--     panini_editions       panini_editions_anon_read    {anon,authenticated}
--     panini_fmv_snapshots  panini_fmv_anon_read         {anon,authenticated}
--     panini_pack_state     panini_pack_state_anon_read  {anon,authenticated}
--     panini_serial_premium panini_premium_anon_read     {anon,authenticated}
--     candy_offers          candy_offers_public_read     {anon,authenticated}
--     watchlist_items       watchlist_items_select_all   {public}
--
--   SPLIT VERDICT — these are NOT all the same state (this corrects the premise
--   that none of the seven were breached):
--
--   (a) The 5 panini_* tables + candy_offers are NOT breached. The 2026-07-19
--       revoke holds; the policies are DEAD (unreachable without a grant).
--       Measured 2026-08-01: SET ROLE anon; SELECT count(*) -> DENIED
--       (insufficient_privilege) on all six, and
--       has_table_privilege('anon', <tbl>, 'SELECT') = false.
--       Dropping the policies is defense-in-depth: it removes the trip-wire
--       where a single future GRANT (or a Supabase default-grant regression)
--       silently re-opens the 2026-07-19 incident, which exposed 1,011
--       collector usernames via panini_card_serials.
--
--   (b) watchlist_items IS breached — it was still anon-SELECTable.
--       Measured 2026-08-01 BEFORE this migration:
--         SET ROLE anon; SELECT count(*) FROM watchlist_items -> READABLE, 0 rows
--         has_table_privilege('anon','public.watchlist_items','SELECT')  = true
--         has_table_privilege('authenticated', ...)                       = true
--       It is empty today, so nothing has leaked — but it is a user-owned
--       table keyed by owner_key, and the grant would expose every user's
--       watchlist the moment the feature ships. This migration revokes the
--       grant as well as dropping the policy.
--
-- WHAT WAS VERIFIED BEFORE DROPPING/REVOKING
--   1. RLS DOES NOT GATE THE LIVE READERS — pg_roles shows service_role and
--      postgres both have rolbypassrls = true, so every server-side reader
--      (supabaseAdmin) bypasses RLS entirely and is unaffected by dropping a
--      policy. This is the check that makes the drop safe on the panini_* set:
--      those tables have NO other SELECT policy, so under a non-bypassing role
--      the drop would have broken reads.
--   2. PANINI IS PUBLIC BUT READS AS SERVICE ROLE — PANINI_PUBLIC=true since
--      2026-08-01 and /insights/panini-squeeze is live, but the board + its
--      public JSON read through supabaseAdmin, never the anon client; the anon
--      DENIED probe above confirms the surface already runs with no anon grant.
--      Same for candy_offers (fed by the candy-offers-indexer route, service role).
--   3. watchlist_items CALLER SWEEP — the only in-repo reader is
--      app/api/profile/watchlist/route.ts, which imports
--      `supabaseAdmin as supabase` (service role, NOT the anon client despite
--      the identifier name). CLAUDE.md records the table as service-role-writes
--      since 2026-04-27.
--   4. watchlist_items INVOKER SWEEP — zero views and zero functions in the
--      public schema reference watchlist_items, so no SECURITY INVOKER chain
--      keeps the anon grant load-bearing.
--   5. service-role policies are retained where they exist
--      (watchlist_items_service_all), and are redundant-but-harmless given
--      rolbypassrls.
--
-- REVERT SQL (exact)
--   CREATE POLICY panini_serials_anon_read ON public.panini_card_serials
--     FOR SELECT TO anon, authenticated USING (true);
--   CREATE POLICY panini_editions_anon_read ON public.panini_editions
--     FOR SELECT TO anon, authenticated USING (true);
--   CREATE POLICY panini_fmv_anon_read ON public.panini_fmv_snapshots
--     FOR SELECT TO anon, authenticated USING (true);
--   CREATE POLICY panini_pack_state_anon_read ON public.panini_pack_state
--     FOR SELECT TO anon, authenticated USING (true);
--   CREATE POLICY panini_premium_anon_read ON public.panini_serial_premium
--     FOR SELECT TO anon, authenticated USING (true);
--   CREATE POLICY candy_offers_public_read ON public.candy_offers
--     FOR SELECT TO anon, authenticated USING (true);
--   CREATE POLICY watchlist_items_select_all ON public.watchlist_items
--     FOR SELECT TO public USING (true);
--   GRANT SELECT ON public.watchlist_items TO anon, authenticated;
-- ============================================================================

-- (a) dead policies on already-revoked staged/unlaunched data
DROP POLICY IF EXISTS panini_serials_anon_read     ON public.panini_card_serials;
DROP POLICY IF EXISTS panini_editions_anon_read    ON public.panini_editions;
DROP POLICY IF EXISTS panini_fmv_anon_read         ON public.panini_fmv_snapshots;
DROP POLICY IF EXISTS panini_pack_state_anon_read  ON public.panini_pack_state;
DROP POLICY IF EXISTS panini_premium_anon_read     ON public.panini_serial_premium;
DROP POLICY IF EXISTS candy_offers_public_read     ON public.candy_offers;

-- (b) watchlist_items — live grant hole: revoke AND drop
REVOKE SELECT ON public.watchlist_items FROM anon, authenticated;
DROP POLICY IF EXISTS watchlist_items_select_all ON public.watchlist_items;

COMMENT ON TABLE public.watchlist_items IS
  'User-owned watchlist rows (keyed by owner_key). PRIVATE: service-role only. '
  'anon + authenticated SELECT revoked and the qual=true policy dropped '
  '2026-08-01 (audit_20260801_drop_dead_anon_read_policies_staged_data) — the '
  'table was anon-readable while empty, which would have exposed every user''s '
  'watchlist once the feature ships. Read only via supabaseAdmin.';