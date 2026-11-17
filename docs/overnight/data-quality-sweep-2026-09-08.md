# RPC weekly data-quality + reconciliation sweep — 2026-09-08 (PT)

**Status: HEALTHY — a quiet week.** Read-only sweep. Nothing shipped except this digest (additive doc). No FMV/pricing/ingest/auth/SQL touched. Every alert-grade check is clean; the only non-trivial item (TS pack-EV secondary staleness) is **flat vs last week** and already carries a handoff — not re-filed.

## This week

1. **FMV sanity** (`v_fmv_sanity_flags`) — **0 rows.** No edition's latest FMV diverges from its set's sales-median. Clean.
2. **Offer reconciliation** (`v_offer_sanity_flags`) — **1,328 rows**, largest `gap_usd` **$3,453**. Composition: `gql_blank_chain_has` 820 + `chain_exceeds_gql` 503, all `has_sub_serial=true`; only **5** non-sub-serial rows, max gap $25. 99.6% is the known structural case where the GQL edition-offers aggregate collapses subedition/serial offers. Trend 1,091 (08-25) → 1,200 (09-01) → 1,328 — modest same-class growth, gap plateaued (~$3,454 last week). Not a regression.
3. **Integrity** — (a) editions with no `fmv_snapshot`: **0** across all Flow collections (canonical TS filter applied; Pinnacle is render-keyed, excluded). (b) `wmc` orphan contract: TS **144**, AllDay **117**, UFC **2** — near-zero, healthy; Pinnacle **56,512** is structural (render-keyed in `pinnacle_catalog`/`pinnacle_editions`, never in `editions`, so orphan-by-definition — not a drain regression). (c) sales in last 7d with null edition mapping: **0** (TS 13,569 / AllDay 1,066 / Candy 304 all fully mapped).
4. **unmapped_sales backlog** — AllDay **95,307** unresolved (**down ~9,349 from 104,656** last week — historical residual actively draining, no new inflow since 2026-08-12), UFC **1,070** (static, newest ingest 08-24), TS **32** (new, last 48h), Golazos **20**. Recent sales map cleanly (check 3c), so this is a legacy dead-letter queue, not a live integrity problem. Benign.
5. **Sentinel** (TS uuid-pair editions created <48h) — **0** (ok<250). No inert-dupe edition creation. Clean.
6. **FMV freshness + coverage** — latest `computed_at` per collection all within ~30 min (TS/AllDay 16:16Z, Golazos 16:26Z, UFC 15:56Z, Candy 16:16Z). HIGH+MED distinct-edition counts: **TS 7,283** (well above ~400 bar), AllDay 1,292, Candy MLB 74, Golazos 2, UFC 0 (Golazos/UFC thin markets — expected). Pinnacle: `pinnacle_catalog.fmv_computed_at` last 10:07Z via `pinnacle-fmv-recalc` (~12h cadence, 0 fails) — within cadence, not stale; render-floor last 13:45Z. Clean.
7. **Pack-EV staleness** — rows with `snapshotted_at` >3d: **TS 1,061 / 1,210**, **AllDay 454 / 3,130**, Golazos 0/211, Pinnacle 0/91, Candy n/a. Of the TS stale rows, **653 are still-`available` live pack-EV targets** (median snapshot ~11d, oldest 2026-06-05). **Flat vs 09-01** (654 then). See Flags.
8. **Offer-indexer liveness** — `topshot-offers-indexer` and `allday-offers-indexer` both **72 runs / 24h, 0 fails**, last run minutes ago. `offers` table **173,130 total / 24,842 open**. Healthy.
9. **Schema-truth drift** — **zero drift.** `pinnacle_fmv_snapshots` still ABSENT, `pinnacle_fmv_history` present; all tables CLAUDE.md names exist; enums byte-identical to the committed snapshot (`fmv_confidence` 7 values, `tier_type` 9 incl. UNCOMMON/CHAMPION/CHALLENGER/CONTENDER, `chain_type` {flow,ethereum,polygon,solana,flow_evm}); RLS-off tables **0** (invariant holds); public base tables now **423** (informational creep, was 372 on 08-25). ⓘ `docs/reference/schema-truth.md` "Last generated" is **2026-08-22** (17 days old) — no drift found this cycle, but it is due for a regeneration by the nightly pass / Claude Code.

## Flags

- **Watch (medium, unchanged — NOT confirmed alert-grade): TS pack-EV secondary-market staleness.** 653 TS packs carry a pack-EV snapshot >3 days old while flagged available (oldest 88 days, 2026-06-05). This is **flat** vs 09-01 (654) — it plateaued after jumping from ~2 on 08-25, and is not growing. The `topshot-atlas-pack-ev` compute is healthy (25 runs/24h, 0 fails), so this is a coverage-shape question, not a dead pipeline. The most likely reading remains the **frozen-flag artifact**: `available` is only as fresh as the row's snapshot, so an 88-day-old "available" row is almost certainly delisted now (the 08-25 sweep found only 2 genuinely-available stale TS packs). User-facing risk exists **only if** a public surface renders available packs without gating on `snapshotted_at` freshness. **Already handed off** — `docs/handoff-2026-09-01-topshot-pack-ev-secondary-staleness.md` — so not re-filed here.
- Otherwise: **nothing flagged.**

## Suggested actions

- **Offer `edition_offers` GREATEST-raise (standing recommend, do not self-apply):** the offer-sanity set is stable and ~100% sub-serial — the documented durable-fix case. When the offer crons have accrued, raise `edition_offers` via a GREATEST-based update (never clobber down). Flagged only; not written.
- **Regenerate `docs/reference/schema-truth.md`** (nightly pass / Claude Code): the volatile-facts snapshot is 17 days old. This sweep found zero drift, but the file's precedence authority ("this file wins") is only as good as its stamp.
- **Pack-EV watch:** no new action — the existing 09-01 handoff already scopes the one open question (does any public surface render `available` packs without a snapshot-freshness gate, and is the Atlas EV compute scoped to a subset). Read-only here by design.

_A quiet week: all alert-grade checks clean, all watch items stable or draining, no schema footguns._
