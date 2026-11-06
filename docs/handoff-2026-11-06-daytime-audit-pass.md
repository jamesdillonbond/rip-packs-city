# Daytime audit pass — 2026-11-06 (~8:43 AM → ~11:50 AM PT)

**Session:** Cowork cloud, repo attached via `add_repo` → shallow clone → direct push (two pushes, CI green on both); Supabase MCP reads and `apply_migration` both passed first try (two migrations applied); laptop linked, no folders (not needed). Trevor: *"work autonomously for the next 5 hours … deep dive audit and QA across all pages, across the project and all our tools … SEO, UI, UX, CX, Concierge, security, new user onboarding, user flow, retention, growth, and workflows."*

**Verdict: GREEN · 4 code commits + 3 DB migrations shipped · 0 reverted · oldest routed: #228 cold-whale snapshot (carried, 3 nights; not recurring).**

⚠ Nothing in this pass was blocked by the environment. Trevor's machine, Cowork and Claude Code push and apply normally. **Commit and apply as usual.**

## What was reviewed

- CLAUDE.md, ledger top matter (through the 11-06 overnight entry and the 7:05 AM PT trophies-max_ms apply), inbox INDEX (every item dispositioned), known-issues open rows (#66, #208–#210, #218, #221, #228, #229, #234), roadmap-2026-10-17 §4, `ops:ready-queue` (5 carried items), the 11-05 daytime / 11-06 overnight handoffs.
- **Health sweep (DB + Vercel), all clean:** security invariants `[]`, secdef-anon drift 0, when-others-blind 0, stalled `[]`, trust 40/40 ok (the overnight BREACH was applied at 7:05 AM PT), alerts 3 `info` (designed Atlas 403s), client beacon 0 real / 7 d, Vercel 6 chronic groups, db 44,312 MB, 41,266 runs / 24 h. `check_zero_yield_lanes` names `pack-pulls-chain-history` — read: 4,658 TS rips in 7 d, **0 unresolved pulls in 14 d**, the lane has nothing to read (its 1,440 one-minute ticks/day are `pg_sleep(30)` + a few probes); not a fault. Three `*-listing-cache` rows are the retired Flowty lanes aging out.
- **User-facing QA instruments:** 373-page curl sweep (status / canonical / robots / og:image / h1, stratified over all 9 sitemap shards): 373/373 200, self-canonical, index. 187-page 390 px Playwright sweep (dark): 0 overflow / broken / scanning. 34-page light-theme 390 px and 34-page 1280 px sweeps: clean. Concierge probed anonymously with a pricing question and a Candy new-user question — both answers accurate and complete (two `support_conversations` rows from this session, `qa-…-c960e655` session ids; not smoke-tagged).
- Supabase advisors: 4 `function_search_path_mutable` (none SECURITY DEFINER; two SQL-language helpers a `SET` would stop inlining; one COMMITting procedure) and 5 anon-exec secdef lints = the known allowlist (drift 0). Left.
- Vercel analytics 7 d: edition pages are the top organic entry (38 visitors), then player pages (25), set (21), home (19), collection (15), share (13) — the entity pages are where SEO work pays.

## Shipped

**Batch 1 — `f393e17` (ledger) + `9ddc5f12f` (code), CI run 42265091946 all success, deploy READY; verified live.**

1. **Search typo fallback.** `/api/search?q=murry` (also `dontcic`, `wemby`, `jalen bruson`) returned 0. New `rpc_search_players_fuzzy` (`20261106172939` + ranking `20261106173036`; pg_trgm `word_similarity ≥ 0.45` over `players`, ~40 ms / 237 buffers, anon REVOKED, service_role only, composite "A | B" names excluded) → `lib/search/fuzzy-players.ts` runs ONLY on an empty exact result, re-runs the ordinary `rpc_search_catalog` per name (≤ 3) and keeps that name's player rows; `meta.fuzzy` labels the answer; `GlobalSearch` says "No exact match for “murry” — closest players:". Live: murry → Kris / Eric / Jamal Murray; dontcic → Luka Doncic first.
2. **One Sign In.** Two "Sign in" controls on every collection page at 390 px (header + the banner's `AnonSignInPill`, 07-17). The header button now carries `?next=<path>` (never an auth page); the pill is deleted; tests re-pinned on the header button.
3. **og:image** on /market, /sniper, /privacy, /terms, /early-access (the 10-14 /about + /help hole, five more pages) + guard `inline-opengraph-blocks-carry-an-image.test.ts` (tree walk over every `openGraph: { ...OG_INHERITED` literal; shared scanner in `__tests__/helpers/object-literals.ts`).
4. **JSON-LD on the cross-collection hubs.** `/players/<slug>` (~2,000 indexable) and `/teams/<league>/<slug>` (31) carried none: `playerHubJsonLd` (Person + BreadcrumbList; breadcrumb ONLY when the name spans sports — rule 2) and `franchiseHubJsonLd` (SportsTeam + BreadcrumbList). Guard `cross-collection-hubs-emit-json-ld.test.ts`.
5. **Binder tab, one wallet box.** `/<c>/collection` for an anonymous visitor showed the layout's "What's your collection worth?" band AND the page's own lookup input; the band now suppresses itself on the Binder tab (its own SUPPRESSED rule, keyed on the tab), and the page input takes the brand mono font.

**Batch 2 — `17ee177` (ledger) + `76709f8b1` (code), CI run 42269123963 all success; verified live (the four mixed-case URLs 308 to lowercase; the UFC edition key untouched 200).**

6. **Mixed-case URLs → 308.** `/NBA-Top-Shot/overview`, `/nba-top-shot/player/Jamal-Murray`, `/nba-top-shot/set/2025-NBA-Playoffs-Common`, `/nba-top-shot/team/Denver-Nuggets` all 404'd. `proxy.ts caseFoldedPath`: first segment a published collection or hub root → 308 to the lowercase path (tab + player/team/set/character/series/product/pack slug), NEVER an edition key (UFC keys are uppercase), never `/share` / `/moment` / queries. Guard `proxy-case-folds-mixed-case-urls.test.ts`.
7. **Binder pre-search empty state.** The table showed fifteen column headers over nothing; it now says "Enter a username or wallet above to load its moments here — free, no sign-in." (desktop + mobile), distinct from the post-search "No moments found" claim; both pinned.

**Batch 3 — `b579599` (ledger) + `e3a1c6a95` (code); CI result in the digest.**

8. **Panini product pages carry JSON-LD.** The 68 `/panini-blockchain/product/<slug>` pages (indexable, sitemap-listed since 10-25) were the one entity route with no structured data; they now publish CollectionPage + BreadcrumbList + an ItemList of the top editions via the series pages' `collectionEntityJsonLd`.
9. **The homepage WebSite JSON-LD drops its SearchAction** — its target was `/share/{search_term_string}`, a wallet-card route robots.txt disallows, not a search; Google retired the sitelinks search box in Nov 2024.

**Batch 4 — `6b95821` (ledger) + `c59fd8497` (code), CI run 42277712661 all success; migration `20261106191250` applied; verified live (nugets → Denver Nuggets, playofs → the Playoffs sets, lakerz → Los Angeles Lakers).**

10. **Closest-match search covers teams and sets too.** "nugets" → Denver Nuggets, "lakerz" → Los Angeles Lakers, "playofs" → the Playoffs sets. `rpc_search_names_fuzzy` (kind, name, similarity over players + distinct `editions.team_name` + `sets` / Panini `sets_summary`) replaces and drops `rpc_search_players_fuzzy`; the route keeps each candidate's rows of its own kind. Empty-path cost ~145 ms / ~6.6k buffers (team leg); exact path untouched.

## Post-ship watch (what to read tomorrow)

- `/api/search` p95 — the fuzzy arm adds ≤ 1 + 3 RPCs only on the empty path; pgss `rpc_search_names_fuzzy` mean should sit ~150 ms (the team leg). If `meta.fuzzy` answers look wrong for a real query, the threshold (0.45) and the ranking are in `20261106191250`.
- Vercel runtime errors: no new group on `/api/search`, `/players/*`, `/teams/*`, `/<c>/collection`.
- GSC: Person/SportsTeam rich-result counts should rise for /players and /teams over ~2 weeks; "Page with redirect" may tick up from the case-fold 308s (that is the fix working).

## Read, not shipped (measured; levers named)

- **`get_pack_realized_ev_row` 5 s bounds (~4/day on `/[collection]/pack/dist/*`).** Body 3,476 buffers / 23 ms warm; the cost is the `pack_ev_latest` view's EV leg (a `pack_ask_state` hash of 2,027 rows = 2,041 buffer touches + 1,415 on `pack_ev_history`), so the overruns are contention, not plan. `mv_pack_ev_latest` is NOT a drop-in (374 of 1,392 TS dists absent, 412 `gross_ev` differ). Lever: a per-dist precompute of the EV leg, same freshness gate the 10-25 rip-leg MV uses. Trevor's standing "we want no errors" (11-04) makes this the next pack-page item.
- `/disney-pinnacle/pack/dist/0` ("[OLD] Summer Splash", 0 minted) and the "Internal Test" / "Redemption Test" dists are sitemap-listed and indexable (the 09-07 prune keeps 0-minted as "unknown"). Five URLs; left.
- `/share/*` is `Disallow`ed in robots.txt while the page says `index, follow` — consistent with the 10-03 decision (personal cards stay out of the index); noted only because a reader could mistake it for a contradiction.
- Entity pages at 390 px put the subject ~440 CSS px below the top (header + ticker + collection banner + tab bar + wallet band + breadcrumb) — each layer is a recorded 07-25 / 08-22 decision; not re-litigated here. If Trevor wants the hero compact on entity routes, `CollectionBanner` + `WalletSearchBand` are the two places.

## Queued for Trevor / Claude Code

1. **[P2, Claude Code, 0 nights] per-dist EV precompute for `get_pack_realized_ev_row`** — the only user-facing error class left on the pack page (above).
2. **[P3, Claude Code, 3 nights] #228 cold-whale `/api/collection-snapshot` timeout** — SQL lever exhausted; next is the CDN warm (route/edge). Not recurring since 11-04.
3. **[P4, Trevor, 2 nights] `net._http_response` growth lever** — weekly read ~11-11.
4. **[P3, Trevor, 2 nights] cron-job.org account has no MFA** — from the 11-04 incident.
5. **[P4, Trevor, carried] #58 `OPENSEA_API_KEY`** — only if Candy still has 0 indexed sales on 11-27.

## Closed / RESOLVED this pass

- The overnight pass's queued `v_insights_trophies` max_ms re-baseline — already applied by Claude Code at 7:05 AM PT (ledger); trust 40/40 confirmed here.

## Revert paths

- Code: `git revert 9ddc5f12f` (batch 1) / `git revert 76709f8b1` (batch 2) / `git revert e3a1c6a95` (batch 3) / `git revert c59fd8497` (batch 4).
- DB: `DROP FUNCTION public.rpc_search_names_fuzzy(text, uuid, integer);` — the route degrades to the plain empty answer when the function is missing (tested).
