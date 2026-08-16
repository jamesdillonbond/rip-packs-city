# The React #418 hydration class is wider than `/insights` — 17 more date/time sites, FILED not fixed

**2026-08-16 10:06 PT / 17:06Z · Claude Code (interactive) · filed while shipping the `/insights/first-mint` #418 fix**

## What was fixed, and why the rest was not

`/insights/first-mint` threw `Minified React error #418` (hydration text mismatch) live. Cause: `toLocaleDateString("en-US", { month, day })` with **no `timeZone`**, in a client board that is server-rendered then hydrated — so the server (UTC on Vercel) and the browser (viewer's zone) disagree for any row near a UTC day boundary. Fixed in `first-mint`, `serial-premiums` (identical, latent) and `panini-squeeze` (the locale sibling), and banned going forward by `__tests__/insights-client-dates-are-hydration-safe-guard.test.ts`.

**That guard is deliberately scoped to `app/insights/**` + `components/insights/**`.** This file records what that scope leaves out, so nobody re-derives the measurement or mistakes a passing guard for a clean platform.

## The measurement

Same predicate over **all** of `app/` + `components/`, `"use client"` files only, comments stripped, argument lists read to the balanced paren:

- **106 sites total.**
- **89** are `Number.toLocaleString()` with no locale — runtime-locale digit grouping (a de-DE visitor gets `1.234` where the server sent `1,234`). Real, lower stakes, very high volume.
- **17** are date/time renderings with no `timeZone` — the acute class, listed below.

Reproduce: the walker in the guard test, with `ROOTS` widened to `["app", "components"]`.

## The 17 date/time sites

| file:line | method | missing |
|---|---|---|
| `app/(collections)/disney-pinnacle/sniper/page.tsx:370` | Time | timeZone |
| `app/(collections)/panini-blockchain/overview/page.tsx:321` | Date | timeZone |
| `app/(collections)/[collection]/collection/page.tsx:1139` | Date | locale + timeZone |
| `app/admin/analytics/page.tsx:259` | Time | timeZone |
| `app/admin/rewards/page.tsx:373` | Date | locale + timeZone |
| `app/admin/rewards/page.tsx:488` | Date | locale + timeZone |
| `app/dashboard/alerts/page.tsx:297` | Date | timeZone |
| `app/profile/edit/ProfileEditClient.tsx:534` | Time | locale + timeZone |
| `app/rewards/page.tsx:497` | Date | locale + timeZone |
| `app/rewards/page.tsx:864` | Date | locale + timeZone |
| `components/analytics/BiggestSales.tsx:40` | Date | locale + timeZone |
| `components/analytics/LoansDashboard.tsx:550` | Time | locale + timeZone |
| `components/analytics/PipelineHealthBadge.tsx:140` | Time | locale + timeZone |
| `components/analytics/PositionTransfersCard.tsx:204` | Time | locale + timeZone |
| `components/analytics/SalesDashboard.tsx:328` | Time | locale + timeZone |
| `components/analytics/WalletProfile.tsx:88` | Date | locale + timeZone |
| `components/sniper/SniperStatsBar.tsx:33` | Time | locale + timeZone |

## ⚠ Why this was NOT swept in the same pass — read before "finishing" it

**A static check cannot tell these apart, and a blanket fix would be wrong for several of them.**

1. **Some are live clocks that render only after mount.** `SniperStatsBar.tsx:33` and `disney-pinnacle/sniper/page.tsx:370` format `hour/minute/**second**` — a seconds-resolution stamp is a ticking clock, which is almost certainly set in an effect. A value that never exists during SSR **cannot** mismatch, so it is hydration-safe by construction and pinning it to UTC would make it *wrong* (a viewer wants their own clock). `PipelineHealthBadge` is likely the same shape.
2. **Viewer-local is sometimes the correct product answer.** The repo already solved this properly once: `components/insights/FreshnessStamp.tsx` renders a deterministic UTC string built from `getUTC*` parts for SSR + first client render, then swaps to the viewer's zone **after mount**, self-labelling with `timeZoneName`. That is the pattern to copy where the reader genuinely wants local time — not a blanket `timeZone: "UTC"`.
3. **So the fix is per-site and needs a mount check**, not a codemod. This repo has already paid for the codemod version of a sweep (the 351-file incident, and the 502→500 / dropped-`rows:[]` regressions in the `safeApiError` sweep).

## What CI can and cannot see

- **`unit-tests` / `component-tests` are structurally blind.** The whole toolchain runs on Node in UTC, so SSR and the "client" render happen in the *same* zone under vitest and the mismatch cannot occur. This is the same shape as the Safari lookbehind defect: a Node suite cannot observe a browser-runtime property.
- **`e2e-smoke` (Playwright, every 6h) is also blind** — it asserts rendered DOM but does not read the browser console. A #418 does not change the final DOM (React re-renders client-side), so the page looks healthy.
- **Only a source guard, or a console-reading browser check, can catch this class.** Cowork's live console-read during the weekly `rpc-surface-qa` sweep is what found it.

## Suggested next step, if taken

Add console-error assertions to `e2e/smoke.spec.ts` (`page.on("console", …)` failing on `Minified React error`). That would cover the whole site at once, including the 17 above, without needing to classify each site by hand — and it closes the detection gap rather than the instance. Cheaper and broader than sweeping 17 files; do that first.
