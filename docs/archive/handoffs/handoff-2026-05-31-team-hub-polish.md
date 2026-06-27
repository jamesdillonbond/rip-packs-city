# Team Hub — polish handoff (buckets / locked-state parity / Clippers split)

Date: 2026-05-31. Scope: NBA Top Shot. Three small, independent items closing the spec's open questions. None are blocking; ship any subset. Full spec: docs/features/team-hub-buildout-2026-05-31.md.

CONTEXT
Team Hub Phases 1-4 are shipped and live. This handoff cleans up three things found while verifying the parked items: (P1) All-Star/Rising-Stars exhibition rosters generating junk team URLs, (P2) the checklist's owned-vs-missing-only limitation — per-wallet lock state actually IS available, so green/white/gray parity with Top Shot is a cheap add, and (P3) the LA Clippers are split across two team URLs. Rebase on latest main.

VERIFIED (prod DB, 2026-05-31)
- Non-franchise NBA team_name values fall into three groups. KEEP: WNBA franchises (New York Liberty, Las Vegas Aces, Minnesota Lynx, Phoenix Mercury, Connecticut Sun, LA Sparks, Dallas Wings, Chicago Sky, Seattle Storm, Washington Mystics, Indiana Fever, Atlanta Dream, Golden State Valkyries, Detroit Shock, Houston Comets, San Antonio Silver Stars, Sacramento Monarchs) and historical/relocated NBA franchises (Seattle SuperSonics, New Jersey Nets, Washington Bullets, Charlotte Bobcats, New Orleans Hornets, New Orleans/Oklahoma City Hornets, St. Louis Hawks, Vancouver Grizzlies, Kansas City-Omaha Kings, Buffalo Braves) — these are real and should keep their pages. REMOVE (exhibition rosters, the only true junk): Team LeBron, Team Durant, Team Giannis, Team Wilson, Team Stewart, Eastern Conference All-Stars, Western Conference All-Stars, Young Stars, OGs, Global Stars, Rookie Team, Sophomore Team (~131 editions total). So the fix is a precise DENYLIST, NOT a "not in teams_master" filter (which would wrongly kill WNBA + historical teams).
- wallet_moments_cache has is_locked (boolean) + lock_checked_at, and it's well populated (sample wallet 0xbd94cade097e50ac: 14,274 moments, 13,166 locked / 1,108 unlocked / 0 null / 14,186 lock_checked). So per-wallet lock state is real -> green (owned+locked) / white (owned) / gray (missing) parity is viable.
- Clippers split: editions has BOTH "LA Clippers" (314) and "Los Angeles Clippers" (69); teams_master has "LA Clippers" (LAC). So /nba-top-shot/team/la-clippers is branded with 314 editions while /nba-top-shot/team/los-angeles-clippers is a separate UNBRANDED page with 69 — same franchise, fragmented.

P1 — exclude exhibition rosters (CODE only, no DB needed)
Create a shared constant, e.g. lib/team-denylist.ts exporting a Set of the slugified exhibition names: team-lebron, team-durant, team-giannis, team-wilson, team-stewart, eastern-conference-all-stars, western-conference-all-stars, young-stars, ogs, global-stars, rookie-team, sophomore-team. (slugify each with the canonical regexp_replace(lower(trim(x)),'[^a-z0-9]+','-','g').) Then:
  - app/sitemap.ts: when building teamMap (the loop near "if (e.team_name)"), skip any team whose slug is in the denylist, so these URLs stop being advertised.
  - app/(collections)/[collection]/team/[slug]/page.tsx: at the top of generateMetadata + the page body (after decoding slug), if the denylist has the slug, return notFound() / {} before calling get_team_detail. This 404s the junk pages that are already indexed.
Leaves WNBA + historical franchises untouched (they are not in the denylist). Revert: git revert (delete the constant + the two guards). Verify: /nba-top-shot/team/team-lebron 404s; /nba-top-shot/team/seattle-supersonics and /nba-top-shot/team/new-york-liberty still render; the next sitemap build drops the ~12 exhibition URLs.
  Optional follow-on (not required): the denylist could instead live as a tiny is_exhibition flag, but a code constant is the lowest-friction fix for ~12 stable names.

P2 — locked-state parity on the checklist (DB + code). Corrects the Phase 2 "owned-vs-missing only" note.
  DB: extend get_team_checklist and get_team_checklist_progress. In the ownership LATERAL (currently SELECT COUNT(*) cnt FROM wallet_moments_cache w WHERE w.wallet_address=p_wallet AND w.collection_id=p_collection_id AND w.edition_key=e.external_id), also compute bool_or(w.is_locked) AS any_locked. Expose per edition: owned (cnt>0), owned_count (cnt), owned_locked (any_locked). Mapping for the UI: gray = NOT owned; white = owned AND NOT owned_locked; green = owned AND owned_locked. In get_team_checklist_progress, optionally add locked_owned = COUNT(*) FILTER (WHERE owned AND owned_locked) for a "X locked" readout. Same signatures -> grants preserved (REVOKE/GRANT unchanged). Pull the current bodies via pg_get_functiondef first. Revert: CREATE OR REPLACE prior bodies.
  Code: components/entity/TeamChecklist.tsx — replace the binary owned/missing badge with the three-state check (green/white/gray) matching Top Shot's legend; update the legend row to "Owned + locked / Owned / Missing". Revert: git revert.
  Verify: with 0xbd94cade097e50ac on the Lakers all-time checklist, owned tiles split into green (locked) vs white (unlocked) consistent with the 13,166/1,108 ratio; anonymous view unchanged (owned null -> all gray/neutral).

P3 — merge the Clippers split (DB; Cowork can apply via apply_migration on request)
  One-time normalization so the 69 "Los Angeles Clippers" editions fold into the canonical branded "LA Clippers" page: UPDATE editions SET team_name='LA Clippers' WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND team_name='Los Angeles Clippers'; (team_name is denormalized text — no FK/constraint risk; the editions.collection text-drift reconcile precedent on 2026-05-24 is the same shape). After it, /nba-top-shot/team/la-clippers covers all 383 and /los-angeles-clippers stops resolving (add it to a redirect or let it 404 — it will return null from get_team_detail once no editions carry that name). Revert: UPDATE editions SET team_name='Los Angeles Clippers' WHERE collection_id='95f28a17-...' AND external_id IN (<the 69 ids captured pre-update>); (capture the 69 external_ids in the migration comment before updating so the revert is exact). Verify: get_team_detail('95f...','la-clippers') edition_count rises by 69; 'los-angeles-clippers' returns null.
  General follow-on (note, not required now): a broader team_name normalization sweep could catch other city/abbrev variants, but Clippers is the only confirmed current-franchise split; the rest are genuinely distinct historical names. Also: the WNBA franchises render as UNBRANDED team pages today (no teams_master rows with league='WNBA') — seeding teams_master WNBA rows (colors/abbr/external_id) would give them branded heros via the existing Phase 1 join, no code change. Optional, low priority.

GUARDRAILS
- Direct-to-main, no branches/PRs. PowerShell git for commit (Git Bash can no-op); re-verify git rev-list --count origin/main..HEAD = 0.
- curl fails silently in Git Bash for Vercel REST -> Invoke-WebRequest.
- CRLF: full-file writes.
- After deploy: smoke + Vercel READY; npx tsc --noEmit clean.
- P3 is a data UPDATE: capture the 69 external_ids in the migration before the UPDATE so the revert is exact (verify-rowcount-before-destructive habit; this is non-destructive but the revert needs the id list).

LET CLAUDE CODE CORRECT FALSE PREMISES
Claude Code's direct file inspection wins over this doc. Inspect the real sitemap teamMap loop + the team page guard sites and the actual get_team_checklist bodies before editing; confirm the exhibition-name list against a fresh DISTINCT team_name query in case new All-Star content landed.

END STATE
Up to three small commits/migrations: exhibition team URLs 404 + drop from the sitemap (WNBA/historical kept); the checklist shows green/white/gray locked-state parity with Top Shot; the Clippers are one branded page of 383 editions. Closes the spec's open questions except the cross-collection fan hub (a separate design pass).
