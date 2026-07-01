# Rip Packs City — Roadmap (updated 2026-07-01)

Grounded in a full-stack audit run 2026-07-01 (database, pipelines, Vercel/Sentry, and Chrome QA of Top Shot / All Day / Pinnacle pages). Framing is unchanged: **intelligence-first**, no paywall until 50+ WAU, chain-two gated on the Candy/Solana data tripwire. This roadmap is about making RPC unmistakably more useful than the native sites, one collection at a time.

---

## State of the platform (what the audit found)

**Health: GREEN.** Security clean (RLS on every table, 0 anon-write holes, 0 SECDEF anon violations). Trust health 15/15 metrics OK, 0 breaches. All 63 watched pipelines firing on cadence with their latest run OK; pg_cron 0 failing jobs; 24h pipeline failures were all transient (every one recovered). Data is genuinely landing: Top Shot / All Day / Golazos / Pinnacle sales, FMV for all five collections, pack_purchases, and the editions catalog are all fresh within the hour/day. No silent failures — GitHub Actions, cron-job.org, pg_cron, and Vercel crons are all wired and writing rows. DB 6.98 GB. Latest Vercel prod deploy READY.

**What's genuinely strong.** The Top Shot edition page is the flagship and it delivers: accurate FMV / floor / ask / best-offer / sales-count, special serials (#1 / jersey / perfect) captured and displayed, full sales history with wallet→username resolution working (5,041 usernames resolved; unresolved wallets fall back to 0x-truncated), parallel printings linked from the base moment with de-blended per-parallel FMV and circulation, IPFS media verification, badges, pack provenance, and insights cross-links. Pack pages are rich (per-edition EV pool, gross EV / value ratio / FMV coverage / depletion% / packs-remaining, sealed-pack resale history, a "what's inside" card grid). Pinnacle render pages are strong too (variant, scarcity-vs-variant, "other printings" ladder, full material attributes). The set tracker and team pages populate correctly.

**The one real problem: detail-page performance.** Edition, pack, player, and team pages fan out to ~15 concurrent DB queries; under load the slow ones exhaust the connection pool and the lower sections ("Scanning the marketplace…") sit for 10–20s or time out. Vercel logs show hundreds of `Timed out acquiring connection from connection pool` and `canceling statement due to statement timeout` events across exactly these routes. The DB itself has headroom (14/90 connections) — it's app-side fan-out + a few slow RPCs, not DB saturation. This is already being chipped at by in-flight commits (removing dead edition-page queries).

**Fixed during this audit.** The All Day overview KPI cards never loaded (and the smoke test timed out on `/nfl-all-day/overview`) because `/api/collection-stats` ran a full-history `DISTINCT ON` over All Day's ~284k FMV snapshots. Rewrote `get_collection_stats` to a per-edition `LATERAL … LIMIT 1` index seek — **4,125 ms → 369 ms (11×)**, proven result-identical, security intact. All Day overview now loads.

**Parity reality (All Day / Pinnacle vs Top Shot).** FMV exists for all five collections — All Day and Pinnacle FMV are already built; the gaps are coverage tails, not absence. Pack EV is full for Top Shot **and** All Day, but absent for Pinnacle / Golazos / UFC. The biggest true gaps: All Day has **no live ask/deal source** (frozen listings + null badge asks → empty All Day deal boards), and Pinnacle render pages have **no sales-history section** despite `pinnacle_sales` carrying live data.

---

## Now — next 1–2 weeks (stability + parity quick wins)

**1. Detail-page performance (P0).** The connection-pool timeouts on edition/pack/player/team pages are the single biggest UX drag and the most-logged production error. Continue the fan-out reduction already underway: bound or precompute the heaviest per-page RPCs (edition sales, `get_edition_detail`, pack lifecycle/market, player top-sales, team detail/activity), add `statement_timeout` to slow RPCs so they fail fast instead of holding a pooled connection, and lift the Supabase pooler pool size (the DB has headroom). Target: edition/pack pages fully painted in <3s, zero pool-timeout errors in a 24h window.

**2. ✅ DONE — `computeHighMediumPct` LATERAL swap (commit `6ebcc8f`, live).** The route's HIGH/MED coverage query was the last full-history `DISTINCT ON` bottleneck after the `get_collection_stats` fix; now a per-edition LATERAL seek. `/api/collection-stats` ~2s → ~0.5s across all collections.

**3. All Day ask/deal parity.** All Day has FMV but no ask source, so its Sniper/deal boards read empty. Stand up an All Day listings ingest (Dapper marketplace / on-chain storefront) and populate `badge_editions.low_ask` for All Day (currently 0/1,572). This is the highest-leverage All Day feature — it turns the existing All Day FMV into actual deal-finding.

**4. ✅ Verified working (no build needed) — Pinnacle render-page sales history.** Already implemented — the page fetches `pinnacle_sales` by render_id (99.99% render-linked, 2,186 traded renders). My initial "missing" note was a false alarm from QA'ing an untraded ASK_ONLY pin.

**5. Image polish — mostly done.** ✅ Team logos now render (CSP fix, commit `aa7224b6`, verified live). The pack-hero "blank" turned out to be dark pack art (a real 1835px image renders fine) — a harmless `onLoad` guard was added for genuinely-dead pack images. Remaining minor: the occasional blank team hero thumbnail (a single moment whose thumbnail didn't resolve) — low priority.

---

## Next — this month (deepen the intelligence moat)

**1. Pinnacle Pack EV (net-new build).** The one true Pack-EV gap. Requires indexing Pinnacle pack drops (event signatures currently unverified — decode a real Pinnacle pack tx first), then reuse the Top Shot/All Day EV + lifecycle + realized-EV machinery. If Pinnacle pack activity is too thin to index reliably, document that and deprioritize.

**2. FMV cold-tail coverage (All Day / Pinnacle).** All Day NO_DATA is ~22% (1,387 editions), Pinnacle has its own thin tail. Extend the ASK_ONLY / honest-floor treatment already used on Top Shot so more editions get a usable confidence band without fabricating prices.

**3. All Day parity clean-up.** Fold in the known All Day data-parity gaps (0 offers surfaced, `cross_market_ask` unsurfaced, null pack titles, no `video_url`) so All Day edition pages reach Top Shot depth.

**4. Observability.** Sentry ingestion is intermittently rate-limited (429s) — errors are being dropped. Tune the Sentry sample/quota so the error signal stays trustworthy, and add a lightweight per-route latency SLO on the detail pages so perf regressions page before users feel them.

**5. Retire dead surfaces.** `first_minted_at` is 0/24,779 populated and `last_updated_at` nearly so — confirm no live consumer and either populate or drop, so they can't mislead a future query.

---

## Later — this quarter and beyond (differentiation + growth)

**1. Chain two — Solana / Candy.** Hold the line on the strategy: start chain-two code only when the tripwire is met (≥30 days Candy Solana sales history, earliest 2026-07-08; defined edition/serial schema; chain-abstraction A–F already complete). Index via Helius DAS + Magic Eden through a dedicated `helius-proxy` (never share Flow proxy secrets). Keep the public tagline single-chain until chain-two ships visible product.

**2. Cross-collection / cross-chain intelligence.** Once ≥2 chains carry real product, unify the portfolio, deal, and FMV surfaces across collections and chains — the thing no native single-collection site can do, and RPC's durable moat.

**3. Ownership index.** Collector leaderboards and set-completers are blocked on a complete ownership index (wmc currently ~241 wallets). Backfilling `topshot_ownership` unlocks a whole class of "who owns what / who's closest to completing" intelligence.

**4. Serial-FMV model deepening.** The #1 / perfect / jersey serial-premium model is fitted but data-gated. As sales completeness improves, refit toward the full player×badge×set×series×parallel hedonic model that gives per-serial pricing competitors don't have.

**5. Growth, then monetization.** Drive activation toward the 50-WAU bar (wallet-paste onboarding is the strongest funnel), then — and only then — revisit the Pro paywall / Stripe / public launch. No promo (tweets / Reddit / TC DMs) until launch-ready.

---

## Long-term vision

Rip Packs City becomes the definitive **multi-chain sports & IP digital-collectibles intelligence platform** — the analytics layer serious collectors open before they buy, sell, or rip, across every chain the hobby consolidates onto. Flow is chain one of N; the bet is that being the best intelligence tool (FMV, pack EV, serial premiums, deal-finding, ownership) beats being another marketplace.

---

### Shipped in this audit (all live + verified, 2026-07-01)

DB migrations (via MCP, result-identical, security invariants []):
- `optimize_get_collection_stats_fmv_coverage_lateral_20260701` — `get_collection_stats(text)` FMV-coverage subquery: full-history `DISTINCT ON` → per-edition `LATERAL … LIMIT 1`. **4,125 ms → 369 ms**, result-identical (All Day covered=4803/have=6190 both ways). Fixes the All Day overview hang + `/nfl-all-day/overview` smoke timeout. Revert: `CREATE OR REPLACE` back to the prior `DISTINCT ON`.
- `optimize_get_fmv_movers_lateral_20260701` — `get_fmv_movers` latest+previous snapshot CTEs: `DISTINCT ON` → `LATERAL … LIMIT 1`. **7,139 ms → 236 ms**, result-identical (latest 6191=6191, previous 6112=6112, 0 diffs). Used by `/api/market-movers` + concierge context. Revert: `CREATE OR REPLACE` back.

Route commits (pushed to main, deploys READY):
- `6ebcc8f` — `computeHighMediumPct` (collection-stats route) → same LATERAL swap; `/api/collection-stats` ~2s → ~0.5s all collections.
- `aa7224b6` — proxy.ts CSP `img-src` now allows `cdn.nba.com` + `cdn.wnba.com` → **team logos now render** (verified live on the Lakers page; was blank). img-src allowlist only, no auth logic touched.
- `dbfce047` — `PackHeroArt` `onLoad` guard (naturalWidth===0 → montage fallback) — defensive completion of the component's documented dead-pack-image handling.

Two audit findings corrected on closer inspection (no fix needed):
- **Pinnacle render-page sales history already exists + works** — the page fetches `pinnacle_sales` by render_id (168,499/168,509 render-linked across 2,186 traded renders). The Minnie Mouse pin I first QA'd was an untraded ASK_ONLY pin (0 sales → section correctly hidden).
- **The "blank" pack hero was dark pack art, not a broken image** — DOM inspection confirmed a real 1835px image rendering at 260×260, visible. (The `onLoad` guard above is still a valid harmless robustness improvement for genuinely-dead pack images.)
