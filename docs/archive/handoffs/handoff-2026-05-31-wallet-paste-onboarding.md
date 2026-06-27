HANDOFF / SPEC — Wallet-paste onboarding: fix the activation funnel leak + RPC Index hub
Date 2026-05-31. Topic: components/HomePageMarketing.tsx, proxy.ts, app/share/[wallet], a public index hub. Scoped during the "what's next" pass. The funnel-leak fix is P0-for-traction; the RPC Index is a follow-on.

WHY THIS MATTERS
Project's own read (memory: rpc-funnel-instrumentation-gap): RPC is PRE-traction and distribution/activation is the bottleneck, not features. This handoff fixes the single worst activation leak and adds a public front-door. All code (Cowork can't deploy) → handoff. Your file inspection wins over this doc.

=====================================================================
ITEM 1 — P0 — The marketing wallet-paste box walls every anon visitor
=====================================================================
FILES: components/HomePageMarketing.tsx (classifyAndRoute, ~line 15) + proxy.ts (isPublicPath).
THE LEAK (verified):
- app/page.tsx renders <HomePageMarketing/> ONLY for logged-out users (authed users redirect to /dashboard). So 100% of the marketing page's audience is anon.
- The hero CTA (WalletSearch, used at HomePageMarketing.tsx ~325 + ~809) calls classifyAndRoute(value), which returns:
    wallet  -> /nba-top-shot/collection?wallet=<addr>
    else    -> /nba-top-shot/collection?username=<handle>
- /<collection>/collection is auth-gated (proxy.ts opened only the SINGULAR entity segments — edition/set/player/team/series/pack — to anon; /collection, /market, /sniper, /overview, /analytics stay behind the funnel).
- Net: anon pastes their wallet into the #1 CTA, clicks ANALYZE, and is 302'd straight to /login. Hooked with "see your collection value," walled the instant they act.
ALSO: app/share/[wallet]/page.tsx is a BUILT public-style results card (Total Collection FMV hero + Top Moments by FMV, via /api/collection-snapshot, with OG) — but /share is NOT in proxy.ts isPublicPath, so anon hitting a shared /share link ALSO gets /login (breaks the share flow). /profile/<username> IS public (proxy.ts ~292) and /api/wallet-search is public.
FIX:
(a) proxy.ts — add /share to isPublicPath for GET/HEAD (mirror the /profile/<username> + /moment public rules; /share is a wallet-keyed read-only card with the same share rationale). One isPublicPath block.
(b) HomePageMarketing.tsx classifyAndRoute — route anon to a PUBLIC results surface instead of the gated /collection:
    wallet (FLOW_ADDRESS) -> /share/<addr>
    username -> resolve via /api/wallet-search (public) to an address then /share/<addr>, or route to /profile/<username> if a public profile exists; fall back to /share with the username-resolved wallet.
   (Only the marketing-page callers need this. The in-app callers — OnboardingModal, CrossCollectionPortfolio — are for logged-in users and can keep routing to /collection.)
(c) app/share/[wallet]/page.tsx — add a clear conversion CTA: "This is a free preview. Sign up to track FMV, badges, set completion, and deal alerts for this wallet →" linking /signup (and a secondary link into /<collection>/collection which will prompt login). Keep it honest (no paywall language per memory: no-paywall-until-traction).
REVERT: git revert (proxy.ts block + classifyAndRoute + the CTA).
VERIFY: logged-out, paste a wallet on the homepage -> lands on /share/<addr> showing real FMV + top moments (NOT /login); a shared /share link opens for anon; the signup CTA is visible. Instrument the click (the front-door instrumentation shipped 2026-05-30) to measure paste->result->signup.

=====================================================================
ITEM 2 — P1 — Enrich the anon results page for activation
=====================================================================
FILE: app/share/[wallet]/page.tsx (+ reuse /api/collection-snapshot, /api/wallet-summary, /api/wallet-search).
WHY: /share currently shows Total FMV + Top Moments. To actually activate, show enough free value that signing up is the obvious next step, without giving away the full product.
ADD (reusing existing APIs): tier/series mix, badge count, biggest mover or a "rarest moment" highlight, and per-collection rollup if the wallet holds >1 collection (cross-collection is RPC's differentiator). Cap depth (e.g. top 10 moments) and gate the deep analytics (full grid, sniper deals, set completion) behind the signup CTA. Keep it fast (these APIs already back the gated /collection page).
REVERT: git revert.
VERIFY: a whale wallet (e.g. 0xbd94cade097e50ac) shows a compelling free preview; a small wallet still renders gracefully.

=====================================================================
ITEM 3 — P2 — "RPC Index": a public, indexable front-door hub
=====================================================================
WHAT EXISTS: the differentiated public surfaces already ship and are anon + indexable — /insights/{squeeze,pack-reality,rookies,first-mint,cross-collection,set-squeeze,pinnacle-scarcity} + /analytics. There is no single hub that ties them together as a branded "index of the Flow collectibles market."
SPEC: build /insights (or a dedicated /index) as a public hub that (a) lists every insights surface with a one-line value prop + a live headline stat pulled from each backing view (e.g. squeeze: "985 editions ≥50% locked"; pack-reality: the 60d KPI), and (b) shows a compact market-overview band (top movers / volume) from existing market APIs. This is the SEO + credibility front-door that the wallet-paste box and Google traffic land near. Reuse the public /api/public/insights/* endpoints (all anon, 200-verified) — no new data work. Add it to the sitemap + an OG card (the /api/og/insights generator already exists).
REVERT: delete the hub route.
VERIFY: /insights hub renders anon, links resolve, each card shows a live stat; in the sitemap; OG card renders.

GUARDRAILS: direct to main, no branches/PRs; PowerShell git + verify push; no CRLF string-replace patches; tsc clean; no paywall/monetization language (memory: no-paywall-until-traction) and no promo/launch copy (memory: no-promo-until-launch-ready) — this is product/funnel plumbing, not a launch.

EXPECTED END STATE
Item 1 → anon wallet-paste lands on a real free results page (not /login); shared links work. Item 2 → that page is compelling enough to convert. Item 3 → a public hub turns the insights surfaces + Google traffic into a coherent front door. Together these attack the actual bottleneck (activation/distribution) rather than adding features behind the wall. Measure with the existing click/instrumentation before/after.
