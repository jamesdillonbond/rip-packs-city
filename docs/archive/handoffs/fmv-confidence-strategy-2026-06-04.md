# FMV confidence strategy — get tracked wallets to "accurate on login" (2026-06-04)

> **PARTLY SUPERSEDED (2026-06-04) by `docs/fmv-held-low-rootcause-2026-06-04.md` (Claude Code).** CC's code-level root-cause found: (a) the held-LOW bulk is a **Step-6 "fossil" freshness bug** (stale LOW from the GQL `upsert_topshot_marketplace_fmv` path, re-stamped forward as fresh `1.7.0`) — so "only 7 of 5,390 are >24h old" was fooled by fresh timestamps on stale computations; (b) the serial-residual gate **is** already wired (`fmv-recalc:535`) and working — the L2 "not wired" premise is wrong; (c) `low_ask` is a **floor** — corroborate/flag with it, never clamp. **Revised sequence: fix Cause B (fossils) first, then ask-corroborate the genuinely-dispersed remainder** (lift smaller than the ~39% projected here). The held-LOW reframe and the `v_tracked_wallet_fmv_confidence` KPI remain valid.

Goal (Trevor): every seeded/beta wallet sees an accurate, confident FMV for their whole collection on first login. Long-term: universal HIGH confidence on every edition. Near-term beachhead: the editions our **tracked wallets actually hold**.

Grounded in live diagnostics run 2026-06-04. The headline finding reframes the problem away from the NO_DATA tail toward the held-LOW bucket; see the superseding doc for the confirmed code-level cause.

## What the data says (held by 243 active seeded wallets, incl. all 6 beta/watch)
New KPI view shipped this session: `v_tracked_wallet_fmv_confidence` (service_role only, security_invoker). Live artifact: `rpc-tracked-fmv-confidence`. Re-query either any time.

| Collection | HIGH+MED | LOW | NO_DATA | other | verdict |
|---|---|---|---|---|---|
| NBA Top Shot | 882 (~10%) | 6,405 (72%) | 783 | ASK 644 / STALE 195 | held-LOW is the problem |
| NFL All Day | 270 (~5%) | 4,541 (87%) | 32 | STALE 277 / ASK 70 | held-LOW is the problem |
| UFC Strike | ~0 | 20 | 340 (94%) | — | throughput/ask problem |
| Golazos | 1 | 9 | 30 | — | thin market |

The problem for TS + AllDay is the LOW bucket (72–87%), not NO_DATA. Every held edition already has a snapshot; the issue is confidence/accuracy, not coverage.

### Why LOW (see superseding doc for the confirmed cause)
- 1,101 held TS LOW editions have ≥5 sales/30d yet stay LOW. CC's follow-up: ~607 are **Step-6 "fossils"** (stale GQL-path LOW re-stamped fresh — they show 0 sales despite active trading, e.g. Chaz Lanier with 207 sales); ~434 are genuine gate demotions (dispersed). The "only 7 >24h old" figure was fooled by fossil re-stamping.
- 5,389/5,390 have a live ask in `edition_offers`. Use it to **corroborate** (raise confidence) — NOT to clamp (the ask is a floor).
- Serials are 100% populated on sales; the serial-residual gate is wired and working.

### Projected lift
Original conservative proxy: held TS HIGH+MED ~11% → ~39%. Post-root-cause, the bulk comes from fixing Cause B (re-pricing fossils to their true confidence — many become MED/HIGH where sales support it, some correctly stay LOW), with ask-corroboration adding the dispersed remainder. Treat ~39% as optimistic; measure the real number via the KPI view before/after.

## The plan (revised priority order)
**L0 — Fix Cause B first (Step-6 fossil / freshness bug).** Stop the stale-touch re-stamping crude GQL-path LOW as fresh `1.7.0`; re-price held/traded editions from actual sales. Lowest-risk (freshness bug, not a new model), highest-leverage; clears most confident-wrong inflation with no clamp false-positives. Validate before/after against `v_tracked_wallet_fmv_confidence` + `v_fmv_sanity_flags`, on named editions (Chaz Lanier; `218:7778`). Owner: Claude Code + Trevor sign-off.

**L1 — Ask-corroborated confidence (after L0).** When sales WAP and live ask agree within a band, raise a step (LOW→MED, MED→HIGH with strong sample). Diverge → stay LOW. Corroborate/flag only — never clamp.

**L2 — Right-size the gate (verify, don't assume).** Serial-residual gate already applied (`fmv-recalc:535`). Re-check the MEDIUM sample-size threshold once fossils stop masking the distribution.

**L3 — Accuracy gates BEFORE confidence (F-series).** A confident wrong price is worse than an honest LOW. Land the serial>circulation guard, finish 8:62 Cosmic / mis-key cleanup. Most set-218 "inflation" is Cause B fossils — L0 clears it.

**L4 — Held-editions-first sequencing.** Bias recalc / a "warm tracked wallets" pass to (re)rate editions held by `seeded_wallets.is_active` first.

**L5 — Presentation builds trust at any confidence.** Show the basis on portfolio/dashboard FMV tiles: "$X — 7 sales (30d), ask $Y", like the squeeze-check tool.

**L6 — UFC / Golazos are a different problem.** 94% NO_DATA = no sales, mostly no ask. Levers: ASK fallback where a feed exists, throughput, honest "not enough market" states.

**L7 — Universal HIGH (end goal).** Same L0–L3 improvements applied to the full edition set generalize the win; held-first sequences who benefits first. Track via the KPI view.

## Safe vs. hand-off
- **Shipped safe this session:** `v_tracked_wallet_fmv_confidence` view (read-only, service_role) + `rpc-tracked-fmv-confidence` live artifact. Revert: `DROP VIEW public.v_tracked_wallet_fmv_confidence;`
- **NOT auto-shipped (pricing logic → Claude Code + product judgment):** L0–L5. A blind recompute would be re-fossilized by Step 6 until L0 lands.

For the confirmed root-cause, exact code locations, and the implementation/validation plan, defer to `docs/fmv-held-low-rootcause-2026-06-04.md` — it is the authoritative analysis.

---

## Parallel diagnostics addendum (2026-06-04, Cowork — collision-free, read-only)
- **All Day has the same fossil bug, proportionally worse.** Held-edition fossil scan (latest snapshot `sales_count_30d=0` but ≥5 real sales/30d): **TS 613 fossils** (32% of its 1,888 traded held editions); **All Day 247 fossils (49%** of its 505 traded held editions). Step 6's stale-touch is collection-agnostic, but the GQL writers are per-collection — **the Cause-B fix must cover `upsert_allday_marketplace_fmv`, not just `upsert_topshot_marketplace_fmv`** (or fix Step 6 itself, which is shared). Verify All Day in `v_tracked_wallet_fmv_confidence` post-fix.
- **Pack EV is a second contaminated surface.** Pack EV = Σ(per-edition FMV × drop weight) reads the same `fmv_snapshots`, so fossil-inflated FMV inflates the public `/packs` +EV rankings and the overview "Top 5 Sniper Deals". The Cause-B fix de-inflates pack EV as a bonus — re-check `pack_ev_latest` / the +EV board after L0 (the +450%-margin / 33%-coverage packs should normalize).
- **UFC / Golazos = thin market, not a bug.** Held: UFC 362 (only 20 with sales/90d, **0 live asks**), Golazos 44 (10 with sales, 0 ask). No ask feed to fall back on → not fixable by Cause-B or ask-corroboration. Right answer: honest "insufficient market" empty-states + price the ~30 that actually trade. Low ROI given the tiny footprint vs TS/AllDay.

---

## RESULT (post-ship, 2026-06-05 ~02:15 UTC) — keystone corrected
The real generator of the held-LOW fossils was **neither Step 6 nor the confidence model** — it was **Step 1 silently truncating its sales fetch to PostgREST's 1000-row cap** on hot pages, dropping 75–92% of sales and computing FMV off a tiny biased sample. Fixed by paginating the Step-1b sales re-fetch (`1c5ccf5`); the Step-6 anti-join (`bf4cbd5`) stops the stale re-stamp. This is the `[PostgREST caps at 1000 rows]` + `[RPC silent-failure class]` footgun, not a model gap.

Measured lift as the sweep reprices (live, still climbing):
- Fossils: TS **955 → 137**, All Day **338 → 183**.
- Held TS HIGH+MED: **10.1% → 14.9%** (903 → 1,334); LOW 6,424 → 6,094.
- Held All Day HIGH+MED: **5.3% → 7.3%** (273 → 379).
- Held TS MED/HIGH inflated >2× ask (accuracy): **78 → 48** (>3×: 32 → 13).
- Named: Chaz Lanier repriced LOW $7.33 off 53 real sales (was frozen $6.76); `218:7778` $6.40 → $0.33.

A2 (ask-corroboration) and L4 (held-first reprice) stay **parked per the soak-first call** — the natural sweep is clearing the remaining ~137 TS / 183 AllDay fossils on its own. Re-measure via `rpc-tracked-fmv-confidence` / the KPI view. Unrelated win shipped same session: `/share` OG image fixed (`b3dae3d`, served via `/api/og/share`) → Discord/Slack/iMessage now unfurl the branded card (their caches mean already-posted broken links need a `?v=2` cache-buster).

---

## VERIFIED MILESTONE (2026-06-05 ~04:45 UTC, Cowork independent check)
Independently confirmed CC's consolidated milestone against live DB:
- **Held-wallet HIGH+MED lift (real):** TS **10% → 24.4%** (2,188 / 8,984) over the engagement; AllDay **5% → 9.5%** (495 / 5,190). Combined effect of the fossil fix (`1c5ccf5`/`bf4cbd5`) + dupe cleanup (cleaner denominator) + A2 ask-corroboration (`b8a0a49`).
- **Canonical TS set verified clean:** 9,123 integer-keyed editions, **0 bad circulation**, **37 honest-NULL tier** — matches CC's numbers exactly. (16,470 → 9,123 canonical; A2 producing MEDIUM-with-3-4-sales editions impossible without it.)

### Open item the verification surfaced (NEW — for the DQ queue)
The **1,152 residual UUID-keyed TS editions are still accumulating** — newest created `2026-06-05 04:39 UTC` (minutes before this check). CC drained the 7,374 historical backlog cleanly; the SOURCE is still live: the `compute-topshot-pack-ev` → `seed_topshot_editions` UUID-fallback writer (the deferred "Item B2" leak in CLAUDE.md, ~250 inert rows/6h). They're inert (the `editions_block_topshot_uuid_dupe_trg` trigger gates them), so no canonical corruption, but they refill the dupe table and degrade `v_edition_integrity_flags` over time. **DQ4 (new): fix the `seed_topshot_editions` writer to prefer the on-chain integer pair (like the 2026-05-30 `/api/ingest` `buildEditionKey` fix) so the drain stays drained.** Until then, a periodic re-drain keeps the canonical set clean.

---

## FINAL (2026-06-05 ~05:30 UTC) — F2/F4 shipped, DQ4 deferred (thread complete)
- **F2 (revised) SHIPPED** (`d881a75`): cohort estimation stayed dead (CV ~0.9–1.0, confirmed); instead fmv-recalc Step 5c reads `edition_offers.low_ask` for zero-sales editions → honest ASK_ONLY (×0.90). Canonical TS NO_DATA 582 → ~105–228; ASK_ONLY +~477; `v_fmv_sanity_flags` 0. (Correction: All Day's `edition_offers` carries **bids, not asks**, so F2 is TS-only — my "same for All Day" note was wrong.)
- **F4 (basis renderer) SHIPPED** (`fd61038`): shared `<FmvBasis>` + methodology-linked `ConfidencePill` in `components/entity/_shared.tsx`, wired to edition KPIs. Grid/team tiles lack the inputs on their payload (would need an API change — out of pure-presentation scope).
- **DQ4 DEFERRED** (correctly): the handoff's premise was wrong — `seed_topshot_editions` is a SQL function with no proxy/`plays`-table access, so it can't translate UUID→onchain in SQL; the real keying lives in the pack-EV edge function and a naive DB skip drops ~274 pool editions/run (degrades pack EV). The leak is bounded by the DQ2 resolver (`8e35190`) + tracked by `v_edition_integrity_flags`; the weekly data-quality sweep watches it. Real fix (re-key the edge flow to canonical integer editions) is a deliberate edge-deploy task. Analysis: `docs/handoff-2026-06-05-f2-f4-dq4-results.md`.

### End state of the FMV thread
- Held TS HIGH+MED **10% → 27.6%**; canonical TS ~**97.5% accurately + honestly labeled**, ~2.5% honest NO_DATA.
- Correctness (no fossils), data quality (9,123 clean canonical, 0 bad circ), confidence (A2 + ASK fallback), and presentation (basis on tiles) all landed. Remaining honest gaps are intentional: ~228 truly-no-market TS editions, UFC/Golazos thin markets, 37 NULL-tier / 325 NULL-thumbnail with no accurate source, and DQ4's bounded residual leak.
