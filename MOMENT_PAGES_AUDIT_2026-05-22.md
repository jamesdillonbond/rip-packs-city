# Moment / Edition Pages — Audit

**Date:** 2026-05-22
**Compiled by:** Claude (Cowork)
**Scope:** The Moment / edition detail surface — `app/moment/[id]`, `app/(collections)/[collection]/edition/[slug]`, `app/(collections)/[collection]/moment/[momentId]`, and their components.
**Status:** Audit only — no fixes applied yet this round. The brand-token violations (V1, V2) are queued for the same mechanical sweep already done on the Pack surface; the rest need review.
**Context:** Flowty shut down its marketplace (~2026-05-13); NFL All Day ended primary pack sales.

## Files audited

`moment/[momentId]/page.tsx` (resolver), `edition/[slug]/page.tsx` (primary edition page), `app/moment/[id]/page.tsx` (public detail / Trophy-Slab QR target), `app/edition/[id]/page.tsx` (legacy redirect), `[collection]/layout.tsx`, `MomentDetailModal.tsx`, `MomentMedia.tsx`, `TrophySlab.tsx`, `BadgeRow.tsx`, `components/entity/_shared.tsx`, `SalesTablePaginated.tsx`, `FmvHistoryChart.tsx`, `MarketplaceStatusBanner.tsx`, `lib/seo.ts`, `app/api/og/moment/[id]/route.tsx`.

---

## Stale platform context (review first)

- **S1 · High · `app/moment/[id]/page.tsx:503-505`.** The moment page renders a "Flowty ask" stat unconditionally; with Flowty shut down, any non-null value is stale. Fix: remove the cell, or relabel "Flowty ask (last seen)" and gate behind `FLOWTY_MARKETPLACE_ENABLED`.
- **S2 · High · `MomentDetailModal.tsx:351-399`.** Renders a live "Buy on Flowty →" anchor; only disabled when `marketplaceSource === "flowty"` is explicitly passed — an undefined source defaults to a live `topshot` CTA. Fix: fail closed — treat a `flowty.io` host (or unset source) as Flowty-disabled. *(Component is currently unreferenced — see dead-code note below.)*
- **S3 · Medium · `lib/seo.ts:94-99`.** SEO description templates still advertise "Flowty ask prices" / "Flowty marketplace intelligence" as live features. Fix: neutral phrasing ("marketplace ask prices").
- **S4 · Low · `[collection]/layout.tsx:91,98`.** The collection ticker advertises "FMV + Flowty asks + badge intel". Fix: drop the explicit Flowty reference.
- **S5 · Medium · `app/moment/[id]/page.tsx` & `edition/[slug]/page.tsx`.** Neither page mounts `MarketplaceStatusBanner` / `FlowtyDormancyChip` (they exist, only used on `/overview`). A user on a UFC or AllDay edition page sees prices with no venue-status context. Fix: mount the banner on the edition detail page.
- **S6 · Low · `edition/[slug]/page.tsx:303-309`.** Pinnacle "Live ask" renders `live_ask.source` verbatim; if it resolves to Flowty it shows a dead, known-bad price. Fix: suppress or flag Flowty-sourced asks.

## Data accuracy

- **D1 · High · `app/moment/[id]/page.tsx:171-179`.** `tierColorVar()` omits UFC's `CHALLENGER` / `CONTENDER` — UFC tiers render undifferentiated gray (hero border, breadcrumb). Fix: add the cases (the shared `TierBadge` already maps them via `--tier-*` tokens).
- **D2 · Medium · `app/moment/[id]/page.tsx:362,681`.** Series rendered as the raw on-chain integer — "Series 0" instead of "Series 1", "Series 3" instead of "Summer 2021". The edition page uses a resolved `series_label`; this page does not. Fix: map through the series table.
- **D3 · Medium · `edition/[slug]/page.tsx:331`.** "Floor" stat silently falls back to FMV (`floor_price_usd ?? fmv_usd`) — presents a computed value as a real lowest ask. Fix: show em-dash when floor is null, or add "(est.)".
- **D4 · Medium · `app/moment/[id]/page.tsx:540`.** `is_listed` (`boolean | null`) renders `null` as a definitive "NO". Fix: three-way — YES / NO / em-dash.
- **D5 · Low · `app/moment/[id]/page.tsx:223,679`.** `circulation_count` coerced to `0`, conflating "0/uncapped" with "unknown". Fix: keep nullable; em-dash only for null.
- **D6 · Low · `MomentDetailModal.tsx:6-13`.** Modal's `TIER_COLORS` omits UFC tiers and hardcodes hex instead of `--tier-*` tokens. Fix: reuse the shared `TierBadge`.

## Visual / UX & bugs — High

- **V1 · `MomentDetailModal.tsx:191,224,233,242,321,336,363,389`.** Hardcoded `'Barlow Condensed'` / `'Share Tech Mono'` / `#E03A2F`. Fix: CSS tokens. *(Queued for the mechanical sweep.)*
- **V2 · `components/entity/_shared.tsx:86,115,129,157,158,172,184` and `FmvHistoryChart.tsx:152`.** `_shared.tsx` (used by the edition page) hardcodes font literals; `FmvHistoryChart` hardcodes `stroke="#E03A2F"`. Fix: tokens. **High value — `_shared.tsx` is shared with the Set pages too.**
- **V3 · `MomentDetailModal.tsx:155,168,402`, `edition/[slug]/page.tsx:241`.** Modal has no `role="dialog"` / `aria-modal` / focus trap / labeled close button; decorative autoplay videos have no accessible label. Fix: add dialog semantics + a labeled close button; `aria-hidden` decorative video.
- **B1 · all page files.** No `loading.tsx` exists anywhere in `app/` — both server-rendered detail pages block silently on the network. Skeleton infra exists (`SlabSkeleton`, `LoadingState.tsx`) but isn't wired up. Fix: add `loading.tsx` for the moment and edition routes.

## Visual / UX & bugs — Medium

- **B2 · `app/moment/[id]/page.tsx:584-585`.** Sales table keyed on array index. Fix: composite key like `SalesTablePaginated`.
- **B3 · `edition/[slug]/page.tsx:352`.** "Recent Sales (30+)" shows the page size, not the true count. Fix: return a real total, or drop the number.
- **B4 · `app/moment/[id]/page.tsx:350,507`.** No `isAllDay && serial === 0 → unresolved` guard — an AllDay moment with an unresolved serial renders "#0" as a real serial. Fix: apply the guard used in `SalesTablePaginated.tsx:106`.
- **B5 · `moment/[momentId]/page.tsx:94`.** Unresolved moment redirects silently to the collection grid — a scanned Trophy-Slab QR dead-ends with no explanation. Fix: redirect with `?notfound=` and show a toast.
- **B6 · `MomentDetailModal.tsx:138`.** Fixed `gridTemplateColumns: "1fr 1fr"` with no breakpoint — crushed on mobile. Fix: stack to one column at a mobile breakpoint.
- **V4 · `app/moment/[id]/page.tsx` vs `edition/[slug]/page.tsx`.** The two moment surfaces use separate `StatCell` implementations with different fonts/borders/padding and different mint formatting. Fix: consolidate on the `_shared.tsx` primitives.

## Visual / UX & bugs — Low

- **B7 · `app/moment/[id]/page.tsx:281-288`.** JSON-LD always emits `availability: InStock` when an FMV exists — wrong when there's no live listing. Fix: base `offers` on real listing state.
- **B8 · `edition/[slug]/page.tsx:386`.** Null `drop_weight` rendered as a fabricated "1 slot". Fix: em-dash / "weight unknown".
- **B9 · `app/moment/[id]/page.tsx:539`.** Owner address rendered raw into an ellipsis-clipped cell, not a profile link. Fix: use the shared `WalletLink` / `truncWallet`.
- **B10 · `MomentMedia.tsx:34,74,89`.** Defaults `alt=""` for meaningful thumbnails; video has no label. Fix: require a meaningful alt; `aria-hidden` the hover video.

## Note — possible dead code

`MomentDetailModal.tsx` and `MomentMedia.tsx` appear to be unreferenced (only `TrophySlab` is used, as a QR target). Worth confirming — if dead, deleting them removes S2, D6, V1, B6, B10 outright. If they're meant to be wired up, that's a separate task.

## Overall assessment

The edition detail page (`/[collection]/edition/[slug]`) is the stronger surface — shared primitives, all five tier vocabularies handled via `TierBadge`, server-resolved series labels. The parallel `/moment/[id]` page is weaker: duplicated formatting code, mishandled UFC tiers (D1) and on-chain series integers (D2), and a stale live "Flowty ask" stat (S1). The highest-value fixes are the stale-Flowty context (S1, S2, S5) and the brand-token violations in `_shared.tsx` (V2, shared with the Set pages). No loading skeletons exist app-wide (B1).
