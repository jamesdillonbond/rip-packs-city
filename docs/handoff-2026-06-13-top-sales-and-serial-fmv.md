# Handoff 2026-06-13 — New /insights/top-sales surface + per-serial FMV layer scoping

Two build items from the 06-13 growth/FMV continuation. Item 1's backing view is SHIPPED (Cowork) — CC builds the frontend. Item 2 is a scoped design for review (touches FMV — do not blind-build; confirm the estimator with Trevor first). Companion: docs/strategy/launch-readiness-2026-06-13.md (the retention rationale).

---

## Item 1 — `/insights/top-sales` (Top Sales / Whale Watch)  [HIGH — retention + SEO]

**Why:** the launch-readiness read shows retention is the gap (1/10 new users returned). The biggest-recent-sales board is the freshest, most shareable /insights surface — a daily reason to return, strong long-tail SEO ("<player> biggest sale"), and it showcases RPC's buyer/seller @handle resolution (the dapper.market moat). 607 rows currently (83 in 7d): Jokić $5,000, LeBron 2020 Finals $3,999, Hakeem Supernova #3 $3,950, etc.

**Backing data — ALREADY SHIPPED (Cowork, `audit_20260613_v_insights_top_sales`).** View `public.v_insights_top_sales`, `security_invoker=on`, granted anon/authenticated/service_role, invariants clean. Bounded: price>=100 + last 30d + thumbnail present (607 rows). Columns: `sale_id, edition_id, external_id, collection, collection_id, player_name, set_name, team_name, tier, circulation_count, thumbnail_url, moment_id, nft_id, serial_number, price_usd, sold_at, buyer_address, seller_address, marketplace`.

**Build (mirror `/insights/trophies` end-to-end — it's the closest, newest analog):**
1. **Route** `app/api/public/insights/top-sales/route.ts` — copy `app/api/public/insights/trophies/route.ts` exactly (supabaseAdmin client, `/api/public/*`, {meta,rows}, `Cache-Control: public, s-maxage=900, stale-while-revalidate=300` — 15min, fresher than trophies' 1h since sales move). Read `v_insights_top_sales`. Params: `collection=` (nba_top_shot|nfl_all_day|laliga_golazos|disney_pinnacle|ufc_strike), `window=7d|30d` (filter `sold_at`; default 7d), `sort=price|recent` (default price desc), `limit` (1..200, default 100). Order: price → `price_usd desc`; recent → `sold_at desc`.
2. **Page** `app/insights/top-sales/page.tsx` — anon-public. Hero strip of the top ~5 by price, then a ranked list/table: tile (use **`https://assets.nbatopshot.com/media/<moment_id>/image?width=512`** for TS — the reliable form that dodges the Series-1 `thumbnail_url` 404s; AllDay use `thumbnail_url`), player · set · #serial/circ · tier chip, **price (big)**, when (rel), and **buyer/seller as @handles** (resolve via `resolveUsernames` over the addresses, like the moment page — this is the differentiator; show truncated addr when unresolved). Link each row to `/moment/<moment_id>`. Brand tokens only (CI guard `scripts/check-brand-tokens.mjs`). Light-mode clean at birth (`--rpc-*` tokens, no hardcoded darks). Collection + window filter chips.
3. **Canonical** `app/insights/top-sales/layout.tsx` — param-stripped self-canonical (copy squeeze/trophies layout) so `?collection=`/`?window=` don't index as dup content.
4. **OG card** `/api/og/insights-top-sales` (or extend the shared insights OG helper) — 1200×630, branded, e.g. "Biggest Flow sales this week" + the top-3 montage. Point the page's openGraph/twitter at it.
5. **Sitemap** `app/sitemap.ts` — add `'top-sales'` to the insights slug array; bump the route-count comment (now 14).
6. **Hub card** `app/insights/page.tsx` — add a Top Sales card to the surface list (the hub currently lists below-FMV/squeeze/etc.). Lead copy e.g. "BIGGEST SALES — the whales of the week, with who bought and sold."
7. **Internal links** — consider a "Recent big sales" rail on player/edition pages where applicable (SEO internal-linking lever).

**QA (rpc-insights-qa):** backing view ✓ shipped+verified. Then `/api/public/insights/top-sales` → 200 JSON; `/insights/top-sales` renders for anon; OG → 200; in sitemap; drill-down (`?collection=nfl_all_day`) returns rows; add it to the rpc-live-health insights surface list; re-run `check_public_security_invariants()` (expect 0).

**Revert:** frontend `git revert`; backing view `DROP VIEW public.v_insights_top_sales;` (no other consumer).

---

## Item 2 — Per-serial FMV layer (SCOPING — review before building; touches FMV)

**The gap (quantified 06-13).** RPC FMV is edition-level — serial #1 and serial #5000 show the same number. But across 3,653 TS editions with >=10 sales/180d, measured vs each edition's median sale:
- **serial #1 → ~41.5× median** (avg; outlier-skewed — use a robust estimator)
- **low serials #2-10 → ~6.9× median**
- **normal serials >10 → ~1.69× median** (the baseline)

So edition-level FMV materially **understates** the grails collectors care most about (your own #1 Clingan, #1 Deni, KD #9). This is the known remaining FMV weakness (roadmap "Next").

**Proposed design (additive, does NOT change edition FMV):**
- A `serial_fmv_multiplier(tier, circulation_band, serial_bucket)` lookup, learned from sales: bucket serials into {#1, jersey-match, perfect(#N/N), low #2-10, normal} × tier × circ-band; compute the **median** (not mean) price-vs-edition-median premium per bucket, **capped** (e.g. #1 cap ~10-15× so a single $5k-of-$100 sale doesn't poison it), with a min-sample guard (fall back to no adjustment when thin).
- Surface as an **additive** field on the moment page (kind='moment'): `serial_adjusted_fmv = edition_fmv × multiplier`, shown as a secondary line ("Serial-adjusted est. $X — #1 premium") with its own confidence, never overwriting the edition FMV. Same additive-with-fallback discipline as the trophy-slab live-FMV fix.
- Recompute the multiplier table on a low cadence (weekly) from the sales base.

**Gating + caveats:** the roadmap defers this until the tshb sales-history base is fuller (more serial-diverse sales → better multipliers). It is FMV pricing logic → **do not blind-ship**; confirm the estimator (buckets, caps, min-sample) with Trevor, build behind a flag, validate against known #1 sales before exposing. Recommend Phase 1 = ship the multiplier *table* + a read-only internal validation (compare predicted vs actual #1 sales) before any user-facing number.

**Revert:** additive-only, so a flag/feature-gate off; the multiplier table is a new artifact with no edition-FMV dependency.

---

## Pending commit note
Cowork session docs uncommitted in the tree (docs-only, build-skipped): `strategy/launch-readiness-2026-06-13.md`, this handoff, `cron-schedule.md` (V1 WIRED), `ledger-append-2026-06-13-audit.md` (FMV-accuracy + V1 + special-serials), the `cc-next-prompt-clear-all.md` Item B update. Fold into the next commit.
