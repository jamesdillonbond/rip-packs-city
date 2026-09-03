<!-- Extracted from CLAUDE.md on 2026-08-17 to bring that file under the memory-file
char limit. Content is VERBATIM; CLAUDE.md carries a one-line pointer to this file.
Same rules apply: every number here is a dated sample - re-measure before quoting. -->


## Memory docs carry no duplicated blocks (`memory-docs-have-no-duplicated-blocks`, added 2026-08-27)

🚨 **A scripted insert duplicated half a reference doc and NOTHING SAW IT FOR TWO DAYS.** On 2026-08-25
(`3592f1d6d`) an edit to `routes-and-surfaces.md` split a bullet **mid-token** and pasted a 46-line copy of
the file's own opening — header comment, first `## ` section and all — into the middle of it. The file
carried two copies of half its content and a sentence ending `then a \`^[0-9]+` followed by a document
header. **Every guard in the repo stayed green**: the link guard checks link TARGETS, the retired-rule guard
checks ABSENCES, coverage has no opinion about markdown. ⭐ **It was found by eye during a tidy-up, and
"someone will notice" is not a detector** — hence this one.

**Three signals, each a BAN AT ZERO because none has a legitimate instance:** the extraction header
appearing **more than once** in a file (the 08-25 fingerprint) · a **repeated `## ` heading** inside one
file (how the SECOND instance was found the same day — `claude-md-condensed-originals.md` carried the same
"Displaced 2026-08-23" section twice, its quote identical after whitespace normalisation) · the extraction
header appearing **anywhere but the start of a line** (the seam itself).

⚠ **It walks the TREE (`docs/reference/**`, `docs/strategy/**`), not a curated list**, and **asserts the
number of files it inspected** — a walk that silently matched nothing would otherwise pass every case.
✅ **Both failure modes proven on the real tree, not a fixture:** appending a duplicate `## ` heading to a
live doc reddens it, and fusing the header onto a line of prose reddens two of the four cases; the tree is
green again on restore.

⚠ **THE FIRST DRAFT WAS TOO BROAD AND IS WORTH RECORDING.** The seam check originally read *"no prose before
any `<!--` on a line"* and **false-positived on this very file**, which documents the inline
`<!-- retired-rule:allow <id> -->` marker in running prose — a marker whose entire design is to sit at the
END of a line. **A guard that fires on the thing it documents is noise**, so it was narrowed to the one
comment that is structurally a document header and can never legitimately appear mid-line.

## The known-issues register carries a generated STATUS INDEX (`npm run docs:issues-index`, added 2026-08-27)

**The register is the canonical open list, and it had 45 numbered items in one ~80 KB section with no way to
see them at a glance — 15 of which read RESOLVED / CLOSED / SHELVED / RETIRED in their own first sentence
while sitting under the heading `### Open`.** ⭐ **That mismatch has already cost sessions, in the opposite
direction: item #8's own text records that it "sat under a Resolved heading, so anyone enumerating the Open
list never saw it".**

⛔ **The fix is deliberately NOT to move or renumber anything.** The ledger, `focus.md`, inbox filings,
CLAUDE.md and migration record files all cite items by number, so re-sorting breaks every citation. The
index is **additive**: number → status → title, between generated markers, with the body untouched.

⚠ **Status is DERIVED from each item's own first sentence**, never curated — so the index cannot silently
disagree with the item, and a row that reads wrong means the ITEM's opening words are wrong. The
closed/partial boundary is the trap the derivation is unit-tested on: **"PARTLY RESOLVED" contains
"RESOLVED"**, and a re-opened item names its own resolution history while still being open.

**Guard: `known-issues-index-lists-every-item`** — a ban at zero checked in BOTH directions (a missing row
hides an item; a dangling row asserts one that does not exist), plus byte-identity against a fresh
regeneration, plus an assertion that it inspected a non-zero population. ✅ **Proven able to fail on the real
file:** inserting a real item without regenerating turns `--check` red (exit 1) and reddens three cases.
⚠ **`closed` in that index means the item SAYS it is closed — it is not a re-verification.**

## Retired rules must not survive in live memory (`npm run memory:retired:check`, added 2026-08-24)

⭐ **Built because every fact corrected during the 2026-08-24 memory refresh was wrong on MORE THAN ONE
surface, and two were still being found AFTER the pass that "fixed" them.** Nothing had decayed — the
corrections had never PROPAGATED:

<!-- retired-rule:allow limit-10000-lifts-the-postgrest-cap -->
- **`.limit(10000)`** was corrected in `RPC_DESIGN_SYSTEM.md` §5 and left intact in the **§0 CHECKLIST of the
  same file** — the section headed *"run through this on every edit"*. **A file contradicting itself.**
- **The retired iPhone-copy-paste handoff rule** was corrected in §10 and in the `rpc-handoff` skill on
  **2026-07-25** and was still sitting in **CLAUDE.md**, the highest-authority memory file, on 2026-08-24.
- A third copy sat in `claude-md-condensed-originals.md`. ⚠ **That file is verbatim history — but CLAUDE.md's
  index points readers at it with *"check here first if a detail seems missing"*, which makes it a LIVE lookup
  surface.** An unmarked retired rule there is handed out as a live answer, so it got a correction note rather
  than a bare suppression. **"It's only history" is a claim about how a file is READ, not about where it sits.**

**Scope: a TREE WALK over `CLAUDE.md` + `RPC_DESIGN_SYSTEM.md` + `docs/reference/**.md` +
`docs/cowork-skills/*/SKILL.md`** — 33 files / 6,268 lines as of 2026-08-24. ⛔ **Frozen history
(`docs/sessions`, `docs/archive`, `docs/overnight`) is excluded on a stated POLICY**, not on a claim that
another instrument covers it: recording retired text is what a ledger is FOR, and a tree-wide ban would be
**permanently red**, which this file already says reads identically to a broken instrument.
⛔ **The `.skill` bundles are deliberately NOT scanned** — the bundle-parity guard binds every bundle to its
`SKILL.md`, which IS scanned, so a retired rule cannot reach a bundle without passing this guard first. **That
is a claim about a specific sibling instrument: if bundle parity is ever removed, re-scope this one.**

⚠ **Each pattern matches the RETIRED SPELLING, never the topic.** A topic-matcher reds on the correction
itself, and the suppression list then swallows whole files — this repo has had at least six guards fire on the
comment documenting the fix.

**Suppression IS the curated list**, as CLAUDE.md prescribes. A doc that must QUOTE a retired rule marks that
line, or the line immediately above, with `<!-- retired-rule:allow <id> -->`. ⚠ **The marker is deliberately
adjacent-only** — a wider lookback would let one marker launder every later violation in the file, and there
is a test arm for exactly that. Suppressions are **counted and printed** (7 today), so sprinkling them is
visible rather than silent.

⚠ **The live 15-file floor was UNTESTABLE at first** — it is skipped under `--root` because a fixture is
deliberately small, so its logic could never be observed failing. Added `--min-files <n>`, which a fixture may
pass but **live ignores by construction** (`IS_LIVE ? LIVE_MIN_FILES : …`), with an arm asserting that
structure so the flag cannot become a hole.

**12 test arms**: three planted offenders, a no-change control, an inspected-nothing arm, a floor arm, the
adjacent-only-suppression arm, and a wrong-id-does-not-suppress arm. Proven to red on a planted violation in a
file the author never touched, which is what shows the tree walk reaches new files.

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
  ⚠ **AND THE SAME GAP BIT FROM THE OPPOSITE DIRECTION 2026-08-27: a SUPPRESSION added on assumption became the error.** A new guard test imported a plain `.mjs` script and carried `// @ts-expect-error - plain .mjs script, no types`. This repo's tsconfig resolves that import fine, so the directive was **unused — TS2578** — and reddened `npx tsc --noEmit` while **vitest ran 15,248 tests green and the coverage gate exited 0**. ⭐ **A suppression is a CLAIM ABOUT THE COMPILER, and vitest never evaluates it: verify it against `tsc`, never infer it from a file extension.** ⚠ **The cost was not the type error — it was that six CI guards are sequenced after `tsc` in the same job and were SKIPPED** (see the job-step section below). **Run `npx tsc --noEmit` before pushing ANY new or edited `.ts`/`.tsx` test file; a green vitest run is not evidence about types.**
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

### 🚨 The JOB-STEP twin of that rule: a guard sequenced after a fallible step in the SAME job is GATED ON IT

**Measured 2026-08-28, run `33142460652` (`5479b6f89`).** The `typecheck` job's only failure was
`npx tsc --noEmit` — one unused `@ts-expect-error`. The job report then shows the next **six** steps
`skipped`:

`check-brand-tokens` · `check-memory-doc-links` · `check-driver-message-leaks` ·
`check-unhandled-third-state` · `check-responsive-flex-basis` · `check-unbounded-server-reads`

**Four of the six are honesty-family guards.** GitHub skips every later step in a job once one fails,
so **ANY type error switched all six off**, and nothing said so — the job named the tsc error, which
reads like one problem with one fix. A commit could have landed violating any of the six while CI
displayed only an unrelated line about types.

⭐ **The rule is CLAUDE.md's "ask what RUNS a guard, not only whether it passes", at job-step
granularity: a guard is gated on every fallible step ahead of it in its own job.** Reading the badge,
or even the job's failure message, does not reveal it — only the per-step conclusions do.

**Fixed** by putting `if: ${{ !cancelled() }}` on all six: they are independent of `tsc` and of each
other, and are pure node with no deps, so nothing was ever gained by gating them. ⚠ `!cancelled()`
rather than `always()`, so a cancelled run still stops.

⚠ **This generalises past these six — audit any job that runs guards after a build or typecheck step.**
And note the shape of the near-miss: the guards were not deleted, disabled or misconfigured. They were
**correctly written, correctly registered, and simply never executed.**

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

### 🚨 A GUARD SCOPED TO WHERE THE BUG WAS FOUND IS SCOPED TO THE PAST — third instance, 2026-09-03

The passage above records the shape once, for the Supabase-read class. **It has now happened three
times, in three different classes, and the third one is the cleanest statement of it.**

| # | class | the guard, and the glob it froze | the next instance, and why it was outside |
|---|---|---|---|
| 1 | server pages with an unbounded Supabase read | `insights-server-pages-bound-their-reads` walks `app/insights` | `/[collection]/overview` hung 30 s — not under `app/insights` |
| 2 | unbounded `fetch` on an OG card | `og-fetches-are-bounded` walks `app/api/og/**` + `lib/og/**` | `app/api/badge-image` + `app/api/moment-thumbnail` — not under either |
| 3 | *(the pattern itself)* | — | — |

**Instance 2 is worth reading closely, because the guard was excellent.** On 2026-08-29 it drove its
class to a MEASURED zero — *30 bare calls across 28 files, none carrying a signal* — asserted the
population it inspected, carried a curated-exemption list with the bound each exempt file uses
instead, and explained in its own header why a render check could not see the property. **It did
everything this repo asks of a guard except one thing: it took its file set from where the bug had
been found.**

Five days later `/api/badge-image` produced **463 `TimeoutError`s across 69 users in 24 h** — the
identical defect, one directory over, with the guard green the whole time.

⭐ **THE RULE.** When a class is driven to zero, the ban's population is the last decision to make,
and *"the directories where I found it"* is the wrong answer every time. Ask instead: **what is the
widest set where this property is even MEANINGFUL?** For an unbounded `fetch` that is every server
route, not the six that happened to fail. If that set is too large to ban, **ban at zero on the
subset whose failure answer is settled and RATCHET the rest** — which is what
`__tests__/image-proxy-routes-bound-their-upstream.test.ts` does: a ban on the three user-facing image
proxies (their answer is a status, so `<img onError>` can fall back) and a frozen ceiling of 26 over
the remaining `app/api/**`, where *"what should this return on a timeout?"* is a real per-route
decision.

⚠ **And do not read this as "always widen the glob".** Instance 1's ban is still correctly scoped —
`app/insights` pages genuinely share a degraded contract that other surfaces do not. **The error is
not narrowness; it is narrowness inherited from the incident rather than argued from the property.**

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

## 🚨 The unbounded-`fetch` ratchet, and six instrument lessons that cost real time (2026-08-27)

`__tests__/unbounded-fetch-in-after-routes-ratchet.test.ts` — sibling to the unbounded-server-read
ratchet above. **No NEW unbounded `fetch(` in an `after()` + `maxDuration` route; count down only
(`RATCHET`).** Same rationale as its sibling: a ban is not satisfiable today, and the correct timeout
is not a constant.

**Why this shape and not "unbounded fetch" generally.** `fetch()` has NO default timeout. In an
ordinary handler an upstream that accepts the connection and holds it open is merely slow. In an
`after()` route with a `maxDuration` it is **invisible**: the lambda is killed, so neither the success
path nor the `catch` runs, **no terminal `pipeline_runs` row is written at all**, and the outage reads
as *"the cron never fired"*. Measured on `/api/candy-listings-indexer`: 15 invocation heartbeats
against ONE terminal row in 48 h, while the PUBLIC `/insights/candy-mlb` board served asks **44 hours
stale**.

⭐ **The fix already existed one file away and had never spread.** `solUsd()` in
`lib/chains/solana/das.ts` — called by that route one line above the walk that hung — carries an 8 s
cap and a comment naming this exact failure mode. This repo's rule is *"when you find one, grep for
the EXPRESSION, not the file"*; here **it was not the DEFECT that spread by copy-paste, it was the FIX
that failed to.** A comment is only read by someone already in that file. That is what a ratchet is
for.

⚠ **Scope limit, stated so the guard is not over-trusted:** it walks `app/api` only. A `lib/` helper
reached FROM an `after()` route is out of scope by construction — `dasCall` was exactly that, and had
to be bounded by hand. **The guard cannot see a hazard one import away.**

### 1. ⛔ Size a deadline off the OBSERVED SUCCESS BAND, never off `maxDuration`

The first sweep budget shipped for the candy sweep was 240 s, reasoned as *"60 s of headroom under the
300 s `maxDuration`"*. **Every successful run on record took 375,699 / 389,236 / 391,226 ms — all
ABOVE the declared ceiling, all completing and logging.** `extra.duration_ms` is `Date.now() -
startedMs`, the same clock the budget uses, so **240 s would have truncated every healthy sweep the
pipeline had.**

**`maxDuration` is what the platform DECLARES; the success band is what the route actually GETS**, and
on Fluid Compute they disagree — `after()` work routinely overruns. Confirmed on four independent
pipelines the same night: `candy-listings` (391 s vs 300 s), `check-alerts` (84.8 s vs 60 s),
`topshot-listing-cache` (361.5 s vs 300 s), `allday-listing-cache` (344.3 s vs 300 s).

⚠ **A budget is invisible to every test that does not exceed it.** The route's tests mock a one-page
book that finishes instantly, so they passed either way and CI was green. It surfaced only from
reading the duration distribution.

⭐ **And the rule produces OPPOSITE actions on different routes, which is the point.** `sales-indexer`
(85/85 ok, p95 40 s, max 83 s vs 120 s) and both alert dispatchers got per-request timeouts and
**deliberately NO deadline** — they are finishing, so a budget could only truncate healthy runs.
**Read the distribution; the rule is not "add a budget".**

### 2. 🚨 A guard's POPULATION is as comment-sensitive as its assertions — and nobody re-checks it

`__tests__/api-og-insights-empty-vs-unavailable.test.ts` selected its 15 cards with
`readFileSync(p).includes("boardEmptyCopy(")` — **raw source**. Adding a comment to `candy-mlb`
*explaining why it cannot adopt that helper* contained the literal token and **enrolled the card in
the guard**, which then failed it on fetch-driven assertions it structurally cannot satisfy (the card
reads `supabaseAdmin` directly, so a `globalThis.fetch` mock cannot drive it).

⭐ **That file already warned about exactly this, one function ABOVE the offending line** — *"Any check
that greps source for user copy must strip comments — including the one you are about to write."* The
warning was applied to its `loading`-claim sweep and not to the selector beneath it. `boardCards()`
now strips.

**The generalisable half: a wrong population still reports a number.** The guard was green throughout;
it simply measured a different set. Related to *"ask what a passing guard is structurally SILENT
about"*, one level up: not what it asserts — what it asserts it ON.

### 3. ⛔ A detector validated only against the population it measures cannot report its own blind spot

The ad-hoc sweep that found this class used a regex requiring `;` or a newline after the closing
paren. It matched every real file (they are formatted that way) and **missed
`await fetch(u, {...}) })` entirely.** Every count published from it was a floor.

**It had a real consequence, not just a numerical one:** the regex was blind to `support-chat`,
`smoke-test` and `golazos-listing-cache`, so three of the four `*-listing-cache` siblings were bounded
and the fourth was left — *purely because the detector did not show it*. The ratchet balances parens
and carries **synthetic fixtures** (bounded / unbounded / mixed / zero-arg). **The fixture caught the
bug; running against the repo never would have, because the repo is formatted agreeably.**

⚠ **Never compare counts across detectors.** The "29" in the inbox filing and the ratchet's number
count different things; only the ratchet's is detector-verified.

### 4. ⚠ The SHARED comment stripper is not a guarantee that comments were stripped

`scripts/lib/strip-comments.mjs` (mandatory, `MAX_LOCAL_STRIPPERS` down-only) **does not blank** line
80 of `app/api/check-alerts/route.ts` — while blanking the identical line in isolation and in every
other file swept. So a comment documenting a fix was counted as code **through the mandated
protection rather than around it**. Original filing (symptom + four falsified hypotheses):
`docs/overnight/inbox/2026-08-27T0500Z-the-shared-comment-stripper-leaves-a-comment-line-intact-in-one-file.md`.

✅ **ROOT CAUSE FOUND AND FIXED 2026-08-27** — by that filing's own recommended next step
(instrument the state machine rather than bisect inputs further), which worked first try.
**A nested template literal inside `${...}` desyncs the machine.** The header called copying an
interpolation verbatim "the safe direction (KEEPING too much, never blanking too much)"; 🚨 **that
claim was false.** The inner opening backtick is read as the OUTER literal's closing one, after which
the machine sits in `code` **inside HTML text**, where `/` in `</td>` opens a regex and `//` in a URL
opens a comment — and it ping-pongs `tpl → regex → code` for the rest of the file.

⭐ **Both failure directions are the SAME desync, twenty lines apart in one file:** line 80's comment
left **INTACT**, line 100's real Telegram URL **BLANKED at `https:`**. That is why neither symptom led
to it — the recorded relative *hides code*, this one appeared to *expose comments*, and it is neither:
**the direction observed is an artifact of the text that follows.** ⛔ **So do not reason about this
stripper in terms of "which direction does it fail".**

Fixed with an explicit `tplStack` (interpolations parsed as code; braces counted only in `code` state).
⚠ Deliberate consequence: a `//` inside `${...}` **is** now stripped. Full suite **1,386 files /
15,204 tests green** — but read honestly that means no guard *depended* on the bug, **not** that none
was *misreading*. ⚠ **DEFECT 4 remains, known and unfixed: JSX text is not JS**, so an apostrophe in
`<p>Couldn't</p>` opens an `sq` state — **8 files** end desynced, in the genuinely safe direction.
⚠ **EOF state is a LOWER BOUND on the population** (9 before / 8 after, of 2,836): `check-alerts`
desyncs mid-file and re-syncs, so it is in neither count. Filing:
`docs/overnight/inbox/2026-08-28T0056Z-ROOT-CAUSE-FOUND-the-shared-stripper-desyncs-on-nested-template-literals-and-fails-BOTH-ways.md`.

**Displaced from CLAUDE.md 2026-08-27 to pay for the rule above, verbatim:** *a copy-pasted stripper
blanked 100k+ chars of real source and hid a live P0; **49** files import the shared one,
`MAX_LOCAL_STRIPPERS` ratchets at **2**, down only; at least six guards have fired on the comment
documenting the fix.*

⭐ **Tactic worth reusing: where a shared helper is unreliable, prefer a check that does not NEED it to
be right over one that assumes it is.** The ratchet skips zero-argument `fetch()` (never a real call
site), so its count no longer depends on stripping having succeeded.

### 5. ⚠ A retry loop only helps a TRANSIENT failure

`Install Flow CLI` reddened `main` twice in one hour with a **7-attempt exponential-backoff loop
already in place**. All seven failed **~65 ms in**, at *"Getting version of latest stable release"* —
`install.sh` resolving `latest` through the **unauthenticated GitHub API at 60 req/hr shared across
the runner IP pool**. Once that limit is hit the failure is deterministic for the hour; the loop's
whole budget is ~168 s. **It converted a fast red into a slow red.**

Fixed by passing the auto-minted `secrets.GITHUB_TOKEN` as `GITHUB_TOKEN` on both `Install Flow CLI`
steps (the script reads it, and falls back to unauthenticated on 403, so it cannot make things worse).
⛔ Deliberately NOT pinned to a version — that trades a CI-reliability problem for a coverage one.

**Ask what a retry is RETRYING.** The existing comment block was careful and correct about the failure
it was written for (a 2026-07-31 curl reset on the `raw.githubusercontent` fetch); this was a
different failure, at a different URL, in a different phase — and the loop was inherited as though it
covered both.

### 6. ⚠ A liveness probe must exercise the PRODUCTION CALLER's code path

`panini-run.bat` relaunched Chrome only when port 9222 was not listening. **A hung browser still
accepts TCP**, so it was never restarted and every run died on `connectOverCDP: Timeout 30000ms
exceeded` — 22 h, four missed bursts, a PUBLIC board drifting.

🚨 **The obvious upgrade is also wrong, and it was MEASURED rather than assumed:** against the
actually-hung browser, `GET /json/version` returned **HTTP 200** with a full version payload. **Three
probes of the same process disagreed — TCP said healthy, HTTP said healthy, the real client said
dead.** The preflight (`scripts/panini-cdp-preflight.mjs`) now does what the runner does
(`connectOverCDP`). Same family as *a control must use the PRODUCTION CALLER* and *probe THE ENDPOINT
YOU NEED, not any endpoint it should reach*.


## eslint is NOT in CI, and that is a decision (2026-08-22)

`grep eslint .github/workflows` returns nothing; `package.json` has the script and no job calls it.
**Do not cite eslint as coverage anywhere**, and do not wire it in without re-making this decision:

`npx eslint .` reports **6,373 problems (5,925 errors)**, of which **5,633 are
`@typescript-eslint/no-explicit-any`** — a convention CLAUDE.md explicitly sanctions ("Supabase client
typed `any` in API routes"). Adding the gate would make CI permanently red on a rule the repo chose.

The one subset worth a look is `react-hooks/set-state-in-effect` (**60** instances, a real correctness
smell — `components/MobileNav.tsx:44` is one). 60 is not a ban either; it would need a ratchet.

---

## 🚨 THE GUARD FAMILY WAS NOT PORTABLE, SO `npm test` ON TREVOR'S BOX WAS AN UNTRUSTWORTHY INSTRUMENT (2026-08-24)

**Measured 2026-08-24 on the Windows box: `npm test` reported 54 failures across 10 files. 53 were not defects.** After the fixes below: **1371/1371 files, 14,945/14,945 tests green** — the first clean full run on that machine. **CI was green throughout**, because every cause is one that only exists off the Linux runner.

⚠ **THE COST IS NOT THE FALSE REDS — IT IS WHAT THEY TRAIN.** CLAUDE.md requires a full-suite run before every push. **A permanently-red instrument is one a reader learns to skim, and a real failure hides in the noise.** Exactly **one** of the 54 was real (a whole-shape `toEqual` in `og-insights-headline-count-is-not-a-page-length`), and it was found only because the other 53 were traced to a cause first.

⚠ **"IT PASSES IN CI" IS NOT THE COUNTER-ARGUMENT — IT IS THE OTHER HALF OF THE FINDING.** CI is the platform on which all four causes below happen to work. That is precisely what let them accumulate. **Where the dev machine and CI differ, each is blind to the other's failures; neither alone is "the" test result.**

### Cause 1 — `execSync("grep -rl … || true")` to discover a guard's own population

Correct on the runner, broken under `cmd.exe`, **in three ways and only one of them loud**:

| mode | instance | what happened |
|---|---|---|
| **LOUD** | `metadata-catch-branch-is-not-a-404` | pattern contains SPACES → cmd.exe re-split it → `execSync` threw **at module scope** → suite reported **"0 test"**. 🚨 **DEAD on that box, green in CI.** |
| **QUIET** | `log-pipeline-run-args-match-the-function` | a simpler pattern happens to work, so the mechanism looks sound until someone widens it |
| **SILENT** ⚠ | `indexer-cursor-hold-on-partial-scan-guard` | **`\|\| true` swallows the cmd.exe failure into an EMPTY list, so the guard walks ZERO files and PASSES.** Its two `--include='*.ts'` sites had exactly this shape — cmd.exe does not strip the quotes, so grep matched no filename at all. |

⚠ **The SILENT mode is the one that matters: a guard inspecting nothing is indistinguishable at a glance from a guard finding nothing.** Same lesson as *"ASSERT THE COUNT IT INSPECTED"* above, arriving by a new route.

### Cause 2 — `f.replace(process.cwd() + "/", "")`

`node:path.join` yields backslashes on Windows, so this **never matches**, the value silently stays ABSOLUTE, and **any allowlist or suppression keyed on a relative path stops matching**. `entity-sections-do-not-conclude-from-a-failed-read` therefore **reported its own deliberately-SUPPRESSED entry as an offender** — ⚠ **which for ten minutes read like a live honesty defect on `/series/[slug]`. It was not.**

### Cause 3 — an AMBIENT SECRET in the developer's shell

**`INGEST_SECRET_TOKEN` is exported from the user profile on that box**, so every process started there inherits the live token. Many routes gate as `if (expectedToken && authHeader !== …)` — **auth is enforced only when the secret is SET** — so a test written against the *unset* branch got a **401** locally and the intended status in CI. ⚠ **`api-ingest-backfill.test.ts` states that contract in its own header and then failed for having it set by someone else.** ⚠ **`vitest.setup.ts`'s `||=` cannot help: it defaults a MISSING var and is silent about a PRESENT one.** It now **deletes** a named list of auth secrets so the test process matches CI. **The list is the CLASS, not the instance.**

### Cause 4 — a SECOND COPY OF A PACKAGE, which defeats `vi.mock` SILENTLY

`workers/topshot-moments-hydrator/` and `workers/pack-events-ingest/` each carry **their own `node_modules/`** (`@supabase/supabase-js` **2.105.4** vs the root's **2.104.0**). 🚨 **The consequence is not a version skew — it is a MOCK MISS.** A worker importing the bare specifier resolved the **NESTED** copy, **a different module id from the one `vi.mock("@supabase/supabase-js")` registered**, so the mock silently did not apply, the worker built a **REAL** client, and the suite made **REAL network calls** that hung to the 5 s timeout.

- ⚠ **It presented as FLAKINESS.** At `--testTimeout=60000` the mask came off and it was an ordinary assertion failure underneath. ➡ **Re-run a "timeout" with a long timeout before believing it is one.**
- ⚠ **Those dirs are gitignored, so they exist on a dev box and NEVER in CI.**
- ⓘ **One probe nearly stopped the hunt:** `createClient` showed **0 calls** with the worker plainly having run — which reads as *"it never gets there"* and actually means *"it called a DIFFERENT module's `createClient`"*.
- **Control both ways: 22 of 25 worker suites pass, and the 3 that failed are EXACTLY the two dirs with a nested install; every other worker dir has none.**
- ⛔ **Fixed by ALIASING the specifier to the root copy in both vitest configs, NOT by deleting those `node_modules`** — they are a local wrangler convenience, and deleting a developer's install to make a test pass is the wrong direction.

### The replacement, and the ban

`__tests__/helpers/source-files.ts` — `filesMatching` / `repoRelative` / `walkSourceFiles`. Returns **repo-relative, forward-slash, sorted** paths, **byte-identical to `grep -rl` on Linux, so no migrated guard needed edits to its allowlists or ratchets.** ⚠ **PARITY MEASURED, not assumed — all seven populations match POSIX grep exactly: 32 / 11 / 18 / 23 / 10 / 98 / 1.**

`__tests__/guards-do-not-shell-out-to-grep.test.ts` bans both shapes at zero across `__tests__` + `scripts`, **proven end-to-end in both directions with a planted offender file**, not merely against string literals.

- ⚠ **It excludes ITSELF**, because its detector-proof block must carry the banned shapes as **string LITERALS, which survive comment-stripping** (comment-stripping alone was tried first and it still reported itself — the seventh guard here to fire on its own documentation, this time via fixtures rather than prose). The exclusion is **DERIVED from `import.meta.url`**, never spelled out, since **a guard that names its instances dies on a rename**; and it is **asserted at the property's granularity** — exactly one file dropped, it is this one, and it genuinely carries both shapes.
- 🚨 **AND IT RED-ON-LOAD IN CI, WHICH IS THE SAME DEFECT IT WAS WRITTEN ABOUT.** It passed locally and standalone, then **timed out at 5217 ms inside CI's `--coverage` run** — it read and comment-stripped ~1,400 files **four times** (once per arm, twice per assertion: the value and the failure message). ⚠ **The very next commit's CI passed by luck**, which is what load-sensitive flakiness looks like. Now reads once, memoised, with an explicit 60 s timeout on the scan-bound arms. ➡ **A guard that reds for being SLOW is indistinguishable at a glance from one that found something, and it trains exactly the same skimming.** ⚠ **Budget a whole-tree scan for the FULL parallel coverage run, never for a standalone run.**

## Displaced from CLAUDE.md — full case histories (verbatim)

Both bullets below were condensed to their rule in CLAUDE.md on 2026-08-22 to make room for the LAYOUT
instrument. The rules still stand; only the examples moved.

⚠ **A THIRD displacement, 2026-08-25** — the LAYOUT and BUILT-BUNDLE clauses of the
"exclusion justified by another instrument" bullet were themselves condensed to a pointer, to make room
for the EQUIVALENCE-PROOF rule the `drain_fmv_cold_tail` scoping earned. **Their full cases already live in
this file** (`## LAYOUT is a defect class no gate in this repo can see` and
`## Nothing here sees the BUILT BUNDLE either`); the CLAUDE.md wording itself, verbatim as it stood:

> ⚠ **NOTHING here measures LAYOUT** — jsdom returns a ZERO box for every element, so a band shipped
> **350px** tall against the ~100px it specified for four weeks with every gate green.
> `e2e/mobile-layout.spec.ts` (scheduled e2e monitor) is the only instrument; a layout claim needs a real
> browser. ⚠ **Nor the BUILT BUNDLE** — turbopack constant-folded a `+`-joined template and DROPPED a
> quasi, so production rendered a sentence the source does not contain while vitest and `tsc` read it
> correctly.

> - ⚠ **Ask what RUNS a guard, not only whether it passes** — `check-tree-corruption.mjs` had no CI job
>   and one manual caller, and its default staged-only mode inspects **nothing** on a CI checkout
>   (`0 file(s) checked`, exit 0). Wiring it naively ships the theatre: **assert the count it inspected**.
>   Its first real run found a committed NUL byte in a URL sanitiser.

> - ⚠ **A permanently-red or permanently-zero instrument is indistinguishable from a broken one at a
>   glance** — `edge-fn-drift` was loudly correct for a week while naming the function fabricating 161k
>   rows, and nobody read it. Check the LOG, not the badge. ⚠ **Before relying on a watcher, prove it can
>   see a FAILURE** — an unreachable monitor and a green build look identical.

### 🚨 The sharpest instance of that rule: SENTRY, and the zero got written in the HEALTHY column (2026-08-26)

**A dark error reporter reports nothing, including its own darkness** — so its silence arrives in exactly
the shape of good news, and it was read that way. Sentry ingested nothing from **2026-08-18** onward; on
**2026-08-26 00:55Z** its newest event was still 7 days old while Vercel carried **50 error groups whose
newest fired in the same minute as the reading**. Both 2026-08-25 daytime-monitor filings had recorded
*"✅ Healthy and unaffected: … no new Sentry issues in 24h"*.

⭐ **The durable rule is that the Sentry number is not readable alone — it is a PAIR:**

> **A Sentry zero is health ONLY if the Vercel 24h error groups are ALSO near zero.**
> A zero on one against 50 groups on the other is a DARK REPORTER, never a quiet week.

⚠ **Why this evaded the sweep for a week:** `rpc-nightly-autonomous-pass/SKILL.md` §2 says *"run …
Sentry … then distrust each"* and then listed distrust bullets for **six** instruments — Sentry not among
them. **An instrument named in the "run" list but absent from the "distrust" list is read at face value**,
which is the failure mode, not the analyst. A seventh bullet now closes it.

⚠ **And two negatives worth not re-deriving:** the Sentry MCP has **no** stats/usage/quota surface (the
catalogue was searched, not assumed), and the decisive ingest probe — POST one envelope, read the status,
where **429 + `X-Sentry-Rate-Limits` confirms quota and 202 refutes it** — **cannot be run from a cloud
sandbox**: it returns the agent proxy's `403 Host not in allowlist`. ⛔ **That 403 is the PROXY's, not
Sentry's, and reading it as a Sentry signal would be the "diagnose from the error STRING, not the fact
that it failed" trap.** Full filing:
[inbox 2026-08-26T0100Z](../overnight/inbox/2026-08-26T0100Z-sentry-is-dark-on-day-seven-and-the-monitor-reads-the-silence-as-health.md).

## 🚨 A RECOVERY TOOL CAN TRIP A GUARD THAT A HAND-AUTHORED FILE SATISFIES (2026-08-23) — and CI must be verified PER PUSH

**`main` was red for six consecutive commits and nobody noticed, including me.** I verified CI green through
one commit, then pushed six more on the assumption. ⚠ **CLAUDE.md already says *a red run is not
automatically yours: read the failing JOB first* — the failure here was never reading it at all.**
**Verify CI per push, not once per session.** A docs-only push is not exempt: the guard that broke was
triggered by *other* files already on `main`.

**The mechanism is the durable part.** `scripts/recover-fileless-migrations.mjs` reconstructs a `.sql` for a
migration that was applied via MCP and never committed — byte-exactly, from
`supabase_migrations.schema_migrations.statements`, md5-verified against prod. Running it and committing the
sixteen recovered files was **correct**, and it turned CI red anyway:
`__tests__/migration-new-function-states-its-anon-exec-decision.test.ts` requires every migration from its
`20260817000000` CUTOFF forward to **state an anon-execute decision** per public function it creates — and
**a byte-exact capture of an already-applied migration states none.** Ten files, five functions.

⚠ **The guard's own header justifies its CUTOFF on the grounds that *"an applied migration is history —
editing it cannot change production"*. Recovered files ARE history; they simply arrived in the repo late.**
So the guard's scoping assumption — *in-repo files were authored here* — is the thing that broke, not the
guard. **Any future recovery run hits this again until the script writes the marker itself.**

**How it was fixed, and what was deliberately NOT done.** ⛔ The CUTOFF was not raised, the files were not
exempted, the guard was not weakened. The decision was **stated and MEASURED**: `has_function_privilege`
(never the acl text) on all five — `get_series_detail`, `get_series_editions`, `get_series_rollups`,
`get_set_editions`, `refresh_series_detail_rollup` — reads **SECURITY DEFINER, anon false, authenticated
false, service_role true**. No exposure; the guard wanted a statement, not a hole.
⚠ **A REVOKE must NOT be added to a snapshot/recovered file** — `CREATE OR REPLACE FUNCTION` does not reset
an ACL, so it would CHANGE production while presenting itself as a no-op.
⚠ **Cost stated rather than hidden: those ten files no longer md5-match prod's stored `statements`.** Only a
comment banner was added — not one SQL byte — so re-running them is still a no-op and each revert path is
intact. Each file says so in its own header.

## ✅ The CI guard estate, PROVEN RED one by one (2026-08-26) — a clean audit, recorded because clean audits are what nobody writes down

CLAUDE.md's rule is *"before relying on a watcher, prove it can see a FAILURE — an unreachable monitor
and a green build look identical."* That had been applied to individual guards after individual
incidents; it had **never been run across the estate**. It has now, and the result is good, which is
exactly why it is written down — otherwise the next session re-does it, or worse, assumes it.

**Method (cheap, ~10 minutes, re-runnable):** for each guard, record the baseline exit code, introduce
a *synthetic violation of the thing it bans*, confirm it exits **1** and **names the file**, delete
the probe, confirm it returns to **0**. Probes went in throwaway dirs (`components/_guardprobe`,
`app/api/_guardprobe`) and one appended line in a memory doc, restored from a copy. ⚠ **`git status`
verified empty afterwards** — a probe left behind is a defect shipped by an audit.

| guard (CI `typecheck` job) | probe used | red on violation? | non-vacuous arm |
|---|---|:--:|---|
| `check-brand-tokens` | hardcoded `#E03A2F` + `'Barlow Condensed'` in a component | ✅ | surface counts `=== 0` |
| `check-driver-message-leaks` | ungated `GET` returning `err.message` | ✅ **named the file** | `handlersInspected < 100`; **gated-leak count `=== 0`** |
| `check-unhandled-third-state` | — (**self-testing**) | ✅ **by construction** | **runs a synthetic fixture that MUST flag, before reporting on the real tree** |
| `check-responsive-flex-basis` | `md:flex-row` + inline `flex: "1 1 320px"` | ✅ | asserts files + media blocks inspected |
| `check-memory-doc-links` | broken relative link appended to a reference doc | ✅ | `files === 0 \|\| linksChecked === 0`, plus "implausibly few" |
| `check-unbounded-server-reads` | async server page with a bare `.from().select()` | ✅ **named the file** | `INSTRUMENT BROKEN` on empty walk |

⭐ **THE PATTERN WORTH COPYING IS THE SELF-TEST.** Two of the six do not need an external probe at
all: `check-unhandled-third-state` runs its detector against a fixture that must be flagged **before**
it reports anything about the real tree, and `check-driver-message-leaks` treats its **gated** leak
population as a built-in positive control — *"if it ever reads 0, the GATE or LEAK regex has stopped
matching and the clean result is meaningless."* **Those two cannot silently rot; the other four can
only be shown healthy by an audit like this one.** When adding a guard, prefer the self-test: it
converts "somebody should re-check this" into "CI re-checks it every run".

⚠ **What this does NOT claim:** that the guards catch everything in their class. It is a check on
*detector liveness*, not on coverage — and this file records two guards whose assertion is
narrower than their own header (`.range()`/`.order()` presence-vs-uniqueness, and
`check-unbounded-server-reads`'s reachable-vs-applied). **A guard can be provably red on the thing it
tests and still test less than it says.**

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
DATABASE_URL="postgres://postgres@localhost:5433/postgres" bash scripts/run-db-tests.sh   # 181 files
```

⚠ **It does NOT survive a session resume** — the cluster is stopped even though `/var/tmp/pgdata-rpc`
remains, so `psql` gives *"Connection refused"*. Re-`pg_ctl start` (re-`initdb` only if the data dir is
gone). Being able to run all 181 files locally is what made re-pinning six DB functions verifiable rather
than hopeful — and it caught nothing that CI later disagreed with.

---

## The blind normaliser — a guard class discovered 2026-08-22

⚠ **DISPLACED VERBATIM FROM CLAUDE.md** (condensed there to make room for the grep-for-guards rule): the
per-HANDLER exclusion example in full — *"a FILE-level secret grep defended a per-HANDLER exclusion, so a
gated `POST` vouched for the ungated `GET` beside it (4 dishonest handlers)."*

### The class

🚨 **A guard's COMMENT STRIPPER is upstream of everything it checks, and when it blanks real source the
guard does not error — it still runs, still reports a population, and still passes.** Nothing distinguishes
that from real coverage except a before/after count. Two separate implementations were measured blind on
the same day:

1. **The 20-copy regex stripper** stripped BLOCK comments before LINE comments, so an ordinary line comment
   mentioning a glob path (`// used by /api/* endpoints`) opened a block comment that closed at the next
   `*/` **anywhere in the file**. Measured across 1,315 files: **103,590 characters blanked across 49
   product files**. It concealed a live P0 — ~19.6k chars of `CollectionAnalyticsClient.tsx`, including the
   branch publishing a 99-day-old row as market depth.
2. ⚠ **THE PROPOSED FIX WAS ALSO BLIND, AND THE INSTRUCTION WAS TO LIFT IT VERBATIM.** The state machine
   had no regex-literal state, so a regex ending in an escaped slash (`/^https?:\/\//`) presents the raw
   characters `\` `/` `/` — read as `//`, blanking the rest of the line. **80 occurrences in 66 files,
   including the guards' own `.replace(/\/\*[\s\S]*?\*\//g, …)` bodies**, so the "fix" would have blanked
   the very code implementing it.

⚠ **The original finding was also UNDERCOUNTED, and the mechanism says why: the swallow comes from the
BLOCK regex ALONE.** The line strip is not part of the defect, so a further **30 files** running the block
regex with no line strip were blind identically — **48,825 chars across 13 files**, same top offenders.

### What this cost, and what it bought

Migrating **28 guards** to `scripts/lib/strip-comments.mjs` produced **two real reds**, both in
`CollectionAnalyticsClient.tsx`: 10 hidden bare `.toLocaleString()` calls (fixed — all 32 in the file now
pass `"en-US"`, ceiling lowered 101 → **79**), and 4 hidden `.then((r) => (r.ok ? r.json() : null))` sites
(triaged individually — **all four discriminate the null**, so they match on SHAPE, not defect).

⚠ **`__tests__/guards-use-the-shared-comment-stripper.test.ts` ratchets the population at 25, down only** —
and it caught its first regression **within the hour**, a newly-landed file carrying a fresh copy.

⚠ **Migration hazard that bit once:** if the local helper is itself named `stripComments`, replacing only
its BODY makes it call itself and blow the stack. **Remove the wrapper; do not delegate to it.**
⚠ **And a red during a migration reads exactly like a discovery** — that one was my own bug, and it arrived
after two genuine reds, which is precisely the context that makes a third feel confirmed. **Read the
failure, not the count.**

⛔⛔ **HOW to verify a strip actually happened — content inequality, NEVER length (2026-08-30).**
CLAUDE.md warns *"using it is not a guarantee it stripped — blind THREE times"* but has never said how
to check, and **the obvious check is structurally broken**:

```js
if (out.length !== raw.length) { /* stripped */ }   // ⛔ ALWAYS FALSE
```

`stripComments` **blanks comments IN PLACE with spaces** — it preserves byte offsets deliberately, so
line/column numbers still line up with the original source. **Length is identical by design.** Proven in
one line: `"const a=1 // x
const b=2"` → `"const a=1      
const b=2"`, same length.

A length-based verifier therefore reports "strip failed" for **every file that HAS comments** — the exact
inverse of the truth — and it fails **silently in the safe-looking direction**: the sweep skips those files
and returns a confident zero. Measured on an ad-hoc empty-state-copy sweep the same day: it declared
**211 of 219** client `.tsx` files unstrippable, scanned almost nothing, and reported **0 hits**, which
reads as a clean codebase. The real run found 9 candidates.

**The correct check, and report both arms so a no-op run is visible:**
```js
const out = stripComments(raw)
const proved = out !== raw     // ✅ comments existed AND were blanked
// else: file genuinely had no comments — count it SEPARATELY, never as success
```

⭐ **And prove it against a known offender first** — four one-line cases take seconds and would have caught
this immediately: a line comment (must blank), a block comment (must blank), a `https://` URL (must
SURVIVE — it contains `//`), and a JSX string (must survive). This is the same
*"prove a scripted guard against a known offender"* rule the repo already carries, applied to the
stripper itself rather than to the guard using it.

ⓘ **Audited 2026-08-30: no committed guard in `__tests__/` or `scripts/` uses a length-based strip
verification**, so nothing here is currently vacuous from this cause. It is a trap for the next person who
follows the "verify it stripped" advice — which is why it is written down rather than left as a near miss.

## A fixture that BATCHES what production STAGGERS can silently disarm the assertion (2026-08-22)

⚠ **Found by mutation testing, invisible to review.** `supabase/tests/backfill_pinnacle_trade_acquisitions.sql` exists to catch exactly one regression: copying the sibling `backfill_pinnacle_mint_acquisitions`'s `nft_id`-scoped `NOT EXISTS` gate onto the trade path. The mint needs that gate (a mint is a Pin's FIRST acquisition); the trade path must not have it (a Pin trades many times), and the two functions sit side by side and are near-identical, so "make them consistent" is the tempting wrong edit. **Applying that exact mutation left the test GREEN.**

⚠ **The mechanism generalises far past this function. Within ONE call, every candidate is selected by the CTE before any row is inserted — so a `NOT EXISTS` against the TARGET table reads an EMPTY table and never fires.** It fires only on a LATER call. The fixture inserted both of a Pin's trades in a single batch and called the function once, so it asserted the property while being **structurally incapable of observing its violation**. It looked thorough in every grep and review: named for the regression, with the reasoning written out above it.

**The rule: when the thing under test accumulates state across invocations, the fixture must INVOKE IT MORE THAN ONCE.** A single-call fixture cannot see any cross-call guard. Here the fix was to have the second trade arrive BETWEEN two calls — which is also how it really arrives, one cron tick per new trade. **Ask what production staggers that the fixture batches**; that difference is where a guard quietly stops guarding.

Now mutation-proven in four directions, each reddening the assertion named for it: the mint gate copied across · `buy_price` defaulted to 0 · a case-sensitive wallet join · the counterparty dropped.

---

## Pin the property, not the spelling — the second instance (2026-08-22)

The `#E03A2F` brand-exception guard asserted its justification comment on **one line**. A concurrent session
**correctly** rewrote that comment (its old text claimed to be "the only sanctioned hardcode", which the
deep audit found false — the recharts SVG strokes and the email accent are sanctioned too) and the re-wrap
**red-ed CI while changing no meaning**.

🚨 **The sharper half is the assertion that kept PASSING.** It matched `/only sanctioned hardcode/i`, and
after the rewrite the only text satisfying it was the sentence **REFUTING** the claim. **It had gone vacuous
while staying green and greppable.** It now matches the machine-readable `brand-exception:` marker against
whitespace-normalised prose, mutation-tested three ways (marker removed → fails; reason removed → fails;
re-wrapped → passes).

## ⚠ A filed DECISION offering a tidy A-or-B choice is the least re-checked hypothesis

CLAUDE.md already records that a filed FINDING is a hypothesis, and that **a filed decision NOT to act is
the one nobody re-checks**. 2026-08-22 added a third shape, and it is the most seductive: **a filing that
hands the reader a clean either/or.**

`/api/ready` was filed with two candidate fixes framed as an operator choice (grant `anon` EXECUTE, or move
to the service-role client). **Both are wrong**, because they share an unstated premise — that
`health_check` is a viable synchronous call. Measured three hours later: it **does not return inside 60 s**.
Candidate 1 dies on `authenticator`'s `statement_timeout=8s`; candidate 2 dies on Vercel's kill, which is
already the second error cluster on that route.

⚠ **The A-or-B framing is what suppressed the check** — it reads as though the analysis is finished and only
a preference remains. **Before offering a choice, state the premise both options share and test THAT.**

## A fail-soft SKIP is a GREEN job, and a module-level memo leaks across Playwright spec FILES (2026-08-22)

Two lessons from adding one arm (`edition_golazos`) to `e2e/entity-smoke.spec.ts`. Both are about the
instrument, not the pages it checks.

⚠ **`entity-smoke.spec.ts` fail-softs by design: a type it cannot discover from the sitemap is SKIPPED, and
a skip counts as a passing job.** In the dispatched run on `bb945049` four of eight arms — `moment`, `set`,
`player`, `team`, every type resolved from **sitemap segment 3** — skipped, and the job was green. Nothing in
"the run succeeded" said four page types went unchecked; only the log lines did. **So "the smoke run passed"
is not evidence that an arm ran** — read the per-arm lines, or assert the count of arms that resolved.
Same family as the permanently-green instrument: an instrument that cannot report its own non-execution.

🚨 **`fetchSitemapLocs`'s memo is MODULE-level and Playwright reuses a worker PROCESS across spec FILES.**
`entity-smoke.spec.ts` runs against production and fills that cache; `smoke-selfcheck.spec.ts` then read
**production** locs instead of the fixture server it had just started — expected the fixture's
`/laliga-golazos/edition/541`, received a production URL. **The self-check was passing against the wrong
corpus**, i.e. a green self-check that proved nothing about the fixture. Fixed by keying the memo on the
base URL rather than caching a single global list. ⚠ **Verified against the conditions that produced it, not
just re-run**: re-dispatch on `6fce088b` gave **100 passed, 0 flaky, 0 skipped** against `1 flaky` before.

⚠ **And the same re-dispatch RETRACTED a filing written eight minutes earlier** which reported the four
segment-3 arms as skipping — all four resolved on the next run. **A single observation of a failure is not a
standing state.** What survived the retraction is the structural half (the sitemap's partial-read `break`
and its 72%-tie paging key — see `known-issues.md`), because that half is a property of the code rather than
a sample.

### ⚠ The sitemap's 503-on-incomplete fix SILENTLY UNWATCHES four entity arms (observed 2026-08-26)

Known-issues #28 fixed the silent sitemap truncation the right way — `fetchAllByCollection` now throws
`SitemapReadIncomplete` and `app/sitemap/[id]/route.ts` turns that into a **503** so a crawler keeps the
sitemap it already has. **That fix has a downstream consequence on the monitor that nobody would see from a
run summary:** `fetchSitemapLocs` treats a non-200 as `[]`, so while segment 3 is degraded, the `moment`,
`set`, `player` and `team` arms **skip — and a skip is a green job**.

Observed across three dispatched runs: **4 skipped → 0 skipped → 4 skipped**, all four being the segment-3
types, every run reporting **success**. ⚠ **So "the DOM monitor is green" does not mean those four page
types were checked**, and the fix that made the sitemap honest is what makes the monitor quieter. The
per-arm lines are the only place this shows. **Asserting the COUNT of arms that resolved would close it**;
nothing does today.

## Nothing here sees the BUILT BUNDLE either (2026-08-22)

CLAUDE.md records that no gate in this repo measures LAYOUT. The same is true of the **build artifact**:
turbopack constant-folded a `+`-joined template literal whose interpolations were all module-level string
constants and **dropped one quasi**, so production rendered *"…switched off on 2026-05-26**written on**
2026-05-15…"* — a sentence the committed source does not contain. vitest evaluates the module and gets the
correct string; `tsc` is clean; the served JS chunk itself was wrong. **A real-browser read of production is
the only instrument that sees this class.**

⚠ **The generalisation was REFUTED and the blanket lint rule must not be written.** The fold requires
*every* interpolation in the chain to be compile-time constant, so a template carrying any runtime value
cannot lose a quasi this way: **42 at-risk-SHAPED concatenations across `app`/`components`/`lib`/`workers`,
ZERO constant-foldable.** The guard `no-constant-foldable-joined-templates` therefore bans the
**precondition at population zero** rather than cleaning up 42 sites that cannot exhibit the defect — and
the zero means something only because the same detector, run against the pre-fix source at `e0f3186dc`,
flags the one real site and names both of its constants.

### Displaced from CLAUDE.md 2026-08-22 — the second "silent by construction" example (verbatim)

CLAUDE.md's *"ask what a passing guard is structurally SILENT about"* bullet used to carry two examples; the
second moved here to make room for the built-bundle instrument gap. The rule is unchanged.

> `check_secdef_anon_exec_drift()` reads `prosecdef = true`, so 84 anon-executable INVOKER functions were
> outside it.

## Running one FILE proves the file, not the tree (2026-08-23)

⚠ **Verifying a commit with `npx vitest run <path>` is not verifying the commit.** On 2026-08-22 I
shipped four commits that way; each targeted file passed, and CI went red on a guard in a *different*
file that the change had made reachable. Four red runs accumulated on `main` before anyone looked,
and the diagnosis then cost more than the full run would have (~5 min locally: **1,365 files / 14,867
tests**).

**The rule: a targeted run is for the edit loop; the full suite is for the push.** `npm test` before
pushing, or accept that CI is the first instrument that sees your change whole — on a repo where a
guard's roots deliberately span the tree, that is a coin flip, not a verification.

⚠ **And a red CI run is not automatically yours.** The same night, four consecutive red runs had two
different causes — one inherited from a concurrent session's commit, one my own guard correctly
reporting a live defect. **Read the failing JOB and STEP before assuming either way**: "my push is
red" and "my change broke it" are different claims, and the second needs the job log.

## Two memory-file guards added 2026-08-22/23, and what each is blind to

- **`inbox-index-lists-every-filing`** — every filing on disk is listed, no entry links a file that is
  not there, the heading count equals the file count, and each per-day count equals its section. Ban at
  population zero, with a >50-file vacuity floor. ⚠ **Blind to CONTENT**: an entry whose title no longer
  matches its filing passes, because nothing compares them.
- **`claude-md-stays-under-the-memory-file-limit`** — the 40,000-character ceiling measured with Node
  `String.length`, plus a 20,000 floor so a truncated file cannot satisfy the ceiling trivially, plus an
  arm asserting bytes > characters (the evidence that `wc -c` is the wrong unit). ⚠ **Blind to the
  reference docs**: nothing bounds `docs/reference/*.md`, and nothing checks that displaced text
  actually landed there — the "displace it verbatim" rule is still enforced only by the author.

### Displaced from CLAUDE.md 2026-08-23 — the vacuous-assertion TITLE examples (verbatim)

Condensed in CLAUDE.md to make room for the "one file is not the tree" rule. The tell is unchanged;
these are the names that gave it away.

> The tell is the TITLE: a name carrying a negative claim ("without claiming none are saved") or a
> transformation ("is not an error", "at or below FMV") is a promise the assertion usually fails to keep.

### Displaced from CLAUDE.md 2026-08-23 (verbatim) — what a passing guard is silent about

Moved here to pay for two new standing rules; nothing deleted. CLAUDE.md keeps the rules, this keeps the cases.

> ⚠ **Ask what a passing guard is structurally SILENT about** — every guard's own derivation fixes its blast radius (the anon driver-message guard derived its file set from `isPublicPath`, so everything behind sign-in was outside it *by construction*). **Prefer a directory/tree walk over a curated list, and a ban at population zero over an allowlist.** ⚠ **A curated list drifts, and COVERAGE IS ONLY REAL AGAINST WHAT THE GUARD READS** — `detect_stalled_pipelines`'s `WHERE w.is_active` blind spot is **76 of 164** (08-23; numerator held while the population grew — diff the SET). Derive from `pipeline_runs`; make *suppression* the curated list. ⚠ **Assert an exclusion at the PROPERTY's granularity** — a FILE-level grep vouched for a per-HANDLER exclusion (4 dishonest handlers).

**Two more instances, both found 2026-08-23, both by asking what the guard's DERIVATION excludes:**

1. 🚨 **A guard's ROOT is a claim.** `saturation-throttle-reads-its-error` walked `app/api/cron` ONLY, and its own
   header argued *"a guard that walks the tree cannot miss the tenth"*. It walked one DIRECTORY. The tenth copy of
   the fail-open breaker was one directory over in `lib/studio-sales-history.ts` — the SHARED implementation that
   `golazos-studio-` and `allday-studio-sales-history-backfill` delegate to entirely, so those two never entered the
   population and their breaker was the broken one. Fixed by walking a SECOND ROOT **plus an assertion that the
   second root CONTRIBUTES**, so a widening that matches nothing fails loudly instead of silently narrowing back.

2. 🚨 **A SPELLING LIST is not the property.** `entity-sections-do-not-conclude-from-a-failed-read` matched
   `/No (?:sales|open offers|notable serials|recent sales|offers|listings|history)\b/` and said in its header that it
   existed to stop "the FIFTH". The fifth said **"No recorded sales yet"** — one adjective, no match — and was live
   at **202 degradations / 157 users a day**. Widened to `No` + ≤2 words + a data noun. ⚠ **Widening reddened CORRECT
   code twice, and both were kept as EXEMPTIONS rather than narrowing back:** the NEGATION (`*Unavailable` copy says
   "it does **not mean** this player has no moments" — the register already records a word-ban failing here for
   exactly this), and the OTHER SANCTIONED GATE (`TeamChecklist`'s `failed ? <load-failure> : … : empty`).
   ⚠ **Its window is 520 chars because that was MEASURED** — TeamChecklist's honest gate sits **394** chars from its
   sentence; a shorter window reddened correct code.

3. ⚠ **A window-based assertion must stop at the next STATEMENT.** A 260-char window from `throttle_read:` passed
   with the log's `extra` emptied, because the next line is
   `return NextResponse.json({ ok:false, skipped:"throttle_error" })` — the same string. **The HTTP body is not the
   record; `pipeline_runs` is.**

### ⚠ A DOC'S SUMMARY OF A GUARD CAN BE SILENT ABOUT HALF ITS ASSERTIONS — and running the documented checks is then not enough (2026-08-23, reddened `main`)

**Instance.** Adding one entry to `docs/overnight/inbox/INDEX.md` reddened `Unit tests (vitest)` on two commits (`6d816200`, `e85c7103`). `__tests__/inbox-index-lists-every-filing.test.ts` has **five** `it(` blocks — a population floor, plus four substantive assertions:

| # | assertion | did the CLAUDE.md summary name it? |
|---|---|---|
| 1 | *lists every filing on disk — zero omissions* | ✅ "every filing listed" |
| 2 | *links no filing that does not exist* | ✅ "no dangling link" |
| 3 | *states a heading count equal to the number of filings* (`# Inbox index — N live filings`) | ❌ |
| 4 | *states per-day counts equal to the entries under each day* (`## YYYY-MM-DD — N filings`) | ❌ |

🚨 **The failure mode is precise and worth naming: I ran checks 1 and 2, both passed, and both are exactly what the prose described.** CLAUDE.md read *"`INDEX.md` is CI-guarded: every filing listed, no dangling link"* — a true statement that is **half the contract**, and a half-description of a guard reads as a whole one. The two counts I did not know about are the two that failed.

➡ **RULE: enumerate a guard's assertions from the test file — `grep -nE '^\s*it\(' <test>` — never from a doc's summary of it, including this repo's own.** A prose summary is a *pointer* to a guard, never a specification of it. The same applies to `npm run` script names and CI job names: the authority is the file, and the doc is a hint.

⚠ **Corollary, since the fix is not "write longer summaries":** CLAUDE.md is at its size equilibrium, so the clause was *shortened* to `**4 CI assertions, TWO of them COUNTS**` (net −9 chars). **A summary that states the SHAPE and the COUNT of a guard's assertions is more useful than one that lists some of them**, because it tells the reader when they have not finished reading.

ⓘ **The two counts to bump when adding an INDEX entry:** the header total on line 1, and the dated `## YYYY-MM-DD — N filings` heading for the section the entry lands in. ⚠ **Sections are keyed by PACIFIC date, while filenames carry a `Z` stamp** — a `2026-08-24T0430Z` filing belongs under `## 2026-08-23` (21:30 PT). Getting that wrong moves the failure from check 4 to check 4 in a different section, and reads identically.

⚠ **It was fixed by somebody else's commit, incidentally** (`ad4606ed` bumped 222→224 and 21→23 while covering its own filing), which is the recorded hazard about a concurrent session absorbing your breakage — the red would otherwise still be open, and the tip going green is NOT evidence your commit was clean. **Check CI per commit, not at the tip.**

## A test can PIN a fabricated number, and a `toBeNull()` is green whenever the harness cannot reach the state (2026-08-26)

Two test-side failures found while fixing the eighth honesty shape. Both are worse than a missing test,
because both read as coverage.

### 1. The assertion was WEAKER than the title, and the title was the tell

`component-DashboardClient.test.tsx` carried:

```ts
it("⚠ does NOT replace the case with the onboarding prompt when the slab read FAILED", …)
  // every assertion it had:
  expect(calls.some(u => u.startsWith("/api/profile/hero-moment"))).toBe(false)
```

The title promises a **render** property; the assertion tests a **fetch**. Gating the hero fetch on
`slabsRes.ok` stops `hero` being set — and the page then fell through to the onboarding prompt anyway. **It
passed for the entire time the defect was live.** ⭐ Proven, not asserted: with the fix disabled the old
assertion still passes and only the new one reds. **Assert the ABSENCE OF THE FALSE CLAIM, not the absence
of a fetch.**

### 2. Two tests did not miss the defect — they PINNED it

`component-AchievementsCard.test.tsx` asserted `getByText("0 / 7")` on a **deliberately failed** read, with
the comment *"0 unlocked -> the count badge still renders once loading settles"*. That is the fabricated
number, written down as the expected result. Per the standing rule both were **INVERTED, never deleted** —
the assertion is what holds the behaviour in place, so it has to keep existing and say the opposite.

⭐ **Swept the repo for that exact shape afterwards and it PASSES: 2,940 `it()` blocks across 247 component
test files, nothing else pins a rendered numeric claim on a failed read.** ⚠ The first cut of that sweep read
**41** and was worthless — it could not distinguish `getByText("0")` (presence, the defect) from
`queryByText("0").toBeNull()` (absence, the fix), and it flagged every ROUTE test correctly asserting a
pipeline recorded `ok:false`. Narrow to component renders and presence-only. ⓘ A passing audit is worth
recording precisely because nobody records one.

### 3. ⚠⚠ A `toBeNull()` passes when the harness never reaches the state at all

My own first test for the "✓ Updated" fix asserted `expect(queryByText(/updated/i)).toBeNull()` under fake
timers. It passed — **against the UN-FIXED component.** The promise chain never reached `setUpdated` in that
harness, so the absence assertion was vacuous, and only the mutation run exposed it (restoring the original
`setUpdated(true)` still gave 10 passed).

⭐ **Ship every absence assertion with a POSITIVE CONTROL THAT REACHES THE STATE, and put it first.** The
pair now reads:

```ts
it("POSITIVE CONTROL — a successful recompute DOES claim Updated", …)   // proves the harness can get there
it("does NOT claim Updated when the recompute POST failed", …)          // now means something
```

**This generalises past this file: `queryByText(...)`, `not.toBeInTheDocument()` and `toHaveLength(0)` are
all green against a harness that renders nothing at all.**

---

## The 2026-08-29 CI/testing audit — six lessons, promoted from the filing

Full filing: [`docs/overnight/inbox/2026-08-29T1741Z-ci-testing-audit-…`](../overnight/inbox/2026-08-29T1741Z-ci-testing-audit-the-gates-are-strong-the-detectors-are-not-firing.md). What follows is only the part that generalises.

### 🚨 A MUTATION CONTROL INHERITS EVERY HIDDEN DEPENDENCE OF THE TEST IT VALIDATES

The most useful thing this repo learned that day, and it cost a red `main` on someone else's commit.

New tests asserted `extra.notifications` contains `telegram` on a GREEN fixture. `/api/sentinel` only notifies when `hasCritical || hasWarn || (UTC hour % 6 === 0)`, so on a green run those assertions hold **in 4 hours out of 24**. They were written and mutation-checked at **18:xx UTC** — one of those four. **All four mutation controls passed, and every one of them inherited the same lucky window**, so they certified nothing about the other twenty hours. CI 4196 (18:52Z) passed; 4197 (19:05Z) failed.

⭐ **Proving a test reds when the code is broken says nothing about whether it is green for the RIGHT REASON.** When an assertion could depend on ambient state — clock, timezone, network, row counts, physical row order — the control has to vary **that**, not only the code under test. This is the ambient-state sibling of the vacuous-assertion rule already recorded above.

⛔ **And the fix NOT to make:** switching the affected tests to a fixture that notifies unconditionally (a CRITICAL one) passes at every hour **by testing a different thing** — it drops coverage of the scheduled GREEN report, the one path where nobody is already looking at a page. Pin the clock instead (`vi.useFakeTimers({ toFake: ["Date"] })` — `Date` only, or faking `setTimeout` hangs awaited fetch mocks), and add a sweep over all 24 hours asserting the contract holds at each.

⚠ **THREE instances on 2026-08-29, by THREE independent authors, in three subsystems** — and they do **not** share one mechanism, which is why a detector aimed at one shape would miss the others:

| # | where | mechanism | window it was wrong in |
|---|---|---|---|
| 1 | `api-sentinel-deep` durability block | the CODE branches on the hour (`getUTCHours() % 6 === 0`), so a green-fixture assertion only holds when it notifies | 20 h of 24 |
| 2 | `analytics-rpc-with-retry` budget crumbs | reads real time and asserts an exact outcome | — |
| 3 | `seo-jsonld-ask-age` | **a DATE compared as a DATETIME** | 00:00Z → ~13:00Z daily |

⭐ **Sub-shape 3 is the one no amount of clock-pinning discipline would have prevented, and it generalises: `Date.parse("2026-08-30")` is 00:00Z — the START of the day.** `priceValidUntil` is a schema.org **date** meaning *"no longer available AFTER this date"*, so parsing it to a timestamp and comparing against `Date.now()` says "expired" for the first thirteen hours of the very day it still covers. **Compare a date as a date** — a lexical `>=` on `YYYY-MM-DD` — never via `Date.parse`. The same commit records the corollary for fixtures: with a date-granular field, an "already elapsed" claim is only unambiguous beyond **`ASK_STALE_HOURS` + one calendar day** (~36 h), so a 31 h fixture is true or false depending on the hour CI runs.

⭐ **Three in one day across three authors is not a rarity argument — it is a frequency argument.** "No suite-level detector exists" stops being an observation and becomes a priority. **There is still no such detector, and a grep cannot be one** — `new Date()` appears in hundreds of legitimate fixtures. The sound version varies the ambient state: a scheduled job running the suite with the runner clock moved to one hour from each `% 6` residue class. ⚠ **`TZ` alone would have read clean through BOTH defects**, because the predicate is `getUTCHours()`, which a timezone does not move.

### 🚨 "Flaky" is not a diagnosis — the 720×-vs-15% discriminator

`api-og-cards-render-sweep` timed out at **60,000 ms** on a card that renders in **83 ms** locally. The tempting read is a slow runner. But the whole run was only **~15% slower** than local (453 s vs 395 s) while that one test was **~720× slower**.

⭐ **General slowness moves everything by the same factor. A lone 720× excursion is a HANG.** That ratio is what makes this repo's standing "flake is not a root cause" rule checkable rather than a slogan.

The cause was `lib/og/brand-fonts.ts` fetching two `.ttf` files from the LIVE SITE with **no timeout**, escaping the sweep's stub (its allowlist was `/api/` and `/rest/v1/`; 0 of 2 matched). ⚠ **The loader memoises at module scope, so the FIRST card to render pays the fetch** — which is why exactly ONE test hangs and why WHICH one varies with execution order. That is what made it present as random.

⚠ **`catch` cannot catch a hang.** The file's header guaranteed "THIS NEVER REJECTS", which was true and beside the point. CLAUDE.md's *"Bound every `fetch` — no default timeout"* covers this; the fetch had none.

⭐ **Mutation-check a bound with a signal that NEVER FIRES.** "Does it pass an `AbortSignal`?" is satisfied by `AbortSignal.timeout(2_147_483_647)` — the unbounded case wearing a signal.

👉 Closing the sweep's passthrough (throw on any unmatched http(s) call, delegate non-http so `next/og` can still load its WASM) immediately surfaced a **second** escape nobody had recorded: `next/og` fetches Twemoji SVGs from `cdn.jsdelivr.net` **at render time**, on 6 of 44 OG routes, in production, on the path a social crawler waits on.

✅ **FIXED 2026-08-29 (R66), and the fix found a THIRD escape.** `next/og` has **two** remote fallbacks, not one: an emoji goes to jsdelivr, and **any glyph the supplied fonts do not cover** goes to `fonts.googleapis.com/css2?family=Noto+Sans+Symbols` — `2605 25c8 25a3 25a6 2192 2191 2193 2190 25b2 25bc 2713 2715 2153 2116 203e` measured, so `★` and `→` were remote too. ⛔ There is still no `loadAdditionalAsset` hook (`ImageResponseOptions` exposes only `emoji?: EmojiType`, every preset remote), so the fix is not config: the cards **draw** their glyphs now, as inline SVG (`lib/og/marks.tsx`).

⭐ **THE PROBE THAT GETS THIS WRONG.** Rendering one character per `ImageResponse` **with no `fonts` option** shows `→` fetching nothing — satori's bundled default covers arrows and production never uses it. Supply `brandFonts()`, as every card does, and it fetches. *A probe whose harness differs from production in the one dimension the answer depends on is not a measurement of production.*

⭐⭐ **AND THE SWEEP'S OWN STUB WAS WHY THIS SHIPPED.** It stubbed `twemoji` "so the suite is hermetic" — so it rendered every card, stayed green, and the CDN dependency ran in production for weeks. **Hermetic by STUBBING hides the dependency; hermetic by THROWING reports it.** Stub deleted; verified a throwing fetch makes the render REJECT rather than degrade (`"deal 🎯 card"` rejects, control `"deal card"` renders 3,364 bytes).

⭐ **Two instruments, each covering the other's blind spot — and a MUTATION THAT SEPARATES THEM, which is what proves the pair rather than asserting it.** The render sweep sees glyphs arriving through DATA (`og/collection` rendered `collection.icon` at 140px and every registry icon is an emoji — no source scan could ever have found that) but only on the branches its fixtures take. The source scan `og-cards-render-no-glyph-they-must-fetch` sees every branch and nothing from data. Putting `→` back in `insights/serial-premiums` **reds the scan and leaves the sweep green**, because that card takes its empty-state branch under the sweep's stub envelope. Neither is a census; together the only gap is a production-only branch carrying a data-only glyph.

⭐ **The scan is a SUPPRESSION list, not a detection list.** Enumerating the bad characters is a description of the past — the next emoji pasted is not on it. `COVERED` enumerates what is **proven local** (ASCII, Latin-1 + Latin Extended-A/B for accented player names, and an individually measured punctuation set including U+2212 MINUS SIGN, which `og/pack` renders); everything else fails by default, and clearing a character costs one measurement.

### 🚨 A workflow that CAPTURES a status, ECHOES it, and never TESTS it

`pipeline-sentinel.yml` did exactly that with `HTTP_CODE`. The only branch that could fail the job was `STATUS = "CRITICAL"`, so a 500, a 504, or a 401 from a rotated token all left `STATUS` as `PARSE_ERROR` — which is not "CRITICAL" — and the step exited **0**. **A sentinel that was completely down reported GREEN**, on the one workflow whose badge is the fleet alarm's only signal to anyone not watching Telegram.

⭐ **Grep for the shape, not the file: a variable assigned from a response, printed, and never compared.** A 200 whose body will not parse must also fail — "unreadable" must never resolve to "not CRITICAL".

⚠ **Pin a workflow's decision by EXECUTING the shipped bash against response fixtures, not by grepping it.** A grep for `if [ "$HTTP_CODE" != "200" ]` passes against a script that tests the code and then swallows the result, and dies on a harmless reformat. ⚠ **Harness trap:** `${{ secrets.… }}` is **not inert text to bash** — it is a bad substitution, so `RESPONSE=$(curl …)` fails, `|| RESPONSE=""` swallows it, and every fixture arrives EMPTY. The first harness reported "unreachable" for every case *including the healthy ones*, which reads exactly like the guard working.

### ⚠ 10,483 lines of edge-function code CANNOT enter the JS coverage gates, and extraction is the only path

Measured 2026-08-29: **38 edge functions, 10,483 code lines, median 246** — and **all 38 use `Deno.*` globals or `serve()`**, so none is importable by vitest. A coverage `include` over `supabase/functions/*/index.ts` is not achievable without a second (Deno) coverage toolchain.

⚠ **Only 6 of 38 import from `_shared/`** — and `supabase/functions/_shared/**` **IS** in the primary gate (29 modules). So the path to measuring this code already exists, is established, and is taken by six.

⛔ **Do not read one well-factored example as the architecture.** `edge-atlas-pool-normalize.test.ts` imports from `_shared/` and its comment says *"edge fns are outside the coverage measure"*, which reads like a considered design — and generalising from it understates the gap by 32 functions. The census is the tree walk, not the exemplar.

### ⚠ A missing tool is not automatically a gap — measure the distribution before calling it one

`npm run lint` had never run in CI and ci.yml said so. Filed as a plain gap; **measuring it changed the finding.** Over 2,857 files: **6,474 violations across 20 rules, of which 5,757 (89%) are `@typescript-eslint/no-explicit-any`** — a documented convention here. A gate would be a 6,000-error wall switched off within a day. **It was a rule-set mismatch, not neglect.**

⭐ **The shippable form is a RATCHET over the part that is NOT conventional** (`eslint-ratchet`, 717 violations / 19 rules, several of them correctness: `react-hooks/set-state-in-effect` 59, `@next/next/no-html-link-for-pages` 114). ⚠ **Exclude at the RULE's granularity, never the plugin's** — muting `@typescript-eslint` wholesale would also silence `no-unused-expressions`, `no-require-imports` and `no-empty-object-type`, which are not conventional here. ⚠ **A rule absent from the baseline that APPEARS must fail**, or the ratchet goes blind the day a plugin upgrade adds one. ⚠ **And it must refuse an all-clear on a missing or empty report**, because "eslint found nothing" and "eslint did not run" produce the same zero.

⚠ **A message with no `ruleId` is an unused `eslint-disable` directive, not a parse failure.** Reading those 24 as "files eslint cannot parse" was a much more alarming finding than the truth, and it was wrong.

### 🚨 GitHub caps this repo at ~5 scheduled runs per workflow per day — any cron above that is fiction

Measured across 17 scheduled workflows in one 24h window: **observed ≈ `min(expected, 5)`**. Eight workflows asking for 24–96/day all received **4–6 (mean 5.0)**, with no relationship to whether they asked for 24 or 96; 8/day got 4–6, 4/day got 3, and all three 1/day workflows got **1 of 1**.

⛔ **It is NOT a constant fraction, so "~92% shed" is the wrong summary statistic** — it is 95% for a 96/day cron and **0%** for a daily one. ⛔ **And total load is not obviously the cause:** the repo requests 561 runs/day, but a per-workflow cap and a per-repo budget are indistinguishable in one window. 👉 **Discriminator:** disable a few high-frequency workflows and see whether the others RISE (budget) or hold at ~5 (cap).

👉 **Consequence: raising a cadence buys nothing** — `offer-fill-backfill` asks for 96 ticks and gets 5, so its cron is a false document the next reader will trust. Move high-frequency schedules to cron-job.org, which is not subject to this, or rewrite the cron to state what it actually gets.

⚠ **A dropped tick emits NO run, NO badge and NO email**, so the workflow reads `active`, its last run reads `success`, and nothing says the alarm did not fire — *an instrument that never RUNS is indistinguishable from one that ran and found nothing.* `scheduler-liveness.yml` (daily, because daily schedules are the ones surviving) catches **total silence only**; ⛔ at a 12.7h observed max gap **no silence bound both clears today's steady state and catches an hourly job that stopped an hour ago**, and saying so is the point.

⚠ **Compute inter-run gaps over CONTIGUOUS pages only.** A union across paginated API pages straddles an unsampled hole and reported a bogus 31.8h maximum where the true figure was 12.7h.

### ⚠ `spy.mockRestore()` CLEARS `mock.calls` — assert before you restore

Found 2026-08-29 building `og-fetches-are-bounded`. The natural shape puts the restore in a `finally` and the assertion after it:

```ts
try { await ogFetch(url) } finally { spy.mockRestore() }
expect(spy).toHaveBeenCalledWith(OG_FETCH_TIMEOUT_MS)   // reads [] — fails on a CORRECT helper
```

`mockRestore()` resets the mock's state as well as unpatching it, so the assertion reads an empty call list and the case fails against code that is doing exactly the right thing. Capture what you need inside the `try` (`const args = spy.mock.calls.map(c => [...c])`) and assert on that. The tell is a mutation suite where the **baseline** is red and every mutation is red too — a test that can never pass is not a strict test, it is a broken one.

---

## The 2026-08-29/30 detection pass — three new instruments, and what each cannot see

Sibling to the "six lessons" section above; that one was about the audit, this one is about the
guards it produced. **Every one of them was wrong on its first run**, and the corrections are the
part worth reading.

### 1. `scripts/check-register-integrity.mjs` + the `register-guard` CI job

`docs/audits/deep-audit-register.md` is what CLAUDE.md calls the canonical open list, and it was the
only one of the three coordination files with **no guard at all** — the ledger has the no-clobber +
future-date arms, `docs/overnight/inbox/INDEX.md` has four CI assertions, the register had nothing.
A lost register row does not merely drop a record: **it un-files a finding**, and the next pass
re-derives it or never looks again.

Three arms: no id vanishes between `HEAD~1` and `HEAD` (ids tracked as a **SET**, so an
OPEN→RESOLVED move is the lifecycle and not a loss); every row matches the width **its own section
header declares**; ids are unique.

⚠ **It found four real defects on its first full run** — R26, R31, D30, R46 — all one shape.
**GFM splits a table row on `|` BEFORE it parses inline code**, so a raw pipe inside backticks
(`` `/(ts|tsx)$/` ``, `` `(TierBreakdownCard|PortfolioSparkline)` ``) opens a column, and cells past
the header's width are **discarded by the renderer**. R46's `owner` column had vanished from the
rendered table entirely. 🚨 **Every character is still in the file, so a grep finds all of it** —
which is what makes this the worst shape of loss and why four audit runs missed it.

⚠ **TWO CORRECTIONS TO THE GUARD ITSELF, both from running it against the real file rather than a
fixture.** (1) It hardcoded `{OPEN: 6, RESOLVED: 5}` and flagged all 48 resolved rows — the width is
now read from **each section's own header row**, which cannot drift from the file it checks.
(2) It matched `^\| R\d+ \|`, silently skipping `D12b`, `D30`, `D2b`, `E5`; widening to every
id-keyed row took the population **67 → 111 and found D30 on the spot**.

⚠ Non-vacuity at **two** granularities: it fails on zero rows, *and* fails unless **at least two
sections contribute** — a parser that stopped matching `RESOLVED` would otherwise report a
healthy-looking count from `OPEN` alone. The prose sections are excluded **by the property** (their
header's first column is `area` / `item`, not `id`), which is asserted, so a new id-keyed section is
picked up with no edit.

### 2. `scripts/clock-sweep.mjs` + `clock-sweep.yml` — the wall-clock detector (register R67)

Runs the suite once per sampled UTC hour and **diffs the failing SETS**. A test failing at some
offsets and passing at others is the finding. The clock is shifted by an opt-in
`RPC_CLOCK_OFFSET_MS` shim in `vitest.setup.ts` that moves **only the zero-argument `Date`** — every
explicit instant is left alone, or the sweep would report the whole suite.

⛔ **A source scan cannot be the detector.** `new Date()` appears in hundreds of legitimate fixtures,
and R67's three instances had at least two distinct mechanisms, one of which (a DATE compared as a
DATETIME) clock-pinning discipline does not prevent at all. **The sound version varies the ambient
state and compares outcomes.**

⭐ **Why in-process rather than `sudo date -s` on the runner, which is what R67 filed and declined:**
its falsifier was *"if it reds for runner reasons rather than test reasons, revert"*. Shifting inside
the vitest process removes that failure mode **by construction** — a failure caused by the runner, a
bad dependency, or genuinely broken code fails at **every** offset and is classified ALWAYS-FAILING
rather than reported. **The instrument cannot cry wolf about its own environment.**

⚠ **The sampled hours are chosen against the residue classes, not spread evenly** — an even spread is
exactly what a `% 6` predicate survives. `0, 5, 13, 20`: no two agree under mod 6, 3 or 2, and hour 0
is load-bearing twice (the `% 6 === 0` notify branch AND the early-UTC window where a date parsed as
a datetime reads as already elapsed). Asserted, not merely chosen.

🚨 **THE FIRST REAL RUN CAUGHT ME TWICE.**
1. My own `expect(process.env.RPC_CLOCK_OFFSET_MS ?? "0").toBe("0")` is false **by construction**
   while the sweep runs, so the detector reported an always-failing test on every sweep. **I shipped a
   permanently-noisy instrument into the replacement for one declined for being permanently noisy.**
   The honest assertion holds under both conditions: the process clock differs from the real clock by
   exactly the declared offset.
2. ⭐ **The shim cannot reach a CHILD PROCESS.** `find-future-dated-ledger-headings.test.ts` computes
   "today in Pacific" in the vitest process and runs the detector via `execFileSync`; a child starts
   with the real clock. Parent and child disagree under the sweep in a way they never do in CI. That
   gets a **third bucket — UNMEASURED**: printed every run, explicitly *not* a clean bill, and not a
   failure. The predicate is a **property of the file** (does it spawn a child), not a name list.

⛔ **Standing limits, stated rather than glossed:** anything a child process decides, and any
clock-dependence needing a span longer than 24 h (a month- or year-boundary shape). Neither is covered.

⚠ **Three readings were DISCARDED rather than reported**, and this is the durable rule: one was taken
while a migration file was created mid-run (four tests walk `supabase/migrations`, so the tree moved
under the instrument); one was my own bad assertion; one was the child-process artifact. **Only the
fourth run was a measurement.** A detector's first output is a hypothesis about the detector.

### 3. `lib/redact-secrets.ts` — publishing an alert's failure reason without publishing the token

`pipeline-sentinel` run 33283636751 reported `"notifications":["telegram-FAILED"]` on a **CRITICAL**
sweep. It had correctly found three dead pipelines and **could not tell anyone**, and the reason went
to `console.error` only — so a revoked token, a non-2xx and a thrown fetch were indistinguishable.
CLAUDE.md's alert sub-class exactly: *an alert's output is silence, so its error is unfalsifiable.*

⚠ **The second half was worse:** both push sites sat inside `if (TOKEN && CHAT_ID)`, so an
**unconfigured** channel produced **no entry at all** — absence, indistinguishable from "no
notification was needed". Now `…-FAILED:not_configured`.

🚨 **Publishing the reason is only safe because of the redactor: the Telegram bot token is IN THE URL
PATH** (`/bot<TOKEN>/sendMessage`), so a thrown fetch quoting the URL would write a live credential
into `pipeline_runs.extra` and the route's JSON response. **Two independent arms, and the second is
not redundant:** (1) replace each secret VALUE the process holds — cannot cover a rotated token;
(2) rewrite the token-bearing SHAPES regardless — cannot cover a value outside those shapes.
⚠ `length >= 8` stops a short env value turning the redactor into a mangler that destroys the very
diagnosis it exists to give.

### Mutation lessons from this pass

- ⚠ **Two agreeing signals, one silently wrong.** A mutation that dropped the two-section floor from
  `ok` survived, because the exit code enforced it separately. **Assert both when a decision is
  computed in two places**, or one can rot unnoticed.
- ⚠ **A parent-only comparison hides half the loss.** Restricting the register's "before" set to
  `OPEN` survived every test: deleting **RESOLVED** rows — where the revert paths live — was
  invisible. Test the direction you did not think of.
- ⚠ **An exemption widened to everything can leave the other bucket untouched**, so a finding appears
  in both. When a classifier partitions, **assert the partition**, not each side.
- ⚠ **Deleting an IMPORT is not a mutation of the behaviour** — the helper name is still in the source
  and the guard still matches, while the build breaks for an unrelated reason. Mutate the **calls**.

---

## A guard can be blind in a way its output never shows — and the DB had two of them, one right (2026-09-02)

`check_secdef_anon_execute_violations()` is the guard that watches for SECURITY DEFINER functions
`anon` or `authenticated` can EXECUTE. It **iterated a hardcoded list of NINE function names.** The
schema has **559 SECDEF functions.** It returned `[]`; `rpc_ops_snapshot` published that as
`security.secdef_anon_violations`; the smoke test hard-passed on it and would have Sentry-alerted on
anything else; the daytime monitor's health line read *"security 0/0/0/0"*. **Four anon/authenticated-
executable rows existed the whole time, and the guard never looked at them.**

⭐ **IT WAS FOUND BY ASKING A DIFFERENT INSTRUMENT THE SAME QUESTION.** Supabase's own advisor reports
`anon_security_definer_function_executable`; ours reported zero. **Two instruments, one question,
opposite answers — and the wrong one was ours.** When a guard has an external counterpart, run both
once; agreement is cheap and disagreement is the whole finding.

### ⛔ And then the fix duplicated a guard that already existed

The rewrite — a tree walk, correctly — carried its own **hardcoded** suppression list. But
`check_secdef_anon_exec_drift()` had walked the same population since 2026-07-21, subtracting
`public.secdef_anon_exec_allowlist`, **a table**. The duplicate was found by a one-line census of
`check_*` functions run *after* building it.

👉 **The standing rule "name the caller before you touch the function" has a sibling: CHECK WHETHER THE
GUARD ALREADY EXISTS BEFORE WRITING IT.** For this database that is one query:

```sql
SELECT proname, length(prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND proname LIKE 'check\_%' ORDER BY 1;
```

### Why a suppression TABLE beats a suppression LITERAL

Four reasons, and the third is the one that matters most:

1. Operator-editable without a migration.
2. Every row carries a `note` and an `approved_at` — a suppression becomes an auditable **decision**.
3. ⚠ **The table's notes were better-researched than the ones written from scratch.** The literal
   called `serial_fmv_estimate` a *"public pricing calculator"*; the table records that it is reached
   **INDIRECTLY** through a SECURITY INVOKER function and an anon-SELECTable `security_invoker` view —
   *"an invoker caller executes the callee AS THE CALLER, so revoking breaks the wallet-moments read
   and the public board."* **A security finding was suppressed without knowing why the grant was
   needed. It happened to be right; that is not the same thing.**
4. The table is RLS-protected with no anon/authenticated SELECT or INSERT, so **the guard cannot be
   disarmed by the roles it watches** — a property a literal cannot have, but also cannot lose.

⚠ **Match on `oid::regprocedure`** (type names, no parameter names) when comparing against such a
table — `pg_get_function_identity_arguments` includes parameter names and never matches.

### The three assertions that make a rewritten guard non-vacuous

- **It inspected a population**: `>= 50` SECDEF functions seen. *A rewrite that looked at nothing would
  also return `[]` and look perfect.*
- **The suppression is what removes the rows**, not the walk missing them: every reachable row must be
  in the allowlist.
- **No stale entries**: the allowlist may not hold more rows than are reachable, or a suppression rots
  in silence.

And, once two guards share a population, **assert that they AGREE** — disagreement means one is looking
somewhere the other is not, which is exactly the failure that started this.

---

## Two guards over one defect class, disjoint syntax — and neither can find the other's population (2026-09-02)

`consequential-read-binds-its-error-ratchet` was built to catch a discarded supabase-js error. Its
detector is:

```
const\s*\{([^}]*)\}\s*=\s*await\s*\(?\s*supabaseAdmin      // then: does group 1 name `error`?
```

That is not a rule about **reads**; it is a rule about **destructuring**. So it is structurally blind
to the most consequential write on this platform:

```ts
await supabaseAdmin.from("event_cursor").update({ last_processed_block: X })…
cursorAfter = String(X)          // ← logged whether or not the write landed
```

**Twenty-one routes carried exactly that**, and the ratchet had been read as clean over the same tree
minutes earlier. A block cursor is the one piece of pipeline state a re-run cannot reconstruct, and
`cursor_before`/`cursor_after` on `pipeline_runs` is the only pair an operator can read to see a walk
progressing — so a failed advance was **logged as a movement**, and the next tick re-scanned the
identical range while the log said otherwise.

⭐ **The transferable rule: a guard's DERIVATION fixes its blast radius, and a detector keyed on a
SYNTACTIC FORM covers that form, not the concept it was written for.** Before trusting a clean
ratchet, write down the shapes the same defect can take that its regex cannot express — here, every
statement with no `const {` at all. Then decide whether that is a second guard (it was) or a widened
one (it could not be: widening this regex to bare `await` would sweep every fire-and-forget write in
the tree into a population the ratchet is not shaped for).

**Ban vs ratchet, decided on the population rather than by habit.** The read population is large and
mostly benign, so it is ratcheted and goes down over time. Cursor writes are **few, uniform, and
consequential by construction**, so `event-cursor-writes-bind-their-error` is a **ban at zero** and its
suppression list is empty — an allowlist there would be theatre.

**What makes the ban non-vacuous** (the same three-part shape as every other guard here):

- **Floors on the population it inspected** — `>= 20` cursor writes across `>= 10` files. `routeFiles()`
  returns `[]` for a root that does not exist, and `stripComments` has blanked real source three times
  in this repo; both failures read as a clean ban without this.
- **A positive control on the DETECTOR, not the tree** — synthetic bound / unbound / read snippets,
  asserting it flags the unbound one, passes the bound one, and does **not** count a `.select()` as a
  write. *Prove a watcher can see a failure before relying on it.*
- **A behavioural half** (`api-topshot-offers-indexer-deep`): a failed cursor update must log
  `ok:false` and must NOT report reaching the tip, with its own positive control that the same fixtures
  minus the error DO reach it — otherwise the assertion passes for a route that never got that far.

⚠ **And the retroactive-incidence check for this class is a trap.** The obvious signature — run N logs
`cursor_after = X`, run N+1 opens at `cursor_before < X` — reported `pinnacle-trades-indexer` at
**436 of 874 runs (50%)**. That route runs **two modes under one pipeline name against two cursors**
(`pinnacle_trades` ascending, `pinnacle_trades_backfill` descending), so alternating ticks produce the
shape by design; `fmv-recalc`'s "cursor" is not a block number at all. 👉 **A cursor-continuity check
that ignores WHICH cursor a run used reads a dual-mode indexer as 50% broken.** No incidence was
claimed, in either direction.

---

## 🚨 A ratchet that reaches ZERO breaks its own not-vacuous check — worked example, 2026-09-02

`consequential-read-binds-its-error-ratchet` drove its population **61 → 51 → 47 → 28 → 0** in one
night. The last fix turned the guard **red**, and the failing assertion was its *not-vacuous floor*:

```ts
it("is not vacuous: the pattern still matches real source", () => {
  const total = family.reduce((n, f) => n + discardingReads(stripComments(readFileSync(f, "utf8"))), 0)
  expect(total).toBeGreaterThanOrEqual(20)     // ← AssertionError: expected 0 to be >= 20
})
```

Its comment called it *"a positive control on the DETECTOR itself"*. **It is not.** It is keyed on the
**defect**, so it can only pass while the defect survives. This repo's rule — *"a not-vacuous check
must be satisfiable at a population of ZERO, or the guard punishes its own success"* — is already
written down, **and this file's own header cited it while shipping the violation.** Knowing the rule
did not prevent it; the shape did.

👉 **The tell is what the floor COUNTS.** A floor over *"files walked"*, *"objects inspected"*, or
*"synthetic fixtures the detector classified correctly"* survives success. A floor over *"violations
found"* cannot, and it reads identically at a glance.

**The repair, and the shape to copy:**

```ts
it("is not vacuous: the DETECTOR still detects", () => {
  expect(discardingReads(`const { data } = await supabaseAdmin.from("x")`)).toBe(1)
  expect(discardingReads(`const { data: rows } = await supabaseAdmin.from("x")`)).toBe(1)
  expect(discardingReads(`const { count: n } = await supabaseAdmin.from("x")`)).toBe(1)
  expect(discardingReads(`const { data, error } = await supabaseAdmin.from("x")`)).toBe(0)
  // ⚠ the false positive this very detector once had: `[^}]*` swallowed the binding
  expect(discardingReads(`const { data: cursorRow, error: cursorErr } = await …`)).toBe(0)
  expect(discardingReads(stripComments(`// const { data } = await supabaseAdmin.from("x")`))).toBe(0)
})
```

Nine assertions against **synthetic** source: shapes it must catch, bound forms it must not, and one
commented-out read proving the shared stripper is reachable and still blanking. It is satisfiable at
zero and still fails if `stripComments` blanks the tree or the regex stops matching — the two
failures the original floor was reaching for. **Keep the population floor separately** (`family.length
>= 30`, plus four routes asserted present by name): that one counts what was WALKED, not what was
broken, so it also survives.

⭐ **And when a ratchet hits zero, convert it.** The honest claim strengthens from *"this must not
grow"* to *"there are none"*, so `BASELINE` becomes `0` and the per-route pins become redundant —
**except** as population detectors: each `it.each` row also asserts its route is still *discovered*,
which is the one thing a ban cannot see. A rename, a move, or a landing expression edited out of a
file all read as success to a ban at zero.


## 🚨 `npm run lint:ratchet` read a STALE report for a whole day (2026-09-02) — four red pushes

`main`'s CI was red on four consecutive code commits and the local gates said green every time. One
job failed, always the same one: **ESLint ratchet**, `@typescript-eslint/no-unused-vars grew
353 -> 355`. Everything else — tsc, all three coverage gates, DB invariants, Cadence, edge functions,
the ledger and register guards — passed on all four.

### The instrument, not the lint

CI's ratchet job is **two** lines:

```yaml
npx eslint . --format json -o /tmp/eslint-report.json || true
node scripts/check-eslint-ratchet.mjs --report /tmp/eslint-report.json
```

`npm run lint:ratchet` was **only the second**. It reads whatever JSON sits at that fixed `/tmp` path,
so it read a report generated hours earlier — before any of the day's work existed — and printed
`2889 files, 717 violations (baseline 717)` on every check while CI regenerated the report and saw
`2893 files, 719`. ⭐ **A green local instrument and a red CI job, out of the same script.**

⚠ **The file count was in the output the whole time (2889 vs 2893) and I read past it.** When two
runs of "the same" check disagree, the DENOMINATOR is where the disagreement shows first.

### ⭐ "Did the instrument produce output?" ≠ "did the instrument measure THIS?"

The script already refused a report that was MISSING, unparseable, or EMPTY — three ways of measuring
*nothing*, each with its own exit code, all of them carefully thought through. It had **no defence
against a report that is complete, parseable, and describes a DIFFERENT TREE.** This repo's own
measurement rule — *a reading taken while its subject changed is not a reading* — was being applied
to database A/Bs the same afternoon and not to the toolchain.

**Generalise it: any check that consumes an artifact it did not produce can be handed a stale one.**
Look for the shape — a fixed path, a `--report`/`--input` flag, a build output compared against a
baseline — and ask what proves the artifact describes the tree in front of you.

### The fix, in three parts

1. **The npm script generates the report itself**, so local and CI cannot diverge. This is the part
   that actually removes the class.
2. **`findStaleness()`** (exported from `scripts/check-eslint-ratchet.mjs`, unit-tested): if any file
   the report claims to have linted is newer than the report, exit 2 and name the worst offender.
   A 1 s slack absorbs coarse checkout mtimes. Proven to fire — `touch` one route and it refuses.
3. A test pins that **CI's own job still generates before comparing**, because a guard's blast radius
   is fixed by what RUNS it: if that line is ever dropped, the runner-local file goes stale too.

### ⚠ And the guard's own test header carried a false claim

It read *"This repo does not run eslint in CI and ci.yml says so."* Raw eslint is not a gate — but the
**ratchet job is blocking and it runs eslint**. That sentence is part of why the local number looked
authoritative. Corrected in place. **A comment that mis-describes what runs a guard is a defect in
the guard.**

## The CI estate audit of 2026-09-02 — three gaps every gate was structurally blind to

Measured over the last 40 CI runs on main (32 green, 8 red, every red a real catch, zero flakes), a
local run of all three coverage gates (0.2–0.65 pt of slack on all twelve numbers), and the Vercel
deployments API. The estate catches regressions well; the defects were in the SEAMS between tools.

- ⚠ **The push-time smoke measured the PREVIOUS deploy.** `smoke-tests.yml` slept 45 s after a
  push; a production build takes **110–124 s** `buildingAt → ready` and the job's median wall clock was
  75 s, so every push-triggered run hit `/api/smoke-test` about a minute before the new build went live.
  A push that broke production read green, and the red landed on the NEXT push under the wrong sha.
  **Fixed by triggering on `deployment_status` (Production + success)** — Vercel's GitHub integration
  posts one per deploy (`githubDeployment: "1"` on every deploy's meta) — no secret, no polling.
  Falsifier: a run with event `deployment_status` must appear within a day of a code push.
  ⭐ **The rule: a check that runs at a fixed delay after a push is measuring whatever was live at
  push time, not the push.** Size waits from a measured distribution, or key on the deploy event.
- ⚠ **`workers/**` was type-checked by nothing.** The root tsconfig `exclude`s it, and the worker
  coverage job runs vitest, which strips types with esbuild. Four worker packages each carried a
  `typecheck` script that no workflow ran. Same gap the edge functions had until `edge-deno` (08-01).
  Now a `workers-typecheck` job walks `workers/*/tsconfig.json` against the root `node_modules`
  (the workers have no lockfiles) and asserts it found ≥ 3. **Coverage is not a type check** — a
  gate that RUNS code says nothing about whether it compiles.
- ⚠ **`scripts/run-db-tests.sh` passed at zero test files.** It printed the count and never asserted
  it. Now fails under 90 (183 on 2026-09-02). Same shape as the tree-corruption job's 1000 floor.
- ⚠ **Ten ops workflows `cat` curl's `-o` file bare under `bash -e`.** On a connection-level failure
  curl writes NO file (reproduced: exit 7, no file), `cat` exits 1, and the step dies BEFORE the
  `::warning::` that names the failure — so a 504 was a green warning and a DNS failure an unnamed
  red, and under `continue-on-error` it vanished entirely. Spelling that works:
  `cat "$F" 2>/dev/null || echo "<no body>"`.
- ⚠ **A warn-only GHA-only caller reads a rotated token as a transient.** badge-sync, the backward
  owner-discovery scan and the Top Shot sales-history backfill have no other trigger and return before
  writing `pipeline_runs`; a 401 on every tick was a green warning forever. Now `401|403 → exit 1`.
  **An auth failure is never transient.**
- ⚠ **A load-bearing redundancy claim was false for 68 days.** `topshot-listing-cache.yml` and
  `cron-schedule.md` said rpc-pipeline still called the route as step 5; that step was removed
  2026-06-25 (`EXPECTED_STEPS: "6"`). The route is single-trigger. Same shape as the sales-indexers
  header corrected 08-27: **re-derive a "backstop exists" claim from the caller's file, not the callee's.**
- Also that day: `allday-ingest.yml` (72 asks/day into a route that returns `skipped` unconditionally)
  deleted; `rpc-pipeline`'s six synchronous POSTs lost `--retry 2` (a retry after a client timeout
  re-invoked an unlocked 300 s route while it was still running, under the saturation that made it
  slow); `migration-autorecover` now fails on a stopped rebase and asserts `ls-remote == HEAD` after
  push instead of logging "Pushed" over "Everything up-to-date"; `timeout-minutes` on every ci.yml job
  and the eight secret-bearing sweeps (the default is 6 h); `permissions: contents: read` everywhere.
- **Deliberately not shipped** (each a decision, not an oversight): a docs-only path filter for CI
  (58% of the last 500 commits are docs-only and run all 14 jobs; the guard jobs must stay
  unconditional, so it needs a `changes` job), a pre-push hook (CI verdicts arrive ~6 min after the
  deploy is live), sharding the 7-minute unit-tests job, a composite `rpc-call` action for the ~25
  curl-and-check copies, SHA-pinning actions (Dependabot is told never to move them), and retiring
  one of the THREE `/api/smoke-test` concierge callers (cron-job.org console).

## CI audit drain, pass 2 (2026-09-02, overnight) — what a docs-only push runs now, and three measurements

- **Docs-only pushes skip the ten code jobs.** `ci.yml`'s `changes` job classifies the push from
  `github.event.before..HEAD` (⚠ never `HEAD~1` — a push of N commits hides code under a docs tip);
  typecheck, eslint-ratchet, both cadence jobs, unit/component/worker coverage, workers-typecheck,
  db-tests and edge-deno gate on `needs.changes.outputs.code == 'true'`. **Fail-safe by construction:**
  an unresolvable base, an empty diff, a `pull_request` event or a script error all leave `code=true`.
  ⚠ **What still runs on a docs push:** ledger/register/inbox guards, tree-corruption, the always-on
  `memory-docs` job (the link guard left `typecheck`, which docs pushes skip), and `docs-tests` — a
  TREE WALK over `__tests__` for files reading `docs/`, `CLAUDE.md` or `.github/` (107 files / 1,406
  tests / 37 s on 2026-09-02, floor 60). The register, ledger, inbox and memory-limit pins live in the
  unit suite; a docs push must never blind them, and this is what makes the skip honest.
  Falsifier: a code push reporting `code=false` is a classifier bug — delete the `changes` job first.
- **The Flow CLI install is one composite** (`.github/actions/install-flow-cli`); ci.yml carried it
  twice verbatim, and a fix to one copy had to be remembered for the other.
- **scheduler-liveness: a never-fired workflow younger than 48 h is `⏳ pending`, not `✗ dead`.**
  GitHub delays a fresh schedule's first fire by hours (daily workflows measured 0/73 on time), so
  every new scheduled workflow reddened the next 08:17 sweep exactly once. `createdAt` is probed from
  the workflows API only when no run exists; older-and-unfired stays red (the cron-that-never-matches shape).
- **vitest config prose displaced** — 17 comment blocks, 1,600 lines, verbatim to
  [vitest-config-notes.md](vitest-config-notes.md); the thresholds had sat at line 905 of a 913-line
  file. Each config keeps the block's first line and a §-pointer. (CLAUDE.md's index had 28 chars of
  headroom, so the file is reachable from here, not from there.)
- **Measured and NOT shipped, with the number:**
  - *Pre-push hook.* Of the 8 CI reds in the last 40 runs, **0 were tsc/guard-class** (2 vitest
    regressions, 3 coverage-ratchet dips, 1 DB pin, 2 vitest mocks). A tsc+guards hook catches none of
    them and `vitest --changed` cannot see a ratchet dip; the cost lands on ~100 agent pushes/day.
  - *Sharding the 7-minute unit-tests job.* Two shards measured **258 s / 192 s under contention**
    (415 s clean single-run), merge 6 s, and **the merged coverage is byte-identical to the single run**
    (92.15 / 80.05 / 94.13 / 94.24) — fidelity inside the 0.2-pt ratchet is NOT the risk. Per-shard
    coverage reads 55–59% and fails thresholds by design, so shards run with thresholds zeroed and a
    merge job applies them; `coverage-gates-are-wired-to-ci.test.ts` pins `npm run test:coverage`.
    Recipe: `vitest run --coverage --reporter=blob --shard=N/2 --coverage.thresholds.{lines,functions,branches,statements}=0`,
    then `vitest run --merge-reports --coverage`. ~3 min off the wall for three jobs; Trevor's call.
  - *`rpc-call` composite for the ~19 curl copies* — they just received their `cat`/401 fixes in
    place; re-plumbing is verifiable only on shed schedules. *SHA-pinning actions* — the sandbox
    cannot resolve shas and Dependabot is configured never to move them. *Retiring one of three
    `/api/smoke-test` concierge callers* — cron-job.org console.
