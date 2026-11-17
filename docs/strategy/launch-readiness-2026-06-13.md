# Launch-readiness brief — 2026-06-13

Decision support for the roadmap's #1 open question: the 50-WAU launch gate. Not a recommendation to launch — a data-backed read of where the funnel actually stands. Companion: docs/audits/full-platform-audit-2026-06-13.md, docs/roadmap-2026-06.md.

## Headline: traction inflected; the gap is retention, not the product

WAU went **~2 → 11** in a week on the back of the June-10 organic signup wave. The product side is comprehensively dialed in (this week's full audit + FMV-accuracy validation). What the data says the platform now needs is a **reason to return**, not more features.

## The funnel (live, 2026-06-13)

| Stage | Value | Read |
|---|---|---|
| Total users | 20 | — |
| New users (30d) | 10 | the organic wave (all landed ~06-10) |
| New users with a saved wallet | **10 / 10 (100%)** | acquisition→onboarding **works** |
| Users with dashboard data (wmc) | **20 / 20 (100%)** | the backfill/prewarm rebuild holds |
| WAU (7d) | 11 | wave still inside the 7-day window |
| MAU (30d) | 12 | — |
| Returned >6h after signup | **1 / 10** | ⚠ **retention is the gap** |
| Rewards-active (7d) | 8 | the points economy is the main return hook today |
| Allow-list active (headroom) | 25 | room to invite ~more without new infra |

Sign-ins by day: 06-10 = 9 (the wave), 06-11 = 1, 06-13 = 1. The wave logged in once and largely hasn't come back. WAU=11 will **decay below ~3 after ~06-17** unless those users return — so "more signups" alone won't clear the 50-WAU gate; **retention compounds it or kills it.**

## Growth surfaces — verified ready to convert (2026-06-13, live)

- **Public profile** (`/profile/jamesdillonbond`) — fully SSR'd: $94.2K portfolio, Team Captain badge (the brand differentiator), trophy case with **live FMV + confidence chips**, "Share on X (+50 Status)" loop, "Build your own profile" CTA. The "build your own card" growth surface that was SSR-empty pre-`b566482` now looks great in link previews.
- **/share/<wallet>** — SSR'd (06-12 audit).
- **/insights** hub + boards (squeeze, rookies, trophies, cross-collection, pack-sniper, below-FMV) + the new **Top Sales** board shipping — the SEO/top-of-funnel surface area. 28K-URL sitemap.
- **Viral loops exist** (share-to-earn-Status, build-your-own) — the mechanics are in place.

Verdict: the conversion surfaces are ready. The bottleneck is upstream (traffic) and downstream (retention), not the surfaces themselves.

## Path to 50 WAU — the three levers (in priority order)

1. **Retention (highest leverage).** Give the 10 (and next cohort) a reason to return weekly. Concrete, mostly-built levers: the new **/insights/top-sales "Whale Watch"** board (fresh daily, shareable — shipping now); FMV/watchlist **alerts** (a "your moment moved / a deal appeared" email or notification is the classic collector return-hook — partially decommissioned, worth reviving); the **rewards** daily-visit/streak loop (8/10 already engage — lean into it). Without a return hook, acquisition leaks out the bottom.
2. **Traffic (SEO, the compounding lever).** The 28K-URL entity + insights corpus is the moat, but it only converts if it ranks/links. The internal-linking lever ([[rpc-seo-internal-linking-lever]]) + more shareable /insights surfaces (top-sales, movers) widen the funnel. This is slow-compounding; start now.
3. **Deliberate invites (controlled).** 25 allow-list slots active with headroom; the funnel converts 100% to onboarded. Inviting a targeted next cohort (e.g. the 100-2,000-moment target collectors from the research thread, or Dumbo/Dapper-adjacent) is low-risk now that onboarding is solid — *when* Trevor calls launch-ready (the no-promo-until-launch-ready constraint stands).

## Recommendation (decision support, not a launch call)

The **product is ready**; the gate is retention + traffic, both of which have built or near-built levers. The single highest-leverage next move is a **return hook** — ship the Top Sales board (done, backing view) + revive lightweight FMV/deal **alerts** so the platform earns a weekly open. Re-measure WAU after ~06-20: if the wave retains >30% and a second small invited cohort behaves the same, the 50-WAU gate is a matter of repeating the motion, not fixing the product. The launch-readiness *decision* (when to actively invite + eventually flip monetization) remains Trevor's.
