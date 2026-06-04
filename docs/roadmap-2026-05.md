# Rip Packs City — Product Roadmap (May 2026)

Companion to `docs/archive/audits/audit-2026-05-20-full-platform.md`. This document frames **where the platform is, where it should go, and in what order.** It is opinionated by design — adjust to taste.

---

## Where we are

Rip Packs City is a genuinely substantial production platform after ~6 months of build. It covers all 5 published Flow collections with a deep feature set: an FMV engine, a sniper deal feed, pack EV analytics, a multi-collection analytics suite, an AI concierge, badge tracking, account linking, and a fleet of 76 on-chain indexing pipelines. The foundations are sound — TypeScript compiles clean, RLS is enabled on all 172 tables with zero security errors, and pipelines run at ~97.6% success.

Two realities shape what comes next.

**1. The product is pre-revenue and pre-launch.** There are 10 authenticated users, 13 on the allow-list, and 1 active in the last 7 days. The Pro tier ($9.99/mo) has a built pricing page, but Phase-1 beta users hold free lifetime Pro. The platform has been built ahead of its audience — which is fine, but it means the next phase is about *readiness and reach*, not more features.

**2. The external venues the product was built on are eroding.** This is the most important strategic fact in this document:

- The Flowty marketplace is **offline** — the Market tab is empty and Sniper is degraded across every collection.
- UFC Strike **migrated off Flow to Aptos** (2025-07-30) — it is now out of scope for a Flow-native product; the site already shows a "marketplace shut down" notice.
- LaLiga Golazos shows a **"status uncertain"** banner.
- The Dapper NFTStorefront has churned through V1/V2 variants (the entire May 18 session was spent chasing it).
- The NBA odds feed is blocked from Cloudflare Workers, so Road to the Ring's picks are dead.

The "live marketplace / buy / snipe" surface depends on infrastructure that is actively winding down. The "intelligence / FMV / analytics / portfolio" surface does not.

---

## Where we should go — the thesis

Rip Packs City is really **two products sharing a shell**:

- **The intelligence layer** — FMV pricing, wallet analytics, portfolio tracking, pack EV, insider signals, the AI concierge. This is differentiated, defensible, owned end-to-end, and is *literally what the Pro page sells* ("Real-time FMV across every Flow collection, institutional flow tracking, unlimited wallet analytics, a Claude-powered concierge").
- **The marketplace layer** — the Market tab, the Sniper buy feed, the cart. This is increasingly blocked by external venues that are dying.

**Recommendation: make the intelligence layer the monetizable core and the brand promise. Treat live-buy/snipe as best-effort, and decouple the product's value from any single marketplace.** Collectors will pay for "know what your collection is worth and what's moving" even when "buy it here" is not available. They will not pay for a sniper feed that shows 0 deals.

This is not a call to delete the marketplace features — it is a call to stop letting their fragility define the product. Every "marketplace offline" banner currently teaches a prospective subscriber that the product is broken.

---

## Now — Stabilize (target: ~2 weeks)

**Goal: make the product chargeable.** You cannot turn on a paywall while a tab crashes and a core tab is empty. This phase is almost entirely in the audit punch list.

- **Ship the 3 audit fixes** already applied to the working tree (analytics crash guard ×2, error-page rebrand) via the clean commit sequence in the audit report §5.
- **Apply the SQL root-cause fix** — `analytics_listings_summary` should return `[]` not `{}` for `marketplace_listings`.
- **Add a CI gate** — one GitHub Action running `tsc --noEmit` + `npm run test:cadence` on push to `main`. With a direct-to-`main`, no-PR workflow this is the only thing standing between a typo and production.
- **Fix the git hygiene** — resolve the 269-file CRLF churn and stale `index.lock`, add a real `.gitattributes` (`* text=auto eol=lf`). Until this is done, every commit is a hazard.
- **Fix the Pinnacle dispatch failure** in `wallet-backfill-multicollection-complete` — it is 61% of all pipeline errors and pure noise; raising the Pinnacle `round_trip_cap` / timeout will clear it.
- **Decide the marketplace messaging** — replace the bare "marketplace offline" banners with intentional copy that reframes RPC as an intelligence product, not a broken store.

Exit criteria: no crashing pages, CI gates `main`, error log is quiet, and the product reads as finished rather than half-broken.

---

## Next — Monetization-ready (target: ~1–2 months)

**Goal: turn on the paywall for new users and launch publicly.**

- **Control database cost before scaling users.** `api_harvest_20260512` (9.9 GB) + `unmapped_sales` (1.97M rows / 1.4 GB) are 84% of the database. Decide retention (audit F2/F3) and reclaim space — adding paying users on top of an uncontrolled-growth DB is the wrong order.
- **Stagger pipeline crons / add connection pooling** — the connection pool is already saturated at the current scale.
- **Invest in HIGH-confidence FMV coverage.** Only 2.5% of editions are HIGH confidence today. FMV *is* the paid product; this number is the product. Also reframe the misleading "FMV COVERAGE 100%" metric to report confidence honestly.
- **Resolve the listings story.** Either find a replacement live-listings source, or formally reposition Market/Sniper as "FMV + historical + outbound buy links" and remove the dependence on a live Flowty feed. Make a deliberate call.
- **Then flip the Pro paywall on for new signups** and open the allow-list / launch publicly. The pricing page, Stripe routes, and Pro gate already exist.
- **Cart execution** — only if live-buy remains a goal after the listings decision. It still has the documented Cadence blockers (H1/H2 in `purchase-moment.ts`) plus the external WalletConnect ID + Dapper co-signer registration.

Exit criteria: DB cost is bounded, FMV confidence is materially better, and a new user can sign up and pay without hitting a degraded surface.

---

## Later — Grow & pay down debt (target: this quarter and beyond)

- **Re-unify the Analytics section** with the main design system — today it looks like a different product (different fonts, colors, casing).
- **Refactor the monolith pages** — `collection/page.tsx` (2,900 lines), `sniper/page.tsx`, `[collection]/analytics/page.tsx`. These are the likely cause of the renderer freezes observed during the audit, and they make every change slow and risky.
- **Resolve the `disney-pinnacle` split-brain route and delete `panini-blockchain`** (dead, off-platform, unpublished).
- **Brand-token cleanup epic** — `#E03A2F` is hardcoded ~80× and the brand fonts ~284×.
- **Pinnacle direct integration** — replace the bogus uniform $1 Flowty floor with a real data feed (`disneypinnacle.com`).
- **Backfill the ~920 Top Shot editions** missing on-chain IDs and reconcile the `editions.collection` drift.
- **Turn on Sentry** (set the DSN) so error reporting actually works, and the error page's "team has been notified" copy becomes true.
- **Historical spork scan** — the 6th worker proxy + the unified resolver to clear the AllDay/Pinnacle backlog.

---

## Open decisions for Trevor

These are genuine forks, not tasks — worth deciding deliberately:

1. **Is live "buy / cart / snipe" still a product goal?** Flowty is dormant, UFC left Flow, Dapper's storefront keeps moving. If the answer is "intelligence-first," a lot of the Now/Next scope simplifies — Market/Sniper become FMV + outbound links and the cart work can be shelved.
2. **`flowty_archive` retention** — options A/B/C from CLAUDE.md known-issue #13. This decision sets the database's cost trajectory.
3. **Public launch timing** — the platform is feature-complete enough to launch *after* the Now phase. The constraint is reliability and reach (an audience), not features. Consider whether the next month is spent on more building or on getting the first 100 real users onto the existing product.
4. **UFC Strike's place in the product** — it migrated to Aptos. Keep it as a historical/archival collection, or sunset the UFC routes? Right now it is a published collection that cannot transact.
