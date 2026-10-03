<!-- Extracted from CLAUDE.md on 2026-08-17 to bring that file under the memory-file
char limit. Content is VERBATIM; CLAUDE.md carries a one-line pointer to this file.
Same rules apply: every number here is a dated sample - re-measure before quoting. -->

## Architecture notes

- FMV recalc v1.5.0 live (WAP + days_since_sale + sales_count_30d).
- TopShot sets catalog: the GQL editions-catalog creates `sets` rows keyed by the TopShot UUID (`external_id`) but does NOT populate `set_id_onchain`. `ensure_topshot_edition_stub` self-heals this on the set-lookup miss path — it bridges UUID→`set_id_onchain` via a sibling edition and backfills the `sets` row (migration `audit_20260523_ensure_topshot_edition_stub_self_heal`). New TopShot sets resolve with no manual seeding.
- Pack EV pipeline v11: queue-poisoning bug fixed — `topshot_pack_ev_targets` view filters zero-priced reward distributions; sentinel rows write to `pack_ev_history` on `pool_empty` with non-NULL `pack_ev` (0 works; view has `BETWEEN -10000 AND 1000000` filter). 0% pipeline failure rate across 23 active pipelines.
- WMC backfill (May 7): TS 99.8% tier / 100% set / 89.6% mint via `UPDATE FROM editions JOIN`. 18 RPCs read `wmc.tier` directly — backfill approach preferred over per-RPC patches. **AllDay mint counts are NOT a coverage gap (corrected 2026-06-05): `editions.circulation_count` is populated for 6190/6191 AllDay editions; the old "AllDay has no circulation" note was stale — it was just a missed wmc denorm. Backfilled `wmc.mint_count` platform-wide (AllDay now 324,510/324,590) and folded `mint_count = COALESCE(wmc.mint_count, e.circulation_count)` into `backfill_wmc_metadata_from_editions` (migration `audit_20260605_backfill_wmc_metadata_add_mint_count`) so the warm/refresh path keeps it current.**
- WMC image denorm (2026-06-05): `wmc.image_url` was never populated — `/share` + `get_wallet_collection_snapshot` rendered placeholder tiles. New SECDEF fn `populate_wmc_image(collection_id, force, limit)` denormalizes `editions.thumbnail_url` (TS/AllDay/Golazos/UFC) + `pinnacle_editions.thumbnail_url WHERE LIKE 'http%'` (Pinnacle), http-only, NULL-only by default. Wired into the `wmc-fmv-populate` cron loop (50k/collection/tick) backed by partial index `idx_wmc_image_url_null`. Pinnacle images are mostly a dead-end (no per-edition on-chain art — see [docs/handoff-2026-06-04-pinnacle-image-catalog-backfill.md]); the fn fills only the ~82 legacy-http Pinnacle thumbnails.
- Flowty analytics (May 6/7): `/admin/flowty-analytics` with `RPC_ADMIN_TOKEN`. 3 materialized views (`mv_flowty_sales/loans_daily`, `mv_flowty_first_activations`) + 5 RPCs (`flowty_top_{buyers, sellers, net_marketplace, lenders, borrowers}`). `refresh_flowty_analytics()` ~1s. UFC/Golazos at 0 in MV until spork. Pinnacle uses `pinnacle_sales` separately.
- GitHub Actions cron every 20min calling `/api/ingest` with `INGEST_SECRET_TOKEN` sourced from repo secrets.
- Watchlist + FMV Alerts: tables and API routes were applied during earlier sessions; the current concierge tool set does not include watchlist/alert tools, so the user-facing path is partially decommissioned. Verify table/route status before reactivating.
- Collection sharing: `/api/collection-snapshot` + `/share/[wallet]` with OG image generation.
- Unique index on `transaction_hash` in `sales_2026` (prevents duplicate wallet-seed rows).
- Flowty relationship: CEO Mike Levy, CTO Austin Kline — aware of and supportive of RPC.

---

## Beta users (current)

- jamesdillonbond — `0xbd94cade097e50ac` (Trevor)
- RipPacksCity — `0xb5053ef95e702657`
- samwise222 — `0xa3d67b29e104e701`
- Mike Levy — `0x11859edcf2f53edd`

Watch wallets at `priority=3` in `seeded_wallets`:
- roham — `0x01d7e57aa5598e47`
- rybaguy — `0xbe9c633840e40df3`

---



---

## Preserved from the 2026-08-17 CLAUDE.md restructure

> These lines were condensed or dropped in CLAUDE.md when it was cut to fit the memory-file
> char limit. They are kept here verbatim so nothing is lost.

### Code patterns dropped from CLAUDE.md

- ⚠ **Module-level per-request state on a route is a defect the moment a SECOND caller exists (2026-09-13).** Vercel's Node runtime serves concurrent requests on one warm instance, so a `let` at module scope that a handler sets at its start and clears at its end is SHARED between overlapping invocations: the later start overwrites the earlier, the earlier end clears it under the later. The sentinel's wall-budget clock shipped that way on the premise "invocations never overlap" and the redundant cron-job.org caller overlapped the delayed GitHub tick by 50.8 s the same afternoon. Scope such state to the invocation with `AsyncLocalStorage` (`lib/sentinel/clock-store.ts` is the pattern: `withX(value, fn)` + `currentX()`, nothing to clear) and test it by running two invocations INTO each other, not one after the other.
- Branch fragmentation is a recurring issue — consolidate with cherry-pick onto one canonical branch before merging.
- `project_knowledge_search` is NOT authoritative against live repo — Claude Code's direct file inspection wins every disagreement; prompts should allow Claude Code to correct false premises.

## Displaced from CLAUDE.md 2026-09-26 (verbatim) — Next.js conventions

Moved to pay for the Disney Pinnacle grain rule in CLAUDE.md; CLAUDE.md keeps a one-line pointer here.

- `proxy.ts` is the correct Next.js 16 convention (renamed from middleware.ts). Supabase client typed `any` in API routes.
- `generateMetadata` cannot be exported from a client component — it belongs in the server `layout.tsx`. ⚠ `openGraph`/`twitter` merge SHALLOWLY: claude-md-condensed-originals.md.
- `useSearchParams` requires a Suspense wrapper.

## ⛔ A SERVER component cannot pass a FUNCTION prop to a CLIENT component — and only a real render says so (2026-09-29, PT)

`InsightsWalletSearch` and `AccountValueSearch` are server components; the first draft of `OwnWalletLink` (a client component) took `href={(w) => …}`. That fails at render with "Functions cannot be passed directly to Client Components", which **`tsc`, vitest (jsdom renders both halves as plain React) and lint all miss** — same class as CLAUDE.md's "a green suite is not a deploy gate for segment semantics". Caught by reading the call site, not by a tool. The fix is a serializable prop: `to: "share" | "tc-report"` plus an `ownWalletHref()` helper inside the client file. Verified on the deployed build: the RSC payload carries `{"to":"tc-report","label":"Run your own report"}`. **Rule: a prop crossing server→client must be data (string/number/plain object), never a callback; build the href on the client side.**

## ⛔ A "use client" module must never reach `lib/supabase.ts`, however many hops away (2026-09-28, PT)

`lib/trophy/slab-href.ts` imported `paniniEditionUrl` from `lib/panini/edition-market.ts`, which imports `lib/supabase` — and `lib/supabase` creates the SERVICE-ROLE client at module load. `TrophySlab` is a client component, so in the browser the key was undefined, the module threw `supabaseKey is required.`, and `/dashboard` (every signed-in visit to `/`) rendered the global error page for ~20 min (7:35 → 7:57 PM PT) until another session moved the pure helper to `lib/panini/edition-url.ts`. `PaniniSniper` already had the same chain — the pattern was copied from a file that "worked" only because nothing had exercised it. `tsc`, vitest and lint were all green; jsdom mocks `@/lib/supabase`. **Guard:** `__tests__/client-modules-never-reach-lib-supabase.test.ts` walks every `"use client"` module's import graph and bans any path to `lib/supabase.ts`. **Rule: a pure helper a client needs lives in a module that imports nothing server-side; never import a URL builder from a data-fetching module.**

## ⚠ A page-level gate is unreachable when the segment's `layout.tsx` answers first (2026-10-03, PT)

The fossil-308 ship put `lookupTopShotFossilRedirect` + `permanentRedirect` in BOTH gates of `app/(collections)/[collection]/edition/[slug]/page.tsx` (generateMetadata and the body), pinned both by test, deployed READY — and the live URL still 404'd. The sibling `layout.tsx` is the existence gate (`if (collection === "nba-top-shot" && slug.includes("-")) notFound()`) and runs BEFORE the page; it exists so the 404 is a real status, not a soft one. The lookup now lives in the layout gate too (`dd057f708`), with a third source pin. **Before editing a `notFound()` / `redirect()` in a `page.tsx`, grep the segment's layout and every ancestor layout for the same gate — a test pinning the page is silent about the layout by construction.** Verify by a LIVE request after the deploy is READY, with a cache-busting query (`?v=2`): the first request can still serve the pre-fix cached status (`x-vercel-cache: HIT` with a large `age` is the tell). Footnote: a hand-rolled `Promise.race` bound is bounded but invisible to `check-unbounded-server-reads` — use `withBoardBudget` (`lib/insights/board-page-fetch`), which the guard recognises and which clears its timer on a fast read.
