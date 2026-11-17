# Handoff — next-block follow-ups (2026-05-31): SEO prune, conversion polish, offers depth, cleanup

Plain-text, iPhone-pasteable. No code fences. Companion: docs/operations/seo-gsc-checklist-2026-05-31.md (operator GSC steps), docs/audits/platform-audit-2026-05-31.md (the audit), docs/handoff-2026-05-31-audit-followups.md (the 6 items already shipped as a79b778).

CONTEXT
The audit + its 6 follow-ups are shipped (a79b778); the offers-sweep cron is live and edition_offers is filling. This handoff is the agreed "all four" next block: (A) SEO sitemap prune, (B) conversion-surface polish, (C) offers depth, (D) cleanup. All route/.tsx/SQL — Cowork verified the facts but can't push code. Prod at handoff: deploy READY past a79b778. No docs/FREEZE.md. Skim docs/overnight/ledger.md first.

Claude Code's direct file inspection wins over this doc on any disagreement — adapt to the actual file shape. Line numbers marked "verify" are from a Cowork subagent read; grep to confirm before editing.

GUARDRAILS (every item): direct to main, no branches/PRs; commit via PowerShell git (Git Bash can silently no-op), re-verify push with git rev-list --count origin/main..HEAD = 0; curl fails silently in Git Bash (use Invoke-WebRequest); Vercel Pro maxDuration cap 800s; full-file writes, not CRLF string-patches; after each: npx tsc --noEmit clean, deploy READY, smoke green.

----------------------------------------------------------------
ITEM A (P2, SEO) — Prune the sitemap to anon-public routes only
----------------------------------------------------------------
File: app/sitemap.ts (full file verified this session). WHY: the sitemap is now correctly populated (live: 33,448 URLs — 23.5K editions, 5.2K packs, etc.), but it also lists AUTH-GATED routes that 302 anon→/login, which Googlebot sees as redirects (wasted crawl budget + "Page with redirect" coverage noise). Confirmed against proxy.ts isPublicPath: the only public per-collection feature page is `overview`; `collection / market / sniper / sets / packs` are gated, and the ENTIRE `/analytics/*` section is gated (including every /analytics/wallets/<addr> and /analytics/sales|loans|fmv|sets|pulse|listings|methodology).

FIX: emit only anon-public URLs.
- featurePages: drop all of `col.pages` except `overview` (keep `${BASE_URL}/${col.id}` and `${BASE_URL}/${col.id}/overview`). Currently it maps every col.pages entry (~line 395).
- analyticsPages + walletPages: remove from the returned array (lines ~403-449, ~443-449) UNLESS you intend to open specific analytics surfaces to anon — that's a product call (these are intelligence pages; opening them could be a deliberate discovery play, but then they need to be added to proxy.ts isPublicPath, not just the sitemap).
- Keep as-is (all verified public): insightsPages, editionPages, momentPages, newSet/Player/Team/seriesPages, packPages, profilePages, static, /nba/fast-break.
- Also confirm legacySetPages (/analytics/sets/<id>, ~line 560) — gated under /analytics, so drop unless /analytics/sets/[id] is opened.

REVERT: git revert. VERIFY: refetch /sitemap.xml; grep it for "/market" or "/analytics/wallets" → 0 hits; entity/insights counts unchanged (~33K). tsc clean, deploy READY. Then resubmit in GSC (operator).

----------------------------------------------------------------
ITEM B (P2/P3, conversion) — First-run / onboarding polish
----------------------------------------------------------------
File: components/HomePageMarketing.tsx (logged-out marketing home) + app/share/[wallet]/page.tsx. WHY: this is what anon SEO + wallet-paste traffic lands on; small sharpenings raise conversion for a pre-traction product.

B1 — Messaging mismatch. Home says "No signup required" / "FREE DURING BETA" (verify ~lines 151, 826) while sign-in enforces a closed-beta allowlist (waitlist). For a logged-out visitor that's contradictory at the Sign-In moment. FIX: align the copy — e.g. "Free, no signup — explore Insights & any wallet" for the public value, and label the Sign-In CTA as "Request beta access" (→ /early-access) rather than implying instant login. Keep the public surfaces (insights/share/moment/fast-break) framed as the no-signup value.

B2 — Hardcoded home STATS. The STATS block (verify ~lines 252-257: "100% Uptime", "9.5K+ Data Refreshes") carries a // TODO: wire. FIX options: (a) wire to real numbers — pipeline_runs 7-day count for "Data Refreshes" via a tiny public /api/public/* stat route or an ISR server fetch; editions/sales totals for the others; OR (b) if not wiring now, soften to non-fabricated phrasing ("5 collections - 24/7 live pipeline - FMV on every edition"). Do NOT ship invented precise numbers.

B3 — "LIVE FMV PREVIEW" mock. The home depth card (verify ~lines 707-789) is a hardcoded mock with // TODO: replace with a real screenshot; public/home-fmv-preview.png does NOT exist (confirmed). FIX: either generate a real screenshot at that path and render it, or replace the mock with a real (cached) FMV sample pulled from /api/fmv/demo (already public, no-auth, 1h cache, 5 real samples) so the hero shows live data instead of fake.

B4 — /share empty-wallet state. A /share/<wallet> for a wallet with no indexed data renders a bare/empty card. FIX: add a friendly empty state — "We haven't indexed this wallet yet" + a "try another wallet" input + a link to /insights so the visit isn't a dead end. (app/share/[wallet]/page.tsx, the no-snapshot branch.)

REVERT: git revert. VERIFY: logged-out home reads consistently; /share of a nonsense-but-valid 0x… address shows the friendly state. tsc clean, deploy READY.

----------------------------------------------------------------
ITEM C (feature, intelligence depth) — Broaden offers beyond TS edition-level
----------------------------------------------------------------
Scope only — size before building. Today (post-a79b778): get_edition_high_offer serves the EDITION-level top offer from edition_offers (sweep) / badge_editions (fallback), TS only. Two extensions:

C1 — Per-serial offers on the moment page. app/api/moment-offers/route.ts already implements TS getTopOffers (byMomentID + byEdition, correct Math.max) but has zero callers. Wire it into app/moment/[id]/page.tsx so a specific serial shows its own best standing offer (per-serial bid) alongside the edition-level one — useful signal a collector wants when deciding to sell. TS-only (the GQL is TS). Per-request live GQL via topshot-proxy; cache ~5 min. Verify the route still works against current TS GQL before wiring (it's untouched dead code).

C2 — Non-TS offers (AllDay/Golazos/UFC/Pinnacle). No live offer feed exists for these. Would require each collection's own source (DapperOffersV2 events at 0xb8ea91944fd51c43, or per-collection consumer GQL). Bigger — only if there's product pull. Note: marketplace_offers is NOT a source (frozen Flowty, edition_id NULL).

Recommend C1 first (small, reuses existing code, real signal), C2 deferred until a collector asks.

----------------------------------------------------------------
ITEM D (cleanup) — dead-table teardown + two ledger items
----------------------------------------------------------------
D1 — Flowty + offers teardown bundle (DB, deliberate — NOT auto-shipped by Cowork because it's destructive on Flowty-era objects kept frozen by decision). Inventory verified this session: flowty_loan_events (13.9K rows/23MB), flowty_transactions (7.7K/11MB), flowty_loans (5.3K/5.4MB), flowty_scanner_state (1), flowty_excluded_addresses (7), offers (0 rows, 32kB), marketplace_offers (585K Flowty offer history). The empty `offers` table is referenced by exactly one function, `analytics_listings_open_loan_offers` (a Flowty loan-offers RPC) — so they're a dead pair. DECISION NEEDED (Trevor): the loan/tx/offer history was intentionally frozen (not dropped) per the 2026-05-24 teardown decision. If you now want the space back (~40MB + the 585K-row marketplace_offers parent), do a deliberate teardown migration: drop analytics_listings_open_loan_offers + offers first (confirm no /api caller greps to analytics_listings_open_loan_offers), then the flowty_* + marketplace_offers tables, each after a count(*) confirm. If keeping the history frozen, no action — they're inert and cheap. Either way, do NOT let an automated pass drop them.

D2 — Q6 evm-transfers-ingest Base-429 (LOW). app/api/cron/evm-transfers-ingest (or the worker). Adds jitter/backoff or a smaller per-tick block range so the hourly run stops logging ~6/24 "over rate limit" fails. Self-heals today; pure cadence hygiene.

D3 — Q8 badge-sync row-grain (the real lever for badge AND broader offer coverage). badge_editions upserts onConflict:"id" but also has UNIQUE(external_id,collection_id); parallels sharing an external_id poison ~part of each batch (upsertErrors). DECISION NEEDED: one-row-per-play vs per-parallel. Cleanest path given the new edition_offers table exists: keep offers in edition_offers (already decoupled, zero poison — proven by the sweep's upsertErrors:0) and make badge_editions one-row-per-play (align onConflict to external_id,collection_id + dedup the sweep by external_id). See ledger Q8 for the full write-up.

----------------------------------------------------------------
ITEM E (P2, trust/safety) — Trade Hub returns FAKE on-chain tx ids; shelve-or-finish + interim guard
----------------------------------------------------------------
Surfaced by the 2026-06-01 weekly health report (untracked across 3 reports). lib/trade-escrow/fcl-submit.ts stubs all 5 trade transactions, returning fake `0xstub_<verb>_<random>` tx ids (verified). LIVE routes import them: app/api/trade-chain/{propose,execute,deposit-callback}/route.ts + app/api/admin/reclaim-expired-trades/route.ts, with a UI at app/dashboard/trade-hub/page.tsx (TradeChainPanel.tsx literally shows "Cancel signing not wired yet"). WHY it matters: a fake tx id implies an on-chain asset SWAP that didn't happen — higher-stakes than the /api/best-offers mock.

CURRENT MITIGATION (partial, verified): propose 409s unless trade_matches.partya_offer_id+partyb_offer_id are populated (the columns exist but the matching that fills them isn't wired), and /dashboard/trade-hub is NOT linked from components/ nav. So it's a LATENT landmine, not actively firing — reachable only by an allowlisted beta user who navigates directly AND a fully-populated trade_match. Still worth closing.

DECISION (Trevor): live on-chain trade escrow is the same class as Cart, which was shelved 2026-05-24 under the intelligence-first / no-live-buy strategy. Recommend SHELVE it like Cart unless trading is a deliberate roadmap bet.

INTERIM SAFETY (small, do regardless of the decision): make the 5 submit* functions in lib/trade-escrow/fcl-submit.ts return a hard 503 "Trade escrow unavailable (contract undeployed)" instead of a fake 0xstub_ tx id (single guard at the top of each, gated on RPC_TRADE_ESCROW_ADDRESS being set), and hide/404 the /dashboard/trade-hub entry, until RPCTradeEscrow is actually deployed. Guarantees no user is ever shown a fabricated trade. Revert: git revert.

TRACKING: add Trade Hub to CLAUDE.md known-issues — the weekly report has recommended this 3 weeks running; it keeps falling between docs/trade-escrow/STATUS.md and the numbered list. (Cowork did NOT edit CLAUDE.md this pass — it was mid-edit by the nightly autonomous pass, uncommitted; left to you/CC to avoid clobbering that.)

END STATE: sitemap lists only crawlable public URLs; the logged-out home + /share read honestly and convert; per-serial offers live on moment pages; and the Flowty/offers teardown is a documented, deliberate decision rather than drift. Ship A + B first (cheapest, highest-leverage for the SEO traffic that's now reachable); C1 next; D on your timeline.
