# Team Hub — Phase 5 handoff (cross-collection fan hub: /my-teams)

Date: 2026-05-31. The personalization capstone and the last open item in the spec. Full spec: docs/features/team-hub-buildout-2026-05-31.md (section 11). Mostly composition over the Phase 1-4 RPCs — one new SECDEF RPC + one route + one page.

CONTEXT
Team Hub Phases 1-4 + polish are shipped and live. This adds an auth-gated /my-teams hub unifying a user's followed teams across leagues, with each team's checklist completion auto-bound to the user's saved wallet. Rebase on latest main.

DECISIONS (resolved with Trevor — baked in)
- Personal /my-teams first (auth-gated). A public per-team "fans" angle is NOT in scope for v1.
- Auto-bind the user's saved wallet so completion % shows without re-pasting per team.
- WNBA IS INCLUDED — it is part of NBA Top Shot. teams_master already holds the 13 current WNBA franchises (with colors + external_id), the Phase 1 get_team_detail join is league-agnostic so WNBA team pages are already branded, and Phase 4 per-league follow already writes league='WNBA'. So WNBA needs NO new work here — just don't filter it out.

VERIFIED (prod DB, 2026-05-31)
- teams_master by league: NBA 30, NFL 32, LALIGA 20, WNBA 13 — WNBA all have primary_color + external_id. The 6 sampled WNBA editions team_names (Liberty, Aces, Lynx, Storm, Fever, Valkyries) all resolve to a teams_master row via slugify(team_name). (Defunct WNBA teams — Shock, Comets, Silver Stars, Monarchs — have no teams_master row and render as plain heros, same as historical NBA franchises; fine.)
- user_favorite_teams: PK-ish per (user_id, league, team_slug); RLS ON, authenticated, auth.uid()=user_id. team_slug stores the SHORT teams_master slug ("blazers"); league is league_t (NBA|WNBA|NFL|LALIGA).
- saved_wallets: wallet_addr (text Flow address), user_id (uuid), verified_at, verification_method, pinned_at, plus cached_* columns. Auto-bind source: the user's verified, most-recently-pinned wallet.
- league -> collection: NBA & WNBA -> nba_top_shot (95f28a17-224a-4025-96ad-adf8a4c63bfd); NFL -> nfl_all_day (dee28451-5d62-409e-a1ad-a83f763ac070); LALIGA -> laliga_golazos (06248cc4-b85f-47cd-af67-1855d14acd75).

DB HALF — G0 FIRST (seed the 2026 expansion WNBA teams, ahead of the first WNBA pack drop)

G0 — Portland Fire + Toronto Tempo are NOT in teams_master yet (it holds the 13 current WNBA franchises; verified neither expansion team is present). Without teams_master rows, their team pages render UNBRANDED and can't be followed the moment their first moments land in the inaugural WNBA pack drop. Seed them now so branding + follow light up automatically at drop. Cowork can apply this live via apply_migration on request.
  Verified values: WNBA rows use short slug + 3-letter abbr + WNBA-stats external_id + hex colors. Portland Fire WNBA stats id = 1611661327 (wnba.com/team/1611661327/portland-fire). Toronto Tempo official colors = Bordeaux #612C51 (primary) + Hydrogen Blue #B8CCEA (secondary) (TruColor WNBA palette). PROVISIONAL / TODO: Portland Fire exact hex is not published (brand palette is fire red / brown / blue / pink) — the values below are placeholders, replace from the fire.wnba.com brand guide; Toronto Tempo WNBA stats external_id was not found — left NULL (fill when known; not blocking).
  Migration:
    INSERT INTO teams_master (league, slug, team_name, abbreviation, external_id, primary_color, secondary_color, display_order, active)
    SELECT v.league::league_t, v.slug, v.team_name, v.abbreviation, v.external_id, v.primary_color, v.secondary_color, v.display_order, v.active
    FROM (VALUES
      ('WNBA','fire','Portland Fire','POR','1611661327','#E03A2F','#0E4DA4',14,true),
      ('WNBA','tempo','Toronto Tempo','TOR',NULL,'#612C51','#B8CCEA',15,true)
    ) AS v(league,slug,team_name,abbreviation,external_id,primary_color,secondary_color,display_order,active)
    WHERE NOT EXISTS (SELECT 1 FROM teams_master tm WHERE tm.league='WNBA' AND tm.slug = v.slug);
  (Portland Fire's #E03A2F / #0E4DA4 are PLACEHOLDER — swap for the official hex. abbr POR is fine; it only collides with the NBA Blazers across a different league + different slug.)
  Revert: DELETE FROM teams_master WHERE league='WNBA' AND slug IN ('fire','tempo');
  Important: get_team_detail aggregates from editions, so a team page only renders once that team HAS moments. Seeding teams_master does NOT create a live page pre-drop — it PRE-STAGES branding + follow so that the instant the first Fire/Tempo moments land, the pages are branded and followable (and they appear in the fan hub) with zero extra work. Verify post-seed: SELECT * FROM teams_master WHERE league='WNBA' AND slug IN ('fire','tempo') returns 2 rows; after their first moments exist, get_team_detail('95f28a17-224a-4025-96ad-adf8a4c63bfd','portland-fire') returns branding.

DB HALF — one new function (Cowork can apply via apply_migration on request).

G1 — get_my_fan_teams() RETURNS jsonb. SECURITY DEFINER, STABLE, search_path 'public'. Returns ONLY the caller's favorites resolved to route + branding. Takes NO user_id param — it reads auth.uid() internally (works inside SECDEF from the request JWT); accepting a user_id would let any caller read others' favorites, so do NOT add one.
  Body shape:
    SELECT COALESCE(jsonb_agg(to_jsonb(t.*) ORDER BY t.is_primary DESC, t.league, t.team_name), '[]'::jsonb)
    FROM (
      SELECT uft.league::text AS league,
             CASE uft.league WHEN 'NBA' THEN 'nba_top_shot' WHEN 'WNBA' THEN 'nba_top_shot'
                             WHEN 'NFL' THEN 'nfl_all_day' WHEN 'LALIGA' THEN 'laliga_golazos' END AS collection_slug,
             CASE uft.league WHEN 'NBA' THEN '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
                             WHEN 'WNBA' THEN '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
                             WHEN 'NFL' THEN 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
                             WHEN 'LALIGA' THEN '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid END AS collection_id,
             tm.team_name,
             regexp_replace(lower(trim(tm.team_name)),'[^a-z0-9]+','-','g') AS route_slug,
             tm.primary_color, tm.secondary_color, tm.abbreviation, tm.external_id,
             uft.is_primary
      FROM user_favorite_teams uft
      JOIN teams_master tm ON tm.league = uft.league AND tm.slug = uft.team_slug
      WHERE uft.user_id = auth.uid()
    ) t;
  Grants: REVOKE ALL ON FUNCTION public.get_my_fan_teams() FROM PUBLIC, anon; GRANT EXECUTE TO authenticated. (Per-user — authenticated only, never anon/service-role-exposed-to-client.)
  Revert: DROP FUNCTION public.get_my_fan_teams();
  Verify: as an authed user with favorites, returns their teams with route_slug + collection_slug + branding; a WNBA favorite (league='WNBA', team_slug='liberty') resolves to collection nba_top_shot, route_slug 'new-york-liberty'. NOTE: this is the inverse of the Phase 4 follow mapping (Phase 4 writes teams_master.slug; this reads it back -> route slug). Keep both consistent.

No other new DB — the cards reuse get_team_detail + get_team_checklist_progress.

CODE HALF — Claude Code.

G2 — saved-wallet resolution (server). The hub auto-binds the user's wallet for completion %. Through the authenticated session: select wallet_addr from saved_wallets where user_id = auth.uid() and verified_at is not null order by pinned_at desc nulls last limit 1. If an existing saved-wallets read helper exists (inspect app/dashboard + app/api/profile), reuse it. Pass the resulting address as p_wallet to get_team_checklist_progress per team. If none, the client may still supply the checklist's localStorage wallet; if neither, render completion as "connect a wallet to track".

G3 — /my-teams page. Create app/my-teams/page.tsx (top-level route, like /analytics — NOT under (collections)). Auth-gated: confirm proxy.ts does NOT treat /my-teams as public (it should require auth by default since only an allowlist of prefixes is public). If unauthenticated, redirect to /login?next=/my-teams (mirror the existing authed-page gating). Flow:
  - Call get_my_fan_teams() via the user-session client (RLS / auth.uid()). Empty -> empty state: "Follow a team to build your hub" with links to a couple of team pages.
  - Resolve the auto-bound wallet (G2).
  - For each fan team, fetch in parallel (server Promise.all): get_team_detail(collection_id, route_slug) + get_team_checklist_progress(collection_id, route_slug, 'all_time', wallet). Typical <=4 teams -> <=8 calls.
  - Render one card per team: a compact branded header (reuse TeamHero's logo/colors treatment or a small variant), checklist completion % + cost-to-complete + "X locked", 30d sales/volume (from detail), and a link to the full hub at /<collection_slug-as-urlSlug>/team/<route_slug>. Badge the is_primary team per league.
  - Group or label by league when a user follows across leagues (NBA / WNBA / NFL / LaLiga).
  Optional (note, not required for v1): a combined "recent activity across your teams" feed unioning get_team_activity — defer unless trivial.
  Brand tokens only (var(--rpc-*)); no hardcoded literals.

G4 — entry points. Add a "My Teams" link in the main nav/header, shown when logged in (inspect the existing header component). Optionally, after a successful follow in TeamHero, surface a small "★ Your {league} team — view My Teams" link to /my-teams.

GUARDRAILS (repeat every handoff)
- Direct-to-main, no branches/PRs. PowerShell git commit (Git Bash can no-op); re-verify git rev-list --count origin/main..HEAD = 0.
- curl fails silently in Git Bash for Vercel REST -> Invoke-WebRequest.
- Vercel Pro maxDuration cap 800s.
- CRLF: full-file writes.
- After deploy: smoke + Vercel READY; npx tsc --noEmit clean.
- SECURITY: get_my_fan_teams must filter by auth.uid() internally and be granted to authenticated only — never anon, never take a user_id param. The page reads favorites + saved wallet through the user session; public team data (detail/progress) may use service-role. No new writes (follow shipped in Phase 4).

LET CLAUDE CODE CORRECT FALSE PREMISES
Claude Code's direct file inspection wins over this doc. Confirm: the real auth-gating pattern (proxy.ts public list + an existing authed page's redirect), the actual saved-wallets read path, get_team_checklist_progress's exact signature from its live body, and the nav/header component to add the link. Adapt to the real shapes.

END STATE
/my-teams (auth-gated) shows a branded card per followed team across NBA / WNBA / NFL / LaLiga, each with checklist completion + cost-to-complete auto-bound to the user's saved wallet, plus a link to the full team hub. Completes the Team Hub build-out end to end (Phases 1-5). No open items remain in the spec except the optional cross-team activity feed.
