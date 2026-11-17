# F8 — Analytics design-system re-unification

**Date:** 2026-05-20
**Audit ref:** `../archive/audits/audit-2026-05-20-full-platform.md` F8 — "the entire `(analytics)`
route group uses a different design system than the rest of the app."

The analytics section reads as a different product: cool blue `slate` palette,
`emerald` accent, default (non-condensed) sans-serif, sentence-case copy — versus
the brand's `zinc`/black neutral, red accent, Barlow Condensed display font, and
uppercase tracked labels.

Done in phases so each is a safe, reviewable diff rather than one risky rewrite.

---

## Phase 1 — DONE (commit `7727ac7`)

- **`slate-*` → `zinc-*`** — 1,088 class tokens + 41 slate hex literals across
  **39 files**. Pure same-scale hue shift to the brand neutral.
- **`emerald` → brand red, navigation chrome** — `AnalyticsSidebar` active item
  + `AnalyticsBreadcrumb` hover.

Verified live: sidebar active item renders brand red, palette is zinc-neutral,
no breakage.

## Phase 2 (partial) — DONE: the `/analytics` landing page

- **`app/(analytics)/analytics/page.tsx`** — 11 `emerald-` → `red-`. All uses on
  the hub page are decorative brand-accent (eyebrow label, nav-card hovers, icon
  chip, "Live" badge, arrow, methodology link, changelog dot) — no data-semantic
  greens, so a clean file-wide swap.
- **`components/analytics/InsiderSignals.tsx`** — 3 `emerald-` → `red-` (the
  `ShieldAlert` section icon and a link). The only analytics component the
  landing page renders.

The `/analytics` landing page is now fully brand-unified. `tsc` clean.

---

## Phase 2 (remaining) — the 8 dashboard sub-pages

~100 `emerald` tokens remain across the dashboard components. **They are NOT a
mechanical swap** — emerald is data-semantic in many places (green = up / gain /
healthy / live). Below is the per-occurrence classification so the next pass is
deliberate. Do it **one screen at a time** (each dashboard is one route + one
component) so no screen is left with a mixed accent.

### KEEP green — data-semantic (do NOT convert)

| File:line | Why |
|---|---|
| `KpiCard.tsx:41` | `positive ? emerald : rose` — delta sign |
| `FmvDashboard.tsx:302,311` | `positive ? emerald : rose` — delta sign |
| `LenderPerformanceTable.tsx:42` | `n > 0.01 ? emerald` — positive value |
| `WalletProfile.tsx:890` | `isOutgoing ? rose : emerald` — transfer direction |
| `EditionGrid.tsx:30`, `FmvDashboard.tsx:67` | HIGH-confidence tier color |
| `HealthBar.tsx:34` | health-bar fill — green = healthy |
| `PipelineHealthBadge.tsx:29,39` | healthy pipeline status |
| `PulseDashboard.tsx:323,557-560,650-651,740` | live/fresh ping indicators, ArrowUp |
| `PositionTransfersCard.tsx:77` | "Repaid" status — good outcome |
| `MarketplaceMix.tsx:25`, `BiggestSales.tsx:50`, `LeaderboardTable.tsx:67,69` | categorical chart / collection-identity colors |

### CONVERT → red — decorative brand-accent

- **All `hover:` / `focus:` emerald states** (~25 occurrences, every dashboard) —
  pure UI accent. Safe regex: `(hover|focus):([a-z]+-)emerald-` → `\1\2red-`.
- **`KpiCard.tsx` accent system** — rename the `Accent` type member
  `"emerald"` → `"red"`, the `ACCENT_BG` key, the `accent = "emerald"` default,
  and the ~12 callers passing `accent="emerald"` (`LoansDashboard`,
  `ListingsDashboard`, `SalesDashboard`, `PulseDashboard`, `WalletProfile`,
  `WalletsHubOverview`). This makes the primary KPI accent brand red everywhere.
- **Active / selected filter & tab states** — `FilterBar.tsx:95,114,130`,
  `ListingsDashboard.tsx:183,199,295`, `PacksDashboard.tsx:204,220`,
  `PulseDashboard.tsx:579,595,684`, `NetMarketplaceLeaderboard.tsx:84,104`.
- **Non-conditional section icons** — `LoansDashboard.tsx:392` (ShieldCheck),
  `NetMarketplaceLeaderboard.tsx:65` (TrendingUp), `WalletProfile.tsx:303`
  (HandCoins), `SalesDashboard.tsx:368` / `LoansDashboard.tsx:601` (Activity).
- **Section eyebrow labels** — `LoansDashboard.tsx:395`,
  `WalletsHubOverview.tsx:233,273`.
- **Decorative cards / dots** — `LoansDashboard.tsx:388` (emerald gradient
  section card), `ComingSoon.tsx:17,37`.

### Needs a visual check (ambiguous)

`FmvDashboard.tsx:179,728` — badge styling that may be confidence-related; decide
with the page open.

### Remaining, not yet started

- **Typography** — Barlow Condensed display headings + Share Tech Mono labels
  (~1 day).
- **Sentence-case → uppercase copy** (~0.5 day).
- **`--rpc-red` token purification** — Phase 1/2 use Tailwind `red-*`; the brand
  red token is `var(--rpc-red)`. Fold into the global brand-token epic.

---

## Estimate

| Phase | Effort | Status |
|---|---|---|
| 1 — palette + nav accent | ~0.5 day | **Done** (`7727ac7`) |
| 2 — `/analytics` landing page | ~0.25 day | **Done** |
| 2 — 8 dashboard sub-pages (emerald, per classification above) | ~1 day | Open |
| 2 — typography | ~1 day | Open |
| 2 — copy casing | ~0.5 day | Open |
| 2 — `--rpc-red` token purification | ~0.5 day | Open (fold into brand-token epic) |
| **Remaining total** | **~3 days** | |
