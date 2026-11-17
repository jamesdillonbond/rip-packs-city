# Handoff — full-platform audit follow-ups (2026-05-31)

Plain-text, iPhone-pasteable. No code fences on purpose. Full audit: docs/audits/platform-audit-2026-05-31.md.

CONTEXT
Cowork already shipped live this pass: a .gitignore guard for docs/overnight/.lock, the audit report, a refreshed ledger, and a health-dashboard artifact. Nothing in the DB needed changing — security is clean, the offer RPC (get_edition_high_offer) is correct, no broken view/RPC was found. Everything below is route/.tsx (Cowork can't push code), so it's yours. Prod at handoff: commit 61fd1e6, deploy dpl_6xk89SzM... READY. No docs/FREEZE.md. Skim docs/overnight/ledger.md first — these items are queued there too (A1–A6).

Claude Code's direct file inspection wins over this doc and over project_knowledge_search on any disagreement — adapt to the actual file shape. I verified each path with grep/Read except where noted "CC verify the exact line."

GUARDRAILS (every item)
- Direct to main. No branches, no PRs. If a claude/* branch is pre-checked-out, switch to main first.
- Commit via PowerShell git on Windows (Git Bash git commit can silently no-op). Re-verify push: git rev-list --count origin/main..HEAD should be 0.
- curl fails silently in Git Bash for Vercel REST — use PowerShell Invoke-WebRequest.
- Vercel Pro maxDuration hard cap is 800s — higher sends the deploy to ERROR invisibly.
- CRLF: don't string-replace-patch on Windows; full-file writes or findIndex on split lines.
- After each: npx tsc --noEmit clean, push, watch the Vercel deploy reach READY, run the smoke test.

----------------------------------------------------------------
ITEM 1 (P1) — Stop serving FAKE offers on the logged-in collection grid
----------------------------------------------------------------
File: app/api/best-offers/route.ts (full file, 81 lines — verified). Caller: app/(collections)/[collection]/collection/page.tsx (enrichOffers -> POST /api/best-offers; subagent cited ~line 838 — CC verify the exact line via grep "best-offers").

WHY: The route is a pure mock. It hashes momentId+editionKey, decides shouldHaveOffer = seed % 4 !== 0, and returns a random offer = 1 + (seed % 2500)/100 (so $1.00–$26.00) with a random bestOfferSource of "Top Shot Edition" / "Top Shot Serial" / "Flowty Serial". No DB, no API. So the authed collection grid shows fabricated bids to real allowlisted users, and cites Flowty (dead since ~May 13). This is a trust bug, and the single clearest "not up to standard" finding.

FIX (preferred): make the route return REAL edition-level offers from badge_editions.highest_offer (the same live source the moment/edition detail pages already use via get_edition_high_offer). The route receives momentIds[] + editionKeys[] (editionKeys are the integer on-chain pair "setID:playID" = badge_editions.external_id). Implementation:
- Take a service-role Supabase client (typed any, per CLAUDE.md).
- Resolve the collection_id (the collection page knows it — pass it in the POST body, or derive from the route's [collection] param; CC decide the cleanest contract).
- Query badge_editions: select external_id, highest_offer from badge_editions where collection_id = <id> and external_id in (<distinct editionKeys>) and highest_offer is not null and highest_offer > 0. Chunk the in() at 500 (PostgREST URL cap — same pattern as the fmv-recalc .in() chunking).
- Map back per momentId by its editionKey. bestOfferSource = "Top Shot Edition", bestOfferType = "edition". Return bestOffer: null for keys with no row (the grid already renders a dash for null — keep that).
- Delete hashString / the random branch entirely.
Caveat to surface in the grid copy if not already: this is the edition-level top offer, TS-only (badge_editions only carries TS offers). Non-TS rows return null.

FIX (fallback, if you'd rather not wire data right now): delete the offers column from the collection grid and drop enrichOffers + the /api/best-offers fetch, so nothing fake is shown. Smaller change, removes the trust bug, loses the feature.

REVERT: git revert the commit. Pure additive/removal in two files; no DB.
VERIFY: load /<collection>/collection authed; offer values now match badge_editions (spot-check one edition against get_edition_high_offer), or the column is gone. tsc clean, deploy READY.

----------------------------------------------------------------
ITEM 2 (P2) — Broaden edition-offer COVERAGE (the substance of the offers ask)
----------------------------------------------------------------
Files: the badge-sync writer app/api/badge-sync/route.ts (writes badge_editions.highest_offer today, but only for badge-tag-gated plays), and/or a new dedicated sweep route. DB: badge_editions already has the highest_offer + low_ask columns and get_edition_high_offer reads them — no schema change needed.

WHY: get_edition_high_offer + both detail pages display the correct MAX offer, but only 2,087 of 16,293 TS editions have a value because badge-sync only walks searchMarketplaceEditions(byPlayTagIDs) (badge-tagged plays). Editions that have a live Top Shot offer but no tracked badge tag show "—". Other collections show 0 offers entirely. This is a feed-throughput gap, not a render bug.

FIX (TS, the high-value one): add a sweep that pulls highestOffer + lowAsk for ALL TS editions, not just badge-tagged ones, and upserts into the table get_edition_high_offer reads (badge_editions, or a dedicated edition_market table if you prefer to decouple offers from badges). searchMarketplaceEditions is index/marketplace-gated (it won't surface every edition), so pair it with the editions the indexers already know are listed/offered. Reuse the integer-pair keying that 0a8c5db/5bd3cd6 just fixed (prefer set.flowId/play.flowID, then the sets-table UUID->set_id_onchain map; never UUID-key — those never join editions.external_id). Same onConflict:(external_id,collection_id) so it can't poison batches.
NOTE: this overlaps ledger Q8 (badge-sync onConflict:id vs UNIQUE(external_id,collection_id) batch-poisoning). Decide the badge_editions row-grain (one-row-per-play vs per-parallel) before scaling the sweep, or offers will hit the same dropped-batch issue. If you decouple offers into their own table, you sidestep Q8 entirely — recommended.

FIX (non-TS): AllDay/Golazos/UFC/Pinnacle have no live offer feed wired. Out of scope unless you want it — would need each collection's own offer source (DapperOffersV2 events or per-collection GQL). The real, unused app/api/moment-offers/route.ts already implements TS getTopOffers if you ever want per-serial offers.

DO NOT use marketplace_offers for this. It is frozen Flowty history (585,341 rows, states only LISTED/CANCELLED, last event 2026-05-16, edition_id NULL on every row). Pointing the RPC at it would show stale, cancelled, edition-less data.

REVERT: revert the sweep commit; data self-ages-out as Top Shot offers change. VERIFY: count(*) of TS editions with highest_offer>0 climbs well past 2,087; spot-check a non-badge edition page now shows Best offer.

----------------------------------------------------------------
ITEM 3 (P1) — Onboarding funnel leak: anon collection tiles -> /login
----------------------------------------------------------------
Files: components/HomePageMarketing.tsx (collection tile href at line 452: href={`/${c.id}/overview`}; JSON-LD SearchAction urlTemplate at line 308: .../nba-top-shot/collection?username={search_term_string}). Also the same /<collection>/overview dead-end in the login footer (app/login/page.tsx ~373) and the (collections) 404 layout (app/(collections)/[collection]/layout.tsx ~56). proxy.ts isPublicPath verified — it opens /insights, /share, /moment, singular entity pages, but NOT /overview or /collection.

WHY: The marketing home is shown ONLY to logged-out users, and its collection cards + structured-data search point at auth-gated pages, so an anon user clicking a collection (the obvious first action) bounces to /login at the activation moment. The primary wallet-paste box is already fixed (routes to public /share); this is the remaining leak.

FIX (pick one):
- A (smallest, recommended): repoint the tile href to a public destination — /insights (the no-friction wedge) or /share, and change the SearchAction urlTemplate to .../share/{search_term_string}. Keeps the funnel anon-reachable; no proxy change.
- B: open /<collection>/overview (GET/HEAD only) to anon in proxy.ts isPublicPath, same as the entity pages were opened. Only if /overview holds no user-private data — CC verify the overview page reads only public/service-role data before doing this.
Fix the login-footer + 404-layout links to match.

REVERT: git revert. VERIFY: in a logged-out/incognito session, clicking a home collection tile lands on a public page, not /login. tsc clean, deploy READY.

----------------------------------------------------------------
ITEM 4 (P2) — Mobile overflow on entity detail + insights tool pages
----------------------------------------------------------------
WHY: These pages have fixed multi-column grids and tables with no mobile fallback; inside the collection chrome's 24px padding they overflow ~390px.

Files + edits (CC verify each line; they're inline style objects):
- app/(collections)/[collection]/edition/[slug]/page.tsx:294 — hero gridTemplateColumns: "minmax(0,320px) 1fr". Make it stack below ~640px (wrap in a media query, or use repeat(auto-fit, minmax(min(320px,100%), 1fr))). Same file ~503 — "Special Serials" grid "minmax(0,160px) 1fr 1fr 120px" → 2-col under ~520px.
- app/(collections)/[collection]/player/[slug]/page.tsx:160 — hero "minmax(0,240px) 1fr" → stack. Same file ~244 — "Top Sales" 6-col grid (~560px min) has NO overflow-x wrapper → wrap the rows in a div with overflowX:auto, or stack under ~640px.
- app/(collections)/[collection]/pack/dist/[distId]/page.tsx:511 — hero "minmax(0,260px) 1fr" → stack.
- Insights TOOL pages render bare <table> with no overflow wrapper (the BOARD pages already wrap with .rpc-sq-table-wrap{overflow-x:auto} — mirror it): app/insights/pack-reality/page.tsx (table ~211), app/insights/tc-report/page.tsx (3 tables ~252/311/383), app/insights/squeeze-check/page.tsx (~191). Wrap each <table> in a div with overflowX:auto.
- Lower priority: the (collections) layout stacks ticker + breadcrumb + header + switcher + tabbar + bottom MobileNav; consider hiding the ticker under ~640px (the home header already hides nav links at <=768px — mirror that).

REVERT: git revert (pure CSS/markup). VERIFY: the entity edition/player/pack pages and the 3 insights tool pages no longer horizontally scroll at 390px (DevTools device toolbar). tsc clean, deploy READY.

----------------------------------------------------------------
ITEM 5 (P2/P3) — Moment-page mojibake + brand bare-literals + missing asset
----------------------------------------------------------------
5a (P2) Mojibake — app/moment/[id]/page.tsx. 21 corrupted bytes: the empty-cell placeholder is stored as "â" (should be the em dash —) and a separator as "Â·" (should be the middot ·). Confirmed at lines 833, 840, 880, 934, 994, 1005 ("...Â· {s.set_name}..."), 1014, 1119 (and a few more). Real users see garbage glyphs in empty cells. FIX: re-encode those literals as proper — / · / … (the file already imports an EM_DASH constant elsewhere — reuse it), and save UTF-8. Grep the file for the stray bytes to catch all of them.

5b (P3) Brand bare-literals — replace bare #E03A2F -> var(--rpc-red), bare 'Barlow Condensed' -> var(--font-display), bare 'Share Tech Mono' -> var(--font-mono) in: app/(collections)/[collection]/layout.tsx (highest traffic — wraps every collection page), app/share/[wallet]/page.tsx (public funnel card), app/(collections)/disney-pinnacle/layout.tsx + collection/page.tsx, app/(collections)/[collection]/player/[slug]/page.tsx, the profile pages (app/profile/[username] + the (collections) variant + profile/edit ACCENT_RED), and the component literal-consts (ProGate, OnboardingModal, SignInWithDapper, components/profile/*, auth/SignOutButton, auth/ProBadge). Do NOT touch: app/rpc-tokens.css, ConsoleGreeting, OG/Satori routes under app/api/og/*, email HTML routes, SVG stroke/fill hexes, lib/collections.ts accent (brand data). The var(--rpc-red, #E03A2F) fallback pattern is fine — leave it.

5c (P3) Missing asset — public/home-fmv-preview.png does not exist; the home "LIVE FMV PREVIEW" is a hardcoded mock (HomePageMarketing.tsx ~707-789 with a // TODO). Either add a real screenshot at that path and render it, or leave the styled mock but drop the dead reference. Also the home STATS are hardcoded ("100% Uptime", "9.5K+ Data Refreshes", // TODO: wire) — wire to real counters or soften the copy.

REVERT: git revert. VERIFY: moment page renders — / · correctly; grep finds no bare #E03A2F outside the allowed files. tsc clean, deploy READY.

----------------------------------------------------------------
ITEM 6 (P3, optional) — Smoke suite cron-rush cry-wolf
----------------------------------------------------------------
File: app/api/smoke-test/route.ts (+ the smoke schedule). WHY: The only unresolved Sentry issues (NEXTJS-1D anon-SECDEF, -1E detect_stalled_pipelines, -1C RLS) are all POST /api/smoke-test, firing 1–3 events at the :00/:06 and :00 cron-rush windows when DB connection-pool pressure makes a smoke query transiently fail — the underlying state is verified clean every time. The harm is desensitization (a real security/FMV smoke failure later gets dismissed as "the midnight flake"). FIX: make the DB-dependent smoke assertions retry once on a transient connection-pool/statement-timeout error before asserting failure, OR shift the smoke schedule a few minutes off :00/:06. Folds ledger Q5 (smoke sales-lag threshold — compute lag from last successful sales-indexer run, not newest sales.sold_at) into the same change. REVERT: git revert. VERIFY: the 3 smoke Sentry issues go 24h quiet; mark resolved.

END STATE: ~5 small commits on main, each deploy READY, smoke green; the authed collection grid shows real (or no) offers, anon home tiles reach a public page, the moment page renders clean glyphs, entity + insights-tool pages don't overflow on mobile, and the smoke suite stops crying wolf. Offer coverage (item 2) is the larger follow-on.
