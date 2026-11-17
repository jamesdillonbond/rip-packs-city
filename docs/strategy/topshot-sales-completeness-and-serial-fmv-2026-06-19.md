# Top Shot Sales Completeness + Multi-Factor Special-Serial FMV — Strategy (2026-06-19)

Goal (Trevor): record **every** Top Shot sale that has ever happened across any marketplace, with buyer + seller fully mapped, then use that complete base to sharpen FMV, Pack EV, special-serial premiums, and special-serial owner identification. Plus: evolve special-serial FMV from a coarse tier model into a multi-factor model (player, badge, set, series, parallel, circulation, team, tier).

## TL;DR

- "Every sale ever" splits into **two independent problems**: (1) *capture completeness* — do we have the sale row at all; (2) *counterparty enrichment* — does the row carry buyer + seller. The right scope is **every sale of every catalogued edition/serial (~9,091 editions)**, not every Flow transaction ever — that bounding is what makes it tractable and is exactly what feeds FMV/EV/serials.
- **Shipped today (Lever 1):** broadened the per-edition history backfill from **784 → 9,091 editions** queued (migration `audit_20260619_broaden_ts_sales_history_backfill_targets`). The mechanism already recovers deep history (proven back to 2020); it was just pointed at <9% of the catalog.
- **Remaining code work (Claude Code handoff):** wire `spork-proxy` into the buyer/seller decoder so the 210K historical null-counterparty rows can be filled; raise backfill throughput to drain the new ~8,500-row queue; fix the `searchSetPlays` set-map error; confirm dapper.market sales settle through an indexed contract.
- **The multi-factor serial model Trevor wants is data-gated by this exact work.** Today there are only **1,086 #1 sales and 627 perfect-serial sales** in the whole DB — far too few to slice by player × badge × set × series × team. Completing the sales base is the prerequisite. The correct modeling technique for sparse, many-factor data is a **pooled hedonic regression with shrinkage**, not an expanded lookup grid.

---

## 1. Verified current state (2026-06-19)

Top Shot sales table (`collection_id = 95f28a17-…`):

- **443,938 sales**, 2020-07-28 → now. **100% carry a serial_number, 0 missing prices** — the data we *have* is clean.
- **Buyer/seller present on only ~53%.** 210,159 rows (47%) have a NULL buyer; 208,438 NULL seller.
- The null gap is **almost entirely historical**: 2020–22 is ~100% NULL; the on-chain indexer running since 2026-03-31 resolves buyer **and** seller ~100%.
- **Every one of the 210K null-buyer rows has a transaction_hash** — so they are *decodable*. The blocker is reach (below), not missing handles.

Capture is comprehensive **going forward** but **heavily sampled historically**:

- Live indexer (`/api/sales-indexer`) watches `A.c1e4f4f4c4257510.TopShotMarketV3.MomentPurchased` + `A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted` (the native Top Shot marketplace + Dapper secondary). ~2,000–2,700 sales/day, near-0 buyer-null. Comprehensive for current native trading.
- But its cursor only ever moves **forward** from ~2026-03-31. It never walked history.
- Historical sources (`topshot_marketplace` GQL, `ts_history_backfill_v1`, `historical_2020_import`, null) are a **small, non-representative sample**. Proof: **Feb 2021 — Top Shot's all-time peak month — shows just 2,227 sales in our DB**, versus the hundreds of thousands that actually traded.

Sources breakdown (sales count / buyer-null):

| source | n | buyer-null | note |
|---|---|---|---|
| `topshot_marketplace` | 159,150 | 49% | GQL marketplace feed (stopped ~2026-05-06) |
| `ts_history_backfill_v1` | 107,800 | 57% | per-edition GQL history walk; reaches back to 2020 |
| `onchain` | 84,274 | **2%** | the gold standard — seller 100%, buyer 98% |
| `null` (legacy) | 62,569 | 62% | early imports |
| `historical_2020_import` | 28,198 | 100% | 2020 bulk import |
| `topshot_gql` | 1,947 | 100% | new since 2026-06-13; buyer-blind by design |

**The FMV payoff is direct and measured.** Canonical TS editions bucketed by lifetime sales vs. latest FMV confidence:

| lifetime sales | editions | HIGH+MED | LOW | ASK_ONLY | NO_DATA |
|---|---|---|---|---|---|
| 0 | 379 | 1 | 0 | 177 | 201 |
| 1–2 | 1,259 | 2 | 491 | 750 | 0 |
| 3–9 | 2,827 | 783 | 1,299 | 744 | 0 |
| 10–29 | 2,161 | 990 | 784 | 384 | 0 |
| 30+ | 2,511 | 1,170 | 765 | 574 | 0 |

Editions with **0–2 lifetime sales almost never reach HIGH/MED** (3 of 1,638). At **30+ sales it's 47%**. More sales → higher confidence, mechanically. The tools to recover those sales already exist; they were just under-deployed.

---

## 2. The two problems (keep them separate)

**Problem A — capture completeness.** Do we have the sale row? Going forward: yes (on-chain indexer). Historically: no — sampled. Fix = the per-edition GQL history backfill, run across the whole catalog. Bounded by ~9,091 editions, not by chain height. **This is the tractable framing of "every sale ever."**

**Problem B — counterparty enrichment.** Does the row have buyer + seller? 47% don't. All have a tx hash. Fix = decode the on-chain transaction. The recent decoder works on current-spork txs; the historical tail (2020–22) sits below the current spork's min block height and needs the `spork-proxy` worker wired into the decode path.

These are independent — a row can be captured but counterparty-blind, or have both. Solve them with different levers.

---

## 3. Lever 1 — Drain the per-edition history backfill (SHIPPED today)

`topshot-sales-history-backfill` walks Top Shot's `searchMarketplaceTransactions` GQL **per edition**, pages to the bottom, and writes every sale (price + serial + tx hash). It provably recovers deep history — `ts_history_backfill_v1` already holds 16,853 sales dated to 2022 and 12,295 to 2021. It is idempotent (dedups on tx hash), so re-walking an edition that already has some sales only adds the missing ones.

The problem: the seed RPC `seed_topshot_sales_history_targets()` only queued editions that were **both ASK_ONLY confidence AND had zero sales** — so only **784 of ~9,091 editions** were ever in the queue (616 done, 168 erroring).

**Shipped (`audit_20260619_broaden_ts_sales_history_backfill_targets`):** broadened the seed to **all canonical int-keyed editions with a resolvable set UUID**, dropping the ASK_ONLY + zero-sales filters. Re-seeded the catalog and reset the 168 errored rows to pending.

- Queue now: **9,091 editions** (616 done + 8,475 pending).
- Priority: LT-matched (567) > wmc-held (8,391) > zero-sales (123) > already-covered re-walk (10).
- Security re-verified: `check_secdef_anon_execute_violations()` = `[]`; function grants `postgres + service_role` only.
- **Revert:** restore the prior narrow function body (in the migration history / §9 below) and, if desired, `DELETE FROM topshot_sales_history_backfill_progress WHERE status='pending' AND priority >= 2;` to shrink the queue back. Non-destructive to existing sales either way.

**Open follow-up (handoff):** the backfill route drains at a low rate (≈8 GQL pages/edition/run, self-budgeted to 180s). At current cadence, draining 8,500 editions takes a long time. Raising the per-run edition count / cadence is a route change → handoff Item 2.

---

## 4. Lever 2 — Historical buyer/seller via spork-proxy (handoff)

210K sales lack buyer/seller; **all have a tx hash**, so they are decodable in principle. The decoder (`lib/chains/flow/dapper-v1-tx-decode.ts`, used by `backfill-topshot-buyers`) fetches the tx result over **current-mainnet REST**, which can't return results for older-spork transactions.

**Corrected scope (measured by Claude Code, 2026-06-19) — the historical tail does NOT fully recover.** The null-buyer tail splits three ways: **2025–26 ~30K** are current-spork and already drained by the forward backfill; **2023–24 ~27K** are recoverable via the wired `spork-proxy` (it walks mainnet19→26); **2020–22 ~171K are pre-mainnet19 and NOT reachable via the wired sporks.** (Correction 2026-06-20 smoke test: 2022 is also pre-mainnet19 — mainnet19's floor ~height 35M lands in early 2023, a Nov-2022 tx returns `tx_not_found_in_listed_sporks`; the earlier "2022–24 recoverable" estimate was wrong by one year.) Recovering the 2020–22 bulk needs separate mainnet1–18 spork/node access (a larger standalone effort). So "buyer/seller fully mapped" has a real floor on the oldest moments — which most limits special-serial *owner* identification on 2020–22 moments specifically.

Shipped **fully inert** (commit `03062c2`): a `spork-proxy` `?tx=` passthrough (walks mainnet19→26, no block_height needed), `decodeTopShotSaleTxViaSpork`, and a `?mode=historical` backfill lane — all OFF unless `TS_HISTORICAL_BUYER_BACKFILL_ENABLED=1` + the spork env vars are set (operator enable steps in the handoff). It targets the recoverable **2023–24** tail (`HIST_WINDOW_START='2023-01-01'`, `HIST_BATCH=120`).

Unlocks: **special-serial owner identification across history**, true buyer/seller leaderboards, holder cohorts, wash-trade detection, real liquidity metrics.

---

## 5. Lever 3 — Venue completeness (handoff)

The live indexer covers the native marketplace (TopShotMarketV3) + Dapper NFTStorefrontV2. Two checks to make "across any marketplace" literally true:

- **dapper.market** (the post-Flowty secondary) settles on-chain. Confirm it settles via `NFTStorefrontV2` at `A.4eb8a10cb9f87357` (already indexed) vs. a different contract/event we're missing. Decode one known dapper.market TS sale to verify; add an indexer leg only if it's a new path. (Atlas listings are written to `topshot_active_listings`, **not** `sales` — that's correct; listings ≠ sales.)
- Confirm the V2→V3 native-market transition window left no gap (older `TopShotMarketV2` events).

Likely small incremental volume, but it's the insurance on the completeness promise.

**Do NOT** attempt a blind chain-genesis event sweep of all Flow blocks. Bounding by edition (Lever 1) gets the same FMV/EV/serial value at a fraction of the cost; reserve spork access for targeted tx decode (Lever 2).

---

## 6. Multi-factor special-serial FMV model

### 6a. Where we are

`serial_fmv_power_model` fits `price = k · fmv^β` on only **`(collection_id, serial_bucket, tier)`** — about 5 cells (first × {COMMON, RARE, LEGENDARY, FANDOM}, plus perfect-ALL). `serial_fmv_multipliers` (the fallback grid) adds a `circ_band`. **No player, badge, set, series, parallel, or team factor exists today.** FANDOM-first is already statistically unreliable (n=34, r=−0.30); the others are decent (RARE r=0.80, LEGENDARY r=0.80).

### 6b. The binding constraint — special-serial sales are sparse

This is the crux. Across the entire DB:

- **#1 sales: 1,086** (over 873 distinct editions)
- **Perfect-serial sales: 627**

You cannot slice ~1,000 observations by player × badge × set × series × team × tier and get non-empty cells — most combinations would have 0–1 sales. This is *why* the current model is only tier-coarse, and it's the same root cause as the whole sales-completeness conversation: **we're missing most historical special-serial sales** (the #1s that traded in 2021 aren't in our DB). Lever 1 + Lever 2 are the prerequisite — they grow the special-serial sample (and let us attribute owners), which is what makes a richer model statistically possible.

There's also irreducible sparsity: a given edition's #1 simply rarely trades (it's usually held). So even with complete capture, many editions will have **zero** direct special-serial sales. A useful model must therefore *estimate* a #1/perfect premium for an edition whose special serial has never sold — by borrowing from comparable editions (same player / badge / tier / set). That is exactly what a pooled model does and a lookup grid cannot.

### 6c. Why a bigger lookup grid won't work

Adding factors as grid dimensions multiplies cells geometrically. tier(4) × badge(7) × series(8) × circ_band(4) is already 896 cells against ~1,000 #1 sales — average ~1 sale/cell, mostly empty, and "reliable" nowhere. The grid approach hits a wall immediately. The factors must enter as **model terms with pooling**, not as independent buckets.

### 6d. The right approach — pooled hedonic regression with shrinkage

Model the special-serial **premium ratio** `P = special_serial_sale_price / edition_base_fmv` (base = the edition's HIGH/MED edition-level FMV), in log space:

```
log(P) = β0
       + β1 · log(base_fmv)              -- the existing power-law term (β1 ≈ β−1)
       + serial_bucket effect             -- #1 vs perfect vs jersey
       + f(tier)                          -- fixed effect
       + f(badge)                         -- Top Shot Debut / Rookie / Championship / All-Star / MVP …
       + f(player)        [pooled]        -- random/ridge effect, shrinks to group mean when thin
       + f(set), f(series)[pooled]
       + f(parallel)      [pooled]        -- play_id_onchain groups parallels of the same moment
       + β2 · log(circulation_count)
       + β3 · log(player_total_circulation)        -- player scarcity
       + β4 · log(player_special_serial_supply)    -- how many #1/jersey/perfect exist for this player
       + ε
```

Key properties:

- **Partial pooling / ridge / mixed-effects** so sparse levels (a player with 2 #1 sales) shrink toward their tier/badge group mean instead of overfitting. This is the standard fix for "many factors, thin cells."
- **Fit offline in Python** (`statsmodels` MixedLM or `scikit-learn` Ridge/`Lasso` with one-hot factors + regularization) on the full special-serial sales base. Write the fitted coefficients (or per-(player,badge,tier) shrunken effects) to a model table — same pattern as `serial_fmv_power_model`, applied in SQL at read time, recomputed on a weekly `pg_cron` job as the sales base grows.
- **Per-prediction confidence** derived from the support behind its factor levels (how many real special-serial sales informed the player/badge/set effects). Surface HIGH/MED/LOW on the estimate, like edition FMV.
- **Keep the current power-law as the fallback** for any prediction whose factor support is too thin — graceful degradation, never a hard gap.

### 6e. Factors → data sources (all available today)

| factor | source |
|---|---|
| player | `editions.player_name` / `player_id` → `players` |
| badge type | `get_edition_badges_unified` / `badge_taxonomy` (7 official TS slugs) |
| set / series | `editions.set_name` / `set_id`, `editions.series` |
| parallel | `editions.play_id_onchain` (same play across sets/series) |
| circulation | `editions.circulation_count` |
| player total circulation | SUM(`circulation_count`) over the player's editions |
| player special-serial supply | COUNT of #1/jersey/perfect editions for the player |
| team | `editions.team_name` |
| tier | `editions.tier` |
| base FMV | latest `fmv_snapshots` HIGH/MED per edition |
| **target** (premiums) | `sales` where `serial_number = 1` / `= circulation_count` / `= players.jersey_number` |

Note: jersey-match is supply-limited — `players.jersey_number` is sparse (~18% ceiling) and needs its own backfill if jersey premiums are to be modeled well.

### 6f. Sequencing — data first, then model

1. **Now → weeks:** Lever 1 (shipped) + Lever 2 drain. Watch the #1/perfect/jersey sale counts climb from 1,086 / 627 as the backfill recovers historical special-serial sales.
2. **At sufficient support:** build the pooled hedonic model offline, validate against held-out recent special-serial sales (compare to the current power-law), write the model table + read-time application + confidence gating. This is **FMV pricing logic** → ships via Claude Code with review per the pricing-change discipline, never a blind in-place edit. Handoff Item 5.
3. Surface the richer estimate where #1/perfect premiums already show (moment/edition pages, underpriced-#1s deal board), with confidence.

---

## 7. Downstream payoff (ties to Trevor's goals)

- **FMV accuracy:** the 1,638 editions at 0–2 lifetime sales (almost never HIGH/MED) convert as history lands; the ~2,629 ASK_ONLY editions move toward SALES_ONLY/LOW/MED as real prints arrive.
- **Pack EV:** EV is FMV-weighted across the pool; thin pool members currently carry ASK_ONLY/NO_DATA and add noise. Complete per-edition history tightens every member.
- **Special-serial premiums:** a multi-factor model becomes statistically possible (6) and can estimate premiums even for editions whose special serials have never traded.
- **Special-serial owners:** identified once historical buyer/seller is decoded (Lever 2) and joined to current holdings (`wmc`).
- **Bonus unlocks:** buyer/seller leaderboards across full history, whale/cohort tracking, wash-trade detection, true volume/liquidity metrics.

---

## 8. Sequencing summary

| # | Lever | Type | Status |
|---|---|---|---|
| 1 | Broaden + drain history backfill | migration (Cowork) + route throughput (CC) | **migration shipped**; throughput = handoff Item 2 |
| 2 | spork-proxy in buyer/seller decode | route/worker (CC) | handoff Item 1 |
| 3 | searchSetPlays fix + dapper.market venue check | route (CC) | handoff Items 3–4 |
| 5 | Multi-factor pooled serial-FMV model | offline fit + pricing logic (CC, reviewed) | handoff Item 5; **data-gated on 1–2** |

All cost-flat — no Supabase/infra upgrade; the levers are seed/cadence/throughput/decode-reach, consistent with the levers-first constraint.

---

## 9. Ledger entry (add to docs/overnight/ledger.md Shipped + CLAUDE.md Recent sessions)

> **`audit_20260619_broaden_ts_sales_history_backfill_targets` (Cowork)** — broadened `seed_topshot_sales_history_targets()` to queue all ~9,091 canonical int-keyed TS editions with a resolvable set UUID (dropped the `confidence='ASK_ONLY'` + `NOT EXISTS sales` filters); re-seeded (+8,307 rows → queue 784→9,091) and reset the 168 `searchSetPlays`-errored rows to pending. Idempotent backfill (dedups on tx hash) so re-walking covered editions only recovers missing sales. Goal: lift FMV/Pack-EV/serial-premium accuracy by completing per-edition sale history. Security: `check_secdef_anon_execute_violations()`=[], grants postgres+service_role only. **Revert:** `CREATE OR REPLACE` the prior narrow body (ASK_ONLY + NOT EXISTS sales filter, latest-CTE) and optionally `DELETE FROM topshot_sales_history_backfill_progress WHERE status='pending' AND priority>=2;`. Throughput to drain the queue is a separate CC route change (handoff Item 2).
