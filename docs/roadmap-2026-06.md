# Rip Packs City — Product Roadmap (June 2026)

Supersedes [docs/roadmap-2026-05.md](roadmap-2026-05.md). Companion audit: [docs/audits/full-platform-audit-2026-06-12.md](audits/full-platform-audit-2026-06-12.md). Standing constraints unchanged: **intelligence-first** (cart/Trade Hub shelved), **no paywall/promo until 50+ WAU**, cost-flat infra *except* the now-open compute add-on question, chains added one at a time.

---

## Where we are (vs. the May roadmap)

Almost everything in May's "Now" and "Next" shipped. The Flowty teardown is done; Market/Sniper were reframed to FMV + outbound links; CI gates main; Sentry is live; the DB was cut 6.9→4.2 GB; crons were staggered and wrapped; chain abstraction (Phases A–F) completed; the rewards program, team hubs, IPFS media catalog, light mode, /insights suite (squeeze, market, pack-sniper, cross-collection), dapper.market dual-links, on-chain offers, and TS buyer resolution all shipped. FMV quality — May's headline weakness — has tripled: TS HIGH+MED 1,062 (06-05) → **3,259** (06-12), with badge-ask coverage at ~100% and Pinnacle per-render FMV live at 86% coverage.

Three facts define this month:

1. **Capacity ceiling — RESOLVED (06-13).** Three consecutive daytime disk-IO exhaustion windows (06-10/11/12, the last with a full telemetry blackout and user-facing page errors) were the first incident class to degrade the product for users. Fixed by the write-storm closeout + 4-cohort seed-refresh wave pacing **and the Supabase Micro→Small compute upgrade** (the one sanctioned exception to cost-flat). The decisive 07Z cohort wave ran 0.2% fails and daytime windows have stayed clean since; the compute decision is CLOSED. Watch it holds for a week.
2. **The first organic users arrived.** 8 organic signups landed June 10; the onboarding funnel was rebuilt end-to-end the same night (real backfill dispatch, auto-attach, lenient auto-approve, daily funnel watch). Traction is no longer hypothetical — it's small and must not be fumbled.
3. **Chain two has a date.** Candy/Solana tripwire fires July 8. Everything buildable in advance (helius-proxy, address layer, inert ingest, DB seeds) is already live.

## Now — through ~June 21 (correctness, first impressions, polish)

Updated 2026-06-13 (full audit). Most of the prior "Now" list closed; the new headline is moment-page media correctness.

1. **DBSAT incident class — CLOSED.** Compute upgraded Micro→Small; cohort pacing live; daytime windows clean. Monitor only.
2. **UFC enrichment — CLOSED.** Decoupled `ufc-enrichment-drain` cron live; null edition_key drained 3,837 → 2 (fossil floor).
3. **First-impression CX batch — SHIPPED** (`6d8c1e4` + profile SSR `b566482`): fmv/demo un-gated, anon overview panels, public-profile SSR, Cart chrome removed, home JSON-LD de-duped. Spot-verify on a fresh anon session.
4. **Moment-page hero media — SHIPPED** (`45f52bb`). New `components/MomentHeroMedia.tsx` prefers the per-moment `media/<momentId>/image` CDN form + ordered candidate fallback + hides 404ing video — fixes the ~30% Series-1 blanks (verified live on /moment/25510 + /moment/134293). Same commit also shipped: the special-serials section with owners, the "No recorded sales yet" copy, the trophy confidence chip, and the trophy edition_id canonicalization.
5. **Trophy case stale FMV — FIXED this session** (`audit_20260613_trophy_slab_live_fmv_resolve`): the slab RPC now resolves live FMV/tier/circ (Deni Avdija ULTIMATE not "COMMON"; Lillard Cosmic $425 not $1,100; Amon-Ra $450 not $1,045). Optional follow-ups: confidence chip (additive), edition_id canonical backfill.
6. **Drain operational residuals.** unmapped_sales AllDay drift (247, +~30/day), NEXTJS-15 resolve-after-quiet, weekly prune (auto 06-14), legacy seed-refresh cron delete (operator).
7. **Protect the funnel.** Daily signups watch green; verify auto-approve/attach on next fresh signup; approve Dumbo (Dapper) when he signs up.

Exit criteria: moment heroes render on every premium page; anon funnel renders complete data; DBSAT stays closed a full week; residuals ≤ a handful.

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

1. **Compute add-on** — CLOSED. Upgraded Micro→Small 06-13; DBSAT resolved.
2. **OFFER-SANITY-RAISE** — RESOLVED. `raise_edition_offers_from_chain` (GREATEST never-clobber) is live + called every offers-sweep tick; `offer_edition_gap_max_usd` monitor is in trust-health (currently $1). The 176 `v_offer_sanity_flags` are ~99% sub/serial offers correctly out of scope.
3. **Special Serials + owners parity — SHIPPED (partial, `45f52bb`).** The board + moment-page "Special serials" section now attach the current holder from wmc. **Ceiling decision:** owners only resolve where wmc indexes them (~30% of TS #1 serials; the rest show last-sale + "—"). Full per-special-serial owner coverage needs a per-edition on-chain holder index RPC doesn't have. Worth building that indexer, or is ~30% + last-sale good enough? (Recommend: good enough until traction; revisit with chain-two indexing work.)
4. **Launch-readiness** — still live: the platform survived its first organic wave and an infra incident in the same week, and this audit found it complete and accurate (modulo the moment-media fix). What's the bar for actively inviting the next 50 users?
