# F8 — Analytics design-system re-unification

**Date:** 2026-05-20
**Audit ref:** `audit-2026-05-20-full-platform.md` F8 — "the entire `(analytics)`
route group uses a different design system than the rest of the app."

The analytics section reads as a different product: cool blue `slate` palette,
`emerald` accent, default (non-condensed) sans-serif, sentence-case copy — versus
the brand's `zinc`/black neutral, red accent, Barlow Condensed display font, and
uppercase tracked labels.

This is a multi-day epic. It is being done in phases so each phase is a safe,
reviewable diff rather than one risky one-pass rewrite.

---

## Phase 1 — DONE (2026-05-20)

The mechanical, zero-risk, fully tsc-verified part — done blind, safely, because
every change is a same-scale 1:1 token substitution with no structural impact.

- **`slate-*` → `zinc-*`** — 1,088 Tailwind class tokens + 41 slate hex literals,
  across **39 files** in `app/(analytics)/` and `components/analytics/`. Every
  `slate-N` step has an exact `zinc-N` counterpart, so this is a pure hue shift
  from cool blue-grey to the brand neutral. Diff is 823 insertions / 823
  deletions — perfectly balanced, no lines added or removed.
- **`emerald` → brand red, navigation accent only** — `AnalyticsSidebar` active
  item (5 tokens) and `AnalyticsBreadcrumb` hover (1 token). Both files are pure
  navigation chrome with no data-semantic greens, so the swap is exact. The
  active nav item now reads as brand red, consistent with the layout's existing
  `text-red-500` wordmark.

`tsc --noEmit` passes clean. No structural, layout, or logic changes.

---

## Phase 2 — REMAINING (needs a browser, signed in)

Everything below is context-sensitive and should be done with the rendered pages
open — it is not safe to do blind.

### 1. The other ~206 `emerald` tokens (~1 day)

`emerald` still appears ~206× across the dashboard components. These are **mixed
intent** and must be judged per occurrence:

- **Keep green** — data-semantic "up / positive / gain" indicators (positive
  deltas, gainer rows, healthy-status pills). Green-for-up is correct universal
  financial UI.
- **Switch to red** — decorative brand-accent uses (section highlights, the
  `KpiCard` default accent, non-semantic badges).

A blind global `emerald→red` would wrongly turn every "gain is green" into red.
This needs a human pass.

### 2. Typography — Barlow Condensed / Share Tech Mono (~1 day)

Analytics headings and labels render in the default sans. The brand uses
`var(--font-display)` (Barlow Condensed) for display headings and
`var(--font-mono)` (Share Tech Mono) for mono/tracked labels. Apply the brand
fonts to the analytics heading/label scale (start with `KpiCard`, the dashboard
section headers, and `AnalyticsSidebar` group titles).

### 3. Sentence-case → uppercase copy (~0.5 day)

Brand labels are uppercase with letter-spacing. Several analytics labels and
section headers are sentence case. Cosmetic pass once typography lands.

### 4. `--rpc-red` token purification (~0.5 day)

Phase 1 (and the pre-existing analytics layout) use Tailwind `red-500`
(`#ef4444`). The brand red is `var(--rpc-red)` (`#E03A2F`) — CLAUDE.md mandates
the token, never a Tailwind/hex literal. Folding the analytics red onto the token
should be done together with the broader brand-token cleanup epic (audit F8
detail: `#E03A2F` hardcoded ~80×, brand fonts ~284×).

### 5. Primitives — radius / spacing (~minor)

`rounded-xl` / `rounded-md` etc. vs brand `var(--radius-*)`. Low priority.

---

## Estimate

| Phase | Effort | Status |
|---|---|---|
| 1 — palette + nav accent | ~0.5 day | **Done** |
| 2.1 — emerald per-context pass | ~1 day | Open |
| 2.2 — typography | ~1 day | Open |
| 2.3 — copy casing | ~0.5 day | Open |
| 2.4 — token purification | ~0.5 day | Open (fold into brand-token epic) |
| **Remaining total** | **~3 days** | |

Phase 1 already removes the single most pervasive "different product" signal
(the slate palette). Phase 2 is best tackled in one focused stretch with the
analytics pages open in a browser for visual verification screen by screen.
