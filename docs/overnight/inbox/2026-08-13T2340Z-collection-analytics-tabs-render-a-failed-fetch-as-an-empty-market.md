# `[collection]/analytics` renders a failed fetch as an empty market — 8 sections, 1 already fixed

**Filed** 2026-08-13 · Claude Code (interactive, test-coverage program) · **read-only finding, NOT shipped**
**File** `app/(collections)/[collection]/analytics/page.tsx` (1,706 lines, `"use client"`)

## What

Eight sections of the per-collection Analytics tab fetch with this shape:

```tsx
fetch(`/api/analytics/listings/summary?collections=${short}`)
  .then((r) => (r.ok ? r.json() : null))
  .then((j) => { if (!cancelled && j) setData(j as ListingsSummaryResponse) })
  .catch(() => {})
  .finally(() => { if (!cancelled) setLoading(false) })
```

A 5xx, a statement timeout, a network blip and a genuinely empty result all land
in the same place: `data` stays at its initial value, `loading` goes false, and
the section renders its **empty state**. The reader is told the market is quiet.
Nothing distinguishes that from "we could not ask".

This is the class already fixed at four other layers — `lib/api-error.ts`
(routes), `lib/insights/board-status.ts` (server pages), `lib/analytics/fetch-json.ts`
(client dashboards) and `lib/og/board-empty-copy.ts` (OG cards). The helper for
*this* layer already exists; these sites simply predate it.

## Sites (line numbers as of `a063b043`)

| line | section | endpoint |
|---|---|---|
| 438 | Listings summary | `/api/analytics/listings/summary` |
| 495 | FMV tier pulse | `/api/analytics/fmv/tier-pulse` |
| 549 | Packs summary | `/api/analytics/packs/summary` |
| 610 | Liquidity distribution | `/api/analytics/fmv/liquidity-distribution` |
| 706 | Buyer + seller leaderboards | `/api/analytics/sales/leaderboard` ×2 |
| 836 | Thin-volume readiness | `/api/ready` |

## ⚠ The strongest evidence that this is a real defect, not a style preference

**Line 853 in the same file already does it correctly.** The market-analytics
section carries a dedicated `setMarketFailed(false)` / failure flag and renders a
distinct state. So the distinction was understood by whoever wrote that section —
it was simply applied to one of eight. That is drift within a single file, not a
deliberate design.

The `/api/ready` one (836) is the mildest: it only decides whether to show a
thin-volume caveat, and failing closed hides a caveat rather than inventing data.
Worth converting for consistency but it is not the user-facing half.

## Why it was not fixed in the same pass

Two reasons, both about risk rather than effort:

1. The file is **measured by neither coverage gate** — it is a `"use client"`
   `page.tsx`, so the component gate's `app/**/*Client.tsx` glob misses it and the
   primary gate does not look at `app/**/page.tsx` at all. Rewriting 8 fetch sites
   in 1,706 lines of unmeasured client code has no regression net under it.
2. The right fix probably is not 8 local edits. This page should follow the
   `*Client.tsx` convention (a thin server `page.tsx` + a gated client body),
   which would put it inside the component gate — and *then* the conversion to
   `fetchJson` is safe to make and testable. Doing the honesty fix first would
   mean doing the risky edit twice.

## Suggested order

1. Split `page.tsx` → thin server wrapper + `CollectionAnalyticsClient.tsx`
   (the glob is already in the component gate's include).
2. Lower `BUDGET` in `__tests__/client-page-gate-ratchet.test.ts` from 33 to 32
   in the same commit.
3. Convert the 7 user-facing sections to `fetchJson` from
   `lib/analytics/fetch-json.ts`, whose discriminator is `ok` — **never
   `json == null`**, since a route may legitimately answer with a JSON `null`
   body and branching on emptiness re-creates the conflation.
4. Add per-section tests asserting the failed and empty states render
   *differently*, each with a positive mirror.

## Related, filed at the same time

`__tests__/client-page-gate-ratchet.test.ts` (shipped) freezes the ungated
`"use client"` page population at **33 files / 27,016 LOC**, so this class cannot
grow while the backlog is worked. The pre-existing
`insights-gate-include-completeness` guard enforces the same convention but only
within `app/insights/**`, which is why this population was never surfaced.
