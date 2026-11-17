# Pack Pages — Audit & Tune-up

**Date:** 2026-05-22
**Compiled by:** Claude (Cowork)
**Scope:** The Pack page surface — `app/(collections)/[collection]/packs/*`, `app/(collections)/[collection]/pack/*`, and `components/packs/*` (~5,150 lines across 11 files).
**Context:** Two recent upstream events shape this audit — Flowty shut down its marketplace (~2026-05-13) and NFL All Day ended primary pack sales.

---

## 1. Fixed today

Applied to the repo (staged, **not committed** — review before pushing):

- **S1 — AllDay packs page no longer framed as a primary market.** `app/(collections)/[collection]/packs/page.tsx` now renders a secondary-market notice banner on the NFL All Day packs page ("NFL All Day has ended primary pack sales…"), and its title changed from "Pack Distributions" to "Pack Market". `packs/layout.tsx` coming-soon copy softened from "primary-market collections" to "collections with active pack drops".
- **V1 — hardcoded `#E03A2F` brand-red literals replaced with `var(--rpc-red)`** across `packs/page.tsx`, `packs/layout.tsx`, the simulator page, `GrailsView.tsx`, and `PackPageClient.tsx` (the `accent` default param).
- **V2 — hardcoded `'Barlow Condensed'` / `'Share Tech Mono'` font literals replaced with `var(--font-display)` / `var(--font-mono)`** across the simulator page (~22 occurrences), `GrailsView.tsx` (~17), `PackShareButton.tsx`, and `packs/layout.tsx`. The inline Google Fonts `@import` in the simulator was left intact (it loads the font; the tokens only reference the family name).
- **V5 — internal SQL function name removed from user-facing copy.** `GrailsView.tsx` empty state no longer tells end users to "refresh the MV (`refresh_pack_grail_metrics_mv`)".

All six edited files were verified clean on disk (zero brand literals remain; `page.tsx`'s new JSX fragment is well-formed). These are type-invariant string swaps — see §4 on verification.

---

## 2. Open findings — stale platform context (review first)

The Flowty shutdown and AllDay primary-pack end leave a few surfaces misleading.

- **S2 · Medium · `pack/dist/[distId]/page.tsx:549-569`, `PackTable.tsx:507-516, 603-611`.** "Buy on Top Shot" / "Buy ↗" CTAs make no primary-vs-secondary distinction and the dist-page button shows whenever a `packListingUuid` exists, with no check the pack is still for sale. Fix: label the CTA by `price_source` ("Buy on secondary market" vs "Buy primary"); on the dist page, suppress the button when `price_source === "none"`.
- **S3 · Low · `packs/simulator/[distId]/page.tsx:334-335`.** The not-indexed error card says "The simulator works on active drops" — "active drops" is now an inaccurate category for AllDay. Fix: reword to "…works on packs with an indexed drop pool".
- **S4 · Low · `pack/dist/[distId]/page.tsx:740-744` + simulator EV sourcing.** Pack EV / FMV derive from `fmv_snapshots`, which historically ingested Flowty-sourced ASK data. With Flowty gone, those inputs may now be stale, but the pages show `Snapshotted {date}` with no staleness warning. Fix: add a "prices may be stale" caption when the snapshot is older than N days; confirm the FMV pipeline still has a live ASK source post-Flowty.

---

## 3. Open findings — bugs & data accuracy (review / needs runtime testing)

### High severity

- **B1 · `packs/simulator/[distId]/page.tsx:211-237`.** When `pack.slots == null` the simulator POSTs `{distId,…}` to `/api/pack-ev`, but that route requires `packListingId` (returns 400 without it) and its response contains no `momentsPerPack`/`slots` field — so the "live slot-count fallback" is dead code for 100% of NFL/UFC/Pinnacle/Golazos packs; it silently falls through to a hardcoded 5. Fix: either have `/api/pack-ev` accept `distId` and return `momentsPerPack`, or drop the dead fetch and go straight to the 5-slot approx default.
- **B2 · `pack/dist/[distId]/page.tsx:179-187`.** Top-Pulls probability denominator is computed from only the top-50-by-`drop_weight` rows when `total_unopened` is null, so every displayed Drop % is inflated against a partial pool. Fix: fetch the full pool-weight sum for the denominator, or show "—" when `total_unopened` is unavailable.
- **B3 · `packs/simulator/[distId]/page.tsx:278-279, 535`.** Simulated pack value treats every pulled edition with `fmv_usd == null` as $0, systematically biasing pack values (and "% beat retail") low, with no disclosure. Fix: track covered vs uncovered slots and annotate ("X/Y pulls had FMV"), or show pack value as a range.

### Medium severity

- **B4 · `packs/simulator/[distId]/page.tsx:326-343`.** The "Drop pool not indexed… usually because it's sold out" error card also fires on genuine API/network errors, misleading the user. Fix: distinguish an empty pool from a fetch/RPC error and show a "couldn't load — retry" message for the latter.
- **B5 · `GrailsView.tsx:11,104`.** `GrailsView` calls `useSearchParams()` but neither it nor `PackPageClient` / `packs/page.tsx` wraps the subtree in `<Suspense>` — per CLAUDE.md this is required. Fix: wrap `<GrailsView/>` in a `<Suspense>` boundary. *(Verify current build behavior first — if the packs route builds today, Next 16 may be tolerating it.)*
- **B6 · `PackTable.tsx:354-369`.** The generic sort comparator sorts `tier` alphabetically (common, fandom, legendary, rare, ultimate) instead of by rarity rank. Fix: add a tier-rank lookup and special-case the `tier` sort key.
- **D1 · `pack/dist/[distId]/page.tsx:370, 411-413, 793-797`.** Free reward packs (`retail_price_usd = 0`) render identically to paid packs; `value_ratio` / `ev_margin_pct` divide by 0 and produce garbage. Fix: render a "Reward pack" badge when `retailPrice === 0` and suppress the price-ratio verdicts.
- **D2 · `packs/simulator/[distId]/page.tsx:386-387`.** `fmv_coverage_pct` and `depletion_pct` are rendered with a raw `+ "%"` — no rounding or range validation, unlike the dist page's `fmtPct`. Fix: route both through a shared `fmtPct` helper.
- **D3 · `pack/dist/[distId]/page.tsx:186, 731-744`.** The dist page's "Edition EV" column is `fmv × drop_weight` (raw weight, not normalized) — a third EV methodology that won't reconcile with the "Gross EV" KPI. Fix: normalize by total pool weight, or rename the column to "Weight × FMV" and label it a ranking heuristic.
- **V3 · `packs/simulator/[distId]/page.tsx:318-323`, `PackPageClient.tsx:534`, `GrailsView.tsx:204`.** Three different loading treatments across the three pack surfaces, none a real skeleton. Fix: adopt a shared skeleton component.

### Low severity

- **B7 · `packs/simulator/[distId]/page.tsx:226-236`.** A `setSlotsOverride`/`setSlotsApprox` after the second `await` doesn't re-check the `cancelled` flag — stale request can set state for the wrong pack on fast navigation. Fix: re-check `cancelled` before each post-await `setState`.
- **B8 · `pack/dist/[distId]/page.tsx:300, 352`.** `fetchDistFallback` can run up to three times for the same row (lines 300, 352, plus `generateMetadata`). Fix: fetch the distribution metadata once and reuse.
- **B9 · `packs/simulator/[distId]/page.tsx:261, 416-418`.** If a pack resolves to `slots = 0`/null, all three Rip buttons are silently disabled with no explanation. Fix: render an explanatory note when slot count is unknown.
- **D4 · `GrailsView.tsx:59,231-232`, `simulator/[distId]/page.tsx:235`.** Aggregate stats derived from an approximated 5-slot default aren't consistently marked with the `~` "approx" treatment. Fix: annotate any aggregate derived from an approximated slot count.
- **V4 · `packs/simulator/[distId]/page.tsx:564`, `GrailsView.tsx:253`.** Pull-card images use `alt={player_name ?? ""}` — empty alt when the name is null leaves the image unlabeled. Fix: `alt={player_name ?? "Pulled moment"}`.

---

## 4. Verification note

The edits in §1 are type-invariant — string-literal value swaps inside `style` objects, one default-parameter string, display copy, and one well-formed JSX fragment — none can introduce a TypeScript error. All six files were inspected on disk and confirmed clean.

A full `npx tsc --noEmit` could not be run reliably here: the sandbox's file mount served stale/corrupt copies of the just-edited files (phantom trailing lines), producing ~636 false "Invalid character" errors that do not exist in the real files. The authoritative typecheck is the `typecheck` job in `.github/workflows/ci.yml`, which runs `tsc --noEmit` on a clean checkout on every push — it will confirm these changes when committed.

---

## 5. Overall assessment

The Pack pages are functionally rich, and the lifecycle page (`pack/[id]`) is the strongest of the set — clean token usage, careful null handling, honest empty states. The main weaknesses are the now-stale platform framing (addressed for the AllDay packs page in §1; S2-S4 remain), three real data-correctness bugs (B1-B3) that warrant fixing with a running app to test against, and brand-token drift that this pass has now resolved. Recommended next batch: S2-S4 (small, high-clarity), then B1-B3 with runtime testing.
