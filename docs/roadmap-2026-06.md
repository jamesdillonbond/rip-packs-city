# Rip Packs City — Product Roadmap (June 2026)

Supersedes [docs/roadmap-2026-05.md](roadmap-2026-05.md). Companion audit: [docs/audits/full-platform-audit-2026-06-12.md](audits/full-platform-audit-2026-06-12.md). Standing constraints unchanged: **intelligence-first** (cart/Trade Hub shelved), **no paywall/promo until 50+ WAU**, cost-flat infra *except* the now-open compute add-on question, chains added one at a time.

---

## Where we are (vs. the May roadmap)

Almost everything in May's "Now" and "Next" shipped. The Flowty teardown is done; Market/Sniper were reframed to FMV + outbound links; CI gates main; Sentry is live; the DB was cut 6.9→4.2 GB; crons were staggered and wrapped; chain abstraction (Phases A–F) completed; the rewards program, team hubs, IPFS media catalog, light mode, /insights suite (squeeze, market, pack-sniper, cross-collection), dapper.market dual-links, on-chain offers, and TS buyer resolution all shipped. FMV quality — May's headline weakness — has tripled: TS HIGH+MED 1,062 (06-05) → **3,259** (06-12), with badge-ask coverage at ~100% and Pinnacle per-render FMV live at 86% coverage.

Three facts define this month:

1. **Capacity is the new ceiling.** Three consecutive daytime disk-IO exhaustion windows (06-10/11/12, the last with a full telemetry blackout and user-facing page errors) are the first incident class that degraded the product for users. The write-storm bugs are fixed and the seed-refresh wave is now split into 4 paced cohorts — but if the daytime window recurs with pacing live, the platform has outgrown the Supabase Micro add-on and the upgrade is the correct spend (the one exception to cost-flat).
2. **The first organic users arrived.** 8 organic signups landed June 10; the onboarding funnel was rebuilt end-to-end the same night (real backfill dispatch, auto-attach, lenient auto-approve, daily funnel watch). Traction is no longer hypothetical — it's small and must not be fumbled.
3. **Chain two has a date.** Candy/Solana tripwire fires July 8. Everything buildable in advance (helius-proxy, address layer, inert ingest, DB seeds) is already live.

## Now — through ~June 21 (capacity, correctness, first impressions)

1. **Close the DBSAT incident class — decision this weekend.** Sat 06-13 cohort-wave verdict (scheduled): if the 07:00Z+ window stays clean, pacing solved it — document and re-baseline. If it recurs, **upgrade the compute add-on (Trevor, billing)** — this is now the cheapest hour of leverage on the platform; it cost three days of degraded product this week.
2. **Fix UFC enrichment (CC).** 84% of UFC wmc rows have no edition_key → no FMV/set/player on UFC surfaces. Ship the decoupled `ufc-enrichment-drain` cron per the ready handoff; done when null_key < 100 and the drain logs its own pipeline_runs.
3. **First-impression CX batch (CC, small).** From the 06-12 site crawl: un-gate `/api/fmv/demo`; fix the anon collection-overview panels that silently call gated APIs (the SEO funnel's first impression); SSR the public profile data (mirror /share); remove the shelved-Cart chrome from the nav; de-dupe the home JSON-LD.
4. **Drain operational residuals.** TFP watchlist restore (gate met), analytics-smoke per-leg fix + restore the 60s cap, topshot-listing-cache cadence (operator, cron-job.org), delete legacy seed-refresh entry after one clean cohort day, resolve the 10 quiet Sentry issues, OFFER-SANITY-RAISE call (Trevor).
5. **Protect the funnel.** Daily signups watch stays green; verify auto-approve/auto-attach end-to-end on the next fresh signup; approve Dumbo (Dapper) when he signs up.

Exit criteria: zero daytime IO windows for a week, UFC keys draining, the anon funnel renders complete data on every surface, queued residuals ≤ a handful.

## Next — through ~mid-July (FMV depth, users, chain-two gate)

- **FMV quality march continues** (the paid product): let the tshb GHA drain convert the remaining ~700-900 ASK_ONLY/zero-history editions to sales-backed prices; re-measure the LiveToken cross-check (the per-serial gap is the known remaining weakness — scope a serial-adjusted layer only after the sales-history base is in); keep TS HIGH+MED climbing toward ~4,000.
- **Get users, deliberately.** The product is demonstrably ready for them (this audit). Use the existing growth surfaces — /share cards, public profiles (once SSR'd), /insights SEO + the internal-linking lever — and decide the launch-readiness call. The 50-WAU gate stays the monetization tripwire; no promo until Trevor calls launch-ready.
- **Candy/Solana chain-two gate:** 6/22 interim audit, 7/8 firm tripwire (both scheduled). If data gates pass → begin chain-two code (DAS editions → ME sales → wallet backfill → FMV), one surface at a time, Flow quality bar unchanged. If they fail → Beezie/Base is the documented pivot.
- **Keep the autonomous loop healthy:** nightly pass + monitor + weekly checks are carrying real load; PAT expires Sep 7 (reminder set).

## Later (Q3)

- Chain-two build-out to published status (if gated in).
- Pro paywall + Stripe flip — only after 50+ WAU and a deliberate launch.
- Monolith page refactors (collection / sniper / analytics), light-mode remaining batch, brand-token Phase 2, /dashboard token migration.
- Per-serial FMV layer (LiveToken-class serial adjustment) if the Next-phase scoping says it's worth it.

## Open decisions for Trevor

1. **Compute add-on** — decide from Saturday's verdict data. (Recommendation: if the window recurs even once with pacing live, upgrade same day.)
2. **OFFER-SANITY-RAISE** — 176 flags and creeping; the edition-level raise + monitor are specced and waiting on your call.
3. **Launch-readiness** — the May roadmap's question is now live: the platform survived its first organic wave and an infra incident in the same week. What's the bar for actively inviting the next 50 users?
