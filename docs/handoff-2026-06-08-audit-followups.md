# Handoff 2026-06-08 — full-audit follow-ups (CX/SEO wiring, brand debt, Flowty copy, mobile, polish)

CONTEXT
Cowork ran a Trevor-requested full-platform audit (report: docs/audits/cowork-full-audit-2026-06-08.md). Already shipped live from Cowork: migration audit_20260608_seed_sets_wnba_skyline_254 (TS set 254 "WNBA Skyline" sets-row seed + edition set_id backfill; stub fn verified healing — expect the hydrator catalog_gap noise for set 254 to be gone; revert SQL in the report). Everything below is route/.tsx/docs work Cowork cannot push. HEAD at audit time: 26fc9f3, all deploys READY. Item 1 duplicates inbox 2026-06-08T03-15Z item 1 on purpose — it is the highest-priority code item and the inbox file has the full forensics.

Claude Code's direct file inspection wins over this doc and over project_knowledge_search on any disagreement — adapt to the actual file shape.

ITEM 1 — [HIGH] Re-key the smoke-test Pinnacle FMV drift guard to pinnacle_catalog (red canary on every tick)
File: app/api/smoke-test/route.ts (~L1142–1199, "Pinnacle FMV not borrowed across characters (drift guard)").
Why: the a9f86af concierge swap reads per-render pinnacle_catalog, but the guard still validates rows against pinnacle_editions (character_name, set_name, variant_type). Verified false-positive by direct SQL: pinnacle_editions has 0 Goofy rows for the flagged set while pinnacle_catalog has 4 priced; AND pinnacle_catalog.set_name for that set carries a LEADING SPACE so string-equality fails even on overlapping tuples. Until fixed, every smoke tick fails this check (Sentry JAVASCRIPT-NEXTJS-14) and the canary masks real leaks.
Fix: validate against pinnacle_catalog using (character_name, trim(set_name), variant) — NOTE the catalog column is variant, NOT variant_type — and/or trim set_name in the searchPinnacleDeals row output. While there, eyeball whether fmv=$1 rows are the old Flowty $1-floor artifact resurfacing via floor/ask inputs.
Do NOT resolve the Sentry issue first — fix the guard, watch one clean tick, then resolve with regression arming.
Revert: git revert of this commit.
Verify: next smoke tick passes the drift guard; JAVASCRIPT-NEXTJS-14 stops re-firing.

ITEM 2 — [HIGH CX/SEO] Open /legal/fmv-methodology to anon
File: proxy.ts (isPublicPath).
Why: the page exists (app/legal/fmv-methodology/page.tsx) but there is no /legal carve-out, and it is linked from components/SiteFooter.tsx (L176 "FMV METHODOLOGY" + L201 "How is FMV calculated?") which mounts on every public surface, AND from the public /pricing page. Anon users and Googlebot 302 to /login on the FMV-disclosure link — undermines the legal-disclosure intent. Verified by code inspection and a live walk (pricing page links it).
Fix: add a narrow GET/HEAD isPublicPath rule for /legal (read-only static content; same risk profile as /about /privacy /terms). Consider adding /legal/fmv-methodology to app/sitemap.ts static URLs.
Revert: delete the isPublicPath block.
Verify: anon (incognito) GET /legal/fmv-methodology returns 200 content, not a /login redirect; tsc clean; deploy READY.

ITEM 3 — [MED CX/SEO] Decide /blog: open it or unlink it
Files: proxy.ts, app/sitemap.ts, components/TopNav.tsx (L21).
Why: app/blog/page.tsx is force-static marketing content with indexable metadata (clearly built for SEO) but it is auth-gated and absent from the sitemap, while the public TopNav links it — anon clicking "Blog" from a public overview bounces to /login.
Recommended: add /blog to isPublicPath (GET/HEAD) + sitemap entries. Alternative: remove the TopNav link.
Revert: inverse of whichever path chosen.
Verify: anon GET /blog 200 (or no Blog link rendered for anon).

ITEM 4 — [MED SEO/honesty] De-Flowty the /analytics public-facing metadata + copy
Files: grep -i flowty under app/analytics/ — the audit found: /analytics/loans/* OG titles/descriptions still say "Live Flowty loan book" / "Flowty loan analytics"; /analytics/listings description "Open Flowty loan offers…"; /analytics/wallets titled "Flowty Wallet Directory — Lenders & Borrowers"; a "Marketplace mix (Top Shot, Flowty, Pinnacle direct)" copy string on the sales landing. lib/flowty-username.ts is still imported by app/analytics/wallets/page.tsx.
Why: Flowty shut down 2026-05-13; these surfaces present a dead marketplace as live. The data underneath is the frozen historical archive (fine) — only titles/descriptions/copy need "(historical)" framing, mirroring the admin/flowty-analytics treatment.
Keep: app/admin/flowty-analytics/* (already framed historical by design), flowty_* DB history.
Revert: git revert.
Verify: tsc clean; the pages render with historical framing; no live-sounding Flowty copy left in app/ outside admin archive surfaces (grep).

ITEM 5 — [MED mobile] Public-page responsive fixes
Files + exact spots (verified by audit subagent; re-verify line numbers on the actual files):
a) app/insights/cross-collection/CrossCollectionBoardClient.tsx ~L280 — the "What the cohort collects" table sits in .rpc-cc-overlap (max-width only) with white-space nowrap cells; wrap it in the same overflow-x-auto pattern (rpc-scroll-x / rpc-table-wrap) every other insights board uses.
b) Raw 1fr inline grids on PUBLIC pages — convert to minmax(0,1fr) (repo convention, prevents content blowouts at 390px): app/(collections)/[collection]/overview/page.tsx ~L389 (repeat(3,1fr)) + ~L428 + ~L543 ("1fr 1fr"); app/moment/[id]/page.tsx ~L794; app/share/[wallet]/page.tsx ~L309; app/profile/[username]/page.tsx ~L540; components/profile/CrossCollectionPortfolio.tsx ~L76; components/HomeFmvPreview.tsx ~L139.
c) Optional same-class auth-gated stragglers: app/(collections)/[collection]/profile/[username]/page.tsx ~L672/~L764, app/rewards/page.tsx ~L441/~L1137, app/dashboard/page.tsx ~L1350, app/my-teams/page.tsx ~L355, plus the analytics leaderboard tables (app/(collections)/[collection]/analytics/page.tsx ~L899/:991/:1613/:1663/:1893/:2134) lacking overflow-x wrappers.
Why: 390px viewport overflow risk on exactly the public/SEO surfaces. Chrome-side mobile emulation doesn't take in Cowork's setup, so these were code-verified; a quick real-device or devtools spot-check after the fix closes the loop.
Revert: git revert.
Verify: tsc clean; at 390px width no horizontal document scroll on /insights/cross-collection, a collection overview, /moment/<id>, /share/<wallet>, /profile/<username>.

ITEM 6 — [MED brand, phased] Brand-token sweep phase 1 + CI guard
Why: audit found ~20 hardcoded #E03A2F and ~77 hardcoded 'Barlow Condensed'/'Share Tech Mono' literals in live UI, violating the CLAUDE.md brand rule (tokens only: var(--rpc-red), var(--font-display), var(--font-mono)). Acceptable exceptions: lib/og/* + app/api/og/* (Satori can't resolve CSS vars), email HTML in app/api/check-alerts + app/api/subscribe/unsubscribe, ConsoleGreeting.tsx, and var(--rpc-red, #E03A2F) fallback patterns. Per-collection accent hexes in the collections registry are data, not violations.
Phase 1 (this handoff): public-facing pages only — app/(collections)/[collection]/analytics/page.tsx (chart color map incl. topshot: "#E03A2F"), collection/page.tsx ~L443 accent fallback, overview/page.tsx (3x), sniper/page.tsx accent fallback, app/(collections)/[collection]/profile/[username]/page.tsx (7x), plus font literals on those same pages. Note FmvHistoryChart recharts stroke is a known justified exception (SVG presentation attr can't resolve var()).
Phase 2 (separate session): admin pages, onboarding modals (FirstRunTour, WelcomeModal), components (ProfilePicker, collection-tab-bar, fast-break/*, rtr/*), blog pages.
CI guard idea (small): a grep step in ci.yml failing on '#E03A2F' or 'Barlow Condensed' outside the allowlisted paths, so the debt can't regrow.
Revert: git revert per commit.
Verify: tsc clean; pages visually unchanged (tokens resolve to the same values); CI grep green.

ITEM 7 — [LOW polish batch] (one commit is fine)
a) Dashboard collection cards: render an em dash (or "no priced editions yet") instead of "$0" when a collection has zero FMV-priced rows — UFC currently shows MOMENTS 247 / FMV $0, which reads broken but is honest (audit verified 0 of those rows map to a priced edition).
b) Edition page "FOUND IN THESE PACKS": rows with 0 slots / 0% depleted (exhausted or weightless pools) — label them exhausted or hide; "0 slots · 0% depleted" reads like broken data (seen live on 2:188 Locker Pack rows).
c) Squeeze board: product call — low_ask renders troll asks raw ($3333k on an FMV-less ULTIMATE). Option: de-emphasize or omit low_ask when FMV is null (no anchor). Trevor decides; fine to skip.
d) proxy.ts: remove the vestigial /api/cart isPublicPath entry (Cart shelved 2026-05-24; the bypass is dead attack surface; re-add on revival).
e) lib/seo.ts: delete the dead profilePageMetadata export (zero importers — the profile layout builds its own metadata).
f) Docs chore: git mv docs/handoff-2026-05-28-fmv-items-4-5.md docs/archive/handoffs/ and update the one CLAUDE.md link pointing at it (Cowork did not touch CLAUDE.md — mount edit hazard).
g) GIT-IDENT: in the shared clone run git config user.name + user.email back to Trevor's identity — every commit today (the whole Pinnacle wave) is authored rpc-daytime-monitor.
h) Ledger/CLAUDE.md logging: add a Recent-sessions entry for this audit + ledger Shipped entry for audit_20260608_seed_sets_wnba_skyline_254 (revert SQL in the audit report §Shipped).
Verify: tsc clean, deploy READY, smoke green.

OPERATOR NOTE (not CC): the minute-:00 pipeline spike is the wallet-backfill dispatch storm (seed-wallet-refresh chain), not the staggered crons — 20h histogram :00 = 1,233 runs of which 871 are the wallet-backfill family, plus a secondary :45–:52 pile. Tonight's 00:50 topshot-fmv-populate tick failed on pool timeout inside the 00:48–01:05Z burst. Feed this to stagger-histogram-verify-jun8 (runs 06-08 8pm) before moving any cron-job.org slots; likely lever is moving the seed-wallet-refresh slot off :00 and NOT onto :45–:52.

GUARDRAILS (standing)
Direct-to-main, no branches, no PRs; if a claude/* branch is pre-checked-out, switch to main first. Commit via PowerShell git on Windows (Git Bash git commit can silently no-op); re-verify push with git rev-list --count origin/main..HEAD (expect 0). curl fails silently in Git Bash for Vercel REST — use PowerShell Invoke-WebRequest. Vercel Pro maxDuration hard cap is 800s. CRLF: no string-replace patches; full-file writes or findIndex on split lines. Known blocker: the un-removable .git/index.lock from the sandbox side (Q7) — clear it locally first if still present (del .git\index.lock).

EXPECTED END STATE
Items 1–2 shipped same-day (canary un-masked, legal page public), 3–7 as time allows; commits on main, deploys READY, smoke green including the re-keyed Pinnacle guard; JAVASCRIPT-NEXTJS-14 resolved with regression arming after one clean tick; anon can read the FMV methodology from the footer and pricing page.
