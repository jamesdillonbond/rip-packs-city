# `/insights/pack-reality`'s +EV ranker has been empty for 10 days because `pack_drop_pool` froze on 2026-08-28 — and the `atlas` pool it fell back to is a **57-distribution static seed last refreshed 2026-07-17**

*Claude Code on Trevor's box, 2026-09-07 09:03 PT. READ-ONLY diagnosis — nothing shipped for this item. Answers the open ask in inbox `2026-09-07T0311Z` (verify the page renders an honest empty state) and **REFUTES that filing's diagnosis**.*

---

## The open ask is answered: the page IS honest. Verified by rendered DOM, with both controls.

Playwright against production, not HTTP 200. The page renders **exactly one** `.rpc-pr-state` block:

> "Our Top Shot pack prices are stale, so the ranker has nothing fresh enough to show — 3 packs would otherwise qualify, last priced 9 days ago. **This is our data being behind, not a reading of the market.**"

- The false market claim `No +EV packs right now.` is **absent**.
- No degraded/failed-read block, no stuck `Loading…`.
- Zero console errors, zero page errors.
- ⚠ **Probe caveat, recorded because it nearly produced a wrong answer:** `innerText` returns text **CSS-uppercased**, so a case-sensitive substring probe returns `false` for copy that is plainly on the page. My first probe reported *both* the false claim and the honest clause as absent. Re-run case-insensitively **with a positive and a negative control** (`PACK REALITY` present, `ZZZ_NOT_ON_THIS_PAGE` absent) before believing any DOM substring result.

This is the 2026-09-01 third-state fix (`rankerStale`) working exactly as designed on live traffic. **No code change wanted on the page.**

## What the 0311Z filing got wrong

It called this "read ok + genuinely empty — a legitimate *no qualifying +EV packs right now*", and told the night pass not to widen the MV gates. **The don't-widen advice is right. The diagnosis is not.** The board is not genuinely empty; it is empty because our pack prices stopped being refreshed. Re-derived clause by clause against the MV's *actual* predicate (the filing quoted only two of its eight clauses):

| clause | rows surviving |
|---|---|
| Top Shot rows in `pack_ev_latest` | 1,210 |
| `is_positive_ev` | 61 |
| `pack_price > 0` | 61 |
| not a reward pack | 61 |
| `dist_id IS NOT NULL` | 34 |
| `COALESCE(depletion_pct,100) < 90` | **3** |
| `fmv_coverage_pct >= 40` | 3 |
| `snapshotted_at >= now() - 48h` | **0** |

The API's `meta.ranker_staleness.stale_count = 3` is therefore **correct**, and so is the page's copy.

⚠ I first hypothesised the page was *over*-apologising — blaming our pipeline for a true market condition — and **that hypothesis is refuted**. All 3 packs still pass depletion **today** (82 / 86 / 89) on supply data refreshed 2026-09-07 12:13Z, with real sealed inventory (270 / 211 / 83 packs). Only their **price** is stale. The page's sentence is accurate in both halves.

## Root cause — the pack pool froze when the Top Shot GQL host died

`pack_drop_pool` for Top Shot, by source:

| `pool_source` | distributions | pool rows | newest `last_refreshed_at` |
|---|---|---|---|
| `gql_historical` | 1,161 | 34,737 | **2026-08-28 16:43Z** (frozen) |
| `gql` | 767 | 26,421 | **2026-08-28 16:38Z** (frozen) |
| `atlas` | **57** | 25,594 | **2026-07-17 14:18Z** (static seed, never refreshed) |

`refresh_atlas_pack_ev()` (pg_cron jobid 217 `rpc-atlas-pack-ev`, hourly) has **no LIMIT** — its population *is* `WHERE pool_source = 'atlas'`, i.e. those 57 distributions. It is not throttled; it has nothing else to walk.

⭐ **The `atlas` pool is NOT part of the recent Atlas restoration work** — it predates it by seven weeks. The 09-06/09-07 Atlas ships (`edition_offers.low_ask`, `ts_listings`, `cached_listings`) restored *edition* pricing; the *pack* pool was never migrated.

**Consequence, measured as a distribution not a snapshot** — distinct Top Shot pack listings priced per day in `pack_ev_history`:

```
08-09..08-28   308 – 836 / day   (08-28 itself: 625)
08-29 onward   149 149 152 150 145 145 145 150 150 147
```

A 5x collapse with a sharp change point at the host death, flat ever since. The 3 packs that pass every gate are all `pool_source = 'gql'` only, with `pack_drop_pool.last_refreshed_at` = **08-28**.

⚠ **Their `pack_ask_state.last_checked_at` also reads 2026-08-27, and that is NOT corroborating evidence — see the retraction below.** Those three asks (\$388 / \$774 / \$19.88) are re-verified every 5 minutes and are genuinely live; the stamp is frozen by design. **What is stale is the EV RECOMPUTE, not the price feed** — `pack_ev_history.snapshotted_at` for these dists, because `refresh_atlas_pack_ev()` walks only the 57-dist `atlas` pool and these three are `gql`-pool. The pool diagnosis above stands on `pack_drop_pool` and `pack_ev_history` alone and does not depend on the ask-state stamp at all.

## ⛔ RETRACTED — the "wider exposure" in the first version of this filing was MY OWN MEASUREMENT ERROR

**The original claim (WRONG, retained so the error is legible):** *"`pack_ask_state` holds 1,995 rows `is_listed = TRUE` with a `lowest_ask` but only 96 checked in 48 h, so ~1,899 rows assert 'listed at $X' on evidence up to 11 days old. Gate on `last_checked_at`, never on `is_listed` alone."*

⛔ **That is false, and acting on it would have made an accurate surface inaccurate** — the precise failure CLAUDE.md warns about under *"a filed FINDING is a hypothesis."* Gating `pack_table_rows.live_ask` on `last_checked_at` freshness would have **hidden 2,876 genuinely-live asks** across both collections.

**What refuted it, re-derived 2026-09-07 ~14:2x PT:**

- `snapshot-pack-asks` runs **every 5 minutes, `ok=true`, ~3 s**, and its `extra.per_collection` reports `total_listed` = **1,995** (nba-top-shot) and **981** (nfl-all-day) — *exactly* the `is_listed = TRUE` counts — with **`dropped: 0` on every tick**. The complete book is fetched and re-verified 5-minutely. A tick at 21:08Z recorded `changed: 3`, so the change-detection is live, not wedged.
- `upsert_pack_ask_state` **does** demote rows missing from the payload (`SET is_listed = false … WHERE NOT EXISTS (SELECT 1 FROM _fresh …)`). `dropped: 0` therefore means every one of those rows was present upstream this tick — that is the positive control.
- ⭐ **`last_checked_at` is not a freshness column.** Migration `20260827030000` made the upsert change-detected (`WHERE s.is_listed = false OR lowest_ask IS DISTINCT … OR pack_listing_id IS DISTINCT`) to stop rewriting every row every tick — **386 MB of WAL/day, "the worst WAL-per-unit-of-information ratio measured on this instance."** An unchanged row keeps its old stamp by design.
- 🚨 **The column carries a COMMENT that says exactly this, and I did not read it before measuring:** *"MEANING CHANGED 2026-08-26: this is now 'last CHANGED', not 'last checked'. … **Do NOT hang a staleness or freshness monitor on this column** — the same trap as `saved_wallets.cache_updated_at` and `edition_fmv_current.refreshed_at`. For sweep freshness read `pipeline_runs` where `pipeline = 'snapshot-pack-asks'`, which is written on every tick."* That migration swept six caller sources and found nothing reading the column; my "finding" was the seventh reader it warned about not existing.
- The "oldest check 2026-08-27 02:58Z" that looked like a host death is just **the migration's own apply time** — the last moment every row was unconditionally rewritten.

⭐ **The lesson, which is the only durable output of this section: read the COLUMN COMMENT before treating a timestamp as freshness.** A `*_at` column name is not its contract. Three columns on this database now carry this same trap.

✅ **`pack_table_rows.live_ask` and `secondary_available` are HONEST.** No change wanted, and the memory `pack-availability-flags-are-snapshot-columns` does **not** apply to `pack_ask_state.is_listed` — that flag is re-verified every 5 minutes.

## Risk read and suggested action

- **Risk: MEDIUM, and it is silent.** A public insights board and buy/no-buy input has published nothing for 10 days; `topshot-atlas-pack-ev` reports `ok` 24/24 the whole time because it completes over the pool it *has*. The "green pipeline blind to its own work" shape — `ok` means it finished, not that its population is right.
- ⛔ **Do NOT widen the MV gates** (the 0311Z filing is right about this, for the wrong reason). The depletion gate failing closed on unknown supply is correct: of the 12 freshly-priced positive-EV packs today, **every one is 92–99 % depleted**. Relaxing the gate would put near-sold-out packs on a buy/no-buy board.
- ⛔ **Do NOT "fix" `refresh_atlas_pack_ev()` to write real `depletion_pct`** as a way to fill the board. I checked: `pack_distributions` already holds fresh `total_minted / total_opened / total_sealed / depletion_pct` for all 57 walked dists (updated 12:13Z today), and the writer hardcodes `total_unopened = 0, depletion_pct = NULL` — **that is a genuine defect worth fixing on its own merits for record honesty**, but it will NOT populate the board: all 12 candidates fail the depletion gate on their *real* numbers too.
- ✅ **The actual lever is repopulating the pack pool from Atlas** — 57 of 1,235 distributions is the whole story. That is the same workstream as known-issues **#65**, which another session has been shipping into for two days, so it wants coordination rather than a drive-by. **Queued deliberately, not dropped.**
- **Cheap interim option if the board's emptiness matters before then:** nothing on the page needs changing — it is already telling users the truth.

**Falsifier for this filing:** if `pack_drop_pool` gains fresh `pool_source='atlas'` rows beyond 57 distributions and the daily distinct-listing count stays at ~150, the pool is not the binding constraint and this diagnosis is wrong.
