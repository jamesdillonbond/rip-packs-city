RPC Claude Code handoff — surface the special-serial owners view (2026-06-19)

CONTEXT

Cowork shipped a new view live this session: public.topshot_special_serial_owners (migration audit_20260619_topshot_special_serial_owners_view). It returns the current holder (among tracked wallets, deduped to latest last_seen_at) of every canonical Top Shot special serial. Verified: 5,927 rows / 4,517 editions / 167 holders (2,522 #1 / 1,513 perfect / 1,892 jersey), security_invoker=on, check_public_security_invariants()=[]. Columns: edition_id (uuid), edition_key (text setID:playID), player_name, set_name, tier, series, team_name, circulation_count, serial (int), tag ('#1'|'perfect'|'jersey'), holder_address, nft_id, holder_seen_at, edition_fmv (numeric, the wmc-cached edition FMV).

This view is currently consumable only by service_role (it reads wmc, which is not anon/authenticated-readable, so a security_invoker SELECT returns nothing for those roles). To surface it, the data must go through a SECDEF RPC (service_role rights) exposed by a route — the standard RPC /api/public pattern. This handoff builds that surface. Nothing here touches FMV/pricing/auth/ingest logic.

Per-edition last-sale of a specific serial is already available via get_edition_special_serials(edition_id) (returns serial, tag, last_sale_usd, last_sold_at, holder_address, nft_id) — use it for the drill-down, not the board (it's per-edition).

Claude Code's direct file inspection wins over this doc and over project_knowledge_search on any disagreement — verify every path and the live view/RPC shapes before editing; adapt to the actual file shape.

ITEM 1 (primary) — backing SECDEF RPC + a Special Serial Owners surface

1a. New SECDEF RPC get_special_serial_owners_board(...) (service_role rights, granted to anon + authenticated for the route to call; security-reviewed). It SELECTs from public.topshot_special_serial_owners with optional filters: p_tag ('#1'|'perfect'|'jersey'|NULL), p_tier (NULL=all), p_player (ilike, NULL), p_holder (exact wallet, NULL), p_sort ('fmv'|'recent'), p_limit (clamp <=200), p_offset. Default order: edition_fmv DESC NULLS LAST. Because it is SECDEF it must: SET search_path='public'; be created then REVOKE EXECUTE FROM PUBLIC and GRANT EXECUTE TO anon, authenticated, service_role explicitly; and you must re-run check_secdef_anon_execute_violations() after — it is EXPECTED to now list this fn (it's an intentional public read), so confirm the list contains ONLY this new fn and nothing unexpected, and that the fn is read-only (no INSERT/UPDATE/DELETE). This is the one SECDEF-anon read we are intentionally adding.

1b. Route: app/api/public/special-serial-owners/route.ts (mirror an existing /api/public/insights/* route — e.g. the squeeze or serial-premiums route). Calls the RPC, 15-min s-maxage cache, validates/clamps params (400 on invalid tier/tag), returns rows. Add the path to proxy.ts isPublicPath (GET/HEAD only) and to app/sitemap.ts IF the page is public (see the privacy decision below).

1c. Page: a board listing special serials — player/set/tier, serial + tag chip, holder (truncated wallet linking to the existing /profile/<addr>, consistent with moment/profile surfaces), edition_fmv, and a drill-down to the edition page. Filters: tag, tier, player search. Follow the rpc-insights-qa checklist (sitemap, param-stripped canonical, OG 1200x630, WebApplication JSON-LD, brand tokens, honest empty state, 15-min ISR).

PRIVACY DECISION (Trevor's call — do NOT default to fully public without confirming): this surface is effectively a directory of who holds every #1/perfect/jersey. Wallets are public on-chain and RPC already shows holders on moment/profile pages, so a public board is consistent — but a dedicated rich-list is more pointed. Recommended default for this ship: gate the PAGE behind the existing auth funnel (NOT in proxy.ts isPublicPath, NOT in sitemap) so it's a logged-in-user feature, and leave a one-line switch (add the isPublicPath + sitemap entries) to make it a public SEO board once Trevor signs off. Build the RPC + route regardless; only the public-exposure switch is gated on Trevor.

ITEM 2 (secondary) — concierge tool

Add a tool to app/api/support-chat/route.ts that answers special-serial ownership questions ("who owns the #1 of <player> <set>?", "what special serials does <wallet> hold?") by calling the new RPC (or selecting the view via the service-role client). Mirror the existing concierge tool pattern (the file has ~5 tools; match their shape, same-turn tool-call rule, no memory-answered values). Read-only.

ITEM 3 (small) — edition page cross-link

On the edition page special-serials section (it already renders holders via get_edition_special_serials), add a link to the new board filtered to that player. Cosmetic; skip if it complicates the page.

REVERT PATHS
- Item 1a RPC: DROP FUNCTION public.get_special_serial_owners_board(...);
- Items 1b/1c/2/3 code: git revert the commit(s).
- The view itself (already live, leave it): DROP VIEW IF EXISTS public.topshot_special_serial_owners; (only if abandoning entirely).

GUARDRAILS (repeat every time)
- Work directly on main. NO branches, NO PRs. If a claude/* branch is pre-checked-out, switch to main first.
- Commit via PowerShell git on Windows (Git Bash git commit can silently no-op). Re-verify with git rev-list --count origin/main..HEAD (expect 0).
- curl fails silently in Git Bash for Vercel REST — use PowerShell Invoke-WebRequest.
- Vercel Pro maxDuration hard cap is 800s.
- CRLF: full-file writes or findIndex on split lines, not string-replace patches.
- After the SECDEF RPC: re-run check_secdef_anon_execute_violations() and check_public_security_invariants() — confirm only the intended new fn appears and base-table invariants stay 0.
- Don't broad-read secret-bearing console pages.

EXPECTED END STATE
get_special_serial_owners_board RPC live (service_role-defined, anon-executable, read-only, security-reviewed), /api/public/special-serial-owners route + a Special Serial Owners board page committed to main and deployed READY, tsc clean, concierge able to answer ownership questions. The board is auth-gated by default; flip to public SEO with the one-line isPublicPath+sitemap switch once Trevor approves the holder-exposure. Net: "special serial owners identified" becomes a usable product surface on top of the data layer Cowork shipped.
