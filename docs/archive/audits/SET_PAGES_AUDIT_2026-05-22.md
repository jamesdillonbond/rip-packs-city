# Set Pages — Audit

**Date:** 2026-05-22
**Compiled by:** Claude (Cowork)
**Scope:** The Set page surface — `app/(collections)/[collection]/sets`, `set/[slug]`, `series/[slug]`, and their components.
**Status:** Audit only — no fixes applied yet this round. Brand-token violations (V1, V2, V3) are queued for the mechanical sweep; the rest need review.
**Context:** Flowty shut down its marketplace (~2026-05-13); NFL All Day ended primary pack sales.

## Files audited

`sets/page.tsx` (Set Tracker), `sets/layout.tsx`, `set/[slug]/page.tsx` (per-set detail), `series/[slug]/page.tsx` (series detail), `components/entity/EditionsGridPaginated.tsx`, `components/entity/_shared.tsx`, and the data routes `api/sets`, `api/allday-set-progress`, `api/ufc-set-progress`, `api/sets-db`, `api/entity/set`. Verified against the DB: `get_set_detail`, `get_set_editions`, `sets_summary` columns.

---

## Stale platform context (review first)

- **S1 · Medium · `components/entity/_shared.tsx:202`.** `marketplaceLabel()` still maps `"flowty"` → `"Flowty"` as a presentable live venue. Fix: relabel "Flowty (historical)" or append "(closed)".
- **S2 · Medium · `set/[slug]/page.tsx:122`, `EditionsGridPaginated.tsx:176`.** "Floor Total" and per-tile "Floor" come from `fmv_snapshots.floor_price_usd`, which `fmv-recalc` blends with Flowty floor asks — now frozen but still shown as current. Fix: confirm the Flowty floor-ask feed is disabled in `fmv-recalc`; add a staleness guard.
- **S3 · Medium · `allday-set-progress/route.ts` + `sets/page.tsx:315`.** The AllDay set tracker shows "cost to complete" with no note that primary pack sales have ended; missing pieces still link to `nflallday.com/search` as if freely acquirable. Fix: add a secondary-market-only banner on the AllDay sets page.
- **S4 · Low · `components/entity/_shared.tsx:99-109`.** The `ASK_ONLY` confidence pill mostly represented Flowty asks for non-Top-Shot collections — now a dead-marketplace signal. Fix: audit which collections can still produce `ASK_ONLY` once the Flowty feed is retired.

## Data accuracy

- **D1 · High · `set/[slug]/page.tsx:78-80`.** `seriesLabel` renders `Series ${detail.min_series}` straight from `sets_summary`, which carries **raw on-chain UInt32 values (0-8)**. A Series-1 set shows "Series 0"; a Summer-2021 set shows "Series 3". (`sets.series` / `editions.series` are already 1-indexed — only the `sets_summary`-fed detail page is wrong.) Fix: map through the CLAUDE.md series table.
- **D2 · Medium · `EditionsGridPaginated.tsx:167`.** Tiles render `series_label` verbatim; for non-Pinnacle collections that's a bare integer ("5") with no "Series" prefix. Fix: format server-side or in-component.
- **D3 · Medium · `sets/page.tsx:443,424`.** The missing-piece "ask" is actually `fmvUsd` (an FMV estimate) for Top Shot — presented as a purchasable ask. Fix: relabel "FMV (est.)".
- **D4 · Medium · `sets/page.tsx:309-318`.** Empty-state copy hardcodes `isAllDay ? "No NFL All Day…" : "No Top Shot…"` — so Golazos / UFC / Pinnacle all say "No Top Shot moments". Fix: use `collectionObj?.label`.
- **D5 · Low · `ufc-set-progress/route.ts:137`.** Missing-piece tier defaults to `"CHALLENGER"` (UFC's *top* tier) — an untiered missing piece looks like a chase card. Fix: default lower, or render no badge.
- **D6 · Low · `sets/page.tsx:85-96`.** `TIER_STRIPE` only defines the standard tier vocabulary; UFC's CHALLENGER/CONTENDER render as undifferentiated grey. Fix: extend the map using `--tier-*` tokens (the sibling `_shared.tsx` map already does).

## Visual / UX consistency

- **V1 · Medium · `series/[slug]/page.tsx:116,136,164,185`.** Four hardcoded font literals — the sibling `set/[slug]/page.tsx` already uses tokens correctly. Fix: `var(--font-display)` / `var(--font-mono)`. *(Queued for the sweep.)*
- **V2 · Medium · `components/entity/_shared.tsx` & `EditionsGridPaginated.tsx` (pervasive).** Hardcoded font literals throughout these shared components. Fix: tokens. **Shared with the Moment pages (Moment audit V2) — fixing once covers both.**
- **V3 · Low · `sets/page.tsx:123,100-115`.** `accent` falls back to literal `"#E03A2F"`; the whole page is built on inline hex objects rather than the `rpc-card`/token system its sibling pages use. Fix: `var(--rpc-red)` fallback; longer-term migrate to shared styling.
- **V4 · Low · `set/[slug]` & `series/[slug]`.** No `loading.tsx` / skeleton on these server pages (cold load = blank screen up to the 8s RPC timeout). Fix: add `loading.tsx` skeletons.
- **V5 · Low · `sets/page.tsx:418-447` modal.** Modal has no `role="dialog"` / `aria-modal`, no focus trap, `alt=""` thumbnails. Fix: add dialog semantics + meaningful alt text.

## Bugs & broken states

- **B1 · Medium · `sets/page.tsx:248`.** `completePct` can exceed 100% — `completeSets` and `totalSets` come from different sources. Fix: clamp to [0,100]; derive both from one source.
- **B2 · Medium · `sets/page.tsx:181`.** `lowestSingleAsk` assumes `missing[0]` is cheapest (relies on RPC ordering). Fix: explicit `Math.min` over the array.
- **B3 · Medium · `sets/page.tsx:567-590,208-221`.** `SetCard` expand and modal open both fetch the same `/api/sets?set=` independently (duplicate request); the effect depends on the whole `set` object so it re-fires on every re-render. Fix: shared cache keyed by `setId`; depend on `set.setId`.
- **B4 · Medium · `sets/page.tsx:227-229`.** "Complete" is defined inconsistently — client filter uses `=== 100`, the allday/ufc routes use `>= 100`, plus `Math.round` rounding — the COMPLETE card count and COMPLETE filter result can disagree. Fix: one rounding-aware definition everywhere.
- **B5 · Low · `series/[slug]/page.tsx:83-110`.** "Sets in this Series" / "Top Players" are derived from only the first 100 editions, so the rollups silently undercount vs the stat-strip totals. Fix: aggregate in the RPC, or add a "showing top N" disclaimer.
- **B6 · Low · `sets-db/route.ts:145`.** Golazos incomplete sets are labeled `"unpriced"` even when the user has real progress. Fix: classify by `completionPct`.
- **B7 · Low · `EditionsGridPaginated.tsx:67,119`.** Client sort only sorts loaded pages — after "Load more" the A→Z list is partial with no indication. Fix: disable client sort until exhausted, or sort server-side.
- **B8 · Low · `series/[slug]/page.tsx:160`.** `encodeURIComponent` on an already-safe slug risks double-encoding. Fix: verify the RPC emits clean slugs.

## Overall assessment

The set surface is functional but carries two systemic issues. **Stale platform context:** Flowty is still a presentable marketplace label, Flowty-derived floor/ask values still feed the set detail page and edition tiles as if current, and the AllDay set tracker presents "cost to complete" with no secondary-market caveat. **Per-collection correctness:** the set detail page renders raw on-chain series numbers (D1 — "Series 0" for Series-1 sets, the highest-value bug here), the empty state hardcodes "Top Shot" for three other collections (D4), and the set-card tier stripe only knows the standard vocabulary so UFC tiers render grey (D6). The series detail page is also the lone holdout on the brand-token rule (V1). D1 and the stale-Flowty findings are the top priorities.
