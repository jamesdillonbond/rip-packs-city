# Handoff 2026-06-09 — Pack Sniper follow-ups: AllDay feed crash + verified outbound URLs

Audience: Claude Code on Trevor's machine. Direct-to-main, no branches, no PRs; if a claude/* branch is pre-checked-out, switch to main first. Follows the shipped 53c2354 (Pack Sniper). Small session: one bug fix + one URL-builder update.

Claude Code's direct file inspection wins over this doc and over project_knowledge_search on any disagreement — adapt to the actual file shape.

## Context

Cowork live-verification of the shipped Pack Sniper (2026-06-09 evening, via Chrome + prod): the TS board and feed are green (40 gated deals anon, HV toggle + methodology verified). Two findings:

1. BUG — the AllDay leg is crashing. Both /api/pack-listings?collection=nfl-all-day AND /api/public/insights/pack-sniper?collection=nfl-all-day return 500 {"error":"Cannot read properties of null (reading 'toLowerCase')"} — so the board's NFL ALL DAY toggle is broken in prod right now. TS works.

2. RESOLVED — the outbound-URL question (old Items 0b/0c). dapper.market is browser-verified, dist_id-keyed, anon-accessible, and has a working Buy flow for packs. Details + caveat below.

## Item 1 — fix the AllDay null-title crash (the live 500)

Root cause (high confidence, verify in file): AllDay pack distributions can carry a null title — the known AllDay data-parity gap. The shared Dapper Studio fetch (extracted in 53c2354 to lib/packs/live-pack-listings.ts; previously inline in app/api/pack-listings/route.ts) calls classifyPackType(d.title.value, ...) whose first line is title.toLowerCase(), and the mapper also uses d.title.value for the title field. One AllDay listing node with title.value null (or a null title object) kills the whole map → 500 for the entire collection. TS never trips it because TS dists all have titles.

Fix in lib/packs/live-pack-listings.ts (and anywhere else 53c2354 left a bare d.title.value / d.tier.value / d.price.value access — grep the file for ".value"):

- const title = d.title?.value ?? ("Pack #" + distId)
- classifyPackType should defend itself too: first line becomes something like const t = (title ?? "").toLowerCase()
- Same optional-chaining treatment for tier (?? "common"), price (?? 0), number_of_pack_slots (?? "1"), start_time (?? ""), image_urls — any of these can plausibly be null on AllDay nodes. The mapper must never throw on one bad node; if a node is missing distId it's already skipped — keep every other field null-safe.

Revert: git revert the commit.

Verify: /api/public/insights/pack-sniper?collection=nfl-all-day returns JSON meta+deals (deals may legitimately be few/empty after gates — assert shape, not count); /api/pack-listings?collection=nfl-all-day returns listings; the board's NFL ALL DAY toggle renders without error; tsc clean; deploy READY.

## Item 2 — outbound URLs: add the verified dapper.market deep link (lib/pack-urls.ts + the board/feed)

Browser-verified by Cowork on 2026-06-09 (anon Chrome, real clicks):

- TS: https://dapper.market/nba/search/packs?packSource=marketplace&packDetail=<distId> — opens a Pack Details modal for exactly that distribution (verified packDetail 8524 = "WNBA Rookie Debut Box" and 5427 = "2025 NBA Finals: Rare Hit", both title-matched against our own pack_distributions), showing supply, pack odds, lowest ask, listed count, and a live "Buy Pack for $X" button when listed there.
- AllDay: https://dapper.market/nfl/search/packs?packSource=marketplace&packDetail=<distId> — same shape, verified packDetail 7578 = "Rewind Legendary" (title-matched in pack_distributions, AllDay collection_id), modal showed Lowest Ask $400, Listed For Sale 1, working Buy button.

IMPORTANT CAVEAT (also verified): dapper.market displays a SUBSET of the Dapper Studio listing book our feed reads. Measured: our Studio aggregation had 1,901 TS dists with live listings; dapper.market's NBA pack browse showed 833 packs. Concretely, dist 5427 showed 1 listing @ $59 in our feed while its dapper.market modal said "No packs listed" — yet WNBA Rookie Debut Box (8524) matched exactly ($198 both sides). So a dapper.market link can land on an empty modal for a deal our board shows. nbatopshot.com/drop/<distId> (the native P2P surface, same book as the Studio aggregation) remains the best-odds primary — it just can't be automation-verified (Cloudflare + tool safety blocks); Trevor should click one once.

Changes:

2a. lib/pack-urls.ts — add dapperMarketPackUrl({ league, distId }) returning the shape above (league 'nba' | 'nfl'). Update the file header comment: dapper.market shape verified 2026-06-09; subset caveat; nbatopshot.com/drop/<distId> still pending one human click.

2b. Pack Sniper feed + board — mirror the moments dual-link pattern (f9210cf): keep the existing native buyUrl as primary (TS: nbatopshot.com/drop/<distId>; AllDay: now ALSO use dapper.market as the primary since nflallday.com/pack/<id> is unverified and dapper.market is verified buyable), and add a second dapperUrl field rendered as a small secondary link on each board row ("dapper.market ↗" or similar, match the moments dual-link styling). This un-gates old Item 4a: in components/packs/PackPageClient.tsx, AllDay rows with a live overlay get buyUrl = dapperMarketPackUrl({ league: 'nfl', distId }) instead of falling back to Simulate.

Revert: git revert.

Verify: board rows render both links; an AllDay row's link opens the dapper.market modal for that dist; tsc clean; deploy READY; smoke green.

## Guardrails (repeat-every-handoff)

- Commit and push directly to main. No branches, no PRs.
- Commit via PowerShell git on Windows (Git Bash git commit can silently no-op). Re-verify with git rev-list --count origin/main..HEAD (expect 0).
- curl fails silently in Git Bash for Vercel REST — use PowerShell Invoke-WebRequest.
- Vercel Pro maxDuration hard cap 800s (irrelevant here, but stated).
- CRLF: full-file writes, no string-replace patching.
- After deploy: deployment READY, smoke test, check Sentry for new issues (the AllDay 500 may already be minting a Sentry issue — resolve it with regression arming after the fix).

## Expected end state

One or two commits on main, deploy READY: the board's NFL ALL DAY toggle works (AllDay 500 fixed at the shared-helper layer), every board row carries a verified dapper.market deep link (subset caveat documented in lib/pack-urls.ts), AllDay packs-page rows get a real buy link, and the only remaining open thread is Trevor's one manual click on nbatopshot.com/drop/5427 to confirm the native TS pattern.
