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
  - ⚠ **Instance 2026-10-14 — a child's `openGraph` without `images` DELETES the parent's image.** `lib/seo.ts` `pageMetadata` (every collection tab, all seven `/overview` pages at sitemap priority 0.9) set `openGraph`/`twitter` with no `images`, replacing the collection layout's objects that carried the card: zero `og:image` / `twitter:image` on those pages, found only by a live audit. Same on `/about`. Any metadata that sets `openGraph` must set `images` itself; pinned by `__tests__/seo-site-description-names-every-published-collection.test.ts` (every published tab has both).
- `useSearchParams` requires a Suspense wrapper.

## ⛔ A SERVER component cannot pass a FUNCTION prop to a CLIENT component — and only a real render says so (2026-09-29, PT)

`InsightsWalletSearch` and `AccountValueSearch` are server components; the first draft of `OwnWalletLink` (a client component) took `href={(w) => …}`. That fails at render with "Functions cannot be passed directly to Client Components", which **`tsc`, vitest (jsdom renders both halves as plain React) and lint all miss** — same class as CLAUDE.md's "a green suite is not a deploy gate for segment semantics". Caught by reading the call site, not by a tool. The fix is a serializable prop: `to: "share" | "tc-report"` plus an `ownWalletHref()` helper inside the client file. Verified on the deployed build: the RSC payload carries `{"to":"tc-report","label":"Run your own report"}`. **Rule: a prop crossing server→client must be data (string/number/plain object), never a callback; build the href on the client side.**

## ⛔ A "use client" module must never reach `lib/supabase.ts`, however many hops away (2026-09-28, PT)

`lib/trophy/slab-href.ts` imported `paniniEditionUrl` from `lib/panini/edition-market.ts`, which imports `lib/supabase` — and `lib/supabase` creates the SERVICE-ROLE client at module load. `TrophySlab` is a client component, so in the browser the key was undefined, the module threw `supabaseKey is required.`, and `/dashboard` (every signed-in visit to `/`) rendered the global error page for ~20 min (7:35 → 7:57 PM PT) until another session moved the pure helper to `lib/panini/edition-url.ts`. `PaniniSniper` already had the same chain — the pattern was copied from a file that "worked" only because nothing had exercised it. `tsc`, vitest and lint were all green; jsdom mocks `@/lib/supabase`. **Guard:** `__tests__/client-modules-never-reach-lib-supabase.test.ts` walks every `"use client"` module's import graph and bans any path to `lib/supabase.ts`. **Rule: a pure helper a client needs lives in a module that imports nothing server-side; never import a URL builder from a data-fetching module.**

## ⚠ A page-level gate is unreachable when the segment's `layout.tsx` answers first (2026-10-03, PT)

The fossil-308 ship put `lookupTopShotFossilRedirect` + `permanentRedirect` in BOTH gates of `app/(collections)/[collection]/edition/[slug]/page.tsx` (generateMetadata and the body), pinned both by test, deployed READY — and the live URL still 404'd. The sibling `layout.tsx` is the existence gate (`if (collection === "nba-top-shot" && slug.includes("-")) notFound()`) and runs BEFORE the page; it exists so the 404 is a real status, not a soft one. The lookup now lives in the layout gate too (`dd057f708`), with a third source pin. **Before editing a `notFound()` / `redirect()` in a `page.tsx`, grep the segment's layout and every ancestor layout for the same gate — a test pinning the page is silent about the layout by construction.** Verify by a LIVE request after the deploy is READY, with a cache-busting query (`?v=2`): the first request can still serve the pre-fix cached status (`x-vercel-cache: HIT` with a large `age` is the tell). Footnote: a hand-rolled `Promise.race` bound is bounded but invisible to `check-unbounded-server-reads` — use `withBoardBudget` (`lib/insights/board-page-fetch`), which the guard recognises and which clears its timer on a fast read.

## ⛔ An inline `<style>` reset must sit in `@layer base` — unlayered, it silently kills every Tailwind spacing utility beneath it (2026-10-03 PM, PT)

Eight client files (`app/(collections)/layout.tsx`, `DashboardClient`, `LoginClient`, `ProfileClient`, `ProfileEditClient`, both admin clients, `HomePageMarketing`) injected `*{box-sizing:border-box;margin:0;padding:0;}` through a `<style>` element with no `@layer`. In the cascade an unlayered rule outranks EVERY layered rule regardless of specificity, so under those layouts every Tailwind `p-*` / `px-*` / `m-*` / `mt-*` … computed to **0** for as long as the files existed — the pack table's `p-3` cells, the collection-analytics cards, the packs filter bar, the header nav's `md:px-1.5` fix of the same morning. `w-4` and `gap-4` worked (preflight resets no width/gap), which is why it never read as "Tailwind is broken". `/analytics` has no such reset and was fine.

How it was established, so the next person does not re-derive it: in Chrome, a fresh `<div class="p-4">` → `padding 0px`; a brand-new `@layer zz{.x{padding:5px}}` → 0; an unlayered `.x{padding:9px}` → 9 px. The served CSS was correct — `curl` + grep of the chunk says "shipped" and is the wrong instrument for a cascade defect. **Preview a cascade fix on production DOM before pushing:** `deleteRule` the offending `*` rule from `document.styleSheets`, `insertRule('@layer base{'+cssText+'}')`, diff every spaced element's `getBoundingClientRect()` and `document.documentElement.scrollHeight` (the packs page went 25.6k → 56.8k px — that is how the PackTable name-cell follow-up was found before the push, not after).

Fix `8b18dccc6`: the reset wrapped in `@layer base{…}` (Tailwind preflight already keeps the same declarations in that layer). Guard: `__tests__/no-unlayered-universal-reset.test.ts` walks `app/` + `components/`. Consequence: any "verified live" layout fix under those layouts that leaned on a Tailwind spacing class was verified against a page where the class did nothing — re-measure before trusting it.

### Function region = database region (2026-10-14)
⚠ **Vercel functions must run in the database's region.** Supabase is AWS `us-west-2`; Vercel's `pdx1` is the same region. Until 10-14 `vercel.json` named none, so everything ran in `iad1` and ~99 % of a trivial read was the cross-country hop (0.14 ms in the DB vs ~118 ms at the function). `__tests__/functions-run-in-the-database-region.test.ts` pins the pair and bans a per-route `preferredRegion`; **if the DB ever moves, move both constants together.** ⓘ The runtime-log `region=` field is the request's EDGE PoP; the execution region is the second segment of `x-vercel-id` (`pdx1::pdx1::…`).

## ⛔ A popup trigger inside a `<label>` re-opens itself on every pick — and jsdom cannot see it (2026-10-21, PT)

A browser forwards a click on any non-interactive descendant of a `<label>` to the label's first labelable control. Wrap a button-triggered list in a label and clicking an option row fires a SECOND click on the trigger, so the list closes and re-opens. Live on the Sniper Team filter 10-21 ~8:53–11:28 AM PT; confirmed in Chromium, invisible to every vitest click test because jsdom does not implement the forwarding. Use a `<div>` for the visual label. Full case + six sibling traps (phone `innerWidth`, transforms and overflow, accessible names, accent-sensitive search): [filter-controls.md](filter-controls.md).

## ⛔ A server component that imports a VALUE from a `"use client"` module gets a stub, not the value (2026-10-25, PT)

Across the RSC boundary every export of a `"use client"` module becomes a client reference. A component that is a client reference is fine. A string, number or object becomes a function that throws when called, and in a template literal it stringifies to its source. `SkipToContent.tsx` (server, root layout) read `PAGE_CONTENT_ANCHOR_ATTR` from `SkipToContentLink.tsx` (client). Every page then shipped `[function(){throw Error("Attempted to call PAGE_CONTENT_ANCHOR_ATTR() from the server…")}]:focus` in its CSS, and the anchor's attribute carried that name, so the 10-24 skip-link fix found no anchor. **tsc, vitest, lint and the build were all green:** vitest renders both halves in one process, where the import is a plain string. Only the served HTML shows it. **Rule:** put a constant shared by both halves in a plain module. Guard: `__tests__/server-never-reads-a-value-from-a-client-module.test.ts` (tree walk over app/components/lib, ban at zero).

🔁 **RECURRED 2026-10-26 as a FUNCTION the server CALLS.** `app/special-serial-owners/page.tsx` called `boardSeed()` exported from `SpecialSerialOwnersClient.tsx`; the call hit the stub and the page 500'd for signed-in visitors for ~50 min (fixed in `e37989a`, helper moved to `board-seed.ts`). The guard exempted every function initializer, so it was silent; `tsc`, vitest, lint and local preflight were green — only CI's `build-render` and the live page saw it. The guard now also bans a server import of any camelCase function (hooks included) from a `"use client"` file — PascalCase components stay allowed (54 client files export such a function; 0 server imports).

## ⛔ A query-param toggle cannot change what a crawler or a link unfurler sees — one collection, one URL (2026-10-27, PT)

`/insights/squeeze?collection=nfl-all-day` switched the board to NFL All Day in the browser, but metadata comes from the route's `layout.tsx` (a layout never sees `searchParams`), and the server seed was Top Shot's. So the All Day "Share on Twitter" link previewed **Top Shot's** title and top three, and no crawler ever saw an All Day row. Making `generateMetadata` read `searchParams` would make the page dynamic (no ISR, a DB read per request). The fix was a page per collection: `/insights/allday-squeeze` and `/insights/allday-set-squeeze`, each with its own metadata, canonical, OG path and server-rendered rows, with the shared client taking `initialCollection`. **Rule:** when a board gains a second collection, give that collection its own URL before anything links to the toggle. Links go through `squeezeBoardPath()` / `setSqueezeBoardPath()` (`lib/insights/squeeze-collections.ts`), and `__tests__/squeeze-links-use-each-collections-own-board.test.ts` bans building the toggle URL. ⚠ That guard's first regex missed a nested template literal (`${cond ? "" : \`collection=${c}&\`}`); prove a source-scanning guard against every real shape it bans, not just a planted literal.
