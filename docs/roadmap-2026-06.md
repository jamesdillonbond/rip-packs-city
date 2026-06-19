# Rip Packs City — Product Roadmap (June 2026)

Supersedes [docs/roadmap-2026-05.md](roadmap-2026-05.md). Companion audits: [full-platform-audit-2026-06-18.md](audits/full-platform-audit-2026-06-18.md) (latest) · [full-platform-audit-2026-06-12.md](audits/full-platform-audit-2026-06-12.md). Standing constraints unchanged: **intelligence-first** (cart/Trade Hub shelved), **no paywall/promo until 50+ WAU**, cost-flat infra (compute add-on question CLOSED — Micro→Small shipped 06-13), chains added one at a time.

---

## Where we are

Almost everything in May's roadmap shipped (Flowty teardown, Market/Sniper reframe, CI gate, DB 6.9→4.2 GB, cron stagger, chain abstraction A–F, rewards, team hubs, IPFS media, light mode, the /insights suite, dapper.market dual-links, on-chain offers, TS buyer resolution). FMV quality — May's headline weakness — has tripled and held: TS HIGH+MED **3,136 (06-18)** vs 1,062 (06-05), badge-ask coverage ~100%, Pinnacle per-render FMV live.

**Since the 06-13 roadmap, the build has been a serial-intelligence + alerts wave (06-14 → 06-18):**

1. **Serial intelligence shipped end-to-end.** `/insights/serial-premiums` + `perfect-mint-premiums` boards (06-16); the **Underpriced #1s** deal board (`/insights/underpriced-serials`, Atlas-fed, 06-16/17); a fitted **serial-FMV power model** (`price = k·fmvᵝ`, weekly pg_cron) replacing the flat multiplier grid as primary for #1/perfect-mint estimates; per-moment **jersey-match** correctness (was last-known player number → now the number worn in that specific play).
2. **Omni-channel alerts went live (still inert / dial-in, 0 subs by design).** Deal + FMV + serial alerts over email/Telegram/Discord, with a front door (nav + dashboard + deal-surface CTAs), serial/jersey/never-sold/badge filter enforcement, concierge-over-DM personalization, and — directly relevant to the parallel concern — a **parallel/variant filter + alert-line surfacing** (TS Galactic/Diced + 14 Pinnacle variants) plus rarity-tier + mint enrichment.
3. **2026-06-18 full audit: GREEN.** Security 0/0/0/0, trust-health 9/9, 0.14% pipeline fail rate, FMV reconciles exactly to edition counts, and **no cross-parallel/cross-collection pollution** (verified at the data layer and live — play 127's 6 parallels each carry independent FMV; recent sales scoped per-edition; Pinnacle variants separated). One real operational watch item + a few cosmetic nits (below).
4. **2026-06-18/19 shipped the wave live.** Alerts went **live end-to-end via the go-live test** (1 sub, 31/31 delivered across email + Telegram + Discord, 0 failed); the **public profile** was made public + dedup-fixed (killed the ~4× moment/cost-basis inflation and the fake −79% P/L); the **AllDay deal-board leg + native "Buy on All Day" buy-links** shipped; **Pinnacle franchise/set mojibake** fixed board-wide.

Three facts still frame the month: the **capacity ceiling is resolved** (Micro→Small + cohort pacing; clean for a week+); **the first organic users arrived** (8 on 06-10; funnel rebuilt; retention is the gap, not acquisition); **chain two has a date** (Candy/Solana tripwire 07-08, everything buildable-in-advance already live).

## Now — through ~June 28 (protect throughput, finish alerts, polish)

The 06-13 "Now" list closed (moment-media, trophy live-FMV, UFC enrichment, CX batch all shipped). New "Now" is driven by the 06-18 audit:

1. **`topshot-buyer-backfill` duration-creep — SHIPPED.** Batch lowered **200→100** and `maxDuration` raised **600→800** (commit `7a70a31`), and the cron was slowed to **`4,34` (every 30 min, off-rush)** which ended the overlapping-run contention. Runs now measure ~540–680s but sit safely under the 800s cap with no overlap. Residual = the OPTIONAL cap-rows-per-invocation defense (low priority).
2. **`alerts-dispatch` deal-leg optimization — SHIPPED.** `dispatch_due_deal_alerts` got a 0-active-sub early-exit + `statement_timeout` 45→90s + route `maxDuration` 60→120, plus the AllDay deal-board leg (commit `dd7e2bf` + migrations). Alerts then went **LIVE** via Trevor's go-live test (1 sub, instant cadence, 31/31 delivered email+Telegram+Discord, 0 failed). Deal-leg timeouts stopped. Remaining = the cache-the-boards scale-path, which only matters as subscriber count grows.
3. **Underpriced-serials board freshness (operator).** Atlas residential-runner appears to skip overnight (board was ~9h stale at audit). Confirm/repair the runner cadence, or surface ingest-age on the board when stale (the page promises "live, buyable" deals).
4. **Cosmetic / hygiene — mostly DONE.** Pinnacle franchise/set mojibake FIXED board-wide (count 0; migration `audit_20260618_pinnacle_editions_fix_double_encoded_mojibake` + the `normalize_pinnacle_edition` de-double-encode trigger hardening so re-ingest can't reintroduce it); SERIAL-FMV-MULT-CRON reclassified (weekly pg_cron by design, not "escalating"); `docs/overnight/focus.md` refreshed. **Only cosmetic left:** prune the ~12 fired one-off scheduled tasks.
5. **Protect the funnel.** 25 allow-listed, 0 pending, 0 stuck redemptions. Daily signups watch green; approve Dumbo (Dapper) when he signs up.

Exit criteria: buyer-backfill comfortably under the cap; alerts-dispatch deal-leg no longer timing out; board freshness honest; residuals ≤ a handful.

## Next — through ~mid-July (FMV depth, retention, chain-two gate)

- **FMV quality march continues:** keep converting ASK_ONLY/zero-history TS editions to sales-backed prices (tshb GHA drain); TS HIGH+MED climbing toward ~4,000. Serial-FMV power model is live — monitor the estimate quality on the underpriced board (tight vs coarse), tune segments as sales fill in.
- **Retention is the lever, not features.** Acquisition+onboarding convert ~100%; only ~1/10 of the organic wave returned. The return-hooks are now built (serial-premiums boards + omni-channel alerts) — **the move is to turn alerts on for the existing allow-list** once §Now items 2–3 land, and watch whether weekly deal/FMV pings bring users back. 50-WAU stays the monetization tripwire; no promo until Trevor calls launch-ready.
- **Extend deal coverage beyond TS + Pinnacle.** Deal alerts + the cross-collection deal board cover TS + Pinnacle only (that's where the listings feed exists). AllDay is the next-most-valuable secondary market — scope an AllDay listings/deal feed so alerts span more of the catalog.
- **Candy/Solana chain-two gate:** 6/22 interim audit, 7/8 firm tripwire (both scheduled). Pass → begin chain-two code (DAS editions → ME sales → wallet backfill → FMV), one surface at a time, Flow quality bar unchanged. Fail → Beezie/Base is the documented pivot.
- **Keep the autonomous loop healthy:** nightly pass + monitor + weekly checks carry real load; PAT expires Sep 7 (reminder set).

## Later (Q3)

- Chain-two build-out to published status (if gated in).
- Pro paywall + Stripe flip — only after 50+ WAU and a deliberate launch.
- Monolith page refactors (collection / sniper / analytics), light-mode remaining batch, brand-token Phase 2, /dashboard token migration.
- Full per-special-serial owner indexing (today ~30% via wmc + last-sale; revisit with chain-two indexing).
- Retire dead-Flowty edge functions + storefront-audit machinery (dormant, zero cost — cleanup only).

## Open decisions for Trevor

1. **Open alerts to the broader allow-list (25 users)?** Alerts are already **LIVE** (go-live test sub, deal-leg optimized + 1-sub-proven: 31/31 delivered on all 3 channels). The feature works — the remaining call is whether to open it to the 25 allow-listed users now (the cheapest retention experiment available) or wait. Go when ready?
2. **Buyer-backfill batch size — RESOLVED.** Batch 100 + `maxDuration` 800 + the 30-min `4,34` cron all shipped; runs sit safely under the 800s cap with no overlap.
3. **Board freshness honesty.** Underpriced-serials promises "live" deals but depends on a residential runner that skips overnight. Acceptable as-is, or add a visible ingest-age badge / move the runner to a always-on trigger?
4. **Launch-readiness.** Platform survived its first organic wave + an infra incident, and this audit found it complete, accurate, and pollution-free. What's the bar for actively inviting the next 50 users — and does retention need one more proof point (alerts live for a week) first?
