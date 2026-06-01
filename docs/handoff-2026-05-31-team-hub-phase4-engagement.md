# Team Hub — Phase 4 handoff (follow / live-game / alerts)

Date: 2026-05-31. Scope: NBA Top Shot first. Full spec: docs/features/team-hub-buildout-2026-05-31.md. The last increment — turns the hub into a return-visit surface. UNLIKE Phases 1-3 (read-only catalog reads), this phase involves an authenticated WRITE and live/scheduled data, so the risk class is different. F3 (alerts) is genuinely optional and gated on infra that may be decommissioned — read F3 before promising it.

CONTEXT
Phases 1-3 shipped and live (0f65db8 hero/stats/roster, dcb23eb checklist, cab6d4f activity/sets/squeeze/rookie). The hub stands on its own at Phase 3. This Phase 4 adds: F1 Follow team (auth-gated write), F2 a live-game chip in the hero, and F3 (optional) completion alerts. Rebase on latest main.

VERIFIED FOR THIS HANDOFF (prod DB, 2026-05-31)
- user_favorite_teams: RLS is ON with correct per-user policies — uft_insert_own (WITH CHECK auth.uid() = user_id), uft_select_own / uft_update_own / uft_delete_own, all role = authenticated. So writes MUST run through the authenticated user's Supabase session (anon key + the user JWT), NOT the service-role supabaseAdmin client — RLS enforces ownership and supabaseAdmin would bypass it. team_slug column stores the SHORT teams_master slug ("blazers", "lions", "seahawks"), NOT the route slug ("portland-trail-blazers"). league is the league_t enum: NBA | WNBA | NFL | LALIGA (Top Shot -> NBA, All Day -> NFL, Golazos -> LALIGA; UFC/Pinnacle have no league row -> no follow).
- No favorite/follow RPC exists (pg_proc search empty). user_favorite_teams is already read by app/api/profile/teams/route.ts + app/profile/edit/page.tsx + the profile pages — there is an existing favorite read/write path in the profile editor. REUSE it; do not invent a new write path.
- nba_games: keyed by home_team_abbr / away_team_abbr using ESPN-style abbreviations ("SA","NY","OKC","GS"...), which DO NOT match teams_master.abbreviation ("SAS","NYK","GSW"). Columns: game_date, tipoff_at, status (scheduled|final|...), home/away_score, is_playoff, series_label, plus odds columns (mostly null). Data is live now (NBA playoffs, synced today) but goes stale/empty off-season.

DB HALF

F1a — surface the follow keys in get_team_detail. The hub knows only the route slug; the follow write needs teams_master.slug + league. Phase 1's get_team_detail v2 already LEFT JOINs teams_master on slugify(team_name)=p_team_slug. Add two fields to its returned jsonb from that same join: team_short_slug (= teams_master.slug) and league (already added in Phase 1 — reuse it). Same signature -> grants preserved. Revert: CREATE OR REPLACE prior body. Verify: get_team_detail('95f28a17-224a-4025-96ad-adf8a4c63bfd','los-angeles-lakers') returns team_short_slug='lakers', league='NBA'. (If Phase 1 already exposed slug, skip F1a.)

F2a — team next/last game. Two options; pick one:
  (i) Preferred, robust: add an espn_abbr text column to teams_master and backfill it (one-time UPDATE mapping the ~6 mismatches: SAS->SA, NYK->NY, GSW->GS, NOP->NO, UTA->UTAH, WAS->WSH — verify each against nba_games distinct home_team_abbr). Then a tiny get_team_next_game(p_team_slug) that resolves teams_master by slugify(team_name)=route_slug, reads its espn_abbr, and returns the next scheduled (tipoff_at >= now(), status='scheduled', ORDER BY tipoff_at) or most recent final game (opponent abbr, tipoff_at, status, is_playoff, series_label).
  (ii) Lighter: skip the column, hardcode the abbr crosswalk map inside the RPC as a CASE. Faster, but the map lives in SQL.
  Either way: NEVER join nba_games to teams_master on abbreviation directly — the vocabularies differ (verified SA vs SAS, NY vs NYK). Revert: DROP the RPC (+ DROP COLUMN if (i)). Verify: get_team_next_game for a playoff team (e.g. spurs) returns its scheduled/last game; an eliminated/off-season team returns null -> chip self-hides.
  HONESTY CAVEAT to encode in the UI: only render the chip when a game row is returned. Off-season this is empty for everyone; that's expected, not a bug.

F3 (OPTIONAL — verify infra FIRST, likely defer) — completion alerts. CLAUDE.md notes the watchlist + FMV-alerts tables/routes exist but the user-facing path is "partially decommissioned," and no alert RPC turned up in this audit. DO NOT build a new notification pipeline for this. Before any work: confirm whether the watchlist/alert tables + a live notification path (Resend email / the Telegram sentinel is ops-only, not per-user) are actually wired. If they are, scope alerts minimally as "notify me when this team's checklist gains a newly-mintable edition" reusing that infra, gated to logged-in users. If they are not, DEFER F3 and ship Phase 4 as F1 + F2 only. Recommended: defer F3 unless the infra check comes back clean.

CODE HALF — Claude Code.

C10 — Follow button (F1). In components/entity/TeamHero.tsx (Phase 1), add a "Follow" control, rendered ONLY when there is an authenticated session AND detail.team_short_slug is present (NBA/NFL/LALIGA teams). For anonymous users render "Sign in to follow" linking /login?next=<team path>. On click, toggle the favorite by reusing the EXISTING profile-teams write (inspect app/api/profile/teams/route.ts + app/profile/edit/page.tsx first and call the same endpoint/helper) with { league: detail.league, team_slug: detail.team_short_slug }. The write goes through the user-session Supabase client so RLS applies — do NOT route it through any service-role/admin path. Reflect followed/unfollowed state on the button. Revert: git revert.

C11 — Live-game chip (F2). In TeamHero, when get_team_next_game returns a row (fetched in the page's Promise.all and passed as a prop), render a chip: scheduled -> "Plays <opp> <relative tipoff>"; final -> "<result vs opp>" if scores present else "Last: vs <opp>". Use the existing chip styling. Render nothing when null. (Optional follow-on: an injury chip on roster tiles from nba_player_projections.injury_status — same abbr-crosswalk caveat applies to mapping players' team; treat as a later nicety, not required for Phase 4.) Revert: git revert.

C12 — wiring. Fetch get_team_next_game in the team page Promise.all and pass to TeamHero. No new sections; F1/F2 live in the hero. If F3 is pursued, add a small "Alert me" affordance near the checklist progress header (logged-in only) calling the verified alert path — otherwise omit. Revert: git revert.

GUARDRAILS (repeat every handoff)
- Direct-to-main, no branches/PRs. If a claude/* branch is pre-checked-out, switch to main first.
- Commit via PowerShell git (Git Bash git commit can silently no-op). Re-verify: git rev-list --count origin/main..HEAD (expect 0).
- curl fails silently in Git Bash for Vercel REST -> PowerShell Invoke-WebRequest.
- Vercel Pro maxDuration cap 800s.
- CRLF: full-file writes, no string-replace patching.
- After deploy: smoke + Vercel READY; npx tsc --noEmit clean.
- SECURITY: the follow write is the first team-hub WRITE. It must run as the authenticated user (RLS-enforced) — never via service-role. Do not add anon write access to user_favorite_teams. This is a user-initiated, per-action, logged-in write (consistent with the safety model); do not auto-follow or batch-follow.

LET CLAUDE CODE CORRECT FALSE PREMISES
Claude Code's direct file inspection wins over this doc and project_knowledge_search on any disagreement — adapt to the actual file shape. Specifically: inspect the REAL app/api/profile/teams/route.ts + app/profile/edit/page.tsx and reuse whatever favorite-write contract already exists rather than the sketch here; verify the nba_games distinct abbreviations before writing the crosswalk; and confirm the alert infra state before doing any F3 work.

END STATE
One commit on main, tsc clean, Vercel READY. The team hero shows a Follow control (logged-in; writes the user's favorite via the RLS-enforced session, mapping route slug -> teams_master short slug) and, in-season, a live-game chip that self-hides off-season. F3 alerts shipped only if the existing watchlist/alert infra was confirmed live; otherwise deferred with a one-line note in the commit. This completes the Team Hub build-out (Phases 1-4); remaining ideas (cross-collection fan hub, non-team-bucket cleanup, per-wallet locked-state parity) are tracked in the spec's open questions.
