# RPC Weekly Data-Quality Sweep — 2026-08-25 (PT)

**Status: HEALTHY.** Read-only sweep. Nothing shipped. No code/pricing/ledger action required. One positive drift (a security instrument that was red on 08-22 is now green) and a few standing residuals, all benign and characterized below.

## This week (headline per check)

1. **FMV sanity** — `v_fmv_sanity_flags` = **0 rows**. No edition diverges from its set's sales-median. Clean.
2. **Offer reconciliation** — `v_offer_sanity_flags` = **1,091 rows**, largest `gap_usd` **$2,000**. **100% are `has_sub_serial=true`** (681 `gql_blank_chain_has` + 410 `chain_exceeds_gql`). This is entirely the known structural case where the GQL edition-offers aggregate collapses subedition/serial offers — not a new regression.
3. **Integrity** — (a) editions with no `fmv_snapshot`: TS **171 / 19,841 (0.9%)**, AllDay/Golazos/UFC **0**, Pinnacle N/A (render-keyed, 0 rows in `editions`). (b) wmc contract (2% `TABLESAMPLE`): TS **0.30%** orphan, AllDay **0%**, Golazos **0%**, UFC 7.7% (n=117, small), Pinnacle 100% (structural — Pinnacle editions aren't in `editions`). (c) 7d sales with null/unresolvable `edition_id`: **0** across all collections.
4. **unmapped_sales backlog** — AllDay **105,038** unresolved (large but **inflow decreasing**: 58 added last 7d vs 137 prior 7d — a historical residual, not growth); UFC 1,070 (static, newest sale April); Golazos 9.
5. **Sentinel** — TS malformed `external_id` in 48h = **3** (ok<250). Clean.
6. **FMV freshness + coverage** — TS/AllDay/Golazos/candy_mlb computed **~6 min ago**. UFC **~17h** and Pinnacle **~18h** — both on daily/weekly late-UTC cadences with today's run pending, NOT stalls (Pinnacle recomputes daily ~22:00 UTC; UFC recomputes ~weekly and has zero recent sales inputs). Coverage (`edition_fmv_current`): TS **HIGH 2,197** / MED 5,081 (well above the ~400 alarm), AllDay HIGH 186 / MED 1,268, candy_mlb HIGH 10, UFC **0 HIGH/MED** (consistent with zero recent sales), Golazos ~0.
7. **Pack-EV staleness** — rows with `snapshotted_at` >3d: AllDay 1,053, TS 414, Golazos 42, Pinnacle 0. **Benign**: of the stale rows with remaining supply, essentially all are delisted (not purchasable) — TS 400/402 unavailable, AllDay 1,053/1,053 unavailable. Only **2** still-available TS packs are stale.
8. **Offer-indexer liveness** — 24h ok-rate: `topshot-offers-indexer` **97.1%** (68/70), `allday-offers-indexer` **98.6%** (70/71), both ran within the hour. `offers` table: **25,851 open** / 38,390 filled / 83,800 cancelled; ~10.9k new offers created in 7d (healthy accrual).
9. **Schema-truth drift** — Enums (`fmv_confidence`, `tier_type`, `chain_type`) byte-for-byte match `schema-truth.md`. `pinnacle_fmv_snapshots` absent / `pinnacle_fmv_history` present (correct). **RLS: 0 of 367 public base tables RLS-off** and `check_public_security_invariants()` returns **0 rows (clean)** — the `series_detail_rollup` RLS-off item flagged in `schema-truth.md` on 08-22 is now **RESOLVED** (RLS enabled). No dropped/renamed table that CLAUDE.md names.

## Flags

- **Nothing alert-grade.** FMV sanity, integrity, mapping, sentinel, indexers, and schema all clean.
- **Doc drift (LOW, positive):** `docs/reference/schema-truth.md` RLS section (stamped 2026-08-22) still describes `series_detail_rollup` as an unresolved red instrument. That instrument is now green. Section is stale-in-a-good-way.

## Suggested actions

- **Offer edition_offers GREATEST-raise (recommend, do not self-apply):** the offer-sanity set is stable and entirely sub-serial, exactly the durable-fix case. When the offer crons have accrued, raise `edition_offers` via a GREATEST-based update (never clobber down). Not written here — flagged only.
- **Nightly pass / Claude Code:** regenerate `docs/reference/schema-truth.md` to clear the stale RLS section (instrument resolved; positive drift). Low priority.
- No FMV/pricing/ingest change warranted this week.
