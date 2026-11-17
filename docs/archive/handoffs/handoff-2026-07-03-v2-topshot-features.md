# Handoff — three v2.nbatopshot.com-inspired edition-page features (2026-07-03)

Claude Code prompt for three additive edition/moment detail-page features inspired by v2.nbatopshot.com:
1. **% Listed** metric in the pricing strip
2. **Activity** tab/section (Sale + Offer events) on the detail page
3. **Parallel tier switcher** promoted to the top of the hero

**Research-only handoff** — no code was changed writing this. Everything below is verified against the live repo at HEAD `5f0c00b`. Line numbers are anchors, not contracts: the pages are large and move. **Claude Code's direct file inspection wins over this doc — adapt to the actual file shape.**

---

## Context — what already exists vs. what this covers

The recent Cowork / overnight / CC work (see `docs/overnight/ledger.md`) has been almost entirely **FMV correctness** (P1a/P1b disconnected-ASK clamps, display guards), **mis-attribution writer guards** (P7/P8 parallel `::subID` leaks), and **AllDay cross-source dedup**. **None of it touches the three features here** — no collision. Do not re-open any FMV/mis-attribution/dedup item; these three are pure presentation + one or two additive read RPCs.

Critically, the detail page is **already partway to all three features**, so most of the work is *surfacing/reframing* existing data, not building pipelines:

- **The canonical detail page is `app/(collections)/[collection]/edition/[slug]/page.tsx`** (~1107 lines) — the rich, SEO, server-rendered edition page. It already renders a Floor / Ask / Best-offer / 30d-Sales StatCell strip, a `SalesTablePaginated` "Recent Sales" section, and a **"Parallel Printings" subedition ladder** (Standard + Hexwave/Jukebox/… printings of the same `setID:playID`).
- **A sibling detail page exists at `app/moment/[id]/page.tsx`** (~1900 lines) — resolves `[id]` as flow `nft_id` / moment uuid / edition uuid; has a "Recent Activity" table (buyer+seller), Best-Offer + Ask cells, and a Parallels section. It shares the same underlying RPCs. **Decide up front which page(s) to touch** — recommendation: implement on `edition/[slug]/page.tsx` first (it's the market-primary surface and the one linked from insights/sitemap), then mirror to `moment/[id]/page.tsx` only if the effort is small. Do NOT silently do one and imply both.

So: Feature 1 is genuinely new (needs a listings *count*, not just floor ask). Feature 2 is a union of an existing sales feed + an existing offers table. Feature 3 is a UI reframe of an already-shipped ladder.

---

## Feature 1 — "% Listed" metric in the pricing strip

**What / why.** Alongside Floor / Ask / 30d-Sales, show `X% listed` = `(active listings / total supply) × 100`. Gives collectors a supply-pressure read at a glance (v2 Top Shot surfaces this).

**Where it goes.** The StatCell pricing `<section>` in `app/(collections)/[collection]/edition/[slug]/page.tsx` — currently around **L696–L734** (`Floor` L704, `Ask` L708–715, `Best offer` L716–728, `30d Sales` L729). Add one `<StatCell label="% Listed" …>` here. Format like `"2.3% listed"`; em-dash when the listings source is stale/absent.

**Data — the real work.** Two inputs:
- **Total supply** is already on the page: `detail.circulation_count` for the base edition, and `currentSibling?.circulation_count` for a parallel printing (the `subedition_siblings` ladder carries per-parallel circulation). Use the parallel's own circulation when viewing a `::subID` page so the % is per-printing-honest.
- **Active-listing count is NOT currently fetched** — the page only has `highOffer.low_ask` (the floor), via `get_edition_high_offer` bundled into `get_edition_market_bundle` (fetch at L316, `MarketBundle.high_offer`). You need a **count of open listings for the edition**. Verified listing sources by collection:
  - **Top Shot** → `ts_listings` (fed every ~5 min by GitHub Actions `ts-listing-ingest.yml` via the Flowty API). **⚠ Verify freshness before shipping** — Flowty wound down its marketplace and this feed has a history of silent failures (see `project_sniper_ts_pool_architecture` memory + CLAUDE.md). If `ts_listings` is stale/empty, a "0% listed" is a *lie*, not a datapoint — gate the metric on a freshness check and render em-dash (not "0%") when the source is cold.
  - **NFL All Day / Golazos** → `cached_listings_v2` (the fresh listing table; the frozen `cached_listings` is dead). There's an `allday_edition_floor_ask` **view** over `cached_listings_v2` used for the floor — a sibling `COUNT(*)` per `edition_id` is the natural count source.
  - **Pinnacle / UFC** → confirm a live listing source exists at all before promising the metric; if none, omit the StatCell for those collections rather than showing a fake 0%.

**Recommended shape.** Add `active_listings integer` to the existing `get_edition_high_offer` / `get_edition_market_bundle` RPC output (a `COUNT(*)` from the collection-appropriate listings table keyed on `edition_id`/`external_id`), so no new page-level round-trip is added (the page already made a point of collapsing the hero fan-out 3→1 in `get_edition_market_bundle` — respect that, don't add a 2nd fetch). Compute `pctListed = active_listings / circulation × 100` in the page, render the StatCell. This is a `rpc-migration`-class change — follow that skill's pre/post-flight checklist (`CREATE OR REPLACE` preserving SECDEF/search_path/grants; run `check_public_security_invariants()` = `[]` after).

**Revert.** `git revert` the page commit + `CREATE OR REPLACE` the RPC back to its prior definition (in Supabase migration history). No data migration, so revert is clean.

**Verify.** `npx tsc --noEmit` (filter to changed files per the null-byte-baseline note). Deploy → Vercel READY. Smoke: open a liquid TS edition (many listings) and confirm a sane `%`; open a stale-source collection and confirm em-dash not "0%"; open a `::subID` parallel and confirm the % uses the parallel's circulation. `curl` the edition page HTML and grep for `listed`.

---

## Feature 2 — "Activity" tab/section (Sale + Offer events)

**What / why.** A combined recent-activity table: columns **Event (Sale / Offer) · Serial # · Price · Buyer · Seller · Date**, last ~50 events. v2 Top Shot has a per-moment activity log; RPC currently splits this — sales only, no offers, and no event-type column on the edition page.

**Where it goes.** `EditionBottomSections` in `edition/[slug]/page.tsx` (async component at **L885**, rendered behind `<Suspense>` at L869). Today it renders `<Section title="Recent Sales">` with `SalesTablePaginated` (**L932–942**), fed by `fetchSales` → RPC `get_edition_recent_sales` (fetch at L203). The component is `components/entity/SalesTablePaginated.tsx`.

**Important: the page has NO tab system today** — it's a linear scroll of `<Section>` blocks. "Add a tab" therefore means one of:
- **(Recommended, lower-risk)** Keep the SSR structure: add a new `<Section title="Activity">` (or rename "Recent Sales") rendering a **client component with a Sale/Offer/All pill toggle** — matches the existing DealsBoardClient / BoardClient split pattern used across `/insights`. No page-wide restructure.
- **(Heavier)** Introduce a real tab bar (`role="tablist"`) around the bottom sections. Only do this if the product genuinely wants tabbed nav; it touches more of the SSR layout and needs a Suspense-safe design. Flag to Trevor before choosing this.

**Data.** Two sources, unioned:
- **Sales** — already available via `get_edition_recent_sales` (the SalesTablePaginated feed). It already carries buyer/seller/serial/price/date (the moment page's "Recent Activity" renders buyer+seller from the same family; serial `#0` is unresolved — reuse the `serial_number > 0` guard shipped in `2f88d54`, don't render `#0`).
- **Offers** — table **`edition_offers`** (confirmed live: written by `allday-offers-indexer`, `topshot-offers-indexer`, `offers-sweep`; read by `fmv-recalc`, `best-offers`, `topshot-deal-floor-serials`). This is the Dapper OffersV2 on-chain offer store for Top Shot + All Day (`offercompleted-event-is-rich`, `onchain-offers-indexers-offersv2` memories). Confirm its columns (buyer/price/nft-or-edition scope/timestamp) before wiring — offers may be edition-scoped (fillable by any serial) rather than serial-specific, in which case the Serial column is blank for offer rows (that's honest, not a bug).

**Recommended shape.** A new SECDEF read RPC `get_edition_activity(p_edition_id, p_limit, p_offset)` that `UNION ALL`s recent sales (event='sale') + recent `edition_offers` (event='offer') for the edition, ordered by timestamp desc, capped at 50. Keeps it one pooled read and paginates like `get_edition_recent_sales`. Alternatively extend `get_edition_recent_sales` with an event-type column — but a separate RPC avoids disturbing every existing SalesTablePaginated caller.

**Revert.** `git revert` the page + component commit; `DROP FUNCTION get_edition_activity(...)`. Additive — no writes, no schema change to existing tables.

**Verify.** tsc clean; Vercel READY. Smoke: an edition with both recent sales and a live offer shows both event types with correct type labels; the toggle filters; pagination/limit caps at 50; offer rows with no serial render blank (not `#0`/`#null`); non-TS/AllDay collections with no `edition_offers` rows degrade to sales-only (don't error).

---

## Feature 3 — Parallel tier switcher at the top of the hero

**What / why.** For a play with parallel printings (Top Shot: Standard `/circ`, Hexwave, Jukebox, etc.; conceptually the "Common /1000 · Rare /99 · Legendary /50" tiers v2 shows), put a pill switcher **at the top of the hero** so the user can jump between printings of the same play without scrolling to the ladder.

**What already exists.** This is largely a **reframe of a shipped feature.** `edition/[slug]/page.tsx` already renders a **"Parallel Printings" `<Section>`** (**L756–797**) from `bundle.subedition_siblings` (`hasParallelLadder = subSiblings.length >= 2`, L479). Each sibling is a card `<Link>` to `/${collection}/edition/${external_id}` with the current one bordered red + "viewing" (L766–794). The current printing is `currentSibling` (matched by `is_self`). So the data, the linking, and the "you are here" state are **done** — Feature 3 is moving a compact version of this to the top and styling it as pills.

**The linking field (verified).** Parallels are linked by the **base `setID:playID`** — i.e. `editions.set_id_onchain` + `editions.play_id_onchain`. The `subedition_siblings` set comes from `get_edition_subedition_siblings` (bundled inside `get_edition_market_bundle`, L316) and returns every `setID:playID::subID` printing sharing that base pair. (Distinct from `get_edition_parallels` at L326 — that's **same play, DIFFERENT set** ("Same Play · Other Sets", L946), which is a *different* relationship and not what this feature is about. Don't conflate them.) This subedition split is Top-Shot-specific; for other collections `subedition_siblings` will be empty and the switcher simply doesn't render (same as `hasParallelLadder` today).

**Honest constraint to preserve.** Each printing is its **own edition row / own page** (that's the whole point of the 2026-06-20 parallel-conflation de-blend). A true zero-navigation in-place switch would require client-fetching each sibling's full market data. Recommendation: render the switcher as **pills that are prefetched `<Link>`s** (Next.js prefetches on viewport; ISR-cached pages make the jump feel instant) with the current pill highlighted — do NOT fake an in-place tab that silently swaps hero data, and don't claim "no navigation" if it navigates. This matches how RPC already models parallels and keeps each printing's canonical URL/SEO intact.

**Where it goes.** A small client component (e.g. `components/entity/ParallelTierSwitcher.tsx`) rendered near the top of the hero block in `edition/[slug]/page.tsx` (above or just under the title/parallel chip at L602–606), fed the existing `subSiblings` array + `currentSibling`. Show name + `/circ` per pill. You can keep the fuller "Parallel Printings" card grid lower on the page or collapse it — decide based on redundancy (Trevor may want both: quick switch up top, detailed cards below).

**Revert.** `git revert` the commit; delete the new component. Pure UI, no RPC/data change (reuses `subedition_siblings` already in the market bundle).

**Verify.** tsc clean; Vercel READY. Smoke: a play with parallels (e.g. a Traoré `233:8121` family or any `::`-bearing edition) shows pills up top, current one highlighted, clicking navigates to the sibling printing; a single-printing edition shows no switcher; non-TS collection edition shows no switcher (no error).

---

## Guardrails (non-negotiable)

- **Commit and push directly to `main`.** No feature branches, no PRs (CLAUDE.md, emphatic). If the harness pre-checks out a `claude/*` branch, switch to `main` first.
- **Windows / Git Bash:** use PowerShell `Invoke-WebRequest` for any Vercel REST call (`curl` fails silently in Git Bash). CRLF line endings silently break Node string-replace patches — prefer the Edit tool / line-number targeting, normalize CRLF→LF before matching. Full-file writes over fragile heredocs.
- **Vercel Pro `maxDuration` hard cap is 800s** — anything higher sends the deploy to ERROR *invisibly* (build log looks clean). These features add no long routes, but don't touch any route's `maxDuration` upward past 800.
- **DB changes go through the `rpc-migration` skill's checklist** — `apply_migration` for DDL, `CREATE OR REPLACE` preserving SECDEF/search_path/grants, and confirm `check_public_security_invariants()` returns `[]` + `check_secdef_anon_execute_violations()` returns `[]` after. New read RPCs should be service_role/anon per the existing `get_edition_*` pattern (these pages are anon-public per `proxy.ts`).
- **Respect the hero fan-out budget** — the edition page deliberately bundled its hero reads into `get_edition_market_bundle` (one pooled connection). Add Feature 1's listing count *into* that bundle; don't bolt on a fresh top-level `await`.
- **Verify before trusting this doc.** Line numbers and RPC output shapes will have drifted. Grep/read the actual files; if a premise here is wrong (e.g. `ts_listings` turns out dead, or `edition_offers` is serial-scoped not edition-scoped), correct course and note it in the commit — the repo wins every disagreement with this handoff.

---

## End state (definition of done)

Three additive, revertible changes on `app/(collections)/[collection]/edition/[slug]/page.tsx` (and optionally its sibling `app/moment/[id]/page.tsx`):

1. A **"% Listed"** StatCell in the pricing strip, fed by an `active_listings` count added to the existing market-bundle RPC, per-printing-honest, and **gated to render em-dash (not "0%") when the collection's listings source is stale/absent** (especially the Flowty-fed `ts_listings`).
2. An **"Activity"** section/toggle unioning `get_edition_recent_sales` (Sale) + `edition_offers` (Offer) via a new `get_edition_activity` RPC — Event · Serial · Price · Buyer · Seller · Date, ≤50 rows, `#0` suppressed.
3. A **parallel tier pill switcher** at the top of the hero, reusing the already-fetched `subedition_siblings` (linked by base `setID:playID`), prefetched-Link based, current printing highlighted — no new data path.

Each: `tsc` clean, Vercel READY, smoke-tested, `check_public_security_invariants()` = `[]` for any RPC touched, and an in-commit revert path. No collision with the FMV/mis-attribution/dedup work in the ledger. Log what shipped (and any corrected premises) to `docs/overnight/ledger.md`.
