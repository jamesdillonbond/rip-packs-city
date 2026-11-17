# Team Hub — Phase 1 handoff (branding + current roster)

Date: 2026-05-31. Scope: NBA Top Shot first (generalizes to NFL / Golazos). This is Phase 1 of the team-hub build-out. Full spec: docs/features/team-hub-buildout-2026-05-31.md.

CONTEXT
Standalone team pages already ship at app/(collections)/[collection]/team/[slug]/page.tsx and were enriched earlier today (commits bf3f4f6, b106a27, 5797235, 29d2e46): get_team_players + get_team_detail dedup fixes (Lakers roster now 73 distinct players, not 116), new get_team_top_editions RPC, and the whole /<collection>/{edition,set,player,team,series,pack}/<slug> tree opened to anon in proxy.ts. Current HEAD = 59c860b. This handoff adds team IDENTITY (colors / logo / abbreviation), an extended stat strip (30d sales + volume), and a current-vs-all-time roster toggle. It ships nothing destructive and does NOT touch the dedup logic shipped today. Phase 2 (the Team Checklist with cost-to-complete) is a separate, later handoff.

PREREQ / RELATED — read before starting
- The LIVE sitemap.xml currently emits 0 entity URLs (known bug; fix is in docs/handoff-2026-05-31-sitemap-seo.md). Team hubs will not be crawled until that lands. Ship the sitemap fix first or in parallel, otherwise the SEO point of this work is moot.
- Rebase on HEAD 59c860b. Do NOT undo the get_team_detail / get_team_players dedup shipped today (Lakers must stay 73 distinct players). This handoff only ADDS columns/branches to those RPCs.
- Two team-slug vocabularies exist: teams_master.slug stores "blazers" while the route uses slugify(team_name) = "portland-trail-blazers". Bridge by slugifying team_name. Do NOT join on teams_master.slug.

DB HALF — two migrations. Cowork can apply these live via apply_migration on request, or apply from Claude Code. Both are CREATE OR REPLACE with the SAME signature, so EXECUTE grants are preserved (no new overload, no anon-grant footgun). Pull the current body first with: SELECT pg_get_functiondef('public.get_team_detail(uuid,text)'::regprocedure); — both current bodies were captured in this session's transcript for the revert.

D1 — get_team_detail v2: add branding + 30d activity (sports/else branch only; leave the Pinnacle branch unchanged).
  - After the existing aggregate SELECT, add a branding lookup: SELECT primary_color, secondary_color, abbreviation, external_id, league::text INTO locals FROM teams_master WHERE active AND regexp_replace(lower(trim(team_name)),'[^a-z0-9]+','-','g') = p_team_slug LIMIT 1. (Match on slugified team_name, not teams_master.slug.)
  - Add a 30d activity lookup: SELECT COUNT(*), COALESCE(SUM(s.price_usd),0) INTO v_sales_30d, v_volume_30d FROM sales s JOIN editions e ON e.id = s.edition_id WHERE e.collection_id = p_collection_id AND e.team_name = ANY(v_team_variants) AND s.sold_at >= now() - interval '30 days'.
  - Add to the returned jsonb_build_object: primary_color, secondary_color, abbreviation, team_external_id (= external_id), league, sales_30d, volume_30d_usd. Pinnacle branch returns these as null.
  - Keep RETURNS jsonb, STABLE SECURITY DEFINER, search_path public, statement_timeout 8s. Verified safe: branding lookup is a single indexed row; the 30d join hits sales via edition_id and is bounded by the team's editions (Lakers: 1,599 rows / ~50ms). If the 30d join risks the 8s timeout on a huge team, gate it behind a separate lightweight RPC instead — but Lakers (the largest) is well under budget.
  - Revert: CREATE OR REPLACE with the prior body (in transcript / from pg_get_functiondef before the change).
  - Verify: SELECT get_team_detail('95f28a17-224a-4025-96ad-adf8a4c63bfd','los-angeles-lakers') returns primary_color, abbreviation 'LAL', league 'NBA', sales_30d ~1599, volume_30d_usd ~18788, and player_count stays 73.

D2 — get_team_players: surface is_active for the roster toggle (sports/else branch).
  - The else branch already LEFT JOINs players p in the with_meta CTE (for headshot_url / jersey_number / position). Add p.is_active to that LATERAL SELECT and to with_meta's output columns so each returned player row carries is_active (boolean, nullable). Pinnacle branch (chars CTE): add is_active = NULL.
  - Same signature -> grants preserved. Revert: CREATE OR REPLACE prior body.
  - Verify: GET /api/entity/team?collection=nba-top-shot&slug=los-angeles-lakers returns is_active per player (true for LeBron/Reaves, null/false for retired names like Magic Johnson). Coverage caveat: players.is_active is partial for Top Shot — treat null as "unknown", never hide a player in All-Time view.

CODE HALF — Claude Code (needs git). Full-file writes, not diffs (CLAUDE.md). Verify each path before editing.

C1 — New branded hero component. Create components/entity/TeamHero.tsx (verified: does not exist today). Server component, no "use client". Props: teamName, noun, abbreviation?, primaryColor?, secondaryColor?, leagueLabel?, externalId?, isFranchise. Behaviour:
  - When primaryColor is present: render a banner with a CSS gradient derived from primaryColor -> var(--rpc-bg), the team name as the h1 (reuse the existing h1 styling from page.tsx lines ~118-120), and chips for abbreviation + leagueLabel.
  - Logo: when externalId present and league is NBA, render an <img> at https://cdn.nba.com/logos/nba/{externalId}/global/L/logo.svg with width/height 96 and an onError handler that swaps to an initials badge (abbreviation). When no externalId, render the initials badge only.
  - When primaryColor is absent (NFL/Golazos teams not yet in teams_master, or Pinnacle): fall back to exactly the current plain-text hero markup so nothing regresses.
  - Brand tokens: use var(--rpc-*) tokens and var(--font-display); never hardcode #E03A2F or 'Barlow Condensed' literals (CLAUDE.md brand rule). Team colors come in as data props, which is correct (they are team identity, not RPC brand).
  - Wire-in: in page.tsx, replace the inline hero <section> (currently lines ~112-128, the block that renders {noun} + h1 + variants + <HeroMontage/>) with <TeamHero .../> followed by <HeroMontage items={topEditions} />. Pass detail.primary_color, detail.secondary_color, detail.abbreviation, detail.league, detail.team_external_id, isFranchise, noun, teamName.
  - Revert: git revert <commit> (deletes TeamHero, restores inline hero).

C2 — Extend the stat strip + TeamDetail type. In page.tsx:
  - Update the TeamDetail interface (lines ~27-37): add optional primary_color?, secondary_color?, abbreviation?, team_external_id?, league?, sales_30d?, volume_30d_usd?: number|string|null.
  - In the stat strip (lines ~130-137), after the existing 5 StatCells add: StatCell label="30d Sales" value={fmtCount(detail.sales_30d)} and StatCell label="30d Volume" value={fmtUsd(detail.volume_30d_usd)}. (Cost-to-complete is Phase 2 — do not add it here.)
  - Revert: git revert.

C3 — Roster Current/All-Time toggle. In components/entity/PlayersGridPaginated.tsx:
  - Add is_active?: boolean|null to the PlayerTile interface (lines ~10-20).
  - Add a small two-button toggle (Current | All-Time) above the grid, default Current. When Current, filter rendered tiles to is_active === true; All-Time shows all. Keep the existing FMV/Editions/A-Z sort. Because pagination is server-side ("Load more" fetches more all-time rows), apply the Current filter client-side over whatever is loaded and show a one-line note: "Current = active per our roster data; some players may be unflagged." This keeps Phase 1 purely additive — no new RPC arg, no grant changes.
  - Revert: git revert.

GUARDRAILS (repeat every handoff)
- Direct-to-main. No branches, no PRs (CLAUDE.md non-negotiable). If a claude/* branch is pre-checked-out, switch to main first.
- Commit via PowerShell git on Windows (Git Bash git commit can silently no-op). Re-verify the push: git rev-list --count origin/main..HEAD (expect 0).
- curl fails silently in Git Bash for Vercel REST — use PowerShell Invoke-WebRequest.
- Vercel Pro maxDuration hard cap is 800s — anything higher sends the deploy to ERROR invisibly. (Not relevant here; no route maxDuration changes.)
- CRLF: don't string-replace-patch on Windows; use full-file writes or findIndex on split lines.
- After deploy, run the smoke test and confirm the Vercel deploy reaches READY. Expected: npx tsc --noEmit clean.

LET CLAUDE CODE CORRECT FALSE PREMISES
Claude Code's direct file inspection wins over this doc and over project_knowledge_search on any disagreement — adapt to the actual file shape. In particular the page.tsx line numbers above are from HEAD 59c860b and may have drifted; locate the hero <section> and stat-strip grid by their surrounding markup, not by line number.

END STATE
One commit on main, npx tsc --noEmit clean, Vercel deploy READY, and https://www.rippackscity.com/nba-top-shot/team/los-angeles-lakers renders a purple/gold branded hero with the Lakers logo, an 8-cell stat strip including 30d sales (~1,599) and 30d volume (~$18,788), and a Current/All-Time roster toggle defaulting to current players. NFL/Golazos team pages fall back to the plain hero with no regression. Phase 2 (Team Checklist) follows in a later handoff.
