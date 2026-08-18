# Top Shot series 6/7/8 carry TWO different display labels, and both are user-visible

**Status: FILED, nothing shipped.** This is a product-naming decision (which label
wins), not a low-risk mechanical fix, so it is queued rather than auto-shipped.

## The measurement

Two independent sources disagree on the display name for the SAME on-chain
`UInt32` series number, for `nba_top_shot` only:

| on-chain | `collection_series.display_label` (live DB, 2026-08-17) | repo constants (`lib/collection/helpers.ts`) |
|---|---|---|
| 6 | **Series 5** | **Series 2023-24** / `"23-24 · 2023-24"` |
| 7 | **Series 6** | **Series 2024-25** |
| 8 | **Series 7** | **Series 2025-26** |

Series 0/2/3/4/5 agree across both (`Series 1`, `Series 2`, `Summer 2021`,
`Series 3`, `Series 4`).

## Why it is not inert — the table has live callers

⚠ **`collection_series` is not a dead lookup.** `app/api/collection-series/route.ts`
selects from it and `app/(collections)/[collection]/collection/CollectionTabClient.tsx`
builds the **series filter control** from the response, converting a display label
back to a series number. So the Collection tab is driven by the DB labels while
analytics/SEO/pack surfaces render the repo constants — **the same moment can be
filed under "Series 5" in one control and "2023-24" in another.**

⚠ **A label round-trip is the risk, not just the cosmetics.** `CollectionTabClient`
converts *display label → series number*; `lib/collection/series-param.ts` maps
`"Series 2023-24" → "6"`. A label produced by one convention and parsed by the
other resolves to nothing, or to the wrong series.

## What I did NOT verify

- Rendered DOM. Both readings come from the DB values and the repo constants, not
  from a browser — per the "verify by rendered DOM, not HTTP 200" rule, treat the
  user-visible claim as strongly indicated, not confirmed.
- Which convention is correct for the OTHER collections. Pinnacle uses year labels
  (`1=2023 … 4=2026`), All Day runs `1..10` as `Series N`, UFC has both 0 and 1.
  Only Top Shot shows the disagreement.

## The decision this needs

Top Shot itself stopped numbering after Series 4 and moved to season naming, which
is what the repo constants encode and what the product shows outside the Collection
tab. **If that is the intent, the fix is a `collection_series.display_label` data
correction for `nba_top_shot` series 6/7/8** (three rows) — cheap and revertible.
Do not "fix" it in the opposite direction without Trevor: it would rename a label
that four code sites and the sitemap already emit.

⚠ **Do NOT blanket-remap series numbers while doing this.** The `0 ↔ 1` collision is
Top-Shot-specific and a collection-blind remap silently dropped 385,734 rows on
2026-08-05. This is a LABEL change on three rows of one collection, nothing more.
