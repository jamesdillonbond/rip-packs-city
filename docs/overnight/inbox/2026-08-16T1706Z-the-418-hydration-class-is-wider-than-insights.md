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

## ✅ The recommended next step SHIPPED the same day — this file is now a REGISTER, not a proposal

The suggestion here was to add console-error assertions rather than sweep 17 files by hand. That shipped in `d89e1798`/`caea7913`:

- `e2e/healthy-page.ts` attaches `console` + `pageerror` listeners **before** `goto` and fails on React-invariant/hydration text only. It lives in the shared assertion, so **all three** e2e specs (smoke, entity-smoke, self-check — 57 tests) inherit it by construction.
- `playwright.config.ts` pins `timezoneId: America/Los_Angeles`. ⚠ **Load-bearing**: CI runners are UTC, and a UTC browser renders SSR and hydration in the same zone, so the class is unreachable *by construction* — exactly as in vitest. Setting it to UTC silently disarms the whole check.
- The filter is deliberately narrow, against the measured noise recorded above; a cry-wolf control fixture pins that ambient 405/500/CSP noise must still PASS.

**So the 17 sites below are now WATCHED, not merely listed** — if one of them ever produces a real mismatch on a monitored page, the 6-hourly run reports it.

⚠ **Two reasons this file stays open rather than being closed.**

1. **The monitor is PROBABILISTIC.** A #418 of this kind is data-dependent — it needs a value to cross a boundary between the ISR snapshot and hydration. Measured: the 30-page sweep caught `/insights/top-sales` failing, and a full suite run ~40 min later passed that same page. Detection ≠ prevention.
2. **Most of the 17 are NOT on a monitored page.** The e2e list covers public surfaces only; `app/admin/**`, `/dashboard/**`, `/rewards` and `components/analytics/**` sit behind the auth wall and are outside the monitor's reach — the guard-scope class again.

**If someone does sweep them**, the per-site decision is unchanged and still cannot be made statically: pin the zone only where the value is meant to be absolute, and use the mount-swap pattern (`components/insights/FreshnessStamp`, or the `nowMs` anchor added to `TopSalesBoardClient`) where the viewer genuinely wants local time or a live clock.
