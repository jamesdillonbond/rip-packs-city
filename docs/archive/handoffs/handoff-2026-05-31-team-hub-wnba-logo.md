# Team Hub — WNBA logo fix (TeamLogo CDN path)

Date: 2026-05-31. Tiny cosmetic follow-up; no DB, no routes. Rebase on latest main.

CONTEXT
Phase 1's TeamLogo renders official logos only for NBA, via cdn.nba.com/logos/nba/{external_id}/global/L/logo.svg, gated on league==='NBA'. WNBA teams_master rows carry external_ids too (13/13), but the NBA CDN path does not serve WNBA marks, so every WNBA team hero (and the fan-hub mini-cards that reuse the logo treatment) falls back to the initials badge. This adds the WNBA CDN branch so WNBA logos render. Low-risk: onError already swaps to the initials badge, so any URL miss degrades to exactly today's behavior.

VERIFIED (2026-05-31)
- The WNBA logo CDN mirrors the NBA pattern: https://cdn.wnba.com/logos/wnba/{external_id}/global/L/logo.svg (same id family; e.g. New York Liberty external_id 1611661313). Both the NBA and WNBA SVG URLs are reachable (neither errors; web_fetch returns no text only because it doesn't extract SVG markup — the known-good NBA URL behaves identically).
- teams_master external_id coverage: NBA 30/30, WNBA 13/13, NFL 0, LALIGA 0. So only NBA + WNBA have ids → only they should attempt a CDN logo; NFL/LALIGA correctly stay on the initials badge (no external_id). Toronto Tempo's external_id is NULL → it also stays on initials until its id is filled (expected).

CODE — components/entity/TeamLogo.tsx (client island; verify the current shape first).
Change the logo-URL construction from "hardcode NBA CDN, gate on league==='NBA'" to a per-league base:
  - league === 'NBA'  -> https://cdn.nba.com/logos/nba/${externalId}/global/L/logo.svg
  - league === 'WNBA' -> https://cdn.wnba.com/logos/wnba/${externalId}/global/L/logo.svg
  - otherwise, or when externalId is falsy -> render the initials badge directly (no <img>).
Render the <img> only when externalId is present AND league is 'NBA' or 'WNBA'; keep the existing onError handler that swaps to the initials badge. Nothing else changes.
Confirm the caller forwards league: TeamHero already receives detail.league + detail.team_external_id (Phase 1/4) and passes them to TeamLogo; the fan-hub card reuses the same logo component, so it benefits automatically. If any caller doesn't pass league, default to the initials badge (safe).
Revert: git revert <commit>.
Verify: /nba-top-shot/team/new-york-liberty shows the Liberty logo (not "NYL" initials); Lakers (NBA) unchanged; Toronto Tempo (external_id null) still shows initials; NFL/Golazos teams unchanged.

GUARDRAILS
- Direct-to-main, no branches/PRs. PowerShell git commit; re-verify git rev-list --count origin/main..HEAD = 0.
- CRLF: full-file write. After deploy: smoke + Vercel READY; npx tsc --noEmit clean.

LET CLAUDE CODE CORRECT FALSE PREMISES
Inspect the real TeamLogo.tsx and how it currently branches on league/externalId; adapt to the actual shape. If TeamLogo doesn't currently receive league, thread it through from TeamHero (which already has detail.league).

END STATE
One small commit on main, deploy READY. WNBA team heros + fan-hub cards render official WNBA logos; NBA unchanged; teams with no external_id (Toronto Tempo, NFL, LaLiga) cleanly show the initials badge. This was the last optional polish item on the team hub.
