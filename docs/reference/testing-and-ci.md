<!-- Extracted from CLAUDE.md on 2026-08-17 to bring that file under the memory-file
char limit. Content is VERBATIM; CLAUDE.md carries a one-line pointer to this file.
Same rules apply: every number here is a dated sample - re-measure before quoting. -->

## Testing & CI coverage (added 2026-07-12)

The repo has a real automated test suite. Run it before shipping non-trivial code changes.

- **Runner:** [vitest](../../vitest.config.ts) (`npm test` = `vitest run`; `npm run test:watch`; `npm run test:coverage`). Setup file `vitest.setup.ts`; `@` alias resolves to repo root.
- **Two measured layers (coverage `include`: `lib/**/*.{ts,tsx}` + `app/**/route.{ts,tsx}` + `proxy.ts`):**
  - **Route handlers** — every `app/api/**/route.ts` is imported and its auth/param guards are exercised; a large subset also drive the 2xx success/accept path by stubbing the `after()` / Supabase seam. Since 2026-07-16/17, flagship route BODIES are also driven end-to-end via the integration harness (below) — sniper-feed 48%, pack-ev 69%, support-chat 22.6% — but the deepest inline surfaces (Flow REST/Cadence scans, SSE streams) still can't be cleanly driven, so a modest line % on the remaining routes is expected.
  - **Pure `lib/**` logic** — unit tests for decode/FMV/pack-EV/market-adapter/logger modules.
- ⚠ **THE STRUCTURAL BLIND SPOT: `app/**/page.tsx` is measured by NEITHER gate — both families are held by RATCHETS rather than tests (2026-08-13).**
  ⚠ **RE-MEASURED 2026-08-17: 119 `page.tsx` = 113 server (17,590 lines) + 6 client (2,906).** This bullet said **~75k LOC** and the two sub-bullets below said **48,325** and **27,016** — those are LANDING-DAY figures for a workstream that then ran to completion, and they overstate the live surface by roughly 3.5×. **A session planning against them would size the work against a population that no longer exists.** ⚠ And the client count moved **4 → 6 inside two hours** on 2026-08-17 while sessions converted pages concurrently, so even a fresh count here is a dated sample: re-derive, and read the ratchets' `const BUDGET` for the authoritative live number. The primary gate's include stops at `route.{ts,tsx}`; the component gate's include is `components/<subtree>/**` + `app/**/*Client.tsx`. A `page.tsx` matches nothing in either, however much logic it holds. **Breadth is not the gap** — 452/452 API routes and 250/254 `lib/` files are referenced by a test; this is.
  - **Server pages doing their own DB access** (⚠ the figures that stood here — 48,325 LOC, 79 querying Supabase — are superseded; see the re-measurement above, and take the live count from `server-page-data-access-ratchet`'s `BUDGET`, whose predicate is direct data access rather than a mere import).** The repo's prior answer was `server-pages-error-vs-absent-guard.test.ts`: hand-written source assertions covering **2** of them. Now also held by **`__tests__/server-page-data-access-ratchet.test.ts`**, freezing the count at **8** (down from 37). ⚠ **A ratchet, not a ban, deliberately**: a ban would have shipped a 35-entry allowlist, i.e. theatre. The ratchet forces a NEW page's data access through `lib/`, where the primary gate watches it. The remedy for an existing one is **extraction** (`lib/trophy-case/pdf-image.ts` → `lib/pack-dist/fetchers.ts` → `lib/moment-detail/fetchers.ts` → `lib/entity/edition-market-fetchers.ts`), and extraction is what surfaces the defects: every fetcher returns `{ data, ok }` so the caller cannot render a failed read as a fact. ⚠ **Pick candidates by CALL SITES, not by LOC**, and do the ARG-ONLY ones first. The edition page is 1,131 lines but only **two** fetchers still held a client; the eight `/insights` board pages held **none** — they imported `supabaseAdmin` purely to hand it to a fetcher that already lived in `lib/`, wrapped in eight byte-identical try/catch copies, so injecting the client inside one shared helper (`lib/insights/board-page-fetch.ts`) removed the import, the duplication and eight ratchet entries at once. **A page whose only Supabase reference is an ARGUMENT is a five-minute conversion; one holding its own `.from().select()` is a real one.** ⚠ Grep carefully — a naive `\.rpc\(` misses `(supabaseAdmin.rpc as any)(`, which mis-sorted two analytics pages into the cheap bucket. **That tier is now exhausted: all remaining pages hold real queries.** ⚠ **Also check for a DEAD import** — `app/(analytics)/analytics/page.tsx` occupied a ratchet slot for an import it never used (`tsc` is clean on an unused import, so nothing caught it); the ratchet detects an IMPORT, not data access, so a dead one overstates the work left. The ratchet now asserts against that. ⚠ **And when a page duplicates its API route's query** (the `/insights/*` board pages all say they read the view "exactly as the API route does" — a claim nothing enforced), extract ONE fetcher used by both: it removes the drift AND the ratchet entry. Share the QUERY, not the policy — the page and route legitimately differ on defaults, and returning supabase's `{ data, error }` untouched lets each keep its own failure handling (`boardUnavailable` vs the degraded notice). ⚠ **And `ok` is worth returning even when the page does not consume it** — the edition page's render sites all gate on `!= null` / `length >= 2`, so a failed read already degrades to an em-dash or a hidden section rather than a fabricated `0`; that safety is a property of the CURRENT call sites, not of the data, so the first consumer wanting to render a figure unconditionally must not have to re-derive the distinction.
  - **`"use client"` `page.tsx` outside `/insights`** (⚠ superseded: **27,016 LOC / 33 files** was the landing-day figure; live 2026-08-17 is **6 files / 2,906 lines** across the whole app) (`dashboard` 2,299 · `[collection]/sniper` 1,748 · `[collection]/analytics` 1,706). Held by **`__tests__/client-page-gate-ratchet.test.ts`**, at **1** as of 2026-08-17 04:48Z — and ⚠ **that 1 is the FLOOR, not "one conversion left". The workstream is DONE.** The single remaining page is `app/rewards/page.tsx`, a hard 404 (`app/rewards/layout.tsx` calls `notFound()` unconditionally), so converting it would add ~1,244 lines of denominator to the component gate measuring code no user can run — a smaller number here bought by making the gate less meaningful. It stays on the ratchet as honest debt rather than being excluded, because the day rewards ships is the day it becomes real work again. **Do not open a session to "finish" this.** (33 at landing.) ⚠ **THIS SENTENCE SAID 9 FOR THE THREE COMMITS AFTER THE VALUE BECAME 6, AND THE MECHANISM IS THIS FILE'S OWN RECURRING ONE: the correction landed in a dated session entry and not in the canonical bullet.** Commit `17f04231` re-derived all three ratchets to **6 / 8 / 39** from the failing no-slack assertion (live is **5 / 7 / 39** as of 03:05Z — it moved again mid-pass) and edited only the session-entry sentence, so a reader following the canonical text got the superseded 9 / 12 / 38 — *including the reader who correctly distrusted the prose and came here for the authoritative number*. ⚠ **Read the number off `const BUDGET`, not off this sentence** — and understand HOW fast it moves before quoting it: this line said **30** at 16:15Z and the live value was **9** five hours later, because **twelve commits between 07:58 and 16:49 PT lowered it 32 → 30 → 29 → 28 → 25 → 24 → 21 → 19 → 17 → 15 → 13 → 11 → 10 → 9**, every step a real conversion or honesty fix. **A ratchet is the fastest-moving canonical number in this file** — it is a countdown someone is actively working, so any prose figure is stale within hours, and a session that plans work off "~30 remaining" will plan against a population that no longer exists. ⚠ Found only by asking what a PASSING guard could not see: `insights-gate-include-completeness` requires client pages to be named `*Client.tsx` so the component gate catches them — and it **walks `INSIGHTS_DIR`**, so it is silent about client pages anywhere else by construction, however often it runs green. Until a file is split, its honesty properties are pinned by source guards (`collection-analytics-failed-vs-empty-guard`, `client-pages-failed-vs-empty-guard`) that **strip comments before matching** — see the OG-layer note under "Key files" for why. ⚠ **Those guards cover HAND-PICKED sites (3 as of 2026-08-15), against ~175 fetch/`catch` sites across 39 client pages — an allowlist for a class two orders of magnitude bigger, and NOT ONE client page uses `fetchJson`, the helper that layer exists for.** So the way to find the next one is to **sweep the empty-state COPY, not the fetch code**: `/alerts` was found that way and was the sharpest instance after the dashboard hero-picker, because every claim on it is about the reader's OWN account — "No alerts yet. Create one above." invited a **duplicate** of an alert they already had, and the channel list told a collector whose Telegram IS linked that it was not. ⚠ Track failure **per leg** when a page fans out (`/alerts` runs three endpoints under one `Promise.all`): one flag blanks all three sections whenever any one breaks, and a thrown fetch must fail **all** legs, since no leg's state can be trusted after it.
    ⚠ **THE CONVERSION WORKSTREAM IS OPEN AS OF 2026-08-16, AND ITS COST IS MEASURED — read this before starting one.** The remedy is the `*Client.tsx` split, because `app/**/*Client.tsx` IS in the component gate's include. ⚠ **The cheapest shape is EXHAUSTED**: `[collection]/packs` was a client page for ONE reason — a `useParams()` call for a value a server page receives as a prop, with everything below it already gated, so no `*Client.tsx` was needed at all — and a sweep found **no others** whose only client-side API is a routing hook. Every remaining page holds real state, effects or handlers. ⚠ **Hoisting the Suspense boundary that `useSearchParams` requires UP to the server page is what makes the split testable**; leaving it inside moves the file into the gate without making it renderable by a test, which is measurement with no assertions. ⚠ **THE NUMBER THAT DECIDES AFFORDABILITY: a conversion moves `% Funcs` DOWN.** Landing `NotificationsClient` at 100/85.9/100/100 took the component gate 90.72/82.09/89.55/93.68 → 90.78/82.34/**89.42**/93.74 — statements, branches and lines UP, **functions down 0.13 against a 89.1 threshold with ~0.3pt of room**. A page is many small handlers, so a partly-tested conversion hits functions hardest (a first pass at 77.8 funcs narrowed the margin to 0.15). **Cover the handlers, not just the fetch paths.**
    ⚠ **AND A RATCHET IS THE ONE CONSTANT WHERE BOTH "take mine" AND "take theirs" ARE SILENTLY WRONG (learned on a real collision, 2026-08-16).** Two sessions ran this workstream at once and each lowered the same budget by *its own* conversions only — 32 and 31. Neither was right: 33 minus THREE conversions is **30**. The value is a COUNT of a shared population, not an opinion, so **re-derive it from the failing no-slack assertion rather than picking a side**. (The other session's conversion had also landed with no note saying which page it converted; a ratchet whose history has a gap cannot be audited, so record the page.)
    ⚠ **That allowlist is now FROZEN by `__tests__/client-page-fetch-honesty-ratchet.test.ts`, at 4 as of 2026-08-17 04:48Z** (35 when first measured 2026-08-15, 33 at 16:15Z the next day — it fell 31 → 8 across a twelve-commit afternoon, so the same do-not-quote-the-prose rule applies; this sentence has already carried a superseded **12** and a superseded **7**, see the sibling bullet). It began as **35 `"use client"` `page.tsx` files calling `fetch(` directly across 149 call sites and 168 catch sites, with ZERO importing `fetchJson`.** A ratchet, not a ban, because the largest were 1,300–2,500 lines and several are edited by concurrent sessions; a ban would have shipped a 35-entry allowlist. ⚠ **THE REMAINING 4 ARE NOT PENDING CONVERSIONS, AND READING THEM AS A WORK QUEUE IS THE MISTAKE THIS BULLET NOW EXISTS TO PREVENT.** They are `app/rewards/page.tsx` (the hard 404 above) plus `app/insights/{pack-reality,squeeze-check,tc-report}/page.tsx` — and those three are **explicitly named in `vitest.components.config.ts`'s `include` (lines ~95-97) with their own suites**, so they are already MEASURED; they simply do not use the `fetchJson` helper. Adopting it there is a **fetch-layer refactor on PUBLIC boards**, not a `*Client.tsx` conversion, and `pack-reality` is the very page whose honesty defect was fixed 2026-08-15 — so it is a deliberate, separately-scoped decision, not leftover work. **Passing means the blind spot did not GROW.** It carries a guards-the-guard case: renaming `fetchJson` would make every page trivially satisfy "does not import fetchJson", so the ratchet would keep passing while pointing at nothing. **53 client COMPONENTS also fetch without the helper.** ⚠ **This used to read "deliberately NOT gated — the component gate measures them, so they are not a blind spot in the same way", and that reasoning was CORRECTED 2026-08-16: it is about COVERAGE and does not carry over to HONESTY.** `TrophyPickerModal` lives in `components/profile/**`, is fully measured, had **three** existing test files — and still rendered "No owned moments found yet" to a collector with thousands, out of a failed read. **Coverage asks whether a line RAN, never whether the sentence it printed was TRUE.** Components are now in scope of `__tests__/client-failure-collapses-to-empty-ratchet.test.ts` (below).
    ⚠ **THE COPY SWEEP WAS RUN AGAIN 2026-08-15 AND FOUND TWO MORE, so treat it as the standing method rather than a one-off.** `/insights/pack-reality` is a PUBLIC board whose `error` state was consulted by **exactly ONE of five claim sites**, so a 503 rendered "Failed to load: HTTP 503" in the pull-value section while **"No +EV packs right now."**, **"No qualifying packs yet."** and a hard **"0 positive-EV TS packs"** rendered below it — the page contradicting itself, on the panel a collector uses to decide whether to buy a pack. **Being in the component gate did not help**: pack-reality is measured there and still shipped this, because coverage asks whether a line ran, not whether the sentence it printed was true. ⚠ **The scope rule is the one this file keeps restating — the fix is per PANEL, not per page.** A page with an honest error branch somewhere is not an honest page; every panel consuming the same failed read needs its own branch, and a sub-component that renders a market claim on an empty list needs the distinction passed IN (a **required** prop, so a later caller cannot silently reopen it by forgetting it).
    ⚠ **AND THE TEST FOR IT ALREADY DESCRIBED THE CONTRACT WITHOUT ENFORCING IT — a distinct failure from the "tests that assert the defect" class, and harder to spot.** The existing case was titled and commented *"an outage must not render as 'no positive-EV packs exist right now', which is a claim about the market"* and asserted only `toMatch(/HTTP 500|error|failed/i)` — that a failure was mentioned **somewhere**. That is satisfied by the one honest section while the market claims render directly beneath it, so the test passed for years on a defective page. **Assert the ABSENCE of the false claim, not the PRESENCE of an error message.** Same root as the `f02362c7` panini case (asserted what the function returns, never what the reader sees).
    ⚠ **Always pin BOTH directions.** An empty board and a genuinely-zero count are HONEST answers and must keep reading as such — a fix that blanks every empty state into "unavailable" only moves the dishonesty and cries wolf on the system working, the cost `board-status.ts` already documents.
    **Verified CLEAN in the same sweep, recorded so nobody re-derives them:** `[collection]/market` (a proper `loading : error : empty` ladder, so the error branch precedes the empty one — this is the shape to copy) and `[collection]/sets` (already distinguishes "Moment-level detail isn't available for this set yet" from "No moments owned in this set yet" via `ownedCount`). `allday-pack-reality` does **not** carry pack-reality's copy, so that defect did not spread by copy-paste the way the 15 OG cards and 5 sales indexers did. Still unswept: the `panini-blockchain` sniper page and the long tail of the ~175 catch sites.
  - **The IDIOM behind all of them, frozen at 39 sites across `app/**` + `components/**`** (39 on landing, briefly 38) (`__tests__/client-failure-collapses-to-empty-ratchet.test.ts`, 2026-08-16): a client read funnelling a FAILURE into the value a successful-but-empty read produces — `.then(r => r.ok ? r.json() : null)`, `res.json().catch(() => null)`, `if (!res.ok) setRows([])`. ⚠ **A ratchet, not a ban, because most of the remaining sites are NOT defects** — a read degrading to an omitted section understates, the safe direction; banning would force a rewrite of ~40 correct call sites and teach people to edit the guard. **Passing claims only that the idiom did not SPREAD** — whether a surviving site is honest depends on what the empty value RENDERS AS, which no static check can see, so **the copy sweep is still the method**. ⚠ **At landing, raw count 43 against a guarded count of 39 — the gap is COMMENTS**: the guard's header quotes all three patterns and the fixed call sites quote the shape they replaced, so without `stripComments()` it would double-count the very conversions it rewards, and a conversion that documented itself would read as a regression.
  - **Both ratchets carry a not-vacuous check AND a no-slack assertion** (the frozen number must equal the live count, not merely bound it). A ratchet with headroom silently licenses the next N additions — the same compounding failure the component gate paid for with a ~13-point unguarded branch buffer. **Lower the budget in the same commit that converts a page**; never raise it.
- **Route-integration harness + deep-loop fixtures (use these for new route tests):** `__tests__/helpers/route-harness.ts` (`installFetchMock`/`jsonRoute`/`gqlRoute` operationName-matched GQL fixtures/`makeSupabaseFixture` sequence-aware chainable stubs — unmatched fetch throws; the all-empty fixture returns `[]` for every unmocked RPC, often enough to drive a whole GET to a stable 200) and `__tests__/helpers/anthropic-fixture.ts` (`buildAnthropicClass` — replays a scripted sequence of model turns for tool-use loops like support-chat). Usage docs: `docs/audits/test-coverage-integration-harness-2026-07-16.md` + `docs/audits/test-coverage-deep-loop-fixture-layer-2026-07-17.md`. **For an OG card use `__tests__/helpers/og-capture.ts`** (2026-08-13): it stubs `next/og`'s `ImageResponse` and keeps the React element, so `ogText()` / `usesColor()` assert the rendered TREE — the tests then pin **honesty logic, not layout** (the closed-market FMV suppression, the pack card's survivor-bias guard, a withheld figure vs a manufactured `$0`). ⚠ It is COMPLEMENTARY to `api-og-cards-render-sweep`, never a replacement: the stub short-circuits satori, so it cannot see a real render failure — the byte-level sweep is what catches the zero-byte-PNG mode.
- ⚠ **A test whose fixture real data never produces asserts nothing — delete it rather than tune it to green.** An OG "with rows" case was written and dropped for exactly this reason: the 15 cards read 15 different row shapes, one generic fixture satisfied 10, and "passing" would only have meant the invented shape happened to fit. Same trap as the `costBasisLabel: "Pack pull"` case the vocabulary never emits. The replacement asserts the property STRUCTURALLY and **spelling-independently** — the empty copy sits in the first arm of a ternary whose second arm renders the rows — because the obvious check (`a .length === 0 precedes it`) reds the `market` card, whose emptiness test is `heads.every(h => h.median == null)` and is just as correct. Enumerating spellings is the path that eventually excludes a real card to make a build pass.
- **React components** have a separate jsdom harness (`__tests__/*.test.tsx`, **235** `.test.tsx` files; **1,308** test files total under `__tests__/` — re-counted 2026-08-17, up from the ~157/~1,053 this line used to carry). They are measured **separately** — deliberately NOT folded into the route/lib coverage number (400+ presentational files would swamp the signal) — and since 2026-07-26 have their **own blocking CI ratchet** (`component-tests` job / `vitest.components.config.ts`, thresholds **90.3/81.6/89.1/93.2** as of 2026-08-15 (raised from 89.8/81.3/88.6/92.7 by the 0%-coverage component wave — SIX gated components were sitting at **0% STATEMENTS**, never rendered by any test while still counting against this gate: `ProBadge`, `GlobalSiteHeader`, `SiteFooter`, `TeamLogo`, `ExploreSection`, `SniperThumbnailPreview`; actuals moved 90.21/81.74/89.00/93.10 → 90.72/82.09/89.55/93.68. ⚠ **`ProBadge` is the one to remember: it carried an 11-line comment describing the site-wide silent failure it narrowly avoided and NOTHING pinned that fix** — re-keying it onto a null identity passed `tsc` AND the full 11,958-test suite. **A near-miss earning a comment instead of a test is the shape to watch for.** Itself re-seated hours earlier from 88.5/79.4/88.2/91.6 against actuals of 90.21/81.74/89.00/93.10 — the branch buffer had drifted to **2.34pt**, the same direction as the ~13pt incident below, so it was pulled back to a ~0.4–0.5pt margin matching the primary gate's; ⚠ **re-seat in the SAME pass that measures a drift** — "keep the buffer" is exactly how the 13pt version accumulated), raised there by the 08-12/13 component wave, and ⚠ **the reason it was that large is itself the lesson**: actuals had drifted to ~80.9 branch against a 67.0 threshold, a **~13-POINT unguarded buffer**, because several waves raised coverage additively and left the ratchet alone ("keep the concurrent-churn buffer"). That is right once and wrong when repeated — **the ratchet only protects the coverage it is actually set to**. The new numbers keep a deliberate ~1.4pt margin: enough for the concurrent-push churn lesson `47f901a1` records, without leaving 13 points dark. Before that: 79.0/67.0/78.8/83.2 as of 2026-08-09, raised from 78.6/66.4/78.2/82.6 by the 08-09 board-client coverage pass (PackSniper/FirstMint/PackDrops/UnderpricedSerials clients, gate ~78.83→79.91 st / 66.65→67.74 br); the 78.6 baseline had itself been re-baselined DOWN ~0.4 in `17738436` when the wallet-sign-in removal DELETED the well-covered `SignInWithDapper`/`ConnectButton` components along with their suites, mechanically lowering the aggregate (the config comment records the legitimacy: "files left the measured set" is the ONE valid reason to move a ratchet down); just before that the 2026-08-08 test-coverage pass had raised it to 79.0/66.5/78.6/83.0, up from the 20.2/17/19/21.2 it launched at — the 07-28→07-31 component-coverage program climbed the gate ~30→71 st, then the 2026-08-08 pass drove the insights-board + entity/pack/modal/wallet client branches ~64→66.9 br across seven batches), scoped to the logic-bearing component subtrees so the gate is meaningful rather than drowned in presentational files. **The gate's `include` is an ALLOWLIST, guarded against silent rot** by `__tests__/component-gate-include-completeness.test.ts` (2026-07-31): a new `components/<feature>/` subtree holding logic-bearing `.tsx` must be added to the gate's `include` (+ tested) OR to that test's `KNOWN_UNMEASURED` allowlist with a reason, else the blocking `unit-tests` job reds — closing the hole where an untested new subtree contributed zero to the ratchet until a human remembered it.
- **Deno edge functions are excluded** (no Deno toolchain in CI). Their pure logic is extracted into vitest-importable modules under `supabase/functions/_shared` (`cdc.ts`, `hybrid-custody-parse.ts`, `pack-ev-edition.ts` — incl. `computeDualPrice`, `spork-cursor.ts`) and tested there, with lib↔_shared parity + source-drift guards where a routine has a repo copy. When editing an edge fn, put testable logic in `_shared` and import it.
- **WRITING A NEW `*-deep.test.ts`? Type the mock-state `data` field `as any[] | null` from the start.** The single most repeated CI breakage on this repo: a `vi.hoisted` mock state initialised `data: [] as any[]` (TS infers `any[]`) and then an error-path test assigns `{ data: null, error: {...} }` → `TS2322: Type 'null' is not assignable to type 'any[]'`, reddening the **blocking** `typecheck` job for every concurrent session. It happened **four separate times on 2026-07-25 alone** (`72835ebe`, `d872110`, `c2f53227`, and again hours later), each needing a follow-up repair commit. `tsc --noEmit` is NOT run by vitest, so a green local `npm test` does not catch it — run `npx tsc --noEmit` before pushing a new test file. Same for the sibling `TS2741`: give every mock-result object BOTH `data` and `error`.
- ⚠ **A SHARED MUTABLE SUPABASE BUILDER CANNOT MODEL PER-TABLE BEHAVIOUR UNDER `Promise.all` — and it fails by making a correct route look broken (2026-08-15).** The common stub returns one singleton from every call (`from: () => b, select: () => b, …`), which is fine while every query resolves identically. The moment a test needs ONE table to fail, the obvious move — record the table in a `let table` inside `from()` — silently does not work: a route that builds its chains inside a single `Promise.all` (`/api/rewards/summary` builds ~9) calls `from()` nine times **synchronously** before any `then` settles, so every chain resolves as the **LAST** table. The tell is a brand-new test failing against a route you already fixed. **`from()` must return a builder that CLOSES OVER its own table.** Worth the two minutes because per-table failure injection is what proves a `?? 0`-style honesty fix at all — a stub that fails every read lets the assertion pass for the wrong reason.
- **CI ratchet (do not defeat).** `vitest.config.ts` `thresholds` sit just below the live baseline (**91.3 stmts / 78.6 branch / 93.1 funcs / 93.4 lines** as of 2026-08-15 — re-seated by the 08-15 page.tsx-extraction pass; ⚠ **this bullet still read 91.2/78.3/93.0/93.35 a day after the config moved**, because the re-seat was recorded in a dated session entry and not here, which is the same "a fact left only in a session log stops being read" failure this file documents for the trust board. **Read the numbers off `vitest.config.ts`, not off this sentence.** Before that: 91.2/78.3/93.0/93.35 as of 2026-08-13, against live actual 91.50/78.63/93.30/93.65 — raised by the 08-13 "analyze test coverage → do all you can" pass. ⚠ **That raise was ~0.9 on branch, an order of magnitude more than a normal increment, and the reason is the durable part**: the previous numbers had drifted ~0.8–1.0 BELOW actual because several waves added coverage additively and left the gate where it was. Defensible once; wrong when repeated, because **a ratchet only protects the coverage it is actually set to** — this repo has already paid for the compound version, the component gate reaching a ~13-point unguarded branch buffer. Before that: 90.4/77.0/92.2/92.6, raised by the 08-12/13 coverage-and-defect program, which also grew the DENOMINATOR: adding `app/api/**/route.tsx` + `lib/**/*.tsx` to `coverage.include` brought ~1,777 previously-UNMEASURED branches into the gate, moving actuals 91.65→90.83 stmts / 78.76→77.28 branch with nothing regressed and ~90 tests ADDED. **That is measurement expanding, not coverage falling** — the mirror image of the documented "files left the measured set" exception, and the only other legitimate reason a number here moves down. Before that: 89.3/75.1/91.5/91.6 as of 2026-08-08, raised 2026-07-31→08-08 from 87.85/73.35/90.7/90.35, itself up across the 07-25→07-31 continuation passes from 76.3/61.45/82.0/78.9 and from ~45/37/53/47 at the deep-loop program's start; the full comment history in `vitest.config.ts` records every wave's numbers and what it covered), so a coverage **drop** fails CI while normal noise passes. ⚠ **The primary gate now also measures `proxy.ts`** (the site-wide auth + allow-list middleware, added to `coverage.include` 2026-08-08) — it sits at the repo root, so before that NEITHER gate measured the security wall; its `isPublicPath` table + page-rate scope + the async `proxy()` dispatch chain (bypass-token / CORS / rate-limit 429 / unauth redirect / allow-list cookie+RPC+revoke) are all now driven. **Raise these as coverage climbs; NEVER lower them to make a red build pass** — but keep a real ~0.1–0.2 buffer under actuals: on this multi-session repo, concurrent pushes add uncovered code and a zero-margin threshold reds CI on otherwise-green work (lesson `47f901a1`). CI job is `unit-tests` in [.github/workflows/ci.yml](../../.github/workflows/ci.yml), which runs `npm run test:coverage`.
- ⚠ **AN ASSERTION CAN BE VACUOUS IN FIVE DISTINCT WAYS, AND ONLY MUTATION FINDS THEM.** All five were hit in one 2026-08-15 pass, each on a test that read as thorough. **Run the mutation before believing a new assertion**, and when one SURVIVES, decide deliberately between fixing the fixture and documenting the clause as unreachable — do not just move on.
  1. **The mutation currently EQUALS the real value.** `expect(badge).toContain(publishedChainsBadge())` passes with the call replaced by the literal `"BUILT ON FLOW"`, because that is what it returns today; a launch-flag guard passes with the flag check deleted, because the flag is `true`. **Remedy: pair the runtime check with a SOURCE assertion**, which can see the difference.
  2. **Self-referential comparison.** `expect(select).toBe(THE_EXPORTED_COLS)` passes when a column is deleted — the mutation changes BOTH sides. **Remedy: a literal list of the columns the consumers actually render.**
  3. **The fixture is not ON the boundary.** `<` → `<=` survives a row one second inside the cutoff. `NOW()` is transaction-stable, so insert exactly `now() - interval '<retention>'`.
  4. **The fixture cannot distinguish the two implementations.** One failing chunk makes FIRST and LAST failed chunk the same block, so `if (first === null)` is unobservable; one erroring board that fails the slow test anyway cannot separate SLOW from EMPTY. **Remedy: add the second failure / the row that trips both classifiers.**
  5. **The property is not observable from a return value at all.** Deleting a `clearTimeout` in a `finally` changes nothing a caller sees, though a leaked timer keeps the export event loop alive. **Remedy: make it observable (spy on `clearTimeout`) rather than accept the gap.**
  ⚠ **And the sixth shape, which mutation CANNOT find: a test that states the contract in a comment and asserts something weaker** — see the pack-reality case under the client-page bullet. **Assert the ABSENCE of the false claim, not the PRESENCE of an error message.**
  ⚠ **THE SIXTH SHAPE'S PUREST INSTANCE, AND IT IS WHY `/dashboard` SHIPPED A FALSE CLAIM ON THE PRIMARY SIGNED-IN SURFACE (`969bff49`, 2026-08-16).** `component-DashboardClient.test.tsx` already carried a case named **exactly right** — *"survives a failed saved-wallets read without claiming none are saved"* — stubbing the route to 503. Its entire body was `await waitFor(() => expect(fetchMock).toHaveBeenCalled())`. **That passes whatever the page renders**, so it certified the defect it was named to prevent: a 503 left `walletList` at `[]`, the hero rendered the onboarding "paste your Dapper address" banner to a collector who had already added one, and the tiles fell through to a confident "0 moments / $0". ⚠ **The title is not the assertion, and a well-named case is the hardest kind to audit** — it reads as covered in any grep, any review, and any coverage report. **When a case name contains a negative claim ("without claiming…", "does not show…"), open it and check that a negative assertion is actually present.** Now five cases, asserting the banner's ABSENCE on failure and its PRESENCE on a genuine empty list. ⚠ Its Retry sibling is the other half: **a Retry that rebuilds its argument from the empty list is inert precisely in the case it is offered for** (`refreshStats([])` early-returns), so **an action offered for a state it cannot fix is its own dishonesty** — and asserting recovery rather than a call count is what proves the retry reaches the failing route. ⚠ **Two Retry buttons render on that path and call DIFFERENT things**, so `getAllByText(/Retry/i)[0]` MASKED the second branch entirely; caught by mutation, not review. ⚠ **A GREP-ABLE FORM OF THE SAME TELL, from the 2026-08-21 cursor-swallow sweep: a title claiming a failure was ABSORBED.** Three tests across the indexer family were not merely vacuous but **asserted the defect as correct** — *"…survives a 500 event fetch"* ending `// The 500 leg did not poison the run — cursor still advanced.`, and two copies of *"an OfferAvailable events HTTP error **degrades that range to empty and still advances the cursor**"*. Each pinned permanent data loss and described it, in its own title, as a graceful degrade. **Grep test TITLES for `survives`, `degrades to`, `still advances`, `does not poison`** — an absorbed failure is the honesty canon's core defect, so a title boasting of one is where it hides. ⚠ Judge by the SUBJECT, not the word: *"a below-spork-floor 404 stops the scan gracefully… cursor still advances"* is the legitimate below-floor case, and *"halves the window on a 429 and advances the cursor only to the block that actually succeeded"* is the CORRECT shape. ⚠ And per CLAUDE.md such a test is **INVERTED, never deleted** — the passing assertion is what held the defect in place, so the same fixture must prove the opposite.
- ⚠ **A GUARD THAT MUST BE DELETED BEFORE A FEATURE CAN SHIP WILL BE DELETED IN A HURRY BY SOMEONE WHO DOES NOT KNOW WHY IT EXISTED — so make it RETIRE ITSELF, and pin the DETECTOR rather than the state (2026-08-16).** `no-rewards-promises-while-unshipped` bans points/Credits copy on user-facing surfaces **only while `app/rewards/layout.tsx` still calls `notFound()`** — it reads its own precondition out of the product, so the day rewards ships it stops enforcing on its own. ⚠ **Its FIRST version asserted `rewardsIsHidden === true`, which HARD-FAILS on launch day**: a guard written to protect the launch would have reddened CI *at* the launch, the exact outcome its own header promised to avoid — found by MUTATING `notFound()` out, not by review. The fix is to assert the **detector** (it reads the real file; it discriminates; a COMMENTED-OUT call reads as not-hidden) and let the enforcement cases `it.runIf(...)` skip — otherwise a silently-broken detector leaves every case skipping while the guard reports green, which is the vacuous-guard trap wearing a clean shirt.
- **DB-invariant SQL tests (added 2026-07-19 — the layer vitest can't reach).** Plain-SQL tests in `supabase/tests/*.sql` pin the behavior of high-stakes Postgres functions/triggers (guards, normalizers, the destructive-op circuit breaker) that live in the database, not in `lib/`/`app/api/`. Each file is **self-contained**: it creates the minimal fixture tables + a **verbatim copy of the committed function DDL** (between `>>> BEGIN verbatim … >>>` / `<<< END verbatim … <<<` markers), asserts the invariant via `_helpers.sql`, and `ROLLBACK`s — so it runs on a vanilla `postgres:16` (only `unaccent` needed) with **no schema apply** (the repo's migrations are incremental `audit_*` patches over an externally-created base and don't rebuild from scratch; some prod objects were applied via MCP and never committed as files). Run locally: `DATABASE_URL=… bash scripts/run-db-tests.sh`. ⚠ **The runner pins `PGTZ=UTC` (added 2026-08-15) and that line is load-bearing — do NOT drop it.** Several tests assert a rendered `timestamptz`, which psql prints in the SESSION zone, so on a non-UTC machine they fail on the OFFSET while describing the same instant (`got [2026-06-30 17:00:00-07] want [2026-07-01 00:00:00+00]`) — which reads exactly like a logic bug. CI containers happen to be UTC, so this was invisible there while failing for **anyone running the suite locally, and Trevor's box is PT**. Prod Postgres is UTC, so pinning makes the suite match production rather than the developer. **If a future instance of this appears, do not "fix" it by editing the expected string to the local offset** — that just moves the breakage to the next machine. **When you change a pinned function: edit the migration, then copy the new DDL verbatim into the test file** — the blocking `unit-tests` job runs `__tests__/db-invariants-drift-guard.test.ts`, which fails CI if a test's embedded DDL diverges from its source migration. CI job is `db-tests` (blocking as of 2026-07-19), which provisions a throwaway Postgres from the runner's preinstalled `initdb`/`pg_ctl` binaries on port 5433 (a `services:` container hangs on image pull here). **180 pins over 179 distinct functions, and 172 `.sql` test files, re-measured live 2026-08-16 23:57Z** (169/168 over 160 files earlier the same day — the scheduled-writer re-close and the pack/board-liveness work moved all three). The drift-guard `PINS` array is the source of truth; `supabase/tests/` holds the per-pin `.sql` files + `_helpers.sql`. ⚠ **Files ≠ pins, in BOTH directions**: several pins legitimately SHARE one file (e.g. the nine MV-refresh wrappers), and the file count also includes `_helpers.sql`, which is not a pin at all — so `ls supabase/tests/*.sql | wc -l` is not a pin census. Count pins from `PINS` (`grep -cE '^\s+fn:'`) and distinct functions by de-duplicating that list; the two differ because `allday_sales_cross_source_dedup` carries two pins. ⚠ **THE SCHEDULED WRITE SURFACE WAS RECORDED CLOSED AT "52 of 52" AND WAS 52 OF 63 THE SAME DAY. Re-derived and re-closed at 63/63 (2026-08-16).** ⚠ **THE REOPENING MECHANISM IS THE PART TO REMEMBER, BECAUSE NO CODE CHANGED: eight `rpc_thp_leg_*` legs entered the population when the 8-way split retired jobid 287 and created per-leg jobs 324–331**, so each leg's NAME now appears directly in `cron.job.command` where only the orchestrator's did before. **A closed-set claim over "scheduled X" can be reopened by a pure SCHEDULING change — the pin count never fell, the population grew.** The other three (`pinnacle_fmv_recalc_render_all` — a PRICING writer, `reconcile_all_saved_wallet_stats`, `capture_board_liveness_history`) are **non-SECDEF**, so a SECDEF-scoped sweep could not see them; ⚠ **`reconcile_all_saved_wallet_stats` had also DRIFTED** (its only committed migration declares a zero-arg FUNCTION where live is a three-arg PROCEDURE), which `db:pins:check` is structurally blind to because it reads only functions already pinned — snapshot migration `20260816181600` fixes that. ⚠ **And the drift guard could not parse `CREATE OR REPLACE PROCEDURE` at all until 2026-08-16, making every procedure in this DB unpinnable**; it failed safe, but "safe" meant the pin could never be written, which is indistinguishable from nobody having got to it. ⚠ **But the number that matters is the PREDICATE, and getting it wrong is the recurring failure here.** The sweep that drove this whole workstream enumerated writers by matching `insert into` / `update ` / `delete from` / `truncate `, and reported "33 scheduled writers, 14 unpinned". Adding **`refresh materialized view`** to that predicate found **52** — a function whose entire body is `REFRESH MATERIALIZED VIEW` contains none of the four DML verbs, so that whole CATEGORY was invisible **by construction**, and `refresh_sets_summary` (which CLAUDE.md singles out for running as a `rolbypassrls` role under pg_cron) sat in it. **"Closed" means closed against THIS predicate.** Before quoting 52/52, ask what shape it is still silent about — a function that calls another function which writes, a `DO` block, a trigger reached only from a scheduled statement. **Re-derive it; do not quote it.** The word-boundary match also matters: `LIKE '%'||proname||'%'` prefix-matches siblings (`..._refresh_p`) and inflated the count once already — use `j.command ~ ('\y'||p.proname||'\y')`.
  ⚠ **HOW TO PICK THE NEXT PINS, now that the scheduled surface is done.** The remaining unpinned population is the **UNSCHEDULED** writers — reached from routes, from other functions, or by hand. Measure it the same way and rank by stakes, not size; the DELETERS first, because over-deletion produces an ABSENCE, not an error, so nothing downstream reports it. ⚠ **Count it with the parser, not a grep** — `grep -cE '\bfn:'` reads **126** because it also catches the `it.each(PINS)("$fn: …")` title, and `allday_sales_cross_source_dedup` legitimately carries two pins, so pins ≠ distinct fns. ⚠ **The +7 on 2026-08-15 CLOSED THE TOPSHOT REMAP/CONFLATION FAMILY, which had been 2-of-9 pinned** — an arbitrary line, since all nine mutate the same `sales` / `wallet_moments_cache` / `editions` keying every edition-keyed FMV derives from, and the two that were pinned were simply the two someone had written a snapshot for. Added: `remap_pack_pool_uuid_key` (the only member that DELETEs), `remap_misattributed_topshot_sales`, `remap_topshot_wmc_from_onchain_map`, `remap_topshot_from_onchain_map`, `remap_topshot_split_resolved_subeditions`, `remap_topshot_realign_miskeyed_subeditions`, `resolve_topshot_subedition_collision_knots`. **Five needed a snapshot migration first; two already had committed migrations that were verified byte-identical to LIVE, so needed only a test** — check that before authoring a snapshot, it halves the work. ⚠ **Three defensive clauses in that family are UNREACHABLE and are deliberately NOT asserted** (`o.id <> mv.moment_pk`; `m2.nft_id <> m.nft_id` in two siblings), each documented in place with the upstream filter that makes it redundant AND the change that would make it load-bearing again — contriving a fixture would assert a state the query cannot produce. ⚠ **Mutation testing found FIVE assertions that were MASKED and proved nothing**, all the same shape: a guard rejecting a bad input is unobservable unless that input would OTHERWISE succeed (a UUID-keyed target that resolves to no edition returns 0 with or without the gate). **Fixture-before-guard is the rule** — add the row that makes the guard the only thing standing between the input and a write.
  ⚠ **THE 2026-08-16 WAVE (139 → 169) ADDED FIVE MORE MUTATION-SURVIVOR CATEGORIES. Sort every survivor into one of them BEFORE touching anything — they need opposite responses, and three of the five are "leave the code alone".**
  1. **A FIXTURE GAP** — close it, but only with a state prod really produces. Three separate survivors this wave needed the SAME fixture: **an `external_id` colliding across collections** (CLAUDE.md states outright it is not unique), which is what makes a collection-scope guard observable at all. Others: an edition that already HAS art (so a fill-only check can be seen declining), a second and DEARER ask (so `ORDER BY lowest_ask ASC` stops being decorative), a pack with a real minted total (so a zero-price guard has something to guard).
  2. **REDUNDANT BEHIND ANOTHER GUARD, IN THE SAME STATEMENT** — document, do not contrive. `sec_ask IS NOT NULL` sits behind `gross_ev <= 3 * sec_ask` (`x <= 3 * NULL` is NULL). `total_fmv IS NOT NULL` sits behind `valued_pulls = total_pulls >= 1`. `IF p_collection_id IS NULL THEN RETURN 0` sits behind three-valued logic. Assert the **COMPOSITE** where both can be dropped, and record what would make the clause load-bearing again.
  3. **REDUNDANT BEHIND A DIFFERENT OBJECT** — settle it with a live measurement, not a judgement call, because the answer goes both ways. The Golazos `floor_ask > 0` is unreachable because the live VIEW already filters `price_usd > 0` (read from `pg_get_viewdef`) → documented. The atlas pool-collection scope looked identical but **54 dist_ids already span collections** in `pack_drop_pool` → it earned a fixture. **One query separates them; guessing is wrong half the time.**
  4. **A CONCURRENCY BACKSTOP** — structurally unobservable in a single-session rolled-back test, so assert the composite and say so. `NOT EXISTS` + `ON CONFLICT DO NOTHING`; the candidate-side and UPDATE-side halves of a fill-only check; a watermark captured before-vs-after the read.
  4b. ⚠ **AN ABSENCE ASSERTION IS VACUOUS UNLESS THE FIXTURE WOULD HAVE MADE THE THING PRESENT (2026-08-16).** "renders no achievements section" passed with the component REMOUNTED, because it returns `null` on an empty list and the fetch stub answered `{}` — so the assertion held whether or not the section was mounted. **Give the fixture a real row, then assert the absence.** Its two siblings this session are the over-broad negative: `not.toContain("TR")` and `not.toMatch(/WALLET/)` both matched unrelated page copy ("TROPHY", "SAVED WALLETS") and failed against CORRECT code. **Scope a negative to the thing it is about** (`/\d+\s+WALLETS?\b/` for a count line), and assert it on the smallest element that can carry it, not on `document.body`.
  5. **INVISIBLE IN BEHAVIOUR BUT VISIBLE IN THE CATALOG** — seven of eight `CONCURRENTLY` mutations passed, because removing the keyword still refreshes; it merely takes an ACCESS EXCLUSIVE lock, and no rolled-back test can watch a lock. ⚠ **`pg_get_functiondef` IS QUERYABLE FROM INSIDE THE TEST** — assert the keyword, the planner hint (`SET enable_nestloop TO 'off'`), or anything else that lives in the definition rather than in the output. Same trick pins a `statement_timeout` or a `search_path`.
  ⚠ **A `waitFor` ON AN ABSENCE IS VACUOUS WHENEVER A THIRD STATE PASSES THROUGH — second recorded instance, 2026-08-16.** A "the failure flag clears on refetch" case did `await waitFor(() => expect(notice).toBeNull())` and **passed with the reset removed**: the effect nulls its rows on re-run, so the SPINNER branch wins for a tick and the notice is legitimately absent during it — the assertion resolved in that window and never observed the state it was about. **Await the RECOVERED CONTENT first, then assert the absence.** Same root as the pills case: *two conditions individually true at DIFFERENT moments do not prove they are ever true together.*
  ⚠ **A ONE-ARG `vi.fn` TYPES `.mock.calls` AS A 1-TUPLE, so every `c[1]` read is a `tsc` error while vitest stays green.** Declare both params (`async (input: unknown, _init?: RequestInit)`) even when only the first is read. This is the repo's most-repeated CI breakage met from a new direction — `npx tsc --noEmit` before pushing a new test file, always. ⚠ And **`vitest.components.config.ts` does not enable globals, so testing-library's auto-cleanup never registers**: without an explicit `cleanup()` the previous test's tree stays mounted and the NEXT test fails looking for something a stale render never produced, which reads as a component bug. ⚠ Also, a label regex is a SUBSTRING match — `/nba favorite team/i` also matches **"WNBA favorite team"**; anchor it.
  ⚠ **KEY A MUTATION HARNESS'S BACKUPS ON THE FULL PATH, NEVER THE BASENAME — this destroyed two files of uncommitted work on 2026-08-16.** A six-file harness stored backups as `<basename>.bak`; three of the targets were `page.tsx`, so all three wrote ONE backup and the restore overwrote two pages with a third's content. ⚠ **Nothing noticed the clobber** — it surfaced two mutations later as `occurrence count 0`, which reads like a stale pattern, not like data loss. `tsc` was clean the whole time, because the file it was overwritten with is itself valid. **Hash the path** (`md5(path)`), and prefer a harness that restores from `git stash`/`git checkout` where the work is committed. The recovery was cheap only because the transforms were scripted and still in the transcript; a hand-edited file would have been gone.
  ⚠ **AND A MUTATION RESULT IS MEANINGLESS UNTIL THE BASELINE IS GREEN.** A scripted `replace` adding a fixture row silently did not match (whitespace), while the *assertion* about that row did land — so the baseline went red and the next mutation "reddened" for the wrong reason entirely. **Assert the occurrence count before replacing** (`n = s.count(old); assert n == 1`) and re-run the baseline after every fixture edit. The same no-op-replace trap also produced a mutation that hit the file's own HEADER COMMENT instead of the code (`HAVING count(*) >= 20` appears in the prose first), which reads as a surviving mutation and is not one.
  ⚠ **A FAILING ASSERTION IS SOMETIMES THE CODE BEING RIGHT — read it before fixing it.** `backfill_wmc_fmv_confidence(NULL, 1)` returned 0 where I expected 1, because **`LIMIT` sits in the targets CTE, BEFORE the join to a priced snapshot: it bounds rows EXAMINED, not rows written.** That is the entire mechanism behind that job's permanent backlog floor and behind its becoming the instance's #1 disk reader once the queue drained — a sharper property than the one I set out to assert.
  ⚠ **FIXTURE COLUMN TYPES MUST MATCH `information_schema`, NOT INTUITION.** `topshot_moment_subeditions.nft_id` is **text** (it looks like a number) and `subedition_id` is **smallint**. Typing them bigint/int errored loudly — the lucky version. A fixture that merely WIDENS a type passes while testing a shape production cannot produce. The +3 since the 122 of 2026-08-05 came from the 08-12 `.tsx`-gate wave (3 DB writers) and the wmc FMV-confidence ship. Up from a 66-pin baseline via a long 2026-07-31→08-05 pin campaign, all validated on a local `postgres:16` + mutation-tested. The 117→122 additions landed in the 2026-08-04→05 continuation (read the `PINS` array for the current set); the earlier +2 (115→117) were the parallel↔base sales-misattribution remappers `remap_topshot_parallel_to_base_misattributed` + `remap_topshot_base_keyed_parallel_sales`. The **2026-08-02 wave alone added 25 (89→114)**: the FULL insider-signal detector family (`detect_floor_drops`, `detect_concentration_buys`, `detect_unusual_edition_volume`, `detect_new_edition_early_buyers`, `detect_topshot_sweeps` — the fabricated-market-signal class), the two sales serial-number write guards (`update_sale_serial` + `update_topshot_sale_serial` — a regression here silently corrupts every serial-keyed FMV multiplier / special-serial / #1-premium), the canonical player-write path `upsert_player_canonical` (COALESCE-fill-only team, no cross-collection clobber), `record_serial_backfill_failure`, `draw_raffle`, `admin_verify_wallet`, `bump_concierge_ip_rate`, `close_expired_cached_listings`, `pinnacle_upsert_nft_map` (NULL-owner-never-nulls-a-holder), `mark_signal_wallets_fully_enriched`, `claim_pipeline_lock` (cross-session anti-double-run), `check_feature_quota` (Pro daily quota), `apply_topshot_supply`, `resolve_golazos_listing_edition_ids`, `check_set_completion`, `stub_editions_from_wmc`, and `compute_pinnacle_serial_fmv_multipliers` (Pinnacle serial-FMV multipliers). The whole 112-pin layer (111 distinct fns) was then audited **0 STALE / 0 NOT_IN_LIVE** against live prod (2026-08-02, via the MCP-replicated `check-db-pin-staleness.mjs`). The 2026-08-01 rewards/account-linking/wmc/game-integrity pins (`redeem_shop_item`, `record_link_state`, `fulfill_redemption`, `upsert_wallet_moments`, `save_fast_break_lineup`, `ensure_topshot_edition_stub`) and the earlier 89-pin audit are folded into that count. The later 2026-08-01 test-coverage session added 9 by authoring the FIRST committed **snapshot migrations** for hot functions that were previously UNPINNABLE (MCP-applied, no committed DDL): `resolve_canonical_owner`, `classify_acquisition`, `raise_impossible_parallel_circ`, the live 2-arg `get_wallet_total_fmv`, `resolve_wallet_challenge_match` (the credit-award + referral-abuse-guard flow), the `get_linked_parents` + `get_linked_children` account-linking pair, `award_points` (the reward-currency mint — per-user-limit / daily-cap / cooldown / global-cap guards), and `save_user_wallet` (saved-wallet write path, COALESCE-never-null-out honesty) — each `supabase/migrations/20260801160*_audit_20260801_snapshot_*.sql` committing the verbatim `pg_get_functiondef` body (a no-op if applied, byte-identical to live) so the function gains a drift-guarded pin. This is the documented remedy for the "UNPINNABLE until someone authors a snapshot migration first" gap below — three of the exact examples it named are now pinned. (`resolve_special_serials_from_ownership` was deliberately NOT pinned — it is dormant/uncalled, so a pin would be theater.) The 2026-08-01 session added 16 (allday_sales_cross_source_dedup, candy_park_unresolved_sale, clear_badge_low_ask_missing, resolve_ufc_edition_by_studio_meta, purge_fmv_snapshots_today, fmv_backfill_candidates, purge_old_fcl_auth_nonces, topshot_serial_board_candidates, upsert_pack_rips_from_api, upsert_allday_marketplace_fmv + refresh_allday_ask_fmv_from_listings, populate_wmc_fmv_from_snapshots, backfill_wmc_metadata_from_editions, update_badge_low_ask_{from_cached_listings,by_external}, apply_sales_ingest_external), each verified byte-identical (or comment-stripped-identical) to LIVE prod before pinning. ⚠ **DURABLE — the cloud (web) sandbox CAN both validate a new pin end-to-end AND verify it isn't stale-from-birth**, so do this before pushing a new pin rather than hand-authoring blind: (1) stand up throwaway `postgres:16` from `/usr/lib/postgresql/16/bin` (initdb/pg_ctl need an unprivileged user — `useradd pgtest; su pgtest -c '…'` on `-k /tmp/pgrun -p 5433 -A trust`; `CREATE EXTENSION unaccent SCHEMA extensions`) and run `run-db-tests.sh`; (2) pull the live definition via the Supabase MCP `pg_get_functiondef`/`prosrc` and confirm the committed-migration body matches (only comments may differ — `check-db-pin-staleness.mjs` tolerates that). With no `SUPABASE_SERVICE_ROLE_KEY` you can still replicate `db:pins:check` by pulling `pg_proc.prosrc` for the pinned set via MCP and comparing to the committed migrations (audited 2026-08-01: all prior pins 53/53 clean). **Many high-value functions are MCP-applied with NO committed migration** (e.g. `resolve_canonical_owner`, `raise_impossible_parallel_circ`, live 2-arg `get_wallet_total_fmv`) — the drift guard has nothing to compare against, so they are UNPINNABLE until someone authors a snapshot migration first. ⚠ **A pin can go STALE without CI noticing, and the repo cannot detect it — only the live DB can.** The guard compares the test copy to **the migration named in its `PINS` entry**, which is repo-vs-repo; when a function is redefined and applied via MCP *without* a committed migration file, the pin, the test and the guard all stay green while the test validates a definition that no longer runs anywhere. Audited 2026-07-31: **3 of the then-42 pins were in that state** — `promote_unmapped_sales` (~3 months behind), `fmv_clamp_disconnected_ask_topshot` (pinned to a superseded circulation-gated clamp predicate; live is `fmv > med*3 AND fmv > p90*1.5`), `compute_pack_ev_per_edition_weighted` (~2 weeks behind, missing the weighted-median `typical_pull_ev` that the public pack-EV surfaces LEAD with). **The obvious repo-side check — "does the pin name the newest committed migration defining this function?" — catches NONE of them** (for two, the repo holds exactly one defining migration), so do not build it and call it done. The real check is **`npm run db:pins:check`** (`scripts/check-db-pin-staleness.mjs`): it parses `PINS` out of the drift-guard test so the lists can't diverge, reads `pg_proc` for every pinned function, compares bodies under both comment-stripped and comments-included normalization (live `prosrc` is often comment-stripped relative to the file — a cosmetic-only diff is NOT drift), and exits non-zero. It needs `SUPABASE_SERVICE_ROLE_KEY` + `NEXT_PUBLIC_SUPABASE_URL`, so it runs in the scheduled `db-pin-staleness.yml` workflow (daily 07:20 UTC + dispatch), not the DB-less `unit-tests` job. **This workflow now ENFORCES as of 2026-08-01** — the last missing repo secret `NEXT_PUBLIC_SUPABASE_URL` was added (the service-role key had existed since 04-02; the pre-existing `SUPABASE_URL` secret is a different key the workflow does not read), so it no longer soft-skips: the first real dispatch checked 90 pins, 90 clean. It is the ONLY check that can catch a pin whose LIVE definition drifted (the in-CI drift guard is repo-vs-repo and structurally cannot). Revert to soft-skip: `gh secret delete NEXT_PUBLIC_SUPABASE_URL`. Pinned-but-intentionally-undeployed functions sit in its two-way `NOT_DEPLOYED_OK` allowlist (**currently EMPTY**). ⚠ **A pin whose function is GONE should be DELETED, not allowlisted.** `compute_listing_divergence` was allowlisted on 07-31 and deleted hours later the same day: `pg_proc` (all schemas) 0, referencing function bodies 0, views 0, `cron.job` commands 0, zero in-repo callers — retired with Flowty. Its SQL test created its own copy of the function, so it passed unconditionally: a test that *cannot* fail asserts nothing, and the allowlist entry then has to be maintained and re-read by every future pin auditor in exchange for zero coverage. Reserve `NOT_DEPLOYED_OK` for a function genuinely pending deployment. **Repointing a stale `PINS` entry is only half the repair — re-read the test's ASSERTIONS**, which by then describe behaviour production has stopped exhibiting (the 07-31 clamp test asserted a circulation gate that no longer exists; the pack-EV test asserted `ev_basis='original'` for a Top Shot pool that live forces to `remaining`). ⚠ **DURABLE — the staleness check's own pin-PARSER had a blind spot (fixed 2026-08-08 `a5e98fb3`): its regex required `fn:`/`test:`/`migration:` on strictly ADJACENT lines, so any PINS entry carrying a comment BETWEEN its fields (a "re-pointed 2026-…" note) was silently dropped from the live-drift check** — `get_wallet_moments_with_fmv` + `get_team_detail` were both invisible. Now uses `[\s\S]*?` between fields (captures all 122), guarded by `__tests__/db-pin-staleness-parser-coverage.test.ts` (reads the script's actual regex, asserts it covers every pin). **Live audit 2026-08-08: all 122 pins CLEAN / 0 stale** (replicated via MCP `pg_proc.prosrc` md5 under both normalizations). Docs: `supabase/tests/README.md`.
- **Cadence tests** — `npm run test:cadence` extracts inline Cadence (`scripts/extract-cadence.mjs`) and runs `flow cadence lint` against `tests/cadence/fixtures/`. Gated in CI (`cadence-lint` job, needs `flow dependencies install`). See `docs/cadence-testing.md`. Separately, a real `flow test` suite exists for the (undeployed) RPCTradeEscrow contract at `cadence/tests/RPCTradeEscrow_test.cdc` — **16/16 green**, all 12 audit scenarios covered — run locally via `npm run test:cadence:escrow` (fetches deps via `scripts/fetch-cadence-escrow-test-deps.sh` first) and **now run in CI** as of 2026-07-19 (`cadence-escrow-tests` job installs flow-cli from master + fetches pinned ExampleNFT v1.2.2; one-time local setup in `cadence/tests/README.md`).
- **Rendered-DOM live smoke (Playwright, added 2026-08-01).** `e2e/smoke.spec.ts` drives a real browser over the PUBLIC deployed surfaces (home, the 5 collections' read tabs, `/insights` hub + top-sales, `/analytics`, `/pricing`) and asserts each renders real content — status <400, NO error-boundary text, a non-trivial rendered-body length (not a 200 streaming shell) — the "200-but-broken-DOM" class the API smoke gate (`/api/smoke-test`) structurally can't see. Shared assertion in `e2e/healthy-page.ts`; config `playwright.config.ts` (`SMOKE_BASE_URL` env, prod default). It runs as a **scheduled + dispatch MONITOR** (`.github/workflows/e2e-smoke.yml`, every 6h), NOT a pull_request gate, so a live-site hiccup never blocks a merge. `e2e/smoke-selfcheck.spec.ts` proves the assertion logic against local fixtures (healthy passes; 500 / error-boundary / empty-shell / missing-text all fail) so it's exercisable even where the deployed site is unreachable. ⚠ **DURABLE — sandbox browser facts (verified 2026-08-01):** Chromium is at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, launches fine and reaches **localhost** (pass `proxy:{server:'http://127.0.0.1:1',bypass:'localhost,127.0.0.1'}` + `PW_CHROMIUM_PATH`), but **CANNOT tunnel the agent proxy to reach the LIVE site** — so `smoke.spec.ts`'s first real run is the CI job, and local verification is the self-check only. `@playwright/test` is not installed but `playwright` (1.61.1) bundles the runner (`import from "playwright/test"`). `e2e/**` IS type-checked by CI's `typecheck`; vitest ignores it (its include is `__tests__/**/*.test.ts(x)`).
- **CI jobs (9, all in [.github/workflows/ci.yml](../../.github/workflows/ci.yml)) — ⚠ this bullet said 8 and omitted `worker-tests` for a full day after that job landed; count the `jobs:` keys in the file, not this sentence:** `typecheck` (`tsc --noEmit` over the whole repo incl. `__tests__`), `cadence-lint`, `cadence-escrow-tests`, `unit-tests` (vitest + coverage ratchet + the DDL drift guard), **`worker-tests`** (the third coverage gate — `npm run test:coverage:workers` over `vitest.workers.config.ts`, thresholds **85.1/72.1/83.8/88.1** as of 2026-08-15; added in `513c514e` because `workers/**` is Cloudflare-Worker source that neither the primary nor the component gate includes), `component-tests` (the jsdom component-coverage ratchet — `npm run test:coverage:components` over `vitest.components.config.ts`, thresholds **90.3/81.6/89.1/93.2** as of 2026-08-15 (read them off `vitest.components.config.ts`, not off this sentence), raised on 08-13 by the component wave, which closed a ~13-point unguarded branch buffer; before that 79.0/67.0/78.8/83.2 as of 2026-08-09, itself raised from 78.6/66.4/78.2/82.6 by the 08-09 board-client coverage pass; the 78.6 baseline had been re-baselined down in `17738436` when the wallet-sign-in removal deleted well-covered connect components — added 2026-07-26 in `c3c86427` at 20.2/17/19/21.2 and climbed by the component-coverage program; also guarded by the include-completeness rot-guard, see the React-components bullet above), `db-tests` (SQL invariants), `ledger-guard` (fails a push that DROPS or REMOVES any `docs/overnight/ledger.md` entry — it compares the `^### ` heading **sets** between `HEAD~1`→`HEAD`, not just counts, so a same-count remove-one/add-one swap is caught too, after commit `2966c0a` defeated the count-only check on 2026-07-19; opt out of a legitimate archival roll with `[ledger-roll]` in the commit message), and **`edge-deno`** (added 2026-07-29; `deno check` + informational `deno lint` over `supabase/functions/**` — the ONLY thing type-checking the Deno edge source, which the vitest/tsc jobs exclude. **PROMOTED TO BLOCKING 2026-08-01 (`33b207e3`), 16 `deno check` errors → 0.** ⚠ The long-standing 16 were NEVER a toolchain conflict or edge-source import bugs (the 2026-07-31 diagnosis this file used to record was wrong on all three of its claims, each re-tested on a real Deno 2.9.4) — they were an **INVOCATION BUG in the job**: there is no `deno.json` at the repo root and the steps run from the repo root, so Deno never discovered `supabase/functions/deno.json` and the import map was never applied. Adding **`--config supabase/functions/deno.json`** to the `deno cache`/`deno check` steps cleared 14 of 16 on the spot (all 12 `@supabase/functions-js/edge-runtime.d.ts` + both `std/http/server.ts` "not a dependency"); the 2 residual `TS7022` were genuine (Deno bundles TS 6.x vs the repo's TS 5) and were fixed with two type-erased annotations in `compute-topshot-pack-ev/index.ts` (type-only → erased at runtime → no redeploy). `--node-modules-dir=auto` is NOT load-bearing; the `jsr:→npm:` remap the old comment/handoff prescribed is unnecessary deploy-affecting churn and must not be resurrected. `supabase/functions/deno.lock` is gitignored on purpose. **Edge fns import deps by BARE specifier via the `supabase/functions/deno.json` import map — new edge code must not use inline `https://esm.sh`/`jsr:` URLs.**

---


## Test-quality lessons from the 2026-08-17 coverage pass

Added rather than extracted — these are new, and the pass that produced them is recorded in
`docs/overnight/inbox/2026-08-18T0230Z-test-coverage-analysis.md`.

### ⚠ A test that sleeps WALL CLOCK inside a timer window is a CI flake, and it fails on somebody else's commit

`c9923296` changed only markdown and its blocking `unit-tests` job **failed on `main`**, between two
passing runs of the same code. Cause: `component-AdminFeedbackClient.test.tsx` slept **90ms of real
time** inside a **300ms** debounce window and asserted nothing had fired. **A `setTimeout` is a FLOOR
on the delay, never a ceiling** — under runner contention the sleep itself outlasts the window, the
debounce fires, and the branch is blocked over a component nobody touched.

- **The fix is fake timers plus `act()`, and `act()` is load-bearing.** The first fake-timer rewrite was
  **vacuous**: without `act()` around the keystrokes React had not yet run the effect that *schedules*
  the debounce, so the timer was created after the advance and a `0ms` debounce behaved exactly like a
  `300ms` one. **Only running the mutation showed it.**
- ⚠ **Do NOT blanket-convert the siblings.** A sweep found five. Three assert a non-occurrence *inside a
  window* and were converted (`AdminFeedbackClient` 300/90, `CollectionAnalyticsClient` 500/120,
  `MarketClient` 350/60). Two were left alone because their claims hold at **any** elapsed time (no
  saved wallets ⇒ no prefetch; no token ⇒ no request) — there the sleep is a courtesy, not a premise.
  **The discriminator is whether the assertion depends on the clock, not whether the file contains a
  sleep.**
- A fourth site in the same neighbourhood was a different defect: it captured a baseline from **the
  same expression it later compared to**, so a persisted no-op that had not landed inside 40ms
  satisfied the assertion. **Assert the absolute value when the fixture makes one available.**

### ⚠ A coverage gate can red on an unchanged tree — check the distribution before believing a margin

Repeated runs of `component-tests` on an **identical** tree measured **3484 / 3485 / 3488 covered of
3910** → **89.10 / 89.13 / 89.20**, against a threshold of **89.1**. The low sample clears by
**0.004pt**. A stash/unstash A/B confirmed it is not caused by any one change. **A stated margin is a
single sample; the number that matters is the spread.** ⚠ The remedy is to find the nondeterministic
suite, **never to lower the threshold** — the config's own rule, and this repo has already paid for the
compounding version.

⚠ **RESOLVED THE SAME NIGHT, AND THE USEFUL PART IS WHAT THE WOBBLE TURNED OUT TO BE.** The session
that took this lane localised it with six gate runs across two independent triples — **not** to the
file the filing named as its leading hypothesis (`SniperClient.tsx`, picked because it was the only
file that moved between two runs and holds a `setInterval`). **That suspect was refuted on
measurement.** The varying file was `CollectionTabClient`, and its `"appends the next page rather than
replacing the loaded rows"` case **was passing without exercising Load More at all**: an auto-paginate
effect appended the remaining pages by itself after a 300 ms sleep, so whenever it beat the click the
assertion held anyway. Proved by deleting the click and watching the test still pass. **So an
oscillating coverage number is worth chasing not because the gate is noisy, but because it is often a
test that is INTERMITTENTLY VACUOUS** — the coverage delta is the only visible symptom of an assertion
that sometimes measures nothing. ⚠ The fix's own trap is recorded with it: freezing the clock does not
work, because the effect sets `loadingMore` *before* its sleep, so a frozen clock leaves the button
permanently disabled and unclickable. ⚠ And it is **not** a claim that the gate is now deterministic —
the 3484/3485 low end never reproduced in that session's six runs, so one source was removed, not
proven to be the only one.

### ⚠ A guard that NAMES its instances is silent about the population it did not name — the SEO instance

`seo-shared-helpers-inherit-og-twitter` pins three `lib/seo.ts` helpers **by name**. Every `app/**`
file that builds metadata inline was therefore outside it *by construction*: **43 files**, **31 of them
the `/insights` board layouts**, each setting `twitter.creator` and omitting `twitter.site` — dropping
the X card byline, **the exact symptom deep-audit R10 was filed for**, on the surface this repo calls
its most shareable. `lib/seo.ts` even carried the instruction ("spread these into every block rather
than restating the literals") three lines above the constants; it had only ever been applied to the
helpers. **The replacement walks the tree and DERIVES the demanded fields from the exported constants,
with a separate case asserting those constants match `rootMetadata`** — so adding a root field widens
the ban for free. ⚠ Its brace matcher was not string-aware in v1, so a `}` inside a quoted `alt:` closed
the block early and reported fields that were present: **a false positive is the expensive direction on
a guard, because the next person weakens the guard to get green.**

### ⚠ A completeness guard over a monitor must be BIDIRECTIONAL when a launch flag moves the population

The rendered-DOM smoke listed **6 of 31** public `/insights` URLs, and both React #418 incidents it
exists for landed on boards it did not watch. Its comment said `panini-squeeze`/`candy-mlb` were
"deliberately omitted… until its flag stays flipped" — **both flags had been `true` since launch**, so
two live public boards sat outside the only monitor that can see them, protected by a sentence that
read like a decision. `e2e-smoke-covers-public-insights-boards` now derives the set from
`app/insights/*` + the real `isPublicPath` **and also fails if a GATED board is listed**: a one-way
check would go red in the slowest, least legible place — the 6-hourly live monitor, on a board now
302-ing to `/login`.

### ⚠ Pin a DB function against LIVE `prosrc`, not merely against the committed migration

Before pinning, compare `md5(prosrc)` from the live DB with the migration's body. Both 2026-08-17 pins
matched exactly (`build_deal_alerts_for_subscription` 8,943 chars; `dispatch_due_deal_alerts` 13,203) —
but CLAUDE.md records that some objects were applied by MCP and never committed, and **a pin against a
stale migration pins something production does not run.** ⚠ `rebuild_flowty_loans` has **no committed
migration at all**, so it cannot be pinned until its DDL is committed; dumping live `prosrc` into a test
file would pin whatever is deployed with nothing asserting the repo agrees.

⚠ **And expect the fixture, not the assertion, to be the weak part.** `dispatch_due_deal_alerts` had
**two of five mutations survive** its first fixture, both reading as thorough coverage:

1. Dropping `COALESCE(min_discount, 25) = 0` from the price-cap predicate survived because **the only
   subscription carrying a `max_price` was the price-only one** — so the wrong predicate selected the
   same row. Fixed by giving the ordinary sub a `max_price` too.
2. Replacing the per-sub pool guard with `pool IN ('price','deals')` survived because the one deals row
   was $20 against a $0.60 cap — **the price filter excluded it whatever the pool guard did.** Fixed by
   adding a $0.50 deals row *inside* the cap.

⚠ A sixth mutation **survives on purpose** and the file says why: `IF v_price_cap IS NOT NULL` → `IF
true` changes nothing, because the INSERT it guards filters on `low_ask <= v_price_cap` and `<= NULL`
is NULL. **Document an unreachable clause rather than chasing it with a contrived assertion.**

⚠ Three dependency stubs were needed for branches **no case exercises** (`pinnacle_catalog`, `sales`,
`get_edition_badges_unified`): **plpgsql plans the whole statement**, so a missing relation fails on
PLANNING and reads like a broken test rather than a missing table.

### ⚠ The three gates share `coverage/`, and the invariant saying they must not is unimplemented

`.gitignore` states *"the two gates must run into SEPARATE `reportsDirectory` dirs or they corrupt each
other's `coverage/.tmp`"* and ignores `/coverage-*` — but **no config sets `reportsDirectory`**, so that
ignore line guards directories nothing creates. Two gates run concurrently kill each other with
*"Something removed the coverage directory"*. CI is safe (separate jobs); a local parallel run is not.
**A documented invariant with no implementation and no test is the same shape as an unenforced guard.**

### ⚠ A retry loop placed after a command that can fail is DEAD CODE under `bash -e` — and it reads as coverage

Found 2026-08-18 in `.github/workflows/ops-monitor.yml`. The step carried an explicit, well-written
three-attempt retry and a comment promising *"Fail only if all attempts are non-200, so a single blip
doesn't red the monitor."* It had never once retried.

GitHub Actions runs `run:` blocks under `shell: /usr/bin/bash -e`. The loop body opened with

```bash
RESPONSE=$(curl -s --max-time 35 -w "\n%{http_code}" ... )
```

and under `-e` a **non-zero exit from curl itself aborts the whole step at that line**, before any
retry, any `HTTP_CODE` test, or any diagnostic `echo` below it. So the protection covered exactly one
failure mode — a **non-200 response**, where curl still exits 0 — and never covered a **timeout**
(`exit 28`), which is the cron-saturation case the retry was written for. The sibling
`data-integrity` step had the same shape and failed as a bare `28` instead of reaching its own
`::error::data-integrity returned HTTP …` line, making the failure undiagnosable from the log.

Fix is `|| true` on the assignment so the script's own logic decides:

```bash
RESPONSE=$(curl -s --max-time 35 -w "\n%{http_code}" ... ) || true
```

⚠ **Verify this class in BOTH directions — the two behaviours are one character apart and look
identical in review.** The control that settles it:

```bash
bash -e -c 'R=$(curl -s --max-time 2 -w "\n%{http_code}" http://10.255.255.1/ ); echo "after"'   # exit 28, "after" NEVER prints
bash -e -c 'R=$(curl -s --max-time 2 -w "\n%{http_code}" http://10.255.255.1/ ) || true; echo "after"'  # prints, code=000
```

Note the repaired path yields `HTTP_CODE=000`, not empty — curl still writes its `-w` output on
timeout — so a `!= "200"` test retries correctly and the final message names `last: 000`.

⚠ **It is NOT only curl, and the first fix missed the sibling.** Re-running the monitor after
guarding both curls showed `fmv-staleness` retrying correctly (`Attempt 1/2/3 — HTTP Status: 000`)
while `data-integrity` printed `HTTP Status: 504` and died on **exit code 5** — `jq` exiting non-zero
on a non-JSON (HTML error page) body:

⚠ **And the obvious candidate was the WRONG line — only a third live run found it.** Guarding the
`ISSUE_COUNT=$(… jq …)` assignment did not fix it; the step still died on 5. The actual culprit was
the jq **inside the branch**, which happened to be the branch's LAST command:

```bash
if [ "$ISSUE_COUNT" != "0" ] && [ "$ISSUE_COUNT" != "null" ]; then
  echo "::warning::$ISSUE_COUNT data integrity issues found"
  echo "$BODY" | jq -r '.issues[]' 2>/dev/null      # <- exit 5 aborts the step HERE
fi
```

**Do not reason about which line aborts — re-run and read the log.** I named the wrong line twice.

⚠ **The guard then introduced a fresh honesty bug, which is the reason to re-run rather than
assume.** With an unparseable body `ISSUE_COUNT` is empty, and empty passes `!= "0"` and
`!= "null"`, so the step published `::warning:: data integrity issues found` — a blank count
rendered as a positive finding, off a 504 HTML page. **An empty read is not a count of zero and not
a count of anything**; the branch now requires `-n "$ISSUE_COUNT"` first. Verified end state:
`::error::data-integrity returned HTTP 504` then `exit 1`, with no fabricated warning.

⚠ **`2>/dev/null` hides the MESSAGE, not the EXIT CODE** — it looks defensive and is not. So the
step still never reached its own `::error::data-integrity returned HTTP 504`. **Audit every
command-substitution assignment in an `-e` block, not just the obvious network call**; `jq`, `grep`
(exit 1 on no match) and `head -n -1` are the usual suspects. ⚠ And the tell that there is a second
instance is an exit code that is **neither 0 nor the script's own** — a bare `5` or `28` where the
script only ever writes `exit 1`.

**Generalise it:** in any `-e` block, a conditional, a retry, or an error message placed *after* a
command that can legitimately fail is unreachable. This is the shell instance of the standing rule
that a guard's own construction fixes its blast radius, and of the rule that a permanently-red
instrument is indistinguishable from a broken one — this monitor's red was real, but its stated
tolerance was fiction.


---

### ⚠ Look for a monitor whose input set includes another monitor's OUTPUT

**Displaced verbatim from CLAUDE.md on 2026-08-21** to make room for the exclusion-premise rule below,
which is the same family and cost more. Nothing here changed:

> ⚠ **Look for a monitor whose input set includes another monitor's OUTPUT** — a concierge health check
> counted its own smoke suite's fixtures and reported an outage that was not happening.

### ⚠ An exclusion justified by ANOTHER instrument is a claim about that instrument — 2026-08-21, 7 live defects

The full case behind CLAUDE.md's one-line rule.

Two of the repo's honesty guards skip the route tree, and both said why in code:

    // app/api/** is the ROUTE tree — server code, already in the primary gate.   (client-failure-collapses-to-empty-ratchet)
    /** Every .ts/.tsx outside `app/api`, which the primary gate already measures. */  (server-page-data-access-ratchet)

**The exclusions are correct — neither guard is about routes. The REASON was false.** "The primary gate"
is the vitest **coverage** gate. Coverage measures whether lines EXECUTE; it cannot see an unhandled
error branch, **because the branch does not exist to be uncovered**. A happy-path route test gives an
unguarded `const { data } = await supabase…` 100% coverage. So the sentence that read as "this is
covered elsewhere" meant "nothing checks this".

**What it cost:** 7 live instances found in one evening — 4 in Fast Break (incl. a market claim,
"Not currently listed", published out of a failed `cached_listings` read) and 3 more in
`cost-basis` / `market-movers` / `edition-stats`. `cost-basis` was the sharpest: a failed
`collection_config` read collapsed to `null`, the caller reads null as "no filter requested", and the
RPC then returned **every** collection the wallet holds inside a single-collection tab — a different
question answered silently, about the reader's own money.

**Measured population** (multi-line-aware detector, with a positive control):

| tree | files | reads **with** `error` (control) | **without** |
|---|---:|---:|---:|
| `app/api/` | 453 | 492 | **259** (35%) |
| `lib/` | 297 | 101 | **21** (17%) |
| `workers/` | 17 | 11 | **0** |
| `components/` | 161 | 0 | **0** |

⚠ **My FIRST measurement said 32 — wrong by 8×.** The detector used `[^\n;]*?` between `await` and
`.from(`, which **cannot cross a newline**, and this repo puts `.from()` on the next line. Caught only
because the count barely moved after four fixes. **The positive control is what makes 259 a finding
rather than a regex that matches everything.**

⚠ **The remainder is NOT a to-do list.** A file-scoped version of this predicate is already recorded as
producing 12 false positives, because "losing a buyer address degrades a FIELD while losing an event
range moves the CURSOR — same expression, opposite correctness". Triage on: **does a swallowed error
become a CLAIM?** `workers/` and `components/` are clean; `lib/`'s 21 are mostly concierge/ingest
(off-limits) or benign (the `alerts.ts` ones are username lookups with an honest wallet-address
fallback). Full triage tiers:
`docs/overnight/inbox/2026-08-21T1945Z-259-route-reads-…`.

## The 2026-08-17/18 guard sweep — five guards, one shape (promoted from session log)

Five separate guards were found defective in ~12 hours, and **every one failed the same way: the
DERIVATION was wrong, not the logic.** Recording them together because the individual fixes are far
less useful than the pattern.

| guard | how it was silent |
|---|---|
| `insights-client-dates-are-hydration-safe` | scoped to `ROOTS = ["app/insights","components/insights"]` — the two dirs the same pass had driven to zero, so green by construction everywhere else |
| `seo-shared-helpers-inherit-og-twitter` | pinned three helpers **BY NAME**; 43 inline metadata blocks called no helper |
| `server-page-data-access-ratchet` | walked `entry === "page.tsx"`, so a `layout.tsx` or server component was outside it |
| smoke battery's `cached_listings` check | prior sweeps were scoped by **call-kind** (RPCs); this was the only direct TABLE read |
| `check-tree-corruption.mjs` | **nothing invoked it at all** — see below |
| `anon-api-no-driver-message-leak-guard` | *(a SIXTH, found 2026-08-18)* excluded `app/api/{admin,cron}/**` and asserted that exclusion with a **file-level** grep — see below |

### ⚠ An exclusion asserted per-FILE cannot defend a property that is per-HANDLER

`anon-api-no-driver-message-leak-guard` skips `app/api/admin/**` and `app/api/cron/**` wholesale, and
it is careful about it: a companion test asserts *"every excluded admin/cron route really does gate
itself on a secret"*, so the exclusion cannot quietly come to cover an ungated route. **That
companion greps the FILE.** The surface it is defending is per **handler**.

**`export async function GET()` takes no parameters, so it cannot read a header, a cookie or a query
param — it cannot authenticate anyone** — and `isPublicPath` returns true for both prefixes, so the
proxy steps aside and every anonymous caller reaches the body. A gated `POST` in the same file
satisfied the grep and vouched for the ungated `GET` beside it. Measured 2026-08-18: **four such
handlers, all four dishonest** — a `count ?? 0` publishing a measured zero out of a timeout, two
returning `error.message` to anyone, and one discarding its error into `ok: true`.

Two method notes, both bought at the usual price:

- ⚠ **The first measurement said 22 and was mostly false positives.** A static "which handlers reach a
  gate" walk missed `const TOKEN = process.env.INGEST_SECRET_TOKEN` at module scope and
  `export const GET = handler`. Spot-reading five found four gated. **Discard a sweep that cannot
  survive five hand-reads; do not publish its number.** The replacement predicate is decidable from
  the declaration alone — an empty parameter list.
- ⚠ **Zero-arg does not imply unauthenticatable.** `cookies()` / `headers()` from `next/headers` are
  ambient in the App Router, so a zero-arg handler importing them CAN authenticate. The guard checks
  the import list too; without that it is a false-positive machine.

**Generalise it:** when a guard buys its scope with an exclusion, the assertion defending that
exclusion must be at the same granularity as the property. A file-level answer to a handler-level
question is not a weaker guard — it is a guard that reports green on the exact case it excluded.

### ⚠ Ask what RUNS a guard, not whether it passes

`check-tree-corruption.mjs` guards a documented mount-corruption failure. Its header says *"wire it
as a pre-commit hook"*. **Measured 2026-08-18: no CI job, no `.husky`, no `core.hooksPath`, no
`.git/hooks/pre-commit`; its only caller in the repo was the manual `scripts/clean-tree.mjs`.** It ran
when a human remembered. **A guard nobody invokes and a guard that passes are the same colour.**
Before trusting any `scripts/check-*.mjs`, grep for its callers in `.github/workflows/`, `package.json`
and hook config — not for its exit code.

### ⚠ And check its DEFAULT MODE before wiring it

That script defaults to inspecting **STAGED** content. On a CI checkout nothing is staged, so it
prints `0 file(s) checked, clean` and exits **0** — a job that passes by inspecting nothing. **Wiring
it naively ships the theatre, not the guard.** The `tree-corruption` job therefore runs `--all` **and
asserts the reported file count** (`>= 1000` against ~4,774 tracked). Removing `--all` makes that
assertion fire. **Any guard whose scope is a flag needs its scope asserted, not assumed.**

⚠ It earned its place on first run: a literal **NUL byte committed** in `lib/concierge/rich-text.ts`,
inside a URL sanitiser's control-character class written with three raw control bytes.

### ⚠ A coverage number that MOVES can be a vacuous test, not a noisy gate

`component-tests` sat 0.004pt above its `functions` threshold and oscillated. The cause was not a
flaky gate: `"appends the next page rather than replacing the loaded rows"` **passed without clicking
Load More**. An auto-paginate effect (300 ms sleep) raced the click; when it won, the button unmounted,
`handleLoadMore` never ran, and the id assertion still passed because auto-paginate had appended the
row itself. **Proved by checking out the pre-fix test, deleting the click entirely, and watching it
pass.** The only instrument that ever saw it was a coverage count moving by 2.

Two traps found while fixing it, both worth knowing before writing a similar test:
- **Freezing the clock is not enough** — the effect calls `setLoadingMore(true)` BEFORE its sleep, so
  holding time under 300 ms leaves the button permanently disabled and unclickable.
- **Keying a mock on CALL ORDER is not enough** — the initial search issues more than one request on
  its own, so the dead-end payload lands on the wrong call. Key on a request PARAM plus an occurrence
  count.

### ⚠ A control that proves the NUMBER is right does not prove the FILE still runs

`audit_20260818_repoint_panini_dry_days_arm…` re-pointed a trust arm onto a live column and verified
both the headline value (`dry_days = 2`) and the revert control (`5`). Both true. **Neither covered
the two sub-cases below them**, which still wrote the DEAD column: the recovery assertion (`want 0`,
got 2) and a 57014 timeout probe whose stub declared only the old columns, so the leg failed with
`undefined_column` — which `WHEN OTHERS` **does** catch — and the error it was probing for never
surfaced. **A dead-column write changes no expected value; it just silently stops doing anything.**
⚠ The second break was invisible until the first was fixed — a pgTAP file aborts at the first ERROR,
so one fix reveals the next. Budget for a chain, not a fix.

### ⚠ Concurrent coverage runs publish FABRICATED numbers (fixed 2026-08-18)

All three vitest gates defaulted to `coverage/`. `.gitignore` documented the separate-directory
invariant in prose; **no config implemented it.** Running the primary and component gates at once:
one dies loudly (`Something removed the coverage directory`), and **the other does NOT crash** — it
loses the deleted `.tmp` chunks and reports the remainder as a measured result (82.27 st / 80.61 fn
against true 90.68 / 89.25), failing as a **threshold violation** that reads as *"your diff broke
coverage"*. Now `coverage` / `coverage-components` / `coverage-workers`, pinned by
`__tests__/vitest-gates-have-distinct-coverage-dirs.test.ts`, which **globs `vitest*.config.*`** so a
fourth gate is covered the day it lands. CI was never affected (separate jobs); the cost was entirely
on local and agent runs.

---

## LAYOUT is a defect class no gate in this repo can see (2026-08-22)

**Promoted from CLAUDE.md's "Guards, tests and instruments" section, which now carries only the one-line rule.**

### Why it is invisible

`vitest` + jsdom returns a **zero box** from `getBoundingClientRect()` for every element, and coverage
measures whether a line RAN, not what it measured. So a component can render at 3.5× its specified size
with `tsc`, eslint and both coverage gates green — the MARKUP is correct; only the LAYOUT is wrong.

### The case that proved it

`components/WalletSearchBand.tsx` specified "~112px total — one band, not a hero" in its own header
comment and rendered **350px** tall at 390×844 (and at 320px) for four weeks, above the fold on every
`/[collection]/*` and `/insights/*` page, for the anonymous mobile visitor the band exists for.

Cause: the input wrapper carried `style={{ flex: "1 1 300px" }}`. **`flex-basis` sizes the MAIN axis**,
and `.rpc-wsb`'s `@media (max-width:640px)` rule flips that axis from width to HEIGHT — so the 300px
width-basis became a 300px height, and **an inline style is exactly the one declaration a media query
cannot override**. Desktop was correct throughout (82px at 1440 / 1024 / 700 before and after), which is
why nobody caught it. After the fix: 102px.

The generalisation: **a size that changes MEANING at a breakpoint must not be an inline style.** Guarded
by `scripts/check-responsive-flex-basis.mjs` (ban at population zero; joins by class name so a component
styled by the global token sheet is in scope; also covers Tailwind's `flex-col sm:flex-row`).

### The instrument

`e2e/mobile-layout.spec.ts`, in the scheduled `e2e-smoke.yml` monitor (NOT the PR gate — same posture as
`smoke.spec.ts`, a live hiccup must never block a merge). It runs against `SMOKE_BASE_URL`, so it is the
only thing here that can check a layout claim **against production**. Every assertion is a ban at a
population that was zero when it landed:

* no horizontal scroll at 390px on five public routes;
* the bottom `MobileNav` tabs ≥44px in both axes;
* navigation controls' 44px HIT AREA reachable (hit-tested, not box-measured — see below);
* the wallet band ≤160px tall.

⚠ **`/[collection]/overview` is deliberately absent from its route list.** The 2026-08-22 13:15Z run
failed with `page.goto: Timeout 30000ms` on four collections' overview pages; that is a SLOWNESS signal
`smoke.spec.ts` already reports, and a navigation timeout in the layout spec would raise a LAYOUT alarm
for it. A monitor that cries wolf stops being read.

⚠ **It asserts PRESENCE rather than skipping.** The band check originally had `test.skip(band === null)`.
A post-deploy run reported "4 skipped" and the CI tail names the flaky test but NOT the skipped ones — so
"the band stopped rendering entirely", a worse regression than it being too tall, would have been a
silent non-result inside a 97-test monitor.

### Running it locally

`npm run dev` with placeholder Supabase env, then
`SMOKE_BASE_URL=http://localhost:3000 PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test e2e/mobile-layout.spec.ts`.
⚠ In a Claude Code web sandbox, Playwright's own browser build is ABSENT (the repo pins a newer revision
than `/opt/pw-browsers` carries) — pass `executablePath` and `--no-sandbox`. ⚠ The agent proxy answers
**403 to CONNECT for www.rippackscity.com** (org network policy, not a transient failure), so production
cannot be measured from there at all; dispatch the workflow instead.

⚠ **A local dev build runs with non-working Supabase credentials**, so data-driven controls are absent.
A clean local result means "the chrome and the empty-state layout are clean", never "the page is clean".

### Two `elementFromPoint` false positives that cost a wrong reading

1. It returns **null for any coordinate outside the VIEWPORT**. The collection tab bar and the switcher
   row are `overflow-x: auto`, so a control scrolled out of view read as a broken hit area.
2. **`NEXTJS-PORTAL`** — the DEV error-overlay root, absent in production — intercepts points and reads
   as click theft.

---

## The unbounded-server-read ratchet (2026-08-22)

Fourth occurrence of one class, **the same error string every time** — `Timed out acquiring connection
from connection pool`:

1. `first-mint` → `BOARD_LIVE_TIMEOUT_MS`
2. `/analytics/sets` → `SET_DETAIL_TIMEOUT_MS`
3. `/insights/market` + `market-pulse` → **two ERRORed production builds**, 2026-08-15
4. `/[collection]/overview` → four collections' pages hung 30s, 2026-08-22

⚠ **Occurrences 1–3 were each fixed on the ONE page that failed**, and
`__tests__/insights-server-pages-bound-their-reads.test.ts` was written to make it shape-level. It walks
`app/insights`, so **occurrence 4 was outside it BY CONSTRUCTION** — this repo's own "ask what a passing
guard is structurally SILENT about" rule landing on the guard written to satisfy it.

`scripts/check-unbounded-server-reads.mjs` is the population that ban cannot see: async server
`page.tsx`/`layout.tsx` under `app/**`, imports followed to depth 3, counting those that reach a Supabase
read with no budget primitive. **A RATCHET, not a ban** — the population cannot be driven to zero in one
pass (several surfaces are on the roadmap's untouchable list, and several have **no honest-degraded
branch to reject INTO**, so bounding them blind turns a slow page into a thrown error boundary, which is
worse than slow). Ceiling started at 17. **Lower it in the commit that bounds a page; never raise it.**

⚠ **The first count was 31 and wrong: `Array.from(` matched a loose `/\.from\s*\(/`.** supabase-js takes
a STRING first argument on both `.from()` and `.rpc()`, so the pattern requires one — 31 → 19. An earlier
filing's "23" is superseded.

⚠ **Blind spots:** depth-3 import following misses barrels and dynamic imports, and **it cannot tell a
read that BLOCKS the stream from one inside `<Suspense>`** — Suspense is a legitimate answer to this class
and still counts here.

### The `/overview` mechanism, because it generalises

`app/(collections)/[collection]/overview/layout.tsx` — the overview **SEGMENT's own layout**, not the
shared `[collection]/layout.tsx` — awaits `<PopularOnCollection>`, an async server component, with **no
Suspense boundary**. `revalidate = 3600`, and every deploy empties the ISR entry, so the first request per
collection does the read inline with the whole document waiting on it.

⚠ **Vercel logged `200` for every one of those requests.** The streaming shell answers instantly, so a
read that hangs is only ever visible as a document that never finishes — the "200-but-broken-DOM" class in
its LATENCY form.

⚠ **Grepping "the page and its layouts" is not grepping "the segment's layouts".** I first concluded the
overview page did no server work — true of `overview/page.tsx`, `[collection]/layout.tsx`,
`(collections)/layout.tsx` and the root layout. In the App Router those are different sets.

⚠ **Suspense was considered and rejected here.** It would also unblock the stream, but that block exists
to put server-rendered internal links in the DELIVERED HTML for crawl equity. Bounding leaves the success
path byte-for-byte identical and only changes behaviour when the read was already failing.

`withBoardBudget` gained an optional `prefix` (default `"insights/"`, so all 36 existing call sites are
byte-identical) — an `[insights/…]` label on a non-insights surface sends an operator to the wrong
subsystem.

---

## eslint is NOT in CI, and that is a decision (2026-08-22)

`grep eslint .github/workflows` returns nothing; `package.json` has the script and no job calls it.
**Do not cite eslint as coverage anywhere**, and do not wire it in without re-making this decision:

`npx eslint .` reports **6,373 problems (5,925 errors)**, of which **5,633 are
`@typescript-eslint/no-explicit-any`** — a convention CLAUDE.md explicitly sanctions ("Supabase client
typed `any` in API routes"). Adding the gate would make CI permanently red on a rule the repo chose.

The one subset worth a look is `react-hooks/set-state-in-effect` (**60** instances, a real correctness
smell — `components/MobileNav.tsx:44` is one). 60 is not a ban either; it would need a ratchet.

---

## Displaced from CLAUDE.md — full case histories (verbatim)

Both bullets below were condensed to their rule in CLAUDE.md on 2026-08-22 to make room for the LAYOUT
instrument. The rules still stand; only the examples moved.

> - ⚠ **Ask what RUNS a guard, not only whether it passes** — `check-tree-corruption.mjs` had no CI job
>   and one manual caller, and its default staged-only mode inspects **nothing** on a CI checkout
>   (`0 file(s) checked`, exit 0). Wiring it naively ships the theatre: **assert the count it inspected**.
>   Its first real run found a committed NUL byte in a URL sanitiser.

> - ⚠ **A permanently-red or permanently-zero instrument is indistinguishable from a broken one at a
>   glance** — `edge-fn-drift` was loudly correct for a week while naming the function fabricating 161k
>   rows, and nobody read it. Check the LOG, not the badge. ⚠ **Before relying on a watcher, prove it can
>   see a FAILURE** — an unreachable monitor and a green build look identical.

## The instrument audit of 2026-08-22 — three daily detectors, and the question that paid

CLAUDE.md's standing rule is **"ask what RUNS a guard, not only whether it passes."** Applied to the three
`check-*.mjs` scripts that are NOT wired into `ci.yml`, it returned nothing: each has its own daily workflow
(`edge-fn-drift` 06:40Z · `db-pin-staleness` 07:20Z · `migration-parity` 07:40Z). **The question that paid
was the next one down: not whether they run, but whether anyone READS what they say.**

Measured that day: **edge-fn-drift red 14 consecutive runs** (since 08-09; run #1 on 08-08 is its only pass
ever) · **db-pin-staleness red 13** (since 08-10) · migration-parity 14/14 green. ⚠ **Both red ones were
LOUDLY CORRECT** — 25 edge functions provably not running `main`, and 6 of 187 DB pins no longer matching
live. Neither was broken; both were being ignored. CLAUDE.md already records this happening to
`edge-fn-drift` once before, which makes 2026-08-22 the **second** time for that detector and the first for
a second one — a property of the estate, not an incident. Registered as known-issues **#23/#24/#25**.

⚠ **The structural gap (#25) and why the obvious fix is wrong.** The hourly sentinel is what actually gets
read, and it has **no GitHub Actions arm**. A watchdog *workflow* would be the same problem one level up —
something else nobody reads. The fix belongs in the sentinel, keyed on a failure **STREAK** (a single red is
normal for a detector doing its job), and it is blocked on a secrets decision: the sentinel runs on Vercel
and needs a GitHub token with `actions: read`.

### A detector that cannot distinguish "clean" from "did not look"

`check-edge-fn-drift.mjs` tier 2 — which its own header calls *"the only census"*, tier 1 being *"a LOWER
BOUND"* — swallowed every body-read failure into a bare `catch {}` commented *"tier 1 still covers it"*. It
does not. **A run whose census read nothing printed the identical DRIFT number to one that completed and
found nothing.** The persisted artifact was worse: it carried no tier-2 field at all, so a function tier 1
called clean but whose body had drifted was recorded as `"clean"` — the series asserting the opposite of the
finding. Now reports `bodies_read` / `bodies_failed` / `content_drifted`, carries `ran` as a **positive
control**, adds a `clean_tier1_only` verdict, and refuses an all-clear it did not earn (a 200 with no
`index.ts` counts as a FAILED read, else an API shape change silently converts the census into a permanent
all-clear).

### A comment claiming a mirror is not a mirror

Three copies of the same DDL extractor exist. The drift guard learned about `PROCEDURE` on **2026-08-16**,
recording that a FUNCTION-only needle *"made every PROCEDURE in this database UNPINNABLE"*.
`check-db-pin-staleness.mjs` — whose own comment says it *"mirrors the guard's own parser"* — did not get the
fix for six days. ⚠ **Grepping the EXPRESSION rather than the file then turned up a THIRD copy**,
`scripts/verify-live-ddl.mjs`, also FUNCTION-only, whose header likewise claimed it extracts DDL *"exactly
as"* the drift guard does. **Neither mirror claim was true, and only the expression grep found copy three.**
Consequence: because extraction failed, the live-drift comparison for `reconcile_all_saved_wallet_stats`
**never ran at all** while it sat in the PINS array looking covered. **A pin that cannot parse its own DDL
asserts nothing** — and it reports that as a chore (`NO_DDL_IN_MIGRATION`) rather than as a gap.
Pinned by a test that derives the extractor-copy set **by scanning** for the needle shape (a curated list is
exactly how copy three was missed), with a floor of ≥3 copies so a broken detector cannot pass.

## Provisioning the DB-invariant suite locally (2026-08-22)

`scripts/run-db-tests.sh` needs only a vanilla Postgres 16, and this sandbox has one. CI provisions it with
`initdb` + `pg_ctl`; the sandbox runs as **root**, so `initdb` refuses unless invoked through `su postgres`:

```
PGBIN=/usr/lib/postgresql/16/bin; PGDATA=/var/tmp/pgdata-rpc
mkdir -p "$PGDATA" /var/tmp/pgrun && chown -R postgres:postgres "$PGDATA" /var/tmp/pgrun
su postgres -c "$PGBIN/initdb -D $PGDATA -U postgres --auth=trust"
su postgres -c "$PGBIN/pg_ctl -D $PGDATA -o '-p 5433 -k /var/tmp/pgrun' -l /var/tmp/pg.log -w start"
DATABASE_URL="postgres://postgres@localhost:5433/postgres" bash scripts/run-db-tests.sh   # 178 files
```

⚠ **It does NOT survive a session resume** — the cluster is stopped even though `/var/tmp/pgdata-rpc`
remains, so `psql` gives *"Connection refused"*. Re-`pg_ctl start` (re-`initdb` only if the data dir is
gone). Being able to run all 178 files locally is what made re-pinning six DB functions verifiable rather
than hopeful — and it caught nothing that CI later disagreed with.
