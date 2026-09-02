<!-- Extracted from CLAUDE.md on 2026-08-17 to bring that file under the memory-file
char limit. Content is VERBATIM; CLAUDE.md carries a one-line pointer to this file.
Same rules apply: every number here is a dated sample - re-measure before quoting. -->

## Key files to always reference

- `lib/collections.ts` — collection registry
- `lib/launch-flags.ts` — single-source-of-truth compile-time launch flags (`CANDY_MLB_PUBLIC`, `PANINI_PUBLIC`) for STAGED public `/insights` surfaces. Each flag fans out to 5 consumers (proxy.ts route wall, sitemap, `/insights` hub card, the surface layout's `robots`, smoke-test public list) so go-live is a one-line, atomically-cascading, git-reviewable diff. Flipping either is a PUBLIC-EXPOSURE change — Trevor's call only.
- `lib/api-error.ts` — **`apiErrorResponse(err, tag, fallback?)`: the REQUIRED failure path for every route a USER can reach — anonymous OR signed-in.** (This bullet said "every route an ANONYMOUS visitor can reach" until 2026-08-13; that scope was wrong and the wrongness is the finding — see below.) `safeApiError` classifies (SQLSTATE first, message-sniffing second) and this builds the response: stable copy + code, driver detail to the log only, `Cache-Control: no-store`, `Retry-After` when retryable, and **503-not-500 for a timeout** so transient capacity stays out of the hard-5xx budget that pages on genuine breakage. ⚠ **The scope of this defect has now been mis-filed FIVE times, each time as "the routes I happened to be looking at"**: D3 filed it as `/api/sets`; 2026-08-11 filed it as six `/api/public/insights` routes, then found all 29; 2026-08-12 swept the routes `proxy.ts` actually lets anon reach and found **43 more sites across 33 files** — plus **33 concierge tool-result sites** in `support-chat/route.ts` that hand driver text to the MODEL (which can quote it to the user), a surface no HTTP-body grep sees; 2026-08-13 swept the routes `proxy.ts` **gates** and found **120 more sites across 64 files** (`7e6a4a2c`).
  ⚠ **DURABLE — the anon guard's greatest strength IS its scope limit, and that is why the fifth filing existed.** The guard keeps no route list precisely so it cannot miss a route someone forgets to add — it EXECUTES `isPublicPath` from `proxy.ts` over every route file on disk. But deriving the file set from the security wall also *fixes the scope to that wall*: everything behind sign-in was outside it **by construction**, and no amount of running it would ever have said so. The leaking surfaces were the collector's own `/profile`, `/wallet`, `/alerts`, `/watchlist` and `/portfolio`; `/api/profile/trophy/reorder` is rendered **straight into a toast** by `app/dashboard/page.tsx`, so a statement timeout was shown to a collector as the reason their trophy case did not save. **A signed-in user is still a member of the public** — the only routes where a driver message is acceptable are ones gated on a shared OPERATOR SECRET, where the reader is holding the token. When a guard derives its inputs from a predicate, ask what that predicate is *silent* about.
  **Two guards now, plus one shared vocabulary.** `__tests__/anon-api-no-driver-message-leak-guard.test.ts` (anon-reachable) and `__tests__/authed-api-no-driver-message-leak-guard.test.ts` (everything a signed-in user can reach, excluding operator-secret surfaces — and it asserts those exclusions really carry a secret gate, **and** that the anon guard's set is a SUBSET of its own so no route falls between them). Both import the five leak spellings from **`__tests__/helpers/driver-message-leak.ts`** — one source of truth, created because this repo has already paid for the alternative: the anon guard once shipped with four spellings where its predecessor had five, and the missing inline-ternary form was still live on 12 sites. **Add a spelling there and every guard widens at once.**
  ⚠ **The fix can destroy the one thing the user needed to be told.** `safeApiError` only knows Postgres, so blanket-applying it to four routes that throw their own "Could not resolve `<username>`" replaced an actionable **400** with "Something went wrong." at a **500**. Hence `isUnresolvedIdentifierError` / `unresolvedIdentifierResponse`: classify on the message **server-side**, publish fixed copy. Reading a thrown message to classify is fine; publishing it is not. Same care on contract keys — `matched: true` is preserved deliberately, because "your listing DID match and only the recording failed" is a different thing to tell a user than "no match".
  ⚠ **The leaked text is not always ours or Postgres's.** `/api/pack-listings` was publishing **Dapper Studio's** internal GraphQL wording (`aafd014d`) — a third-party endpoint we do not control, reached only by signed-in users, which is exactly why it outlived every anon sweep. Also note two codemod regressions caught by existing tests when this class was swept mechanically: a 502 flattened to 500 in `breaks/{draft,lock}` (**the third-party-upstream distinction tells an operator whether WE broke**), and `rows: []` / `results: []` dropped from two bodies — the drop is correct (empty data beside a 500 lets a caller who skips `res.ok` render "no market data" from an internal error) but must be deliberate and commented, not accidental.
- `lib/insights/board-error.ts` — **`boardUnavailable(err, board, fallback?)`: a thin alias of `apiErrorResponse` for `app/api/public/**`**, keeping the board-specific log scope and default copy.** Never return a driver message from these routes — they are anon-readable AND the concierge's `fetchPublicInsight` forwards `json.error` straight into the model's tool result, so a Postgres "canceling statement due to statement timeout" reaches both visitors and the assistant (deep-audit D3). Swept and fixed across all 29 routes 2026-08-11; the leak had **three spellings** (`{ error: error.message }`, a `const msg = e instanceof Error ? …` then `{ error: msg }`, and a bare `{ error }` shorthand — `lib/supabase-paginate` returns `error` as a **string**, already the message), which is why a grep for the obvious one finds less than half. Pinned by `__tests__/public-insights-no-driver-message-leak-guard.test.ts` (directory-driven, all four spellings) — ⚠ a SOURCE test because no type forbids this: a string in a response body type-checks perfectly, so `tsc` can never catch a regression. The helper also sets **`Cache-Control: no-store`** (these routes set a PUBLIC `s-maxage` 300..3600 cache on success, so a cacheable 503 would pin a momentary blip into a sustained outage) and normalizes a bare-string error before classifying (else a timeout is misreported as a hard 500 instead of a retryable 503).
- **"A failed read must not render as an answer" — THREE helpers, one per layer. Pick the one for your layer; do not invent a fourth.** The class was swept out in stages during 2026-08-11/13 and each stage found a spelling — or a whole SURFACE — the previous sweep structurally could not see, so the helpers are deliberately separate:
  | layer | helper | the failure it prevents |
  |---|---|---|
  | any **API route a user can reach** — anon OR signed-in; only operator-secret surfaces are excused | `lib/api-error.ts` → `apiErrorResponse()` (`boardUnavailable()` is its `/api/public/**` alias) | publishing the driver's own message, edge-caching a 503, and a 500 where 503 is true |
  | **server page** (`app/insights/**/page.tsx`) | `lib/insights/board-status.ts` → `summarizeDegraded()` / `degradedFromSource()` | an empty board at HTTP 200, indistinguishable from "nothing matched" |
  | **client dashboard** (`components/analytics/**`) | `lib/analytics/fetch-json.ts` → `fetchJson()` | a `.catch` in a `useEffect` collapsing network/5xx/bad-body/empty into one `null` |
  | **OG social card** (anywhere under `app/api/og/**`) | `lib/og/board-empty-copy.ts` → `boardEmptyCopy(fetched, noun)` | one line for both an empty board and a failed read — **baked into a cached PNG** |
  | **a board's ROW COUNT**, anywhere it is published (`/api/public/insights/**` meta, and any OG card header) | `lib/insights/board-meta.ts` → `boardRowMeta(n, limit)` / `boardRowMetaComplete(n)`; `lib/og/board-count.ts` → `fetchBoardCount()` + `boardCountLabel()` | a **capped page length** published as a board total |
  | **link-preview metadata** (`generateMetadata` in any shareable `layout.tsx`/`page.tsx`) | no helper — the RULE is *never emit a figure the read did not produce*; see `profileDescription()` / `trophyCaseDescription()` | a failed read publishing **"Portfolio: $0 FMV across 0 moments"** into the unfurl of a named collector |
  | **server page PANELS, below whatever the page already hardened** | no helper — branch on *did the READ succeed*, and place the guard on the **post-filter** array | `?? 0` on a null stats object rendering **"No sales in the last 24h"** while the collection did 8,332 |
  ⚠ **The sixth instance landed on a page whose honesty had ALREADY been fixed, which is the transferable part (P0, 2026-08-15).** `/nba-top-shot/overview` and `/nfl-all-day/overview` stated **"No sales in the last 24h"** while Top Shot had done **8,332** sales and All Day 240 in that window. Every honest layer worked — `/api/collection-stats` returned a proper **503**, the KPI band showed em-dashes, the amber banner rendered — and then `overview/page.tsx` applied **`?? 0`** to the same null `stats` two panels lower and turned it into a market assertion, **the page contradicting itself on screen** while its own Insider Signals panel listed 269- and 171-moment sweeps from 1–2 h earlier. Deep-audit **D11 hardened the KPI band directly above these panels and did not reach them.** *A page is not "made honest" by fixing the component that failed; every panel that consumes the same failed read needs the same branch* — now on `statsUnavailable` (did the read succeed) **before** any length check. ⚠ **The empty-state guard also has to sit on the POST-FILTER array**: top sales are name-filtered before render, so a guard testing the RAW array saw length 5, skipped the empty state, and the filter then stripped all 5 — **a blank panel with no copy at all**, live on `/disney-pinnacle/overview` because a Pinnacle ingest regression left every top sale with a NULL `edition_id`.
  ⚠ **INSTANCES EIGHT THROUGH TWELVE (2026-08-16) FORM A SUB-CLASS WORTH NAMING SEPARATELY: THE FALSE CLAIM IS ABOUT THE READER'S OWN ACCOUNT.** That is the worst version, because the reader is the one person who knows the claim is wrong and has no way to tell that we know it too — and unlike a market claim, it is *actionable*, so it makes them do something. Four surfaces in one sweep: `/my-teams` told a collector who follows six teams **"Follow a team to build your hub"** (an invitation to start over) and told them to **"Add a wallet address … on your profile"** they had already added; `/fast-break` and `/road-to-the-ring` both rendered **ConnectWalletCard** to someone who HAS pinned a wallet. ⚠ **That last one was COPY-PASTED VERBATIM** — the identical eight-line `saved_wallets` query in both pages, carrying the identical missing `error` — so the fix is ONE shared module (`lib/wallet/pinned-wallet.ts`), not two edits. This repo has paid for the copy-pasted version of a defect twice already (15 OG cards, 5 sales indexers); **when you find one of these, grep for the query before fixing the file.** ⚠ **All four sat behind SIGN-IN**, which is exactly why no sweep had reached them: the anon driver-message guard derives its file set from `isPublicPath`, so everything past the auth wall is outside it **by construction** — the guard-scope class again, and the reason this file already states that *a signed-in user is still a member of the public*.
  ⚠ **INSTANCES THIRTEEN AND FOURTEEN (2026-08-16) ARE THE SAME COPY-PASTED LOADER AGAIN, AND THEY ADD ONE THING: A SECOND PATH TO THE SAME FALSE CLAIM THAT IS INVISIBLE IN THE DIFF.** `/dashboard/history` and `/dashboard/packs` each carried the identical twenty-line `saved-wallets` loader — `if (!res.ok) { setWallets([]); return }`, no error state anywhere — so a 503 rendered **"No verified wallets yet — Verify a wallet from your dashboard, then come back here"**, with an **Open dashboard** button, to a collector who had already verified one. Actionable in the worst way: it sends them to redo finished work. ⚠ **Both also ran the fetch inside `try { … } finally { … }` with NO `catch`**, so a thrown fetch escaped as an unhandled rejection while `wallets` sat at its `[]` initial value and the `finally` cleared the loading flag — **a render byte-identical to the non-2xx path**. Fixing only the status check would have left the offline case lying. Fixed as ONE module (`lib/wallet/verified-wallets.ts`, deliberately NOT merged with `fetchPinnedWallet` — server vs client, collection-scoped vs cross-collection, unverified vs verified). **Second copy-pasted instance of this class in two days: grep for the query before fixing the file, every time.** ⚠ Checked in the same sweep and **CLEAN**, recorded so nobody re-derives them: `/dashboard/api-keys` (consults `loadError`), `/dashboard/alerts` and `/alerts` (per-leg `failed` flags), and `[collection]/collection`'s saved-wallets read, which is **prefetch-only and never rendered** — a failure there costs cache warming, not truth.
  ⚠ **THE WORST INSTANCE IS NOT A FALSE CLAIM AT ALL — IT IS SILENT DATA LOSS, AND THE USER'S OWN TRUST IS THE MECHANISM (`/profile/edit`, 2026-08-16).** The render was `loading ? "Loading…" : <form>` with **no failure branch**, so a failed `/api/profile/bio` left the form at its EMPTY initial state and presented it as your profile — and `save()` POSTs **every field unconditionally**, so editing one thing and hitting Save overwrote display name, tagline, socials and avatar with nulls. ⚠ **The fix has to WITHHOLD the form, not annotate it**: a banner over a blank editable form still lets a save go out, and the save is the destructive act — so the test asserts the **ABSENCE of the editor and of the Save button**, not the presence of an error message. ⚠ **A second, independent loss vector on the same page**: `/api/profile/teams` REPLACES the full list, and the loader's `.catch(() => [])` was indistinguishable from "no favourites", so any save after a failed teams read **deleted every favourite team — exactly what `/my-teams` reads back**. That leg is now SUPPRESSED rather than sent: leaving them untouched is the only safe answer when we do not know what they are. **When a page LOADS state and WRITES IT BACK, a failed read is not a display bug, it is a delete.**
  ⚠ **A COMMENT IDENTIFYING A CLASS IS NOT A SWEEP OF IT (`TrophyPickerModal`, 2026-08-16).** That file's header documents, in detail, an instance of this very class — the `PICKER_LIMIT` search-scope cap rendering "No moments match the current filter" about someone's real collection. The **failed-read** instance sat **two lines above it in the same effect**, uncaught: `.then(r => r.ok ? r.json() : null)` → `?? []` → *"No owned moments found yet — try the manual tab if you know the moment ID."* A claim about the reader's own holdings, and **actionable** — it sends them to type an id for a Moment we merely failed to fetch. **When you find one of these, grep the same FILE for the others before closing it.**
  ⚠ **THE STRONGEST FORM OF THIS CLASS FOUND SO FAR, and it is worth recognising by shape: the false claim came with a GUARANTEE attached.** `/fast-break` rendered *"No active Fast Break run — **We'll surface the next run here as soon as Top Shot opens it**"* out of an unchecked `const { data: run }`, i.e. during a live run it both denied the run and promised it would have said otherwise. ⚠ Its header **subtitle** asserted "No active run" too and renders ABOVE the gate ladder, so fixing only the card would have left the claim on screen — **sweep every site that consumes the same failed read, not the one that failed**. Same page, third site: a failed slate read rendered as a quiet night, which is a real answer the NBA produces most weeks.
  ⚠ **AN EMPTY STATE THAT CONCLUDES IS WORSE THAN ONE THAT MERELY REPORTS, and it is the last shape to look for once the plain ones are swept (2026-08-16).** The sniper's Listing Suggestions panel printed *"No listing suggestions found. **Your moments are priced at or below current market asks.**"* — a specific analytical claim about the reader's portfolio, produced by **three** paths in which no comparison ever happened (a non-2xx `/api/collection-snapshot`, a thrown fetch whose `.catch` only stopped the spinner, and the deals feed not yet loaded). ⚠ **It is actionable in the direction of INACTION** — it tells a collector not to re-list, which is the quietest possible harm: they do nothing and never learn why. ⚠ **When there are two ways to fail, their ORDER is load-bearing**: `read-failed` must beat `no-market`, or a failure on the reader's own collection is blamed on the market feed, pointing them somewhere that will never fix it. And the conclusion must **stay reachable** when both sides loaded — routing a true, useful answer into a failure notice is the mirror-image defect. Sibling shapes already fixed: *"Benchmark data may be too thin"* and *"try a longer time range or lower min FMV floor"* — **advice to fix a filter that is not the problem**.
  ⚠ **THE FURTHEST-REACHING MEMBER OF THIS FAMILY IS AN ALERT, BECAUSE ITS OUTPUT IS SILENCE AND SILENCE IS UNFALSIFIABLE (`08b16613`, 2026-08-16).** The concierge's `manage_alerts` defaulted `min_discount` to **25 unconditionally**, so *"alert me any time a Damian Lillard Archive moment lists for $0.60 or less"* was saved as `max_price 0.60` **AND** `min_discount 25` — an alert **strictly narrower than the sentence that created it** — while the confirmation said "whenever one lists at $0.60 or under". The user then hears nothing and cannot tell a quiet market from a rule that could never fire; unlike a wrong panel, **there is no screen on which the error is visible**. Three parts to the fix, and each generalizes: (1) the default now applies **only when no `max_price` was given**, because a threshold is the only thing between an alert and a firehose *when the user supplied none* — it is not a free extra safeguard once they have supplied one; (2) the tool returned only `{id, label, channels}`, so **any silently-added filter was invisible by construction** — it now returns `applied_filters` with a note requiring every entry to be stated back, and the auto-label was fixed the same way (a row labelled *"25%+ under FMV"* carrying no discount filter is the same lie, sitting in the list); (3) ⚠ **the honest-looking fix was WORSE and was caught by running the UPDATE against the live row before shipping the code** — writing `null` throws **23502**, because the column is `NOT NULL DEFAULT 25`, so the alert would not have been created at all. ⚠ **And `0` did not mean "no FMV condition"** — `build_deal_alerts_for_subscription` read `cross_collection_deals_board`, so an **above-FMV** listing under the price cap still could not fire. That was DISCLOSED in `applied_filters` rather than quietly shrunk, on the principle that **disclosing a limitation you cannot yet remove is the honest move**. ✅ **SUPERSEDED THE SAME DAY (Trevor: "do the scanner change so price-only alerts actually ignore FMV") — `audit_20260816_price_only_alerts` REMOVED the limitation**, and the measurements behind it are the durable part:
  - ⚠ **A price-only alert was structurally incapable of firing at ANY price, because both scanners read a DEALS board BY CONSTRUCTION** — `topshot_deals_vs_fmv` requires `low_ask >= 5`, the Pinnacle/All Day arms `floor_ask >= 1`, and every arm `low_ask < fmv_usd` with confidence IN (HIGH, MEDIUM). Live: **111 board rows, cheapest $1.00, ZERO at or below $0.60** — against a raw ask universe of **4,563 rows, cheapest $0.33**. **The listings were there; the instrument could not see them.** Price rows are now a separately tagged pool (`pool = 'price'`), built only when a price-only sub exists.
  - ⚠ **A SECOND, INDEPENDENT DEFECT WOULD HAVE MADE THAT FIX CHANGE NOTHING for the one subscription that motivated it** — `set_names` matched with **exact equality** while the saved filter was `Archive` and the real catalogue set is `Archive Set`, so zero rows at any price. Set filters are CONTAINMENT now; **`player_names` stays EXACT deliberately** (a proper noun the concierge resolves from the catalogue, versus a phrase people abbreviate). **Ship one of two blocking defects and you ship a fix that demonstrably changes nothing.**
  - ⚠ **Do NOT add FMV context to the price pool: the lateral cost 99% of the query** — **28,117 ms with it, 320 ms without**, at the tightest cap, *with* the `computed_at <= now()` pruning already applied and `Subplans Removed: 1` confirmed. It is 2,640 index probes on a 2 GB IO-throttled instance for a column that by definition is not a condition here, inside a 90 s dispatcher shared with every subscriber.
  - ⚠ **AN HONEST ZERO IS INDISTINGUISHABLE FROM A STRUCTURAL ONE, AND THAT IS HOW A "FIX" GETS SIGNED OFF WRONG.** Previewing Trevor's own subscription after the fix returned `deals_count: 0` — correctly, because Archive Set Lillard's cheapest ask is **$4.00**. **The clean way to prove a notification path end-to-end without sending anything is a throwaway subscription with `channels = '{}'`** — the dispatcher's `FOREACH` cannot enqueue on an empty array, so the query runs and nothing is delivered.
  - ⚠ **On the render side the discriminator is AVAILABILITY (`hasFmvContext`), NOT the `price_only` flag** — the question is *is there an FMV to state*, which also catches a legacy deals row arriving with a null FMV that the flag would miss. All four sites (Telegram / Discord / email HTML / email text) had interpolated `${pct(discount_pct)} below FMV ${money(fmv)}` unconditionally, rendering **"— below FMV —"**: an em-dash sentence that both looks broken and implies we know an FMV we failed to show. Discord OMITS the fields rather than em-dashing them. ⚠ And on `/alerts`, **`min_discount 0` with NO `max_price` is NOT price-only** — it means "any discount at all", which the deals board still answers; the two are pinned apart.
  - ⚠ **AND THE DISCLOSURE ITSELF THEN BECAME THE FALSE STATEMENT — a disclosed limitation has a SHELF LIFE, and nothing announces its expiry.** The `applied_filters` line *"at or below FMV — the deal scanner is FMV-based, so a listing priced ABOVE FMV … will not fire even if it is under your price"* was correct when written and **false a few hours later**, once the price-only pass shipped. Left standing it tells the user their alert is **NARROWER than it is** — the same failure as the invisible filter it replaced, pointing the other way, and just as unfalsifiable: they read the silence as "nothing has listed". ⚠ **A TEST WAS PINNING IT, AND IT WAS A GOOD TEST** — `expect(filters).toMatch(/at or below FMV/i)`, with a comment explaining exactly why. **A correct assertion about a limitation becomes the thing holding that limitation's description in place once the limitation is gone**; it is the "tests that assert the defect" class with a clean conscience. Inverted to assert the new line is present **and the old one ABSENT**, so a revert reds. Same payload carried a second staleness: `set: Archive` implied an exact match the scanner had stopped performing in that same migration (it reads `set name contains:` now). **When you remove a limitation, grep for every place you documented it — code copy, tests, and prose — in the same pass.**
  ⚠ **A LOOKUP KEYED ON `x ?? ""` PAIRS EVERY UNKEYED ROW WITH AN EMPTY-KEYED ONE.** `dealByEdition.get(m.editionKey ?? "")` would match a feed row whose `editionKey` is `""` against **every unmapped Moment** — and unmapped rows are not hypothetical here (the Pinnacle catalog-coverage gap leaves real sales with no edition id). The result is a confident claim about a Moment we cannot identify, priced against a listing we cannot identify. **Skip the row instead.** Found by an assertion written expecting it to pass.
  ⚠ **`?? 0` ON A SUPABASE COUNT — THIRD RECORDED INSTANCE, and this one was on a PUBLIC shareable URL.** `/pinnacle/moment/[id]` published `Number(holdersRes.count ?? 0)` as **"Tracked holders — in RPC wallet cache"**, so a `57014` rendered a hard **0**: a claim about OUR OWN data manufactured from OUR OWN outage. **Branch on the ERROR, never on the value** — and note the mutation that survives here (`count == null ? null : …`) is *indistinguishable in every state the client produces*, because supabase reads `count` off `Content-Range` and an error response carries none. That is a case for a SOURCE assertion plus a recorded reason, not a contrived fixture: the value-branch is correct only while the transport happens to null the count on failure, which is exactly the reasoning that made `?? 0` look safe.
  ⚠ **FOURTH AND FIFTH INSTANCES (2026-08-16) ARE ON THE SERVER, AND THE SHARP ONE SHOWS THAT `Promise.allSettled` DOES NOT HELP.** `/api/overview-stats` published `totalEditions`/`highConfCount` as `status === "fulfilled" ? (count ?? 0) : 0`, and `/api/badges` published `meta.total: count ?? 0` beside rows that loaded fine. ⚠ **A supabase count that FAILS still RESOLVES** — `{ count: null, error }`, not a throw — so `allSettled` reports `fulfilled`, a `try/catch` never fires, and the `??` turns it into a measured zero. `overview-stats` had already adopted `allSettled` *deliberately*, after one rejection once zeroed its whole KPI strip: **that bounds the blast radius of a failure and does nothing about the failing leg asserting "there are none", because the realistic failure is not a rejection at all.** On `badges` the count is the EXPENSIVE half (`count: "exact"`), so it is the likelier of the two to time out, and `total` is a pagination contract — a 0 tells a caller there is nothing to page through while `editions` is non-empty in the same response. ⚠ **Both were LATENT, not live** (no in-repo consumer renders either field) and are documented that way in code, tests and ledger; fixed for the contract, the reasoning that fixed `meta.total_rows`. ⚠ **A MUTATION CORRECTED THE OBVIOUS READING OF THAT FIX and the correction is the durable part: branching on `error` is REDUNDANT.** Measured across every shape supabase-js produces — `{null,error}` → null, `{0,null}` → 0, `{7,null}` → 7 — identical with and without the branch, because a failed count nulls `count` too. **The load-bearing change is `?? 0` becoming `?? null`.** Keep the branch as intent if you like, but do not let a comment claim it is the mechanism; assert the composite instead.
  ⚠ **THE SIXTH INSTANCE IS THE ONE THAT MATTERS MOST, BECAUSE IT IS A GUARD RATHER THAN A SURFACE — `?? 0` ON A COUNT MAKES A CHECK FAIL *OPEN*, AND A GUARD'S OUTPUT IS SILENCE (2026-08-17).** `stale-fmv-monitor` derived `dataIntegrityOk` from two orphan counts being zero and read them as `count ?? 0`, so a `57014` on a 19k-row count became **0 → "no orphans" → integrity alert suppressed**: the monitor reported the data sound **from a read it never performed**. ⚠ **`Promise.all` made it LOOK protected and is not** — all five reads sit in one `Promise.all` inside a `try/catch`, but supabase-js RESOLVES `{ count: null, error }`, so nothing rejects and the catch never fires; the route's own *"non-fatal; keep snapshotsToday=0"* comment reads as if it were the failure path. Fixed to **three states** — `data_integrity_ok` true / false / **null**, with `data_integrity_checked` travelling beside it so a consumer cannot misread the null — the same `couldNotRun` distinction the Pinnacle FMV drift guard was rebuilt around. ⚠ **The unevaluated case is deliberately NOT an ops page**: a transient count failure on a 30-minute cron would page on noise, which is how an arm trains its operator to skim.
  ✅ **AND THE SWEEP THAT FOLLOWED FOUND THE WORST STRUCTURAL FORM OF IT: A SELF-THROTTLE THAT IS DISABLED EXACTLY DURING THE CONDITION IT DETECTS. SHIPPED 2026-08-17 (`5eda629f`) — all 9 routes, verified here at destructure + guard present in each.** ⚠ **This bullet said "filed, NOT shipped … a deliberate call" for about an hour, and BOTH the filing's rationale and my endorsement of it were wrong — that is the durable part.** The filing's decisive argument was a **cost estimate nobody measured**: that nine bespoke Supabase stubs would each need per-file sequencing to make *only* the throttle read fail. They do not — **the throttle is the FIRST read and it RETURNS EARLY**, so on the failing path the route never reaches another query and a blanket-error stub cannot be ambiguous; one behavioural test plus a directory-driven source guard covers all nine and any tenth. ⚠ **The fix is also uniform in a way the filing did not anticipate**: rather than replicate each route's differing `logRun` arity, it `throw`s the returned error into the `catch` the author already wrote, so both failure shapes share one path (a bare `throw throttleErr` would log `[object Object]`, because a PostgREST error is not an `Error`). ⚠ **THE GENERAL LESSON: this file tells you to re-derive a filed FINDING before acting on it, and says nothing about a filed DECISION NOT TO ACT — but a not-shipped rationale is exactly as much a hypothesis, and it is the one nobody re-checks, because declining to act looks like the conservative option.** ⚠ **And the sweep proved its own point about half-done sweeps while fixing it**: a scripted edit matched **8 of 9** and silently skipped `ufc-studio-sales-history-backfill`, which names its constant **`PIPELINE`** instead of `PIPELINE_NAME`. Only a per-file occurrence assert caught it — which is why the shipped guard **walks the tree** instead of naming routes. The original filing follows, kept because its reasoning was wrong in an instructive way. Nine `app/api/cron/**` routes open by counting other pipelines' recent failures and skipping the tick if the platform looks saturated. **The `catch` fails CLOSED; the returned-error path fails OPEN**, in the same block: a rejection abandons the tick (`skipped: "throttle_error"`), while `{ count: null, error }` → `?? 0` → `0 > THRESHOLD` is false → **the tick proceeds**. The author's intent is unambiguous from the `catch`, and the branch that fires in production is the one that fails open. ⚠ **It is self-reinforcing**: the throttle read is a `count: "exact"` over `pipeline_runs` — the table every pipeline is writing to — so it is most likely to fail *during* saturation, and the more saturated the instance the more likely all nine decide the platform is healthy. ⚠ **Nothing measures how often it failed open, because a failed-open tick is indistinguishable from a healthy one in `pipeline_runs`** — the observed `skipped: "saturation"` rows only prove the guard works when the count SUCCEEDS. **Verified independently 2026-08-17: 9 routes, 0 of 9 destructure the error.** ⛔ **Do NOT "simplify" the fix to `count == null`** — identical today and for the wrong reason (the `?? 0`-is-the-mechanism correction above), and it breaks the moment a client returns a count alongside an error. ⛔ **Do NOT raise `SATURATION_FAIL_THRESHOLD` or widen the 30-minute window instead** — the guard is not mis-tuned, it is unreachable on one of its two failure shapes. ⚠ **Two files contain TWO `const { count } = await supabaseAdmin` reads and only one is the throttle — match on the `SATURATION_FAIL_THRESHOLD` line, not on the count read.** ✅ **The shipped fix `throw`s the returned error into the `catch` the author already wrote**, so both failure shapes share one path and no per-route `logRun` signature knowledge is needed — the routes' arities differ, and replicating them nine times is what made this look expensive. Pinned by `__tests__/saturation-throttle-reads-its-error.test.ts` (a directory-driven BAN at population ZERO, so a tenth route pasted from a sibling reds; it asserts the error guard PRECEDES the threshold comparison, and that the error is wrapped in a real `Error` so a plain PostgREST object cannot log as `[object Object]`) plus `__tests__/saturation-throttle-fails-closed.test.ts` (behavioural, on one representative route, pinning all three directions incl. that a healthy count still opens the gate). ⚠ **AND THE DURABLE PART IS WHY IT WAS ALMOST NOT SHIPPED: my filed reason was a COST ESTIMATE I NEVER MEASURED.** I claimed nine bespoke Supabase stubs would each need per-file sequencing to make *only* the throttle read fail. They do not — **the throttle is the FIRST read and it RETURNS EARLY**, so on the failing path the route never reaches another query and a blanket-error stub cannot be ambiguous. One behavioural test plus a source guard covers all nine and any tenth. Original filing (§5 kept and labelled superseded, because its reasoning was wrong instructively): [inbox 2026-08-17T1211Z](../../docs/overnight/inbox/2026-08-17T1211Z-the-saturation-self-throttle-fails-OPEN-on-a-returned-error-in-9-routes.md). It also ranks below the two above because it **degrades the platform rather than lying to a collector**.
  ⚠ **A CLOSING CLAIM OF MINE — "the leftover `?? 0`-on-count sites are all telemetry" — WAS FALSE, AND VERIFYING IT IS WHAT FOUND THE USER-FACING ONE.** `/api/profile/market-pulse` published a failed count as **"0 snapshots / 0 editions indexed"** — a claim that our own FMV index is empty, manufactured from our own outage. ⚠ **The tell was already inside the route**: its whole-route failure object returns `commonFloor: null` **beside** `indexedEditions: 0` — it knew how to say "unknown" and used it for the floors only. **A no-more-instances claim is a hypothesis; the cheap check is to go and confirm it.**
  ⚠ **AND A GUARD PINNED THE LITERAL `count ?? 0`, so it fired on a strictly BETTER spelling.** `invariants-postgrest-cap` exists for the count-not-`.length` property (the 4,243-reported-as-1,000 clamp), but it matched the exact old text, so correcting `?? 0` → `?? null` reddened it. **Pin the property, not the spelling** — otherwise the guard bills every improvement as a regression. Same family as the two good tests inverted alongside it, whose requirement was right and whose way of honouring it was wrong.
  ⚠ **A LEGACY REDIRECT ROUTE IS THE HIGHEST-STAKES PLACE TO CONFLATE THEM.** `/edition/[id]` did `if (error || !data) notFound()`. That route exists ONLY to catch links that already exist in the wild — old shares, DMs, anything a crawler indexed under the flat URL — so a statement timeout handed a hard 404 for a real edition **to the audience least likely to retry and most likely to record it**. On a redirect route the right failure is a THROW (retryable error boundary); there is nothing to render, so an "unavailable card" is not an option.
  ⚠ **A FALLBACK IS A THIRD STATE THAT CAN SWALLOW A FAILURE, and it is harder to see than a plain empty state.** `/[collection]/set/[slug]`'s tier bar sampled the first 100 editions whenever the full-set count came back empty — a LEGITIMATE fallback for a collection unreachable by `set_name` — and `fetchFullTierMix` returned a bare `[]` on a query error, so a failed read silently took it. The bar prints ABSOLUTE COUNTS, so a ~3,600-edition set rendered "COMMON · 62 · 62.0%" against a true ~2,200, identically to the accurate bar. **Keep the fallback for the case it was written for and withhold the section on failure**; deleting the fallback is the mirror-image defect. ⚠ And **discard partial counts** rather than returning them — a truncated mix still sums to 100% and reads as complete, so it is not a smaller answer but a wrong one.
  ⚠ **THE SEVENTH INSTANCE WAS CREATED BY THE SIXTH'S FIX, and that is the part to remember (2026-08-15).** Moving the guard onto the post-filter array killed the blank box and silently introduced a THIRD false claim: the dropped rows were **READ SUCCESSFULLY** — the market traded and we could not name it — so routing them into the existing empty state published **"No sales in the last 24h"**, a claim about the MARKET manufactured from a gap in OUR catalog. Measured live: Disney Pinnacle did **960 sales in 24 h with 60% carrying a NULL `edition_id`**, and **2 of the top 5 by price were unnameable**, so the panel was quietly serving a **3-row "Top 5"** and was one unlucky draw from asserting a busy market had gone silent. **A name filter is not an emptiness test.** There are THREE states and they must never share a branch: *read failed* → "couldn't load"; *read ok, 0 rows* → "no sales" (an honest market claim); *read ok, 0 nameable* → "N recent sales not yet matched to a moment" (a claim about us). Partial omission is now DISCLOSED inline — a "Top 5" rendering 3 rows is a truncated ranking served as the complete one. ⚠ **The existing test ASSERTED THE DEFECT**, and it was a well-written test: its case was named *"top sales that all fail the name filter render the empty state, not a blank panel"* and explicitly pinned "No sales in the last 24h" as correct. **A case correctly reasoned for the bug it was written against becomes the thing pinning the next one in place** — a distinct failure from a vacuous assertion, and mutation testing cannot find it. ⚠ **Also note the cause was mis-labelled**: "a Pinnacle ingest regression" is wrong — nothing regressed, it is a **catalog-coverage gap** (`pinnacle_nft_map` does not cover every traded NFT) that a 4.5× volume jump on 08-14 made visible, so the copy has to survive it rather than wait for an ingest fix.
  ⚠ **The metadata layer is the FIFTH, found 2026-08-14, and it is the one nobody looks at** — `generateMetadata` output is invisible in the browser and only ever seen in *someone else's* timeline, so `/profile/[username]` published a false `$0` for ~2 months undetected. The fix is structural, not copy: **build the description from parts and OMIT any count that is zero or unread**, so an absent figure falls out of the sentence rather than being asserted as a measurement. ⚠ **`generateMetadata` must not self-fetch its own API either** — it ran an HTTP round trip back into the same deployment; `getPublicProfile` is now a shared module wrapped in React `cache()` so the layout's call and the page's collapse into ONE read. The memo keys on ARGUMENTS, so every server caller must pass the same `source` label or the dedupe silently does not happen.
  ⚠ **DURABLE NEXT.JS GOTCHA — `openGraph` and `twitter` merge SHALLOWLY.** A route that redefines either key **REPLACES the root object** from `lib/seo.ts` rather than merging into it, silently dropping `siteName` / `type` / `locale` / `creator`. Every route-level block must **restate** the root fields it wants to keep. Invisible locally; shows up only as a degraded unfurl. (Same family: `rootMetadata.twitter` had `creator` but no `site`, and since ~44 files define their own block while every other page inherits this one, most of the site unfurled with no X byline at all.)
  ⚠ **The ROW-COUNT layer is the newest member (2026-08-15), and it is the one where the NAME caused the defect.** Every `/api/public/insights/**` route published `meta.total_rows: data?.length ?? 0` — the length of the **capped page**, since each route clamps `limit` with `Math.min` — under a name meaning the opposite. Six OG cards read it as a board total, and **three read it off the same `limit=3` request they used to render their top-3 rows**. Measured live: `top-sales` published **"3 sales this week"** against **30,592**; `squeeze` "200 editions squeezed 50%+" against 1,352; `trophies` "500 grails ranked" against 842. A consumer reading `total_rows` has no reason to suspect a page length, which is why this survived review by everyone who touched it. **`total_rows` is KEPT unchanged** (the concierge's `fetchPublicInsight` and external consumers read it); `returned_rows` + `truncated` are added beside it, and a capped count renders as a **floor** (`"200+"`). ⚠ **Deliberately NOT fixed with `count: exact`** — these are anonymous endpoints on a 2 GB disk-IO-throttled instance where the insights refresher already fails 4 of 6 board warms per tick, so a full count per request would buy a nicer number by worsening the saturation that causes the timeouts. ⚠ **`market` is the one route left on `boardRowMetaComplete`** because it pages through everything (`fetchAllPaged`) — marking a paged read truncated, or a capped one complete, are both silent lies, so check which you have. Guard: `__tests__/og-insights-headline-count-is-not-a-page-length.test.ts`, which ⚠ matches the **call forms** `boardCountLabel(` / `fetchBoardCount(` rather than the bare identifiers — a card that keeps the import while hand-rolling the interpolation satisfies a plain `includes()` and slips straight through (caught by mutation, not by review).
  ⚠ **A BROADER VERSION OF THAT GUARD WAS BUILT, MEASURED, AND REJECTED — it would have made four ACCURATE cards less accurate.** "Any card publishing a count must use the helper" flags `pack-drops` (its fetch takes no limit), `pack-sniper` (`positiveEv` is counted before the `slice(0, limit)`), `set-completers` (that route has no limit at all) and `rookies` (a real cohort aggregate). The defect is not *publishes a count* — it is *publishes a count derived from a capped page*, and **that is not decidable from the card's own source**. Forcing those four through the helper would have replaced exact counts with floors to satisfy a rule. The rejected rule and the four verifications are recorded in the test file so nobody re-derives them. **This is the "a filed finding is a hypothesis" lesson applied to a guard you are about to write yourself.**
  ⚠ **The OG layer is the one where the copy could not possibly be true, and it went unnoticed longest.** Fifteen cards printed `Loading the live board…` on an empty result. An OG card is a **static PNG generated once and edge-cached**: by the time that string renders the fetch has finished, nothing is loading, and a card generated during a five-minute outage keeps telling every social feed otherwise long after recovery. `fetched` answers *did the READ succeed*, NOT *were there rows*, and **must be set inside the `if (res.ok)` branch** — at the top of the try it would report a failed read as an empty board. Succeeded-with-nothing makes a claim about the MARKET; could-not-read makes a claim about US and points at the uncached page. The helper deliberately contains no wording implying a retry, because the card will never update itself. Guard: `__tests__/api-og-insights-empty-vs-unavailable.test.ts`, directory-driven so a 16th card is covered automatically (this defect spread by copy-paste across 15 near-identical files, the same way the 23505 batch-insert bug reached 5 sales indexers).
  ⚠ **The row above used to say `app/api/og/insights/**`, and that narrower scope was wrong in the way this file keeps documenting: the guard's own predicate fixed its blast radius.** The first version of the impossible-claim sweep walked `og/insights`, so it was silent *by construction* about `app/api/og/fast-break`, which carried "Tonight's slate is still loading." for weeks after the 15 insights cards were fixed — a guard I had written that same session, making it the fourth instance of this shape (the anon driver-message guard, the server-page guard's hand-written 2-of-79 list, `insights-gate-include-completeness`'s `INSIGHTS_DIR` walk). It now recurses the **whole `og` tree**, with a not-vacuous check naming both families and a `stripComments()` pass — required, not tidiness, because its first run reported exactly one offender: the comment documenting the fix, which quotes the old copy verbatim. **Any check that greps source for user copy must strip comments, including the one you are about to write.** ⚠ Two cards outside `og/insights` needed the same fix for a sharper reason: `og/share` and `og/profile/[username]` published **"$0.00" / "PORTFOLIO FMV $0" about a named collector** during an outage, onto the exact card that collector deliberately posts. The share route's own comment called the zeros "a branded shell" — zeros are not a shell, they are a NUMBER, and a reader cannot tell one from a real answer. Both now withhold the figure per leg (a failed trophy read must not blank the portfolio, and vice versa) while **still rendering $0 for a wallet that genuinely holds nothing** — pinned in both directions by `__tests__/api-og-share-cards-no-false-zero.test.ts`.
  ⚠ **The client spelling is why a single sweep never finds the whole class**: the server variant is `if (error) return []`, the client variant is `.then(r => r.ok ? r.json() : null).catch(() => {})`, and a grep for either finds none of the other. ⚠ **`fetchJson`'s discriminator is `ok`, NEVER `json == null`** — a route may legitimately answer with a JSON `null` body, and branching on emptiness reintroduces the exact conflation. Each layer has a directory-driven guard; extend the guard, not just the instance. ⚠ **There is a FOURTH layer with no helper, because its renderer is a language model:** the concierge. `support-chat`'s tools return `{status:"error", …}`, and what stops the assistant reporting that as a finding ("there are no deals below FMV right now") is a RULE IN THE SYSTEM PROMPT — *CRITICAL — An errored tool is NOT an empty result* — sitting alongside the older `status: "no_results"` rule, which is the opposite case and IS a real finding. Keep the two rules distinct; collapsing them re-opens the conflation even if the heading survives. Pinned by `__tests__/support-chat-error-vs-empty-prompt-guard.test.ts`, which also asserts the tools still EMIT that shape and still classify through `safeApiError` ⚠ **That EMIT check counts occurrences across the whole 3,996-line file, so it is satisfied by any 33 of them — a 34th tool could ship able to say only `no_results` and still pass** (the guard-scope class, met on a COUNT rather than a directory walk; the prompt rule is worthless for a tool physically incapable of producing the other status). Closed 2026-08-16 with a **per-HANDLER** pass that splits `executeTool` into its `if (toolName === "x")` blocks — audited first: **33 handlers, every one that can return `no_results` already carries an error path**, so it pins a property that holds rather than fixing a defect. ⚠ **`escalate_to_human` is the one legitimate exception, and its claim is the INVERSE of every other one here** — not "we found nothing" but **"we DID something"**. Telling a user with a live emergency *"The team has been paged"* when both channels refused makes the failure invisible to **both** sides: they stop escalating and nobody was told. Four properties are pinned: `pageDelivered` is set ONLY inside each channel's `res.ok` branch (⚠ **a dead token still RESOLVES a response, so an awaited `fetch` succeeding proves nothing**), the confirmation copy is gated on it, and an undelivered HIGH page writes a `support-chat-escalation` row with `p_ok:false` so a broken pager is discoverable rather than silent. — the prompt tells the model the message is safe to relay verbatim, which is only true while they do.
  ⚠ **A THIRD CONCIERGE SHAPE, AND THE WORST OF THE THREE: A TOOL ASSERTING ITS OWN FEED IS HEALTHY (`754c8886`, 2026-08-16).** `status:"error"` vs `no_results` is a two-way split, and `search_serial_deals` had quietly added a THIRD claim on top of `no_results`: its empty-state copy said *"The residential serial-listing feed refreshes every few hours; **this is not an error**"*, and the system prompt told the model *"do NOT imply the feed is broken."* Measured live: `topshot-active-listings-ingest` fails **`egress_blocked`** on most sweeps and on **2026-08-12 wrote ZERO rows across all 5 runs of the day** — so on a dead-feed day the concierge told a collector nothing was listed below FMV **and explicitly reassured them nothing was wrong**. **A tool cannot observe its own health; it can only report how old its data is.** ⚠ **The empty result is jointly a fact about the MARKET and about the FRESHNESS of our copy of it**, and only the second half is knowable from inside the tool — so all four exits now carry `feed_age_hours` / `feed_stale` / `feed_note` and the prompt requires the age to be stated. ⚠ **The POPULATED exits carry it too**: a stale snapshot sends a collector to a listing that may already have sold, which is the same defect pointing at money. ⚠ **"Every few hours" was itself wrong, and measuring it is what stopped a cry-wolf threshold** — over the ~73 h `pipeline_runs` window there were only **5 successful sweeps**, gaps **min 3 h / median 6 h / p90 22 h / max 26.7 h**, so a 24 h ceiling fires during NORMAL operation (the `ufc_fmv_stale_hours` cost again). Hence the **AGE is the primary output** and `feed_stale` sits conservatively at **36 h**, with the sample size recorded in place because 5 sweeps cannot support a sharp threshold. ⚠ **A test was pinning the reassurance** (`toMatch(/not an error/i)`) — the SECOND instance that day of a well-commented assertion holding in place a claim the product could not support, after the `applied_filters` case above; the first pinned a *limitation*, this one a *reassurance*. **Whenever a tool's copy characterises the health of an upstream it cannot see, that copy is a guess with a test around it.**
- ⚠ **A GUARD's own comparison fetch is part of its verdict — check that error, or the guard fabricates incidents (2026-08-13, `3c9448d2`).** ⚠ **The guard this bullet is about was RETIRED 2026-08-14; the LESSON is what survives, and it generalizes to any guard.** It was retired because the `couldNotRun` fix below, while correct, did not make it meaningful: the deal rows it validated **were** `pinnacle_catalog` rows mapped straight through, so the triple it checked for was guaranteed present and the check could not fail for its stated reason. **Do not rebuild it.** ⚠ **And do NOT re-point it at `pinnacle_fmv_history` — that was measured and REJECTED.** That table is written by an `AFTER INSERT/UPDATE` **trigger on `pinnacle_catalog`**, so it is a derivative copy, not an independent source; comparing them is the same tautology one hop removed, *except* where the trigger silently drops a row — which it **did for 776 renders** until `20260815172945` changed that `ON CONFLICT` from `DO NOTHING` to `DO UPDATE`. ⚠ **That is FIXED: measured live 2026-08-16 the count is ZERO**, and `supabase/tests/pinnacle_fmv_recalc_render_all.sql` pins it by reproducing the double-write (`NOW()` is transaction-stable and the recalc writes each render twice per txn) and asserting the SECOND, published revision survives. **A residual 20 renders differ for a DIFFERENT reason** — the trigger's `WHEN new.fmv_usd IS NOT NULL` means a de-pricing writes no row at all, so the series keeps a stale last point; pinned as current behaviour. Re-pointing would have paged immediately, on a real-but-different defect. What actually prevents the leak is structural — `searchPinnacleDeals` reads ask and FMV from the SAME row — and that is pinned by `__tests__/pinnacle-router-fmv-same-row-guard.test.ts`, a SOURCE guard, because a runtime probe can only observe the consequence of that property, which is exactly how it degenerated into a tautology. The original defect: the guard built its set of legitimately-priced `(character, set, variant)` triples from `pinnacle_catalog` and **did not destructure that read's `error` at all**. A failed fetch left the set EMPTY, so every priced deal row failed the membership test and the guard **hard-paged with a fabricated FMV-drift incident assembled out of its own transient DB error** — Sentry `JAVASCRIPT-NEXTJS-14`, 54 occurrences since 2026-05-11. Verified false: every row it named was present in `pinnacle_catalog` with a matching FMV. ⚠ The check's existing `TRANSIENT_RX` soft branch did **not** cover it (that guards the `searchPinnacleDeals` call, not the second read), which is why it survived an earlier hardening pass on the same check. Fixed by reporting **`couldNotRun`** — an unevaluated check must never be published as a violated assertion. ⚠ **An EMPTY-but-successful read is deliberately still a real leak** (if the catalog holds no priced row, the deal row genuinely is unbacked); **only a FAILED read is inconclusive** — blanket-skipping on empty disarms the guard while looking like a fix.
- ⚠ **Triaging the error board: sort by FREQUENCY and USERS, never filter by recency.** A 2026-08-13 sweep used `firstSeen:-3d` and surfaced one small issue; dropping that filter revealed the **largest error on the platform** had simply been running since 2026-07-18 (`NEXTJS-1Z`, 81 users then, **86 as of 2026-08-15** and still firing). **Age is evidence of severity, not of irrelevance.** ⚠ **But READ THE TITLE AND CULPRIT before attaching a cause to an ID** — that same `NEXTJS-1Z` got two different diagnoses in two bullets of this file, a day apart, because each session found a real defect and reached for the biggest ID on the board. Sentry groups by title; the title is the cheapest available check and settles it in one query (see the `apply_migration` bullet). And verify every "stale" verdict against the LIVE DB rather than the last-seen date — on 08-13 two issues looked identical on the dashboard (single event, days old) and needed opposite handling: one was genuinely clean, one was a security assertion whose recurrence must be treated as real.
  ⚠ **The `check_*` count trap is REAL but NARROWER than this file used to state (re-measured live 2026-08-15).** The claim was a blanket "`count(*)` over a `check_*` function returns 1 when CLEAN". That holds only for the ones returning a **jsonb array** — `check_secdef_anon_exec_drift()` is `count(*)` **1** / `jsonb_array_length` **0** when clean, so read the array length. ⚠ **Two more members of that family were confirmed 2026-08-16 and it bit a pass that already knew the rule: `check_secdef_anon_execute_violations()` and `check_edge_fn_http_failures()` both returned `count(*) = 1` meaning ONE ROW CONTAINING `[]`** — i.e. clean. **Knowing the trap is not the same as recognising an unfamiliar function as a member of it; check the return type per function, every time.** The two SETOF-returning invariants are the opposite: `check_public_security_invariants()` and `check_anon_write_surface()` both return **ZERO rows** when clean, so `count(*) = 0` **is** the healthy reading and treating 1-means-clean there would invert the verdict. **Check the return type before interpreting the count.**
- ⚠ **A FILED FINDING IS A HYPOTHESIS — re-derive WHICH SUBSYSTEM it measured before acting, especially when it names a number.** Deep-audit run 2's P2 said the homepage published serial multipliers "the live model does not produce" and recommended replacing them. It had compared `HomePageMarketing.tsx` (which states `lib/fmv/serial-multiplier.ts` **verbatim** — the model the public `/api/fmv` calls) against `serial_fmv_multipliers`, **a different subsystem**. **Doing what the finding said would have made an accurate surface inaccurate**, and would have published one scalar for a matrix. The tell was cheap: open the file the finding cites and the module it imports, which is one grep. This is the same shape as the archived "re-measure a *this is dead* annotation before acting on it; the annotation is not the evidence" lesson — **promoted here because that one had rolled off to `docs/sessions/` and was therefore no longer being read.** Findings in `docs/audits/**` and `docs/overnight/inbox/**` are *leads*, and several have already been recorded as inverted or resolved on re-measurement (deep-audit D2b, D32, D8, D26). **Re-point a wrong finding rather than closing it** — there was a real defect one layer down here, and closing would have buried it.
  ⚠ **NEWEST INSTANCE (2026-08-16) IS THE NAME-TRAP MET ON A *FUNCTION* NAME, AND EVERY NUMBER IN THE FILING WAS CORRECT.** "`unmapped-sales-nfl_all_day` — the resolver is stuck in December" measured `get_unmapped_resolver_targets` exactly (candidate window 2,000 rows spanning **2025-12-29 14:42Z → 2025-12-30 01:39Z = 10.94 h**, 76.7% frozen price-zero rows) and reproduces on re-measurement. What failed was the ATTRIBUTION: **that function has exactly ONE caller in the repo — a manually-invoked admin route on no scheduler** (`vercel.json`, GHA and pg_cron all swept), so its December window is not the scheduled drain path. The live crons already load candidates through `lib/unmapped-rotating-window.ts` (never-attempted first), which **IS the filing's own preferred Option 1, shipped weeks earlier in `0c554695` + `8f3589f4`.** ⚠ **Falsified by measurement rather than by reading code, which is the part to copy: of the 87 All Day NFTs attempted in the trailing 2 h, ZERO anchor in December** (oldest open rows span 2026-01-03 → 2026-02-01; per-month attempt coverage Jan 31.3% · Feb 49.2% · Mar 100% · Apr 100%). ⚠ **And the obvious reconciling hypothesis was tested and rejected** — "an attempt stamps every open row of the same NFT, so Jan/Feb only *look* worked while selection stays December-anchored" would explain both observations and is wrong: grouping by each NFT's **oldest open row** (the value the resolver orders on) still puts 0 of 87 in December. **Anchor, not stamp, is the correct instrument.** So this file's standing rule — *read `cron.job.command`; never infer the callee from the name* — generalizes past pg_cron: **before acting on any finding about a named function, prove something actually calls it on the path you think it does.** What survives: the backlog genuinely is not draining, but the constraint is **throughput, not ordering** (~200 rows/day written against ~230–240/day inflow).
  ⚠ **Its real lead was its SIBLING, and that one is a cost/benefit question, NOT a defect — do not open it as an incident.** `allday-unmapped-resolver-tail` is **0-for-977 on decode and 5-for-4,706 on scan chunks**, spending **51.5 min over 3 days to promote ONE row**, with ~54% of runs ending in `upstream request timeout`. ⚠ **The refutation of the "it's broken" reading is in the route itself** (`app/api/cron/allday-resolve-unmapped-tail/route.ts:419-425`): a 2026-07-27 probe resolved 0/40 backlog and 0/11 head rows **with zero transport errors**, establishing that "0 resolved on a healthy transport" is the *expected steady state of an exhausted backlog*. Live corroboration: `onchain_err` is **1** across 977 attempts — clean nils, not failures. The open question is only whether ~1.7 resolutions/day against a 105,991-row backlog is worth that share of a saturated IO budget. ⛔ **Do NOT raise its timeout or budget** (the lever is the WORK, never the clock), and ⛔ **do NOT read this as an argument to retire the non-tail sibling `allday-resolve-unmapped`** — that one is the working drain. **The check that decides it:** the route already stamps `last_onchain_attempt_at`, so re-probe a sample of rows that nil'd ≥2 weeks ago — still nil ⇒ the pool is genuinely exhausted and retiring the schedule is defensible; a meaningful share now resolving ⇒ it is doing real work slowly and the answer is a cadence cut. ⚠ **DO NOT try to answer that from the DB alone — the obvious query is CONFOUNDED and returns a confidently wrong answer (tried 2026-08-16).** Asking "of the rows attempted ≥14 d ago, how many resolved?" returns **183 of 271 = 67.5%**, which reads as decisive proof the nils are transient. It is a selection effect: **a resolved row LEAVES the retry queue, so its `last_onchain_attempt_at` freezes, while an unresolved row keeps being re-attempted and its stamp keeps refreshing.** An old stamp therefore *selects for* resolved. The scale of the skew gives it away — the overall resolution rate among ever-attempted rows is **4.6%** (1,978 of 42,623), so 67.5% in the ≥14 d sliver is ~15× enrichment, not a signal. **The question genuinely requires a fresh Flow re-probe, which the sandbox cannot make (egress blocked) — it is operator/prod-side work, not a query.** Filed: [inbox 2026-08-17T0130Z](../../docs/overnight/inbox/2026-08-17T0130Z-the-allday-tail-resolver-is-not-broken-it-is-grinding-an-exhausted-backlog.md).
- **Bounding a PostgREST TABLE read: `withQueryDeadline(builder, label, ms?)` in `lib/analytics/rpc-with-retry.ts`** (added 2026-08-13, `fc7a4f10`). `rpcWithRetry` is RPC-shaped and cannot take a `.from()` builder, so table reads were unbounded even after every `.rpc()` on a page was bounded — and an unbounded read does not merely fail, it **parks the render until Vercel's 300 s kill and leaves a streamed section spinning forever**. ⚠ It is a THIN WRAPPER over the existing `withDeadline`, not a second primitive: that function only ever probes for `.abortSignal` and is otherwise shape-agnostic. **No retry** (these are supplementary sections; a retry doubles the worst-case hold on the pool that is itself saturating), and it keeps the **45 s** default — a tighter client bound would pre-empt Postgres's own `statement_timeout=30s`, the handled path that turns a slow query into a retryable error boundary.
  ⚠ **DURABLE — `withDeadline` bounds an attempt TWO ways and they used to produce TWO different errors, and the one that fires in production was the one no test could reach (`b0cebf90`, 2026-08-15).** The race guard resolves `timeoutError()` with code **`RPC_TIMEOUT`** — the constant this module exports precisely so *a bound we imposed* is greppable and never mistaken for something the server reported. The `abortSignal` path resolved whatever supabase-js made of the DOMException: `TimeoutError: The operation was aborted due to timeout`, **with no SQLSTATE and no `RPC_TIMEOUT`**. In production the abort wins the race, so the shape that actually escaped had none of the properties this module advertises — and that string is the Sentry TITLE of `NEXTJS-1Z` (86 users), `-23`, `-22` and `-20`, while `-26` shows the *other* shape (`rpc … timed out after 45000ms with no response`), so the board itself displayed the split for weeks. ✅ **THAT SPLIT IS GONE — CONFIRMED IN PRODUCTION 2026-08-17 ~01:40Z, so the normalization is not merely shipped.** Read live over 24 h, `NEXTJS-1Z`, `-26` and `-23` ALL now carry the single `rpc <fn> timed out after 45000ms with no response` wording — the abort spelling no longer appears on any of them. ⚠ **So the ID→shape mapping in this sentence is HISTORY and must not be used as a diagnostic**: it can no longer tell you which exit fired, because by design only one shape leaves the function now. ⚠ **And `-20` is not a timeout at all** — live it reads `Could not query the database for the schema cache. Retrying.` (`PGRST002`, the self-inflicted migration burst documented under `apply_migration`), so listing it in the abort family is wrong today whatever it showed then. Sentry titles can change within an existing issue as the message changes, which is exactly why **the title is a live reading, never a fixed property of the ID** — re-read it rather than quoting this line. ⚠ **No test could have caught it: every mock in the repo implements `.rpc` as a bare async function with NO `.abortSignal`, so every test takes the guard branch by construction — and the guard branch was already correct.** This is the same shape as the guard-scope blind spots elsewhere in this file (the anon driver-message guard, `insights-gate-include-completeness`'s `INSIGHTS_DIR` walk): **a mechanism's own derivation decides what it is able to observe.** Hence `__tests__/rpc-with-retry-abort-shape.test.ts`, which supplies a mock that DOES implement `.abortSignal`. Both exits are now normalized so exactly one timeout shape leaves the function; `isAbortShaped()` accepts both spellings (`AbortSignal.timeout()` raises `TimeoutError`, an explicit `.abort()` raises `AbortError`). ⚠ An abort arriving as a **rejection** also escaped `rpcWithRetry` entirely, past every caller that destructures `{ data, error }` — a non-abort rejection is still deliberately **re-thrown**, because folding every throw into `error` would hide genuine programming faults behind a plausible "timed out" story.
- ⚠ **READ THE ERROR MESSAGE TO TELL WHICH FAILURE YOU HAVE — the entity-page timeouts are TWO families with different fixes (2026-08-15).** `canceling statement due to statement timeout` is Postgres killing a genuinely-running query at `service_role`'s **30 s** (verified live in `pg_roles.rolconfig`; anon 3 s, authenticated 8 s) — Sentry `NEXTJS-27`/`-24`/`-1Y`. `TimeoutError: The operation was aborted due to timeout` is **our own 45 s bound** — `NEXTJS-1Z` (86 users), `-26`, `-23`, `-22`, `-20`. **A request that dies at 45 s without Postgres having killed it at 30 s was not executing a statement**, and `pg_stat_statements` confirms it: over a 3 d window the heaviest real PostgREST call maxes at **13,636 ms**. ⚠ **THAT SUPPORTING ARGUMENT IS UNSOUND — corrected 2026-08-17, and its two halves fail differently.** The 30 s premise is false: `service_role`'s `rolconfig` applies at LOGIN, PostgREST logs in as `authenticator` and only `SET LOCAL ROLE`s, so **Postgres does not kill a `supabaseAdmin` call at 30 s** — measured, `SET ROLE service_role` leaves `statement_timeout` at `2min`, and 39 service_role PostgREST statements exceed 30 s with a worst of 352 s (see the role-ceiling bullet under DB "General rules"). The 13,636 ms half is a *windowed* claim that a cumulative `pg_stat_statements` read cannot confirm or refute, so it is neither endorsed nor overturned here. ⚠ **The CONCLUSION may still be correct** — a connection-acquire stall remains the best explanation for the abort family — **but re-derive it rather than citing this sentence**, because the reasoning as written proves nothing. That time is connection-acquire / socket, on a 2 GB instance with `max_connections=90`. ⚠ **So a query-plan fix cannot close the second family**, which is why two attempts on `NEXTJS-1Z` did not (`collection_id` covering-index — measured and rejected; `computed_at <= now()` pruning — shipped, 9,131 → 6,308 buffers, correctly recorded as not closing it). Details + the next useful measurements: `docs/overnight/inbox/2026-08-15T0450Z-…`.
- ⚠ **`<collection>_fmv_pct_stale_30d` is a PIPELINE-LIVENESS metric, not a price-freshness one** (measured 2026-08-13). It asks whether `computed_at` is >30 d old — *did WE recompute* — so it reads **0.0% for every live collection**. The share of prices derived from OLD TRADES is the separate `confidence = 'STALE'` label, and the two diverge hard: **Golazos 0.0% by the board vs 51.7% STALE-labelled**; All Day 0.0% vs 13.0%. Neither is wrong; reading the first as "our pricing is fresh" is. The quantity a collector cares about is **on no board today** — the cheap fix (one more `count(*) FILTER` over `rpc_thp_leg_fmv_coverage`'s existing pass, TRACK-only first) is filed, not taken.
- ⚠ **Never overload a value that ALREADY carries a meaning — add a field (`48369a45`, 2026-08-13).** Same conflation family as the table above, met from the other side: when `/api/cron/run-insider-detectors`' candidate-count telemetry was sampled down, `candidates_evaluated: null` already meant *"the count RPC errored"*, so making it also mean *"we chose not to count"* would have rendered a **broken telemetry RPC indistinguishable from a deliberate skip**. Hence `candidates_status: "counted" | "failed" | "skipped"` — and a total whose legs partly failed is marked `failed` rather than silently under-reported, because **a partial sum reads as a real, smaller number** (the silently-sliced-ranking shape). The sampling itself is worth knowing about operationally: `count_insider_detector_candidates` was **44.7 GB of disk reads over 39.7 h — ~27 GB/day, roughly 3% of ALL disk reads on the IO-throttled Small tier** (`3 collections × 4 detectors = 12 calls every hourly tick`) for **pure telemetry with no production consumer** — the instance was spending more disk explaining the detectors than running them. Now sampled every 6th UTC hour (288 calls/day → 48); **`INSIDER_CANDIDATE_COUNTS=always` reopens hourly counting for a diagnostic window with no deploy**, `=never` disables it. ⚠ **The better fix is measured but NOT taken** (it needs a migration, filed in the inbox): all four counts per collection re-scan the same 24h window and `unusual_volume`/`floor_drops` are the *identical* query differing only in `HAVING >=5` vs `>=3`, so one RPC computing all four in a single pass cuts 12 scans to 3 **while keeping hourly granularity**. ⚠ Do not "simplify" it by substituting `detect_unusual_edition_volume`'s existing `sales_examined_24h` — it looks like the number you want and is not (raw sale ROWS, not distinct editions passing the gate), and swapping it changes the field's meaning with every test still green.
- `lib/insights/board-status.ts` + `components/insights/DegradedDataNotice.tsx` — honest degradation for the public boards: a backing-view failure must not render as an EMPTY board at HTTP 200 (byte-identical to "nothing matched"). ⚠ **There are TWO independent paths that produce it, and a board can be blind on one while wired for the other** — a fix that covers only one reads as done and is not:
  1. **Inline-fetch boards** (squeeze · trophies · offer-spread · pinnacle-scarcity · allday-scarcity · set-squeeze) — a fail-soft `if (error) return []`. Fixed by returning `{ rows, ok }` and building `summarizeDegraded([boardStatus(label, ok)])`.
  2. **Cached boards** (deals · first-mint · rookies · candy-mlb · panini-squeeze) — `readBoardOrLive` returns `source: "live-degraded"` with an EMPTY payload when the live query failed AND no snapshot exists. Use **`degradedFromSource(source, label)`**. ⚠ `payload.degraded` does NOT cover this: the payload is `{}`, so candy-mlb and panini-squeeze rendered the notice everywhere EXCEPT the case that needed it most, until 2026-08-12.
  ⚠ **DURABLE — on a `BoardStatus`, `ok` means USABLE, not "the query succeeded", and `partial` is now honoured REGARDLESS of `ok`.** The type's doc used to say `partial` was "meaningless when `ok` is true", and `summarizeDegraded` read it only inside its `!ok` branch — so a status of `{ok: true, partial: true}` ("the query succeeded and I KNOW it was cut short", i.e. a read that filled a hard cap) was **silently dropped**. That shipped a blank Panini board with no notice on 2026-08-12: the fetcher correctly emptied its truncated rows and the notice explaining the blank never rendered — strictly worse than the silent truncation it replaced. The primitive now checks `partial` FIRST and independently, so a caller that knows its read was truncated cannot be ignored; the two board fetchers ALSO fold truncation into `ok` at the call site (belt and braces, deliberate). ⚠ **Truncation is not only paginated-fetch failure — a hard `.limit()` that fills exactly is a truncated RANKING served as the complete set.** Both board fetchers now detect it (`panini` at its `MAX_PAGES` cap, `candy` per-view via `rows.length >= limit`), and candy DISCLOSES rather than blanks because a large top-N slice is still useful. ⚠ **Candy's caps are NOT all the 600 default** — check the call site: measured 2026-08-12, `candy_special_serials_board` 607/**800** and `candy_holder_board` 395/**800**, both growing (+21% / +61% since those caps were chosen).
  ⚠ **THE WARM CRON FAILS FAR MORE THAN ITS OWN COMMENT ASSUMES, and its `ok` hid it for 869 straight ticks (measured 2026-08-15).** `/api/cron/refresh-insights-cache` ruled `ok = okCount > 0` on the reasoning that "a single board timing out under saturation is EXPECTED". Over 3.2 days: **`deals` failed 59.5% of ticks (longest streak 34 ≈ 2h50m)**, first-mint 54.2%, panini-squeeze 51.0%, rookies 15.1%, **candy-mlb 4.4%** — so `okCount > 0` was satisfied almost entirely by the one cheap board, and the healthiest board vouched for the other four. The reasoning was sound; its premise (failures are occasional and rotate) was false. **A tick's outcome structurally cannot express a CUMULATIVE quantity: how long a board has gone unrefreshed.** Now also gated on `stalestBoards()` / `readBoardSnapshotAges()`, with `BOARD_SNAPSHOT_STALE_CEILING_MS` at **2 h** picked from the streak distribution (414 streaks: 75 ≥30 min, 34 ≥1 h, **only 4 ≥2 h**) — anything near one tick would be red most of the time, the cry-wolf outcome `ufc_fmv_stale_hours` already cost this repo; move it with a fresh measurement, not a hunch. `extra` carries per-board age, and `extra.snapshot_age_min` carries per-board age so a streak is queryable rather than reconstructed from rows that prune at ~73 h. ⚠ **An unknown age is NOT stale** (counted as `never_warmed`) — reporting it would manufacture the finding from our own missing data. ⚠ **Nothing consumes `pipeline_runs.ok` for this pipeline**, so this is honesty + a hook, not an alarm; and a `pipeline_cadence_watchlist` entry would NOT help, because the cadence is perfect — the cron ticks reliably and it is the work INSIDE that fails. ⚠ **Serialization is arithmetically impossible: the six backing views' mean costs sum to 59,960 ms against a `maxDuration` of 60 s.** They are STARVED, not slow — every max is ~29.x s (the 30 s ceiling) while means are 10–12 s, and `panini_squeeze_board` fails 51% of ticks on a **3.4 s mean**. Each failure burns a full 30 s of DB time for nothing, ~90 s per tick, so the refresher feeds the saturation it exists to survive. Options + what not to try: `docs/overnight/inbox/2026-08-15T1200Z-…`. ⚠ **User impact is bounded and precise: nobody sees an empty board** — the ladder serves last-good with an age stamp, so the cost is a PUBLIC board up to ~3 h stale while every instrument reads healthy.
  ⚠ **THIS IS THE PLATFORM'S STANDING BEFORE/AFTER INSTRUMENT for any saturation-reducing change — and reading it has two traps that both invert the verdict (learned the hard way 2026-08-15, evaluating my own recommendation).** The per-board failure rate is queryable from `pipeline_runs.extra->'boards'` (a jsonb **ARRAY**, so `jsonb_array_elements`, not `jsonb_each`) plus `extra.snapshot_age_min`. **(1) Confirm the post-change window actually CONTAINS a differential before reading it.** The market-index cadence cut was measured 45 min after apply and every board looked *worse* — but jobid 235 last ran at 16:07Z and would not have fired again before 18:07Z **under the old schedule either**, so that sample was structurally incapable of containing the effect. A `*/N`-cadence change is not observable until the first tick where old-would-run and new-would-not. **(2) The baseline moves, so a fixed one lies.** The 3-day figures above (59.5 / 54.2 / 51.0) were already 75.7 / 55.6 / 75.4 over the following 30 h, and the hourly rate climbed **04:00Z 0% → 16:00Z 78.3%** with nothing changed — **a change applied into a degrading trend cannot be evaluated against a frozen number**; compare against the same clock hours, or wait a full day. ⚠ **And your own `EXPLAIN (ANALYZE)` profiling is a confound** — single statements at 30–42 s on this instance are themselves saturation.
  ⚠ **`stale-cache` is deliberately NOT degraded** — it serves complete last-good data with its own age stamp; flagging it cries wolf on the cache working as designed. A board that SUCCEEDS with zero rows is likewise NOT flagged — an empty board is an honest answer. Pinned by `__tests__/insights-board-degraded-wiring-guard.test.ts` (both paths), which exists because `initialDegraded` is an OPTIONAL prop and `tsc` cannot catch a page that stops passing it.
- **A number the data cannot support must not be manufactured — three shapes, all found on live public surfaces (2026-08-12/13).** Distinct from the "failed read renders as an answer" class above: here the READ SUCCEEDED and the arithmetic invented the answer.
  - ⚠ **`|| 1` as a divide-by-zero guard.** `app/profile/[username]/ProfileClient.tsx` computed its 30-day change as `((last - first) / (first || 1)) * 100`, so a **$0 baseline silently became $1** and a rise to $500 rendered as **"↑ 50000.0% / 30D"** on a page collectors SHARE. A ratio against zero is UNDEFINED, not enormous. Omit it and keep the chart — the *shape* is real even when the ratio is not. ⚠ That forces a second half people miss: anything deriving DIRECTION from the now-null ratio (`change >= 0 ? green : red`) must derive it from the series instead, or a genuine gain paints as a loss.
    ⚠ **THE FIX LANDED ON ONE COPY, AND THE SIBLING SHIPPED THE DEFECT FOR ANOTHER FOUR DAYS (`12c55422`, 2026-08-16).** `app/(collections)/[collection]/profile/[username]/CollectionProfileClient.tsx` carried the **identical** `((last - first) / (sparkData[0] || 1)) * 100`, so the per-collection profile kept rendering "↑ 50000.0% / 30D" while the fix's own detailed comment sat in the sibling file. **Third instance of grep-for-the-EXPRESSION-not-the-file**, after the two `saved_wallets` loaders and the 15 OG cards — and note the first fix's comment did not prevent it, because a comment is only read by someone already in that file. ⚠ The second half bit exactly as predicted above: the sparkline colour keyed on `sparkChange != null && sparkChange >= 0`, so **nulling the ratio alone would have painted a genuine $0 → $500 GAIN in the loss colour**, and only on the rows the null was introduced for. Direction now derives from the series.
    ✅ **The class is now a BAN at population ZERO** — `__tests__/no-fabricated-divisor-ratchet.test.ts` forbids `x / (y || N)` and `x / (y ?? N)` across `app`, `lib`, `components` and `workers`. ⚠ **It is anchored on the `/`, deliberately**: `parseInt(x) || 1` is a parse fallback, not a divisor substitution, and banning that spelling would have flagged correct code. ⚠ **Do not "simplify" the `> 0` guard down to `Number.isFinite` — `Number.isFinite(0)` is TRUE**, so that reintroduces the division by zero while looking stricter (a mutation catches it). ⚠ **And its escape hatch was broken on its first version, in a way worth copying the fix for:** it matched an opt-out marker only on the offending LINE, but these expressions wrap, so the `|| 1` lands on a different line from the only sensible place to write the justification. It now honours the flagged line **or any of the 3 above**, matching the brand-exception convention. **An escape hatch unreachable in the common case is not an escape hatch — it teaches people to delete the guard.**
  - ⚠ **`?? 0` ON A SUPABASE `count`, which turns a failed read into a measured zero at HTTP 200 (2026-08-15).** `/api/rewards/summary` returned `referralCount: referrals.count ?? 0`. **supabase-js RETURNS errors rather than throwing**, so a failed count — a `57014` statement timeout is the realistic case on this instance — leaves `count` **null**, and the `??` published a hard 0 with a 200. `/rewards` renders 0 as **"No referrals yet — be the first to share."**, a claim about the reader's OWN account, shown to a collector who may have referred friends and earned the credits. ⚠ **The null has to survive all the way to the render or the fix is cosmetic:** the client's own `setReferralCount(data.referralCount ?? 0)` would have undone it, and the display prop is now typed `number | null` so a caller cannot pass a failed read as a zero without `tsc` objecting. **Check the `error`, never just the value** — this is the counting sibling of the `?? 0` stats-object case that put "No sales in the last 24h" on a day with 8,332 sales.
  - ⚠ **A silently sliced ranking.** `CandyBoardClient`'s `DataTable` applies `r.slice(0, cap)` AFTER sorting, so an overflow is invisible: every row on screen is still correct, the board just stops. Individual caps had been re-raised twice (550→800, 250→800) instead of disclosing it — a data-dependent margin, not a guarantee. It now renders "Showing the top N of M … capped, not complete", and is deliberately SILENT at `length === cap` (that board IS complete; a permanent notice is its own false claim). The fetch layer needs the same treatment or `M` becomes the cap — see `lib/insights/candy-board.ts`.
  - ⚠ **COUNTING ROWS OF A PER-(ENTITY, COLLECTION) TABLE AS ENTITIES — the fourth shape, found 2026-08-16.** `/profile/<u>` rendered `{wallets.length} WALLETS` and told a collector with ONE Dapper wallet they had **4**, because `saved_wallets` is keyed per **`(wallet_addr, collection_id)`**: pinning one address writes one row per collection it holds moments in. ⚠ **The FMV and moment totals on the same tile were CORRECT** — they SUM across those rows, which is exactly right — so the bug sat beside two right answers derived from the same array, which is why nobody spotted it. ⚠ **The fix had to be SERVER-SIDE and that is the transferable part**: `wallet_addr` is deliberately stripped from the public payload (the privacy step), so **no consumer can dedupe** — `getPublicProfile` now ships a `wallet_count` scalar (a count is not an address). When it is absent the tile **omits the line** rather than falling back to `wallets.length`. **Before counting `.length` of anything from `saved_wallets`, `wallet_moments_cache` or any other per-collection table, ask what one row IS.**
  - **Nulls must sort to the BOTTOM in BOTH directions** on any priced board. A naive `null → 0` floats unpriced rows to the top of an ASCENDING price sort, presenting "we have no price for this" as "this is the cheapest".
- ⚠ **`components/collection/CollectionMomentTable.tsx` renders TWO COMPLETE TREES (desktop table + mobile cards), and the mobile one drifts because it is hand-maintained.** Two separate user-facing defects came out of this in one day: the mobile branch was a bare `filteredRows.map()` with **no empty state at all** (a phone user whose filters matched nothing saw a blank area, while desktop had carried two distinct messages all along), and its P&L basis was `label === "Loan" ? cb.buyPrice : cb.buyPrice` — **a ternary with identical branches**, i.e. `buyPrice` unconditionally, while desktop used the shared `resolveMomentPnlBasis()`. On an unlabelled cost-basis amount (real: `ACQUISITION_METHOD_LABEL` maps `unknown → null`) the same moment showed **a different profit on a phone than on a desktop**. **When you change one tree in this file, check the other**; desktop splits Cost and P&L across two COLUMNS while mobile renders both in one block, so deriving one number from the other is what caused the drift. Both trees are pinned by `__tests__/component-CollectionMomentTable-{mobile-badges,pnl-parity}.test.ts`.
- ⚠ **Rewriting a guard can silently DROP a spelling the guard it replaced already had.** The anon-API driver-message guard replaced a hand-kept route list with one that EXECUTES `isPublicPath` from `proxy.ts` — a real improvement — but shipped with four leak patterns where the older `public-insights` guard had five, losing the **inline ternary in a response body** (`{ error: err instanceof Error ? err.message : "…" }`). 12 live sites across 11 anon-reachable routes were still publishing through it. **Diff the new guard's PATTERN SET against the old one's, not just its coverage.**
- `lib/og/brand-fonts.ts` — **the single brand-font loader for every OG card** (2026-08-14; built on `lib/og/font-bytes.ts`). Before it, exactly ONE card loaded the brand fonts and the rest rendered in `system-ui`. Exports `brandFonts()` / `brandFamilies()` / `OG_CACHE_HEADERS`. ⚠ **COUNT THE TREE, do not trust a number in this file** — the family was 43 cards when branding landed and is **44** as of 2026-08-14 (`/api/og/trophy-case/[username]` shipped the same day), so a doc that says "43/43 covered" reads as a closed set exactly when a new card has slipped outside it. Coverage today is 44/44 but reached **two different ways**: 39 routes call `brandFonts()` directly, and the 5 entity cards (`edition`/`player`/`series`/`set`/`team`) inherit it by delegating to `lib/og/entity-card.tsx` — so **a grep for `brandFonts` under `app/api/og` legitimately reports 39 and is not a 5-card gap**. Verify with `find app/api/og -name 'route.tsx' | wc -l` against that split. ⚠ **`brandFonts()` NEVER rejects** — 39 call sites depend on that instead of each guarding, which is why 39 defensive `.catch(() => undefined)` wrappers were removed as dead code rather than kept. ⚠ **A try/catch around `new ImageResponse(...)` cannot catch a font error**: the body is a STREAM consumed after `GET` returns, so satori throws outside the handler — validate the BYTES up front (`isSupportedFontBuffer`) instead. ⚠ And **`Cache-Control` is not optional on an OG route**: 42 of 43 set none, so every crawler fetch re-ran satori plus its DB reads, and X's crawler times out — a slow card is a missing card.
- `lib/og/marks.tsx` + `lib/og/og-fetch.ts` — **the two things an OG card is no longer allowed to do on the crawler's path** (2026-08-29, R66 + R72). ⚠ **`next/og` has TWO remote fallbacks, not one, and only the first was ever recorded**: an EMOJI fetches Twemoji from `cdn.jsdelivr.net`, and **ANY glyph the supplied fonts miss** fetches a Google Fonts stylesheet — `2605 25c8 25a3 25a6 2192 2191 2193 2190 25b2 25bc 2713 2715 2153 2116 203e` measured, so `★` and `→` were remote too. ⛔ **No config fix exists** (`ImageResponseOptions` exposes only `emoji?: EmojiType`, every preset remote; no `loadAdditionalAsset` hook), so the cards **draw** their glyphs: 11 original monoline marks, pure inline SVG, no network and no font lookup. ⚠ **The probe that gets this wrong renders with NO `fonts` option** — satori's bundled default covers arrows, production never uses it. ⚠ **`og/collection` reached the CDN through DATA** (`collection.icon`, every registry value an emoji, at 140px), which no source scan could ever have found; that hero is now an accent rule with the wordmark at 96px, registry untouched. ⭐ **And the sweep's own `twemoji` STUB is why this shipped** — hermetic by stubbing HIDES a dependency, hermetic by THROWING reports it. Stub deleted; a throwing fetch makes the render REJECT, not degrade. `ogFetch()` then bounds every card read at **10 s — a PRODUCT budget, not a percentile** (after that a degraded card beats no card; at 5 s four of a measured 40 `pack-sniper` reads would abort, at 10 s one). ⚠ **An abort must land on the HONEST branch**: every call site's `catch` leaves `fetched` false → `boardEmptyCopy`. ⚠ **One read is not covered and the module says so**: Next drops a caller's signal on a background revalidation. Guards: `og-cards-render-no-glyph-they-must-fetch` (ban at zero, a SUPPRESSION list — `COVERED` names what is *proven local*), `og-marks`, `og-fetches-are-bounded`.
- `lib/trophy/reorder.ts` — pure trophy-case math, extracted because `app/dashboard/page.tsx` is a `page.tsx` that NEITHER coverage gate measures. Holds `reorderByDelta` / `reorderByTarget` and **`occupantOfSlot`** (2026-08-14). ⚠ `occupantOfSlot` exists because **filled slabs pack to the FRONT of the fixed-length array while `slot` is the persisted column**, so `slabs[slot - 1]` names the wrong Moment the moment the case has a gap — and it feeds a DESTRUCTIVE confirmation ("this replaces X"), where naming the wrong trophy is worse than naming none, since the collector then approves a replacement they were never shown. Context: the picker used to pin on ONE TAP with no undo (the upsert conflicts on `(user_id, slot)`), so a mis-tap on a 72px row silently replaced a chosen Moment behind a success toast.
- **Avatars — FOUR modules, one field. `lib/profile/default-avatar.ts` (`DEFAULT_AVATAR_URL` / `resolveAvatarUrl`) · `lib/profile/avatar-url.ts` (`classifyAvatarUrl`) · `components/profile/AvatarMomentPicker.tsx` · `lib/media/avatar-proxy.ts` + `app/api/public/avatar-media`** (all 2026-08-16). ⚠ **READ THE `img-src` BULLET UNDER SECURITY POSTURE FIRST — a third-party avatar does not render at all without the proxy, and the reason is our own CSP, not the URL.** Every collector without an avatar of their own renders the **RPC logo**; four render sites resolve through `resolveAvatarUrl` (public profile, per-collection profile, OG card, edit preview) and the monogram survives only as the image-load fallback. ⚠ **ALL THREE WRITE THE SAME `profile_bio.avatar_url`** — no `avatar_moment_id`, no second save path — which is why a picked URL, a typed URL and the default all flow through one set of guards. ⚠ **`DEFAULT_AVATAR_URL` must stay ABSOLUTE `https://` and an exact member of `STATIC_ROOT_ASSETS`**: the OG card (edge) and the trophy-case PDF fetch it server-side with no session, the card refuses anything not `https://`, and a gated path would hand satori an HTML login page **at status 200** rather than a 404 (the `/fonts/*.ttf` failure). ⚠ **The design lesson is the durable half: asking a collector for an image URL is asking them to do a job browsers make hard** — the obvious thing to copy is the PAGE address, which is valid, serves HTML, and fails silently (a real collector pasted an OpenSea item page). Validation only *warns*; the **picker is the answer**, because we already know every Moment they own and already have its art (measured: 81.9%–100% image coverage across the five largest collector wallets, via `/api/profile/top-moments`, which returns a COALESCE'd thumbnail chain). ⚠ Host patterns in `avatar-url.ts` are **apex + `www.` only** — `(^|\.)host$` matches `assets.nbatopshot.com`, the CDN that serves the artwork, so the warning fired on exactly the link it had just asked for.
- `lib/cosmetics.ts` — profile Border/Banner style maps **and `hasCosmeticStyle(slot, value)`**. ⚠ **The cosmetic catalogue has TWO halves joined by nothing**: a SKU is a `shop_items` row (`metadata: {slot, value}`) — a pure DB insert, **no deploy** — while its appearance ships in the bundle, and both lookups fail SOFT by design. So a SKU sold ahead of its style was fully redeemable: credits spent, equipped, public profile unchanged, **no error on any surface**, and the owned-cosmetics tile drew a grey placeholder that reads as a legitimately dark cosmetic. The rewards shop and the owned list now ask `hasCosmeticStyle` first; it **fails CLOSED on an unknown slot** (a cosmetic we cannot classify is one we cannot draw, and "sellable" is the wrong way to be wrong when credits change hands). ⚠ The gate is `unrenderable && !equippedNow` **deliberately** — making it simply inert would strand anyone already wearing one with no way to clear the slot, recreating the dead end the unequip path was built to fix. Guard: `__tests__/rewards-cosmetic-renderable-guard.test.ts`.
- `lib/cart/CartContext.tsx` — cart state (addToCart: thumbnailUrl must be `null` not `undefined`)
- `lib/wallet-backfill-helpers.ts` — generic + paginated runners (`runIdOnlyBackfill`, `runAllDayDetailsBackfill`, `runPinnacleDetailsBackfill`, `runPaginatedDetailsBackfill`)
- `lib/cadence/` — per-collection Cadence scripts (pinnacle-wallet, allday-wallet, etc.)
- `app/api/sniper-feed/route.ts` — merges Top Shot GQL + Flowty listings
- `app/api/fmv/route.ts` — FMV lookup endpoint
- `app/api/support-chat/route.ts` — AI concierge (**33 tools**, counted from the tool array 2026-08-16, Claude Sonnet — model `claude-sonnet-4-6`, verified 2026-07-16). See the AI Concierge section for the 2026-08-13/14 additions (`search_catalog`, `get_price_history`, `find_quirky_serials`), the newest one (`get_edition_listings`), and the honesty constraints that travel with them.
- `lib/serials/fun-patterns.ts` — `classifySerial(serial, ctx)`: the NOVELTY serial patterns (palindrome, repdigit, sequential, round, meme, first/last mint, jersey / birthday / draft-year / area-code match). ⚠ **Deliberately separate from `specialSerialTraits`, and it must stay separate.** That array feeds `applySerialPremium` in `lib/market-analytics.ts`, where "#1 Serial" multiplies value by 1.35, "Perfect Mint" by 1.18, "Jersey Match" by 1.2 — multipliers that encode OBSERVED market premium. These are fun facts (Trevor: *"they're so niche, they don't get a value bump, but they're just fun if you find them, and that's part of the collecting experience"*), so folding them into that array would silently move FMV for thousands of moments on the strength of a joke. If a premium is ever wanted for one of these it must be MEASURED against sales first. Every pattern is a pure function over numbers RPC already stores, and every quirk carries its own `why` — "this is a palindrome" is unverifiable at a glance, and the whole value of the feature is that the claim is checkable. The chips render in `MomentDetailModal` on a NEUTRAL surface, never the FMV green a few lines below, for the same reason.
- `components/SupportChat.tsx` + `lib/concierge/rich-text.ts` — the chat surface. Three things here are easy to re-break:
  1. ⚠ **It must paint from THEME TOKENS.** It hardcoded `#0d0d0d`/`#141414`/`#ccc` until 2026-08-13, so a light-mode collector (`ThemeToggle` sets `data-theme="light"`) got a black slab with grey text floating over a white page. The brand-token guard covers this file now.
  2. ⚠ **The bubble renders TOKENS, never markup — and that is a SECURITY property, not a style choice.** Concierge output is model text that quotes tool results, and tool results carry values RPC does not control (collector handles, set names, board rows); rendering that as HTML would make a stored catalog value an injection vector into every chat that mentions it. `parseRichText` returns typed tokens React escapes on render, and `safeHref` allows only http/https/site-relative so a `javascript:`/`data:` target degrades to visible text. Pinned by a source guard forbidding `dangerouslySetInnerHTML` in this path (there is no type that forbids it). Before this, every `/insights/*` link the prompt tells the bot to "hand out freely" arrived as inert text the user had to retype.
  3. ⚠ **No ES2018-only regex syntax in `rich-text.ts`.** `tsc` does NOT transpile regex literals, so the pattern ships to the browser verbatim; a lookbehind is a **`SyntaxError` at PARSE time** on Safari < 16.4, which kills the module and takes the whole concierge with it. Every gate stayed green when this shipped because the entire toolchain runs on Node — a Node test suite is structurally incapable of catching it, hence the source guard.
  Also: `PAGE_DEFAULTS`' 35 per-page pill sets are merged with the context route's generic list, not replaced by it — assigning the server list straight over them made the whole map dead code on every session.
- `proxy.ts` — site lockdown (Next.js 16 convention, replaces middleware.ts; hardened May 8)
- `workers/topshot-proxy/` — Cloudflare Worker. Routes: POST / or POST /topshot → public-api.nbatopshot.com/graphql, POST /allday → public-api.nflallday.com/graphql, POST /allday-consumer → nflallday.com/consumer/graphql.
- `workers/odds-proxy/`, `workers/sports-proxy/` (deploys as `rpc-sports-proxy`), `workers/hybrid-custody-proxy/`, etc. — see the Cloudflare Workers table below for the full list + per-worker auth. `hybrid-custody-proxy` uses `INGEST_SECRET_TOKEN` Bearer; the others use `TS_PROXY_SECRET` via `X-Proxy-Secret`; `spork-proxy` uses `SPORK_PROXY_SECRET`. Don't conflate them.
- CI/CD: GitHub Actions workflows in `.github/workflows/` — rpc-pipeline.yml, ops-monitor.yml, pipeline-sentinel.yml, allday-ingest.yml, badge-sync.yml, pinnacle-owner-discovery.yml, topshot-active-listings-ingest.yml, topshot-listing-cache.yml, smoke-tests.yml, e2e-smoke.yml (Playwright rendered-DOM monitor, every 6h), db-pin-staleness.yml (daily DB-invariant-pin drift check, 07:20 UTC), edge-fn-drift.yml (repo↔deployed edge-fn drift comparator, daily 06:40 UTC), migration-parity.yml (prod-applied migrations that have no committed file — the containment for a push outage; daily 07:40 UTC, reporting-only), plus the backstops (sales-indexers, wallet-backfill, snapshot-institutional-wallets, offer-fill, topshot-sales-history-backfill, allow-list-reconcile) and ci.yml. NOTE: there is NO `alert-checker.yml` — pipeline-failure alerting runs via `/api/check-alerts` (`get_pipeline_alerts()` → Telegram+email), triggered by cron-job.org, not a workflow.

### Cloudflare Workers (current full list)

All `.tdillonbond.workers.dev`. Auth surfaces split across rotation domains — see "Worker auth surfaces (3 rotation domains)" above; note `helius-proxy` is a NEW independent surface (`HELIUS_PROXY_SECRET`, never shares `TS_PROXY_SECRET`). 17 worker dirs live under `workers/` (verified 2026-08-09; `atlas-proxy` added 2026-08-09, INERT pending an operator `wrangler deploy` + Cloudflare-egress probe). There is NO `workers/allday-proxy` dir — AllDay GraphQL is served by `topshot-proxy` on its `/allday` + `/allday-consumer` routes.

| Worker (dir) | Purpose | Auth |
|---|---|---|
| `topshot-proxy` | TopShot GraphQL + AllDay GraphQL (public-api + consumer routes) | `X-Proxy-Secret` (`TS_PROXY_SECRET`) |
| `pinnacle-proxy` | Pinnacle GraphQL | `TS_PROXY_SECRET` |
| `pinnacle-events-proxy` | Pinnacle on-chain events (manual/cron-invoked via workers.dev URL) | `TS_PROXY_SECRET` |
| `spork-proxy` | Flow mainnet historical spork access (port 8070) | `SPORK_PROXY_SECRET` |
| `pack-events-ingest` | Pack purchase/open event ingest → `pack_purchases` (TS + AllDay cursors) | `TS_PROXY_SECRET` |
| `topshot-moments-hydrator` | Moment→edition enrichment (`getMintedMoment`) | `TS_PROXY_SECRET` |
| `atlas-proxy` | Dapper Atlas marketplace pass-through (`api.production.atlas.dapperlabs.com/…/SearchMarketplaceTransactions`) so `topshot-active-listings-ingest` can reach Atlas from a non-WAF-blocked IP — the GHA runner IP is `egress_blocked` (~83% fail). **INERT: shipped 2026-08-09, not yet `wrangler deploy`'d; Cloudflare-egress-to-Atlas is UNVERIFIED (different WAF than the GQL host)** — probe before wiring the runner (see `workers/atlas-proxy/README.md`). ⚠ **THE COST OF LEAVING IT INERT IS USER-FACING AND WAS MEASURED 2026-08-16: ~60% of sweeps fail and 2026-08-12 wrote ZERO rows across all 5 runs of the day.** `topshot_active_listings` feeds `topshot_underpriced_serials_board`, which is BOTH the concierge's `search_serial_deals` and the serial pass of the live alert dispatcher — so a blocked ingest silently starves a chase-serial alert and makes the bot's "nothing is listed" answer a claim about a snapshot that may be a day old. The tool now DISCLOSES the age (`feed_age_hours`), which makes the starvation visible but does not feed it | `X-Proxy-Secret` (reuses `TS_PROXY_SECRET`'s value) |
| `sports-proxy` (deploys as `rpc-sports-proxy`) | NBA stats / DK projections / cdn.nba.com | `TS_PROXY_SECRET` |
| `odds-proxy` | the-odds-api.com pass-through with apiKey injection | `TS_PROXY_SECRET` |
| `reddit-proxy` | Reddit API access | `TS_PROXY_SECRET` |
| `hybrid-custody-proxy` | HybridCustody event reads against `0xd8a7e05a7ac670c0` | Bearer `INGEST_SECRET_TOKEN` |
| `dune-proxy` | Dune Analytics Query Results API (TopShot ownership-index sync, Pipeline A) | holds Dune API key |
| `helius-proxy` | Solana RPC pass-through (Candy chain-two) | `HELIUS_PROXY_SECRET` |
| `base-proxy` | Base mainnet RPC (`mainnet.base.org`) — Beezie/EVM data plane | `X-Proxy-Secret` |
| `flowevm-proxy` | Flow EVM RPC (`mainnet.evm.nodes.onflow.org`) | `X-Proxy-Secret` |
| `rpc-mcp-proxy` | MCP API-key cache-flush proxy (dashboard `/api/mcp/keys`) | internal |
| `sales-counterparty-backfill` | Recovers counterparties on historical `sales` via Flow REST tx decode — TopShot buyer+seller; AllDay/UFC **seller-only** (their `Deposit.to` is a Dapper custodian, never write it as buyer); Golazos excluded (no transfer to decode). SELF-SCHEDULED (Cloudflare Cron Trigger `*/5` — immune to the cron-job.org dropout class); fill-only + audited via `sales_counterparty_recovered` | `scheduled()` Cloudflare-internal (no auth); manual `fetch()` Bearer `INGEST_SECRET_TOKEN`; NOT on the `TS_PROXY_SECRET` surface (Flow public REST is Workers-reachable directly) |

---


## Two new instances on the sentinel itself (2026-08-22) — an ALERT that vanishes, and a share of zero

Both were on `app/api/sentinel/route.ts`, and both sat on the arm that measures the roadmap's **headline
metric** (the share of prices at HIGH/MEDIUM confidence). Instances 25 and 26 of the canon.

### 1. The arm could DISAPPEAR from its own report

```ts
if (error) { checks.push(warn) }
else if (data) { checks.push(the real answer) }
// no else — a read returning NEITHER pushed NOTHING AT ALL
```

`supabase-js` RETURNS rather than throws, so `error: null, data: null` is reachable. The arm then did not
warn, did not error, and did not render zero — **it was absent**. ⚠ **In an alert, absence reads as "not
among today's problems", and it is unfalsifiable: there is no wrong value to notice.** This is the worst
shape in the canon precisely because every other instance leaves something behind to catch.

Now bans at population zero via `scripts/check-unhandled-third-state.mjs` (measured: 1 instance across
**1,297** files, now 0). ⚠ The guard runs a positive AND a negative control on synthetic fixtures *before*
reporting, and fails if it inspected nothing — a detector that has stopped matching prints `0 violations`
and is indistinguishable from a clean tree.

⚠ **A syntactic ban only closes the routes it knows.** Pinned behaviourally too, in
`__tests__/api-sentinel-branches.test.ts`: **no arm present in a healthy run may disappear when every read
ERRORS, or when every read returns NO PAYLOAD.** Deliberately **not** a roster of expected arm names —
CLAUDE.md records that a guard naming its instances dies on a rename — so the healthy run defines the roster
and a rename changes both sides at once. Verified against the pre-fix route: the null-payload run produced
**12 arms instead of 13** and named the missing one.

### 2. A POPULATION of zero is not a SHARE of zero

```ts
const pct = (n: number, d: number) => (d > 0 ? ((n / d) * 100).toFixed(1) : "0")
```

The sibling of `?? 0` and `|| 1`. It looks like a safe divide-guard — it does avoid `NaN` — but what it
publishes is a **measurement**. Both gate meters rendered `0%`: `FMV Confidence` whenever the tally returned
no canonical base editions, `Edition Coverage` whenever the RPC returned no `live`-scope row. ⚠ **The read
did not have to FAIL for this**: `data = []` is truthy, so a **genuinely empty** tally took the success path
— the "read ok + genuinely empty" state rendering as a measured zero.

Both now withhold the number. ⚠ **The copy says "not zero", NOT "not 0%", and that is deliberate**: the first
draft used `0%`, which forced the test to carve a negative lookahead out of its own assertion so the fix's
wording would not trip it. **A carve-out added to tolerate the fix's own text is how a test stops pinning
anything.** With the reword the assertion is strict — `expect(detail).not.toContain("%")` — and pins the
ABSENCE of a percentage rather than the presence of a warning string.

⚠ **Three write-sites were deliberately NOT changed** (`lock_rate_pct` / `burn_rate_pct` in
`backfill-badges-from-sets`, `allday-badge-ingest`, `badge-sync`): they are typed `number`, not
`number | null`, and are WRITE payloads rather than display strings, so honesty there is a schema-shaped
change on ingest logic. **The correct pattern already exists in-repo** at
`app/api/cron/data-integrity/route.ts:122` (`… : null`). No guard was written for this expression — unlike
the two-state branch, its population is **majority-correct**, so a ban would red correct code and be
switched off.

---

## A new member of the class (2026-08-22): a TRUE freshness stamp that materialisation silently made false

This one is worth its own section because **nothing in the code changed at the site of the lie.** The
defect was introduced somewhere else entirely, and the field kept describing exactly what its code did.

**The identity that broke.** `fetched_at: new Date().toISOString()` is the house convention across ~20
`/api/public/insights/**` routes, and behind a LIVE view it is honest: the fetch computes the rows, so
fetch time *is* data time. The snapshot layer inherited that honesty for free — a 175-minute-old
`public_board_snapshots` row carries the 175-minute-old stamp taken when it was built, so a stale board
correctly *looks* stale.

**What broke it.** Materialising `cross_collection_deals_board`, `panini_squeeze_board` and
`topshot_first_mint_trophies` (same day; see the ledger) put an MV between the fetch and the data. The
fetch still happens now; the rows are now up to a full refresh interval old. `DealsBoardClient` renders
that value as **`Updated <FreshnessStamp iso={fetchedAt} />`**, so `/insights/deals` told collectors the
board was current while measurably **21.3 minutes** behind — on a board whose entire subject is listings
that disappear.

⚠ **The direction is what makes it dangerous: it UNDERSTATES staleness, and understates it MOST at the
moment the refresh pipeline is broken.** Overstating costs a reader nothing; understating sends them
after a deal that is gone.

**The general rule, which is not specific to boards:**

> ⚠ **Any cached/precomputed layer inserted UNDER an existing freshness stamp silently converts that
> stamp from a fact into a claim.** The stamp keeps compiling, keeps rendering, and keeps passing every
> test — because the code at the stamp did not change. **When you add an MV, a snapshot, a CDN rung or a
> memo cache beneath a surface, go and re-read what that surface says about how fresh it is.**

**The fix, and the two shapes worth copying:**
- `lib/insights/mv-freshness.ts` → `readMvAsOf(board)` reads when the MV last refreshed *successfully*
  from the `pipeline_runs` rows the refresh functions already write. **4 shared buffers** on
  `pipeline_runs_pipeline_started_idx` — no new table.
- ⚠ **It returns `null`, NEVER `now()`, on every failure path** (error, throw, no row, non-string,
  unparseable). A `now()` fallback restates the exact lie the module exists to remove, and does it
  precisely when the board is most stale. `FreshnessStamp` already renders `null` as `—`.
- `fetched_at` was **kept, not renamed** — it still means "when we answered" and remains correct for the
  ~17 insights routes that are still live-computed. Only the three materialised boards read `data_as_of`.

⚠ **The guard for this already existed and stayed GREEN through the whole regression.**
`__tests__/component-cached-boards-render-snapshot-age.test.tsx` pins *"stamps the SNAPSHOT's instant,
not the render clock"* — but its `BOARDS` list held `rookies` and `first-mint`, and `deals` and
`panini-squeeze` were never in it (their clients take bespoke props, so they could not join the
parametrised loop). **A hand-listed population drifts away from the thing it is meant to cover, and the
drift is invisible because the guard keeps passing.** Both were added explicitly, and the first-mint
fixture was INVERTED to supply a *later* `fetched_at` than `data_as_of` — turning "renders some
timestamp" into "prefers the age of the DATA over the age of the REQUEST".

⚠ **Still open, filed not swept:** `app/insights/candy-mlb/page.tsx` retains
`?? new Date().toISOString()`. Candy is not materialised, so its `fetchedAt` is genuinely the data time
and the coalesce is latent rather than live — but it is the same shape, one materialisation away from
being the same bug.

## A PAGED read that `break`s on error is the same defect with no error branch to audit (2026-08-23)

Every instance in the canon above is a read that failed and got *rendered* as a fact. This one has the
same ending and a different shape: the read **partly succeeded**, and the loop that gave up returned what
it had.

`lib/sitemap-data.ts`'s `fetchAllByCollection` pages with `.range()` and, on a PostgREST error, logs the
message and **`break`s** — so the caller receives an array that is indistinguishable from a complete one.
Measured in production 2026-08-23T02:19:54Z: `[sitemap] editions page 24000 error: canceling statement
due to statement timeout`, response **200**, **24,000 of 27,246** edition rows. `/sitemap/3.xml` then
asserted that truncated set to Googlebot as the complete list of our set / player / team pages.

⚠ **There is no dishonest COPY to grep for here**, which is why the copy sweeps that found the other
instances could never have found this one. The claim is made by the response's existence, not by a
sentence in it. **The tell is the control-flow keyword**: a `break`/`return` inside a pagination loop's
error branch, with a caller that takes the accumulated array.

⚠ **Three states again, and the middle one is the whole point:** all pages read · **some pages read** ·
zero pages read. A partial result must either throw (so the caller can 500 or serve the last good
artifact) or carry a `complete: false` the caller must handle. Returning it bare makes truncation
unobservable downstream.

⚠ **Its monitor is silent by construction too** — the four entity-smoke arms fed by sitemap segment 3
fail-soft to SKIP when they cannot discover a URL, and a skipped arm is a green job. The first evidence
anyone saw was four skips inside a passing run.

## Two more instances (2026-08-23), both in `backfill-topshot-pack-supply`, and one of them was mine

**Instance A — a bare `return` that rendered a failed read as a 200 with no counts.**
`backfillPool`'s targets-read error path was `{ console.error(...); return }`. The caller does
`{ done: true, mode, sync: true, ...result }` — spreading `undefined` contributes nothing, so a failed
read produced **`{"done":true,"mode":"pool","sync":true}` at HTTP 200**: indistinguishable from a
completed batch that happened to have no counts. Fixed: logs `ok=false` with `rows_* = NULL` (a `0`
would be indistinguishable from a genuinely empty queue) and the surface returns **500**.
⚠ **The shape to grep for is a bare `return` inside an error branch of a function whose result is
SPREAD by its caller.** Nothing about it reads as an error path at the call site.

**Instance B — a failure counter incremented without setting the error variable.**
`if (!okPages || eds.length === 0) { fail++; return }`. When the GQL walk SUCCEEDS and returns zero
editions, `fail` rises and `lastErr` stays `null`, so the tick returns
`{"done":true,…,"ok":0,"fail":3,"lastErr":null}` — **a clean success reporting its own total failure.**
This ran 288×/day; `net._http_response` shows **67 of 70 ticks in 6 h converting zero dists**.
⚠ **Generalised: whenever a `fail++` and an error-message assignment are separate statements, some path
does one without the other.** The tell is a `fail`/`error` pair that are not written together.

🚨 **Instance C — the instrument I built to expose B reproduced B.**
The new `log_pipeline_run` call logged `ok: !lastErr`. Its **first live row** read **`ok=true`** on a tick
that spent **29,189 ms**, found 3 dists and converted **0** — because `lastErr` is exactly the variable
instance B leaves null. Fixed one deploy later: `ok` is false when targets were found and **none**
converted, and the error string is **synthesized** rather than copied from a variable that may be null
(`"0/3 dists converted; 3 returned no editions"`), so the condition can never be unfalsifiable.

**Two durable rules from C, which is the one worth remembering:**

1. ⚠ **Deriving `ok` from an error VARIABLE inherits every path that forgets to set it.** Derive it from
   the WORK — did this run accomplish anything? — and synthesize the message when no upstream error exists.
   `ok: !err` is the same family as `?? 0` on a count: it publishes an absence as a positive fact.
2. ⚠ **Check a new instrument's FIRST reading against something you already know is true.** Mine
   disagreed with a measurement taken ten minutes earlier and the **instrument** was wrong. The positive
   control that closed it: identical work, v31 `ok=true` → v32 `ok=false`. **An instrument that has never
   been shown to report a failure has not been tested** — and a brand-new one agreeing with your hopes is
   the least tested of all.

## The FIFTH LAYER, swept properly (2026-08-24) — five public boards, and the SWEEP PREDICATE is the durable part

CLAUDE.md's honesty table has four layers and one helper each. **A SERVER-SEEDED PROP is a fifth it does not cover:** `initial={rows}` arrives as the empty fallback on a failed read **carrying no provenance**, so a component that correctly distinguishes failure for its OWN fetch still concludes on the seed. Two were found 2026-08-23. **Five more were found on 2026-08-24 — and the first attempt at the sweep nearly stopped at two.**

### ⚠ THE PREDICATE, because the first one was scoped to the wrong side

The first pass looked for boards with **no `initialDegraded` prop** — a property of the **CLIENT**. That missed every board whose **PAGE** has an `ok` and simply drops it on the floor. The population that matters:

> **Server pages that KNOW `ok` and seed a client component without passing it.**

Derived from the tree with that predicate: **9 candidates, 5 real, 4 correctly rejected.** Re-run it, do not quote the five.

### The five, and why each is a claim rather than a filter

| board | the sentence | note |
|---|---|---|
| `pack-drops` | "No live re-pack drops to score right now. **Check back when the next Vaultopolis drop lists.**" | claim about the MARKET; page exists to put drops in the **raw server HTML for crawlers** |
| `new-collectors` | "The board is refreshing — check back shortly." | ⚠ the **impossible-claim** shape already fixed at the OG layer — nothing is refreshing, **there is no refetch at all**, and it promises a recovery the component cannot deliver |
| `set-completers` | "No completion data available yet." | **no client refetch** ⇒ permanent for that viewer |
| `underpriced-serials` | "No underpriced headline serials right now — **the board is empty when nothing's listed below value.**" | the worst sub-class: an empty state that **CONCLUDES and then explains itself** |
| `serial-premiums` | "No qualifying #1 sales in this window." | |

⚠ **A DEGRADED BANNER ABOVE THE BOARD IS NOT A FIX, AND ALL FIVE ALREADY HAD ONE.** Each page rendered `<DegradedDataNotice summary={summarizeDegraded([boardStatus(…, ok)])} />` from the very `ok` it then discarded — **so a notice saying the data is degraded sat directly above a board stating confidently that there is none.** This is the sharpest example yet of *fix per PANEL, not per page*. ⓘ **`underpriced-serials` proves it three times on ONE surface:** its OG card's liveness claim, its page's staleness caption, and its page's empty state were three separate panels, fixed in three separate passes.

⚠ **NONE of the five refetches its data on mount** — measured, not assumed; two say so in their own comments (*"only refetch on explicit refresh"*, *"no refetch"*). **So the false sentence does not self-correct.** I had assumed the opposite for `pack-drops`.

### ⛔ THE FOUR REJECTIONS ARE THE POINT

`pack-sniper`, `parallel-premiums`, `rookie-board`, `top-sales` all say **"… match those filters"** — a claim about the **FILTER the reader just set**, not about what the platform knows. `market-pulse` renders **nothing** when empty and so makes no claim at all. ➡ **Widening a guard until every candidate passes is how a correct surface gets made incorrect.** The rejections and their reasons live in the test file, not just here.

### ⛔ AND THE RENDERED HTML REFUTED ONE OF MY OWN FIXES

For `new-collectors` I first guarded the gateway panels' *"No data in this window."* — **unreachable**: on a failed read the page hands over `EMPTY_BOARD`, so `hasData` is false and the **whole board collapses before those panels render**. `renderToString` showed it immediately. ➡ **Read the rendered output, not the source, before believing a branch is the one a failure reaches.**

### The guard shape

**SSR (`renderToString`), per the `FmvHistoryChart` precedent** — a client-only assertion cannot see the sentence the reader reads first, and on an ISR route that markup is cached for the whole revalidate window. Mutation there had shown that **both `useState(false)` and the mirror image `useState(true)` left every jsdom test passing.**

- **Assert the ABSENCE of the false claim** (`not.toMatch(/No live re-pack drops/)`) — asserting the degraded sentence's PRESENCE would pass a board printing **both**.
- **A NO-CHANGE CONTROL on every case**, or deleting the empty state entirely satisfies the guard.
- **Wiring assertions**, because a component test cannot see the call site: `initialFailed={!ok}` **DERIVED, not a literal** — `initialFailed={false}` passes a presence check and reinstates the whole defect.
- ⛔ **One test was DELETED rather than propped up.** "A failed seed that nonetheless has rows" needed a hand-built fixture for a state production cannot produce (the failure fallback IS `[]`), and the fixture was wrong, which is how it announced itself. **A test that needs an impossible fixture is testing the fixture.**

---

## The CACHING amplifier (2026-08-24) — ISR bakes a failed read into the whole `revalidate` window

⭐ **Found BY a fix, not by a search.** Minutes after the fifth-layer honesty fix deployed (`34d8ff78`),
`/insights/pack-drops` rendered **"Pack drops couldn't be loaded — refresh to try again."** in production.
Before that deploy the same state rendered **"No live re-pack drops to score right now…"** — so the
degradation was **already happening and was invisible, disguised as a quiet market.** ➡ **An honesty fix's
first job is to make the real problem findable, and it did that within minutes.**

⚠ **THE FIRST HYPOTHESIS WAS WRONG, OFF ONE SAMPLE.** The route reported `elapsed_ms: 11529` on the first
call and **8 s is `BOARD_LIVE_TIMEOUT_MS`**, so the tidy conclusion was *"this page is permanently
degraded."* Five more samples: **4,286 · 1,140 · 1,187 · 1,293 · 1,192 ms.** Warm, the read is ~1.2 s —
**six times under budget**; the 11.5 s was the COLD path (`source: vaultopolis_public_api + rpc_fmv`, an
EXTERNAL API, so the cold cost is upstream, not the DB). ➡ **A directional claim needs a distribution, not
a snapshot** — the one-instant read would have sent someone to raise a timeout for a query that is fine
5 times out of 6.

**What is actually true, and why it is a member of this canon rather than a perf item:**

1. A cold regeneration that exceeds the budget **fails the page's read**, and `export const revalidate = 900`
   then **serves that failure for up to 15 minutes.** Observed live: `x-vercel-cache: HIT`, `age: 158`,
   degraded copy, while the API answered in 1.2 s throughout.
2. 🚨 **`pack-drops` HAS NO STALE SNAPSHOT.** `BOARD_LIVE_TIMEOUT_MS`'s own comment justifies the budget as
   *"precisely when a stale-but-complete snapshot is the better answer"* — but this page calls
   `fetchBoardForPage("Pack drops", [], …)`, i.e. **the fallback is `[]`.** The budget's stated rationale
   does not hold for this caller. **Enumerate which other boards pass an empty fallback rather than a
   snapshot before touching the constant.**
3. **The blast radius is the page's whole purpose** — it exists to put the scored drops into the raw server
   HTML so the unique content is crawlable. A cold-miss window serves a crawler a page with no drops on it.

⚠ **IT SELF-HEALS ON THE FIRST WARM REVALIDATION, WHICH MAKES IT EASY TO DECLARE FIXED BY ACCIDENT.** The
honest test is not *"is the page OK now"* but **"does a COLD regeneration still exceed the budget."**

⛔ **NOT FIXED, and three of the obvious remedies are wrong in ways worth naming:**

- ⛔ **"Raise `BOARD_LIVE_TIMEOUT_MS`"** — it is **shared by every insights board** and was created
  deliberately (first-mint, 2026-08-12) so a throttled DB falls back rather than blocking a page or a build.
  Raising it globally trades every board's worst case for this board's rare one.
- ⛔ **"Just retry"** — the abandoned query **keeps running server-side** (supabase-js has no cancel; the
  module says so). A retry adds load during the exact window the budget exists to protect.
- ⛔ **"Lower `revalidate`"** — that increases how often the cold path is HIT, not how often it succeeds.
- ✅ **The two plausible ones, both Trevor's call:** a **per-caller budget** (the precedent exists —
  `SET_DETAIL_TIMEOUT_MS` on `/analytics/sets`), and/or **a real stale snapshot** so the fallback matches
  the rationale the shared budget is written against.

Filing (every number is a dated sample — re-run the six-sample distribution before quoting ~1.2 s):
`docs/overnight/inbox/2026-08-24T1441Z-a-cold-isr-regeneration-can-bake-a-failed-read-into-15-minutes-of-cached-html.md`.

## A THIRD supabase-js shape: a DISCARDED WRITE RESULT on a telemetry insert (2026-08-24)

CLAUDE.md names two fabricated-number shapes — `?? 0` on a count and `|| 1` as a divide-guard — both powered by the same engine: **supabase-js RETURNS errors rather than throwing.** Here is the third, and it fabricates an ABSENCE rather than a number:

```ts
await supabase.from("pipeline_runs").insert({ … })   // result discarded
```

**Nothing throws, so `try/catch` is no defence and the function reports success.** On a **telemetry** write the consequence is specific and nasty:

> insert fails → **no `pipeline_runs` row** → every arm keyed on `pipeline_runs` reports **`cron_silent`** → which reads as **"the scheduler stopped"**.

⚠ **The pipeline becomes indistinguishable from one that never ran** — and this repo has arms that key on exactly that (`detect_stalled_pipelines`, `get_pipeline_alerts`), on a table already documented as a null-instrument in other ways (`rows_written = 0` has three incompatible meanings).

**Swept 2026-08-24 across `supabase/functions/**/*.ts`: 5 INSERT sites, 3 discard the error** (`backfill-pack-opens-api`, `ingest-allday-pack-opens`, `ingest-topshot-pack-opens-history`) and **2 check and log it** (`hybrid-custody-backfill`, `hybrid-custody-events`). ⓘ **Those two are the positive control — the correct shape is already in this tree.** Held by `__tests__/edge-fn-pipeline-run-inserts-check-their-error.test.ts` as a **down-only ratchet at 3**, because the three cannot be fixed without an edge deploy and a ban at zero would sit permanently red.

⛔ **AND A DISCIPLINE NOTE THAT COST ME AN HOUR: this defect is REAL and was NOT the cause of the outage I found it during.** I was chasing `allday-pack-opens-backfill`'s silence, found this, and it looked like the answer. It is not — **the identical call writes 46 `allday-pack-opens-forward` rows a day.** ➡ **A defect that is real and is not the cause of the thing you are investigating must be filed separately, never reported as the cause.** Reporting it would have closed a live investigation on a true statement about the wrong thing.

⚠ **The detector for this was WRONG TWICE and its own fixtures caught both** — it walked vendored `node_modules` (1,756 files instead of ~40), and its statement-boundary heuristic cut at the last brace, **severing the `{ error }` destructuring it was looking for** so that every site classified as unchecked, including the CHECKED fixture. ➡ **Prove a detector in BOTH directions; a detector that never fires is as green as one that finds nothing.**

## The SIXTH shape (2026-08-25): `Array.isArray(data) ? data : []` — a coercion that turns an unreadable payload into a POSITIVE CLAIM

⛔ **`const rows = Array.isArray(data) ? data : []` is this repo's `?? 0` for list-shaped RPC reads.** Any non-array payload — a jsonb object, a scalar, a NULL jsonb — becomes an EMPTY list, and the caller's next line decides whether that is harmless or a fabricated fact. **8 sites fixed across 3 routes on 2026-08-25** (`ddb452a8`, `a3c99bf1`).

### ⭐ THE DISCRIMINATOR IS THE DURABLE PART — the expression is not the defect

The tree carries ~20 instances of this exact expression and **most are fine.** Do not sweep them all. Ask one question:

> **Does the coerced `[]` become a POSITIVE CLAIM, or just an empty render?**

| the next line does… | severity | example |
|---|---|---|
| `passed = rows.length === 0` | 🚨 **guard FAILS OPEN** — a shape it cannot read *passes* the check | the 4 `check_*` guards in `smoke-test` |
| `if (hot.length === 0) return` on an alert | 🚨 **worst — output is SILENCE**, and `p_ok` stays true | `check-alerts` / `get_pipeline_alerts` |
| `status = rows.length ? "warn" : "ok"` | 🚨 **fabricates a health SENTENCE** about things it never read | sentinel `Pipeline Silence` |
| renders an empty list / returns `{rows: []}` | ⓘ **usually fine** — an empty renders as empty and is visible | `market-pulse-board`, `pack-ev-history` |
| drives a work queue (`for (const x of rows)`) | ⓘ **low** — the tick no-ops and the next one retries | `resolve-wallet-usernames` |

### ⚠ STEP ONE IS `pg_proc`, NOT THE CALLER

**PostgREST's payload depends on the function's return type, and this DB mixes both in a single route:**

- `proretset = true` (`RETURNS TABLE …`) → PostgREST **always** sends a JSON array → the ternary is **dead code**, leave it alone.
- `proretset = false` (`RETURNS jsonb`) → the payload is whatever the jsonb is → the ternary is **load-bearing**.

`smoke-test` calls two SETOF guards (`check_public_security_invariants`, `check_anon_write_surface`) and three scalar-jsonb ones (`check_secdef_anon_execute_violations`, `check_cursor_stall_threshold_drift`, `detect_stalled_pipelines`). **Classify before editing.**

### ⚠ MEASURE BEFORE YOU ALARM — all eight were PROSPECTIVE, and saying so is the point

Every one of the five RPCs returns a JSON array **today**, and each COALESCEs its own NULL (`coalesce(jsonb_agg(…), '[]'::jsonb)`; `coalesce(core(),'[]') || coalesce(…,'[]')`). **Nothing was mis-reporting; no guard was silently green.** The fix is hardening, and the ledger and commits say so rather than claiming a save. What makes it worth shipping anyway: **both shapes are already live in one route**, so converting a scalar-jsonb guard to the object shape a sibling uses would silence it with no test going red.

⭐ **The shapes were verified by READING `prosrc`, deliberately not by calling the functions** — `get_pipeline_alerts_core()` is precisely what times out during a disk-IO spell, and one was in progress. **Choose a measurement method that does not add load to the thing being measured.**

### The fix, and the test that proves it

`if (!Array.isArray(data)) return couldNotRun(meta, data)` — handled exactly as `error` already was. **Never `soft`**: a shape change is not transient and a retry cannot fix it. ⚠ **Report the TYPE only, never the payload** — these guards read privilege catalogues, and echoing a body puts catalogue rows in a Sentry title on the one path nobody rehearses.

⚠ **Pin the PROPERTY across BOTH return shapes and at least three payloads (object / null / scalar)**, or a fix that handles one passes. ⚠ **Assert the ABSENCE of the false claim** (`not.toContain("All watchlisted pipelines running")`), not the presence of an error string — the pre-fix code produced **no error string at all**, so any assertion about wording passes against the defect. ⚠ **Ship a both-directions control** (*an empty array is an honest zero*), which stays green in both worlds by design; without it, "treat every payload as unreadable" satisfies every regression while permanently warning on a healthy platform.

### ⓘ And a different defect found while reading the same file — ZERO INSPECTED IS NOT A PASS

Sentinel's `Sales Ingest by Collection` starts `worst = "ok"` and only moves on a breach, so an **empty** result fell through to `status: "ok"` with an **empty detail string** — a green check that examined nothing. **`value` already carried the cardinality; STATUS is what a reader and the alerting key on**, so the count now moves the status and the healthy branch states how many it inspected. *"0 breaches in 12 collections"* and *"0 breaches in 0 collections"* rendered identically before.

---

## The SEVENTH shape (2026-08-25): a PARTIAL SWEEP that PURGES — the honesty defect whose output is a DELETE

The class this file catalogues is *a failed read rendered as a fact*. **The five listing-cache routes hold its
most expensive variant: the "fact" is not rendered to a reader at all — it is written back as a deletion.**

**The shape.** Each route sweeps a paged upstream (Flowty / the collection proxies) into `cached_listings`,
then purges every row older than the function-top `startedAt` — i.e. *"anything I did not just see is gone
from the market."* That statement is only true **if the sweep was complete.** Every one of the five had a
page-level error branch (`break`, `continue`, or a caught fetch) that ended the sweep early **and then ran
the purge anyway**, so an upstream outage mid-sweep did not degrade the cache — it **emptied** it.

⚠ **The guards that existed were the wrong shape, in an instructive way.** Three of the five gated the purge
on `stats.upserted > 0` — which reads like a safety check and is not one: a sweep that read page 1 and then
died on page 2 has `upserted > 0` and is still partial. **`upserted > 0` answers "did I write anything",
never "did I see everything".** `ufc-listing-cache` was the worst: it wiped unconditionally.

**The fix, uniform across all five:** carry completeness explicitly — `pageErrors` counted at every error
branch and `sweepComplete` set **only** at the three legitimate ends (empty page, past the last page,
page-cap reached) — and gate the purge on it. ⚠ **`app/api/listing-cache/route.ts` needed a signature change
to be able to express it at all:** `fetchFlowtyPage` returned a bare `any[]`, so *"the page was empty"* and
*"the page failed"* arrived as the same value — the fetcher now returns `{ nfts, failed }`. Its
degraded-response `reason` changed from `flowty_empty` (a claim about the market) to `flowty_unreadable`
(a claim about the read), which is the same correction this file records everywhere else.

⚠ **`ufc-listing-cache`'s gate is deliberately NOT also `rows.length > 0`.** A complete sweep that legitimately
returns zero listings SHOULD purge — that is the cache doing its job. Conflating the two is how the
`upserted > 0` misfire got written in the first place: **gate on COMPLETENESS, never on VOLUME.**

⚠ **Four pinned tests asserted the old behaviour** and were **INVERTED, not deleted** (the standing rule), each
paired with a no-change control proving the complete-sweep path still purges. One fixture bug surfaced doing
it: the Golazos `proxyStub` returned **HTTP 500** for any offset past its fixture, so *every* test in that file
was exercising the error path by accident and the "purge happens" arm was vacuous. Past-the-fixture offsets
now return `200 {nfts: []}`, with `pageErrorAtOffset` for deliberate injection. **A stub whose default is an
ERROR makes every happy-path assertion in the file a lie.**

## The EIGHTH shape (2026-08-26): a GUARDED `setState` publishes the INITIALISER as a measurement

Three live instances in one night, on `/dashboard` and the profile Achievements card. No coercion, no
`?? 0`, no `|| 1` — nothing that any existing grep or ratchet matches. The shape is simply:

```ts
if (res.ok) { setRows(await res.json()) }        // /dashboard trophy slabs
if (!d?.achievements) return                      // AchievementsCard, inside .then()
```

**On failure the setter never runs, so the state keeps the value it was declared with — and THAT value is
what renders.** `useState([])` / `useState({})` / `useState([null,null,null,null,null,null])` were written as
"nothing yet", and the render layer reads them as "nothing, measured". The declaration is a hundred lines
away from the branch, which is why this reads as correct in review.

⭐ **The tell is not an expression, it is an ABSENCE: a `set*` call inside a conditional or after an early
return, with no `else`.** Grepping for the fixed shapes cannot find it. Ask instead: *if this read fails,
what value does the component render — and who chose it?*

**What made each one a defect rather than a harmless understatement was the COPY the initialiser reached:**

| surface | initialiser | what it rendered on a failed read |
|---|---|---|
| `/dashboard` trophy case | `[null × 6]` | **"Pin a moment to your trophy case"** — to an owner with six pinned |
| `/dashboard` Friend Activity | `[]` | **"Follow other collectors … hit + FOLLOW"** — the `/my-teams` incident verbatim |
| `AchievementsCard` | `{}` | **"0 / 7"** and every badge locked — a fabricated number about their own account |

⚠ **All three are the WORST sub-class**: a false claim about the reader's OWN account, and **actionable** —
each tells someone to redo work they have already done.

⚠ **THE TROPHY-CASE PANEL WAS ALREADY HALF FIXED, WHICH IS THE REUSABLE WARNING.** `refresh()` gates the
HERO fetch on `slabsRes.ok` and carries a comment naming this exact incident — but the render fallback still
landed on `<EmptyHeroState>`. **A panel with one honest branch is not an honest panel**; the fix has to
follow the value all the way to what renders, not stop at the read that produced it.

⚠ **The safe siblings are worth knowing so the sweep does not become noise.** In the same pass,
`PublicAchievements`, `CollectionRecentSales` and the `TeamSets` parent all leave state at an empty
initialiser too — and all three **omit their section** (`return null`, or `{x.length > 0 && …}`). An omission
understates and is the safe direction. **The initialiser is only a defect when something renders a sentence
about it.**

⭐ **Also fixed in the same file, and it is a distinct member of the class: a CONFIRMATION that reports the
passage of time.** `AchievementsCard`'s Refresh swallowed its POST result and ran `setUpdated(true)`
unconditionally, so a failed recompute still told the collector their achievements had just refreshed. It is
**unfalsifiable by construction** — the re-read that follows succeeds either way and simply returns the OLD
data, so the UI looks exactly the same whether the recompute worked or not. Derive the confirmation from the
WORK (`setUpdated(recomputed)`), never from reaching the end of the chain.

## Three RE-RUNNABLE sweeps for the eighth shape (2026-08-26), and exactly what each can and cannot see

The eighth shape has no expression to grep, so the work was in building detectors. All three are cheap,
were run over the live tree, and **their blast radii differ in ways worth writing down** — each is blind to
what the others catch.

### Sweep 1 — a guarded setter with no failure state, reaching an empty CLAIM

Client components only. Flag a file that (a) guards a setter on a read's success or early-returns inside a
`.then`, (b) has **no** failure state, and (c) renders a sentence about emptiness. Condition (c) is what
keeps it useful: a file that omits its section understates, which is safe.

**200 client components → 4 candidates → 1 real.** The three false positives are the calibration evidence:
`DashboardAlertsClient` gates on `!err` (the filter looked for `setError` and missed `setErr`),
`ProfileClient` throws on `!r.ok`, `FollowButton` documents the rule in a comment. **Three of four were
already right**, which is what a healthy sweep looks like.

The real one: **`PlayersGridPaginated`'s `catch { setExhausted(true) }`** — a failed page marking the list
COMPLETE, so a truncated roster rendered identically to a full one. ⚠ **Its sibling
`EditionsGridPaginated` had been fixed long before and still carries the comment *"THIS USED TO
`setExhausted(true)`"***. One copy fixed, the other never grepped for. Now a **ban at population zero**:
`__tests__/catch-blocks-do-not-assert-completeness.test.ts`.

### Sweep 2 — a TEST that pins the defect

Two variants, and **the first one I ran was too narrow, which is the lesson.**

- **Numeric variant** (a failure mock + `getByText("…0…")`): **2,940 `it()` blocks / 247 files → clean**,
  once narrowed to component renders and PRESENCE only. ⚠ A first cut read **41** because it could not tell
  `getByText("0")` (the defect) from `queryByText("0").toBeNull()` (the fix), and flagged every ROUTE test
  correctly asserting `ok:false`.
- ⛔ **That numeric sweep is BLIND to the affordance variant, and I stated its result too broadly before
  noticing.** An **affordance** sweep (failure mock + an absence assertion naming a button) flags **10**, of
  which 8 are legitimate controls asserting an ERROR message is absent. The other two were real, and one was
  **provably blind**: `component-EditionsGridPaginated`'s `it("marks exhausted on a fetch error…")` still
  passed after re-introducing the defect — **11/11 green** — because the button's label changes to "Retry",
  so `queryByRole(name: /Load 2 more/)` is null under the fix AND the defect.

⭐ **Asserting that an affordance DISAPPEARED is almost always the wrong assertion.** Assert what the reader
can now SEE and DO.

### Sweep 3 — a file that KNOWS the idiom and applied it to one field only

The highest-signal of the three. Flag a file using the honest `X.error ? null : …` on at least one field
**and** `Y.data ?? []` on a sibling. Such a file demonstrably knows the trap.

**1,152 files → 3 hits, 0 new defects.** `/api/rewards/summary` was the live one (fixed: `redemptions` was
coerced while `referralCount` three lines below carried the honest idiom **and a comment explaining the exact
trap**). `app/api/badges/route.ts` throws on `dataResult.error` first — a false positive. `lib/pinnacle/
moment-detail.ts` is a **documented deliberate decision**: its own comment says the other reads degrade to an
omitted section or an em-dash, "the safe direction — so this is the one that needed a flag."

⭐ **The reusable form: search for INCONSISTENCY WITHIN A FILE, not for the bad expression.** Code that fixed
the trap once and missed a sibling is both the likeliest defect and the cheapest to confirm — the evidence is
already written in the file, usually a few lines away.

### Sweep 4 — the OG CARD layer (layer 4 of the honesty table), and it is CLEAN

**44 OG route files · 22 render a NUMBER · 0 defects.** All 22 either use `boardEmptyCopy`, carry a failure
state, or **guard the zero so it can never display.** Worth recording because a passing audit is the kind
nobody writes down and someone later re-runs — and because the sweep was **wrong twice** before it was right.

⚠ **Correction 1 — a failure state is a PROPERTY, not a VOCABULARY.** The first predicate looked for the
words `failed|unavailable|fetched` and flagged **8**. It had missed the `ok` FLAG, which is how the two
most-shared cards do it: `og/profile` returns `{ rows: [], ok: false }`, and `og/trophy-case` calls
`renderFallback(...)` on `!result.ok`. Grepping for a house style finds the files written in that style.

⚠⚠ **Correction 2 — a `?? 0` that NEVER RENDERS is not a defect.** The second cut flagged 2, and both were
still false. `app/api/og/insights/panini-squeeze/route.tsx` genuinely contains `editions = agg.count ?? 0` —
the documented fabricated-count shape, in shipped source — but the render is:

```tsx
{editions ? `${editions.toLocaleString("en-US")} editions · ${usd(sealed)} still sealed in packs`
          : "2026 Prizm World Cup Soccer — still-in-packs supply + FMV"}
```

**Zero is falsy, so the failed read falls through to a generic tagline and the fabricated number never
reaches a pixel.** `candy-mlb` guards identically on `priced > 0`.

⭐ **This is the `client-failure-collapses-to-empty-ratchet` header proved in the field: *"the method that
keeps working is sweeping the empty-state COPY, not the fetch code."*** A fetch-shape grep cannot decide this
class in either direction — it misses defects whose shape is an absence (the eighth), and it accuses code
whose shape is present but unrendered. **Follow the value to the pixel.**

ⓘ Both surviving candidates were also the two `is_active=false` pre-launch collections (Candy MLB, Panini) —
worth establishing *before* spending a fix, since even a real defect there reaches almost nobody.

---

## The ALERT sub-class, made falsifiable (2026-08-29/30)

The canon above names the alert as one of the worst sub-classes — *its output is silence, so the error
is unfalsifiable*. Two live instances, both fixed, and the fix is the same idea in both: **an error
that is not published is not an error anyone can act on.**

**Observed:** `pipeline-sentinel` run 33283636751 reported `"notifications":["telegram-FAILED"]` on a
CRITICAL sweep — it had correctly found three dead Top Shot GraphQL pipelines and could not tell
anyone. The reason went to `console.error` only, so a revoked token, a non-2xx and a thrown fetch were
indistinguishable from outside.

⚠ **The second half is the one that generalises: an unconfigured channel produced NO ENTRY AT ALL.**
Both push sites sat inside `if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID)`, so a channel that could not
deliver was silent, and **absence reads identically to "no notification was needed"**. Whenever a
capability is gated on config, ask what the ABSENCE renders as. It now says
`telegram-FAILED:not_configured`.

**The helpers:**

| what | where |
|---|---|
| scrub a secret out of anything about to be published | `lib/redact-secrets.ts` → `redactSecrets()` |
| a synchronous cron route's terminal `pipeline_runs` row | `lib/pipeline/terminal-run.ts` → `logTerminalRun()` |
| an `after()` route's pre-work marker | `lib/pipeline/heartbeat.ts` → `writeInvocationHeartbeat()` |

🚨 **`redactSecrets` is not decorative — the Telegram bot token is IN THE URL PATH**
(`/bot<TOKEN>/sendMessage`), so publishing a thrown fetch's message writes a live credential into
`pipeline_runs.extra` and the route's JSON response. It scrubs **by value AND by shape**, because the
value arm cannot cover a rotated token and the shape arm cannot cover a value outside those shapes.

⚠ **Fixed in BOTH copies.** `lib/ops-alert.ts` is the copy-paste sibling (it backs
`stale-fmv-monitor` and `data-integrity`); its `OpsAlertResult` gained `telegramReason`/`emailReason`
**additively**, so the booleans keep their exact meaning and no caller breaks. This is the standing
rule in action: **when you find one, grep for the EXPRESSION, not the file.**

⚠ **Four existing tests were UPDATED, NOT DELETED, and three were STRENGTHENED.** They pinned
spellings — `toContain("telegram-FAILED")`, `toEqual` on the whole result object — which red on an
honest addition. They now match the `…-FAILED` **prefix** (the property any reader keys on) *and*
assert the reason is present, which is the improvement.

---

## The NINTH shape (2026-09-02): the failed read arrives from OUTSIDE, as an upstream **HTTP 200** — and the fix is a FLOOR, not an error branch

Every shape above is ours: our code turns a failed read into a claim. This one is the same defect with
the failure originating at an **upstream that reports success for data it cannot serve**, which is
worse in one specific way — **there is no error to branch on, anywhere, at any layer.**

**The instance.** `sales-counterparty-backfill` walks `sales` newest-first, decoding each tx via
`rest-mainnet.onflow.org` to recover the seller. Past Flow's prune horizon that endpoint does **not**
404. It answers:

```
HTTP 200  { "block_id": "", "execution": "Pending", "status": "", "events": [] }
```

`res.ok` is true, there is no `Withdraw` event, so the worker records an ordinary miss and advances the
cursor — **exactly what it does for a throttled request.** Result: **288 runs a day, all `ok`, ~9.2 h of
runtime, ZERO rows recovered**, and every fleet instrument reading *idle* rather than *blind*.
`rows_written` was **honestly** 0.

⭐ **THE DISCRIMINATOR IS THE BODY, NOT THE STATUS.** `execution !== "Success"`, or zero events on a
transaction that certainly had some. **A probe that reads only the HTTP status can never find a prune
horizon, however far back it goes** — which is how a recorded memory came to state that this endpoint
*"has no spork wall"* on the evidence that it answered 200 back to 2024-12-31.

⭐ **AND THE STRUCTURAL FIX IS A FLOOR, NOT AN ERROR BRANCH.** A cursored newest-first walk terminates
only by running out of data, so without a **lower bound** it walks off the edge of what its upstream can
serve and keeps going, at full cost, reporting success. **A cursored backfill needs a FLOOR, not just a
cursor.** Shipped as `sales_counterparty_backfill_state.floor_sold_at` — deliberately DATA rather than a
literal inside the function, so it can be raised when an upstream prunes further without a migration,
with a `COALESCE` in the function so it cannot be NULLed back into an unbounded walk.

⚠ **TWO MEASUREMENT LESSONS, and the second overturned a filed number.**

1. **The cursor is not a decodability timestamp.** `deep-audit-register` R70 put the boundary at
   `2023-11-08T14:39Z`, read from `cursor_sold_at`. But the cursor advances past rows that were
   **missed**, so it runs ahead of the last row actually converted. Read the **rows written** instead:
   the last productive hour recovered down to `sold_at 2023-11-08 19:41:13Z` and no further — five hours
   from where the cursor said.
2. **Bracket a boundary against a gap in your OWN data.** 24 probes put the last `Pending` row at
   `2023-11-08 15:58:12Z` and the first `Success` at `18:51:39Z`, and `sales` holds **no row between
   them** — so a floor anywhere inside that gap partitions the population *exactly*, and the choice
   stops being a judgement call about margin.

⚠ **A floor is a property of the ENDPOINT, not of the chain.** 2,339 rows below this one — back to
2021-07-31 — were recovered by a different path on a single day in 2026-07. Do not let "unreachable"
harden into "does not exist": name the endpoint in the claim.

### ⛔ AND THE SAME NIGHT, THE FIX'S OWN SIZING WAS THE NINTH SHAPE POINTED AT ME

The floor above was shipped with the headline *"450,987 rows above it are still recoverable."* **That
number counts rows whose TRANSACTION IS REACHABLE. It says nothing about whether a seller exists in the
transaction to be decoded** — which is the only thing the pipeline does. It is the circular sizing this
canon already records from fmv-recalc (*"I sized a backlog using the very predicate that was defining
it wrongly"*), committed by the next session, in a different pipeline, hours after reading it.

**It surfaced by watching the SECOND tick.** The first recovered 109 of 120 and would have been quoted
happily. The next six recovered **0 of 720**, all `allday_studio_history_v1` — whose rows carry the
`NFTStorefrontV2.ListingAvailable` transaction, not the transfer. 21 of 21 hash-bucket-sampled txs
(two bucket moduli, so not one physical page) came back `Success` with **zero Withdraw events and one
ListingAvailable**, against a 3-of-3 positive control on `onchain` rows. A listing moves no NFT.
Corrected: **reachable 450,987 · decodable ≈ 42,569 (9.4%)**.

⭐ **Two rules, and the second is the cheap one.** *Reachable* and *convertible* are different
populations, and a floor or predicate tells you only the first — **size a backlog by SAMPLING THE
CONVERSION, never by counting what survives the filter.** And **watch the second tick**: the first tick
after a fix is the one most likely to flatter it.

---

## THE TENTH SHAPE (2026-09-01): the discarded read error whose landing place is a RETIREMENT path

Every entry above is about a failed read that gets *published* as a fact. This one is worse in a
specific way: the failed read is never shown to anyone, and instead **destroys the work it was reading
about**.

The shape is the plainest possible line, and there are **55 of it** in `app/`, `lib/` and `workers/`
as of 2026-09-01:

```ts
const { data } = await (supabaseAdmin as any).from("...").select("...").in("...", batch)
for (const row of data ?? []) { /* build a map */ }
```

`error` is destructured away. supabase-js **RETURNS** errors rather than throwing, so a failed read
yields `data: null` and the `?? []` turns it into *"this table has no row for any of these ids."*

⚠ **Most of the 55 are harmless — and that is exactly why this needs a discriminator rather than a
ban.** In an enrichment loop, an unread lookup means one un-enriched row and the next tick fixes it.
**Ask instead: WHERE DOES `not found` LAND?** Three landing places found in one sweep of the two
listing-retry drainers and their admin sibling:

| landing place | consequence of a failed read |
|---|---|
| `stillUnresolvedIds.push(id)` → `retry_count + 1` | **10 bumps retire the row permanently** at `RETRY_COUNT_CAP` |
| `UNRESOLVABLE_MARKER` + `resolved_at = now()` | **irreversible**, on the first occurrence |
| an enrichment map | harmless — retried next tick |

👉 **THE RULE: `?? []` is safe over a read whose miss is RE-TRIED, and unsafe over a read whose miss is
RECORDED.** At `*/15` with a cap of 10, a sustained read failure retires every queued row in **two and
a half hours**, and the only trace is `rows_skipped` going up — which looks like the pipeline working.

### Two siblings of the same shape, in the same files

1. **A failed WRITE that is nevertheless marked done.** `allday-listings-retry` upserted resolved rows
   into `cached_listings_v2` in batches, logged any error, carried on — and then marked **the whole of
   `resolvedIds`** `resolved_at`. A listing whose v2 row never landed had its failure row closed
   forever, and **nothing else re-derives it.** The fix indexes the id list by the same slice as the
   batch, so only rows whose write landed are marked.
2. **`x = list.length` after an error branch that only logs.** All three routes ended their
   resolved-mark with `if (error) console.log(...)` followed by an unconditional
   `resolved = resolvedIds.length`. **The mark IS the resolution**, so that published N rows resolved
   while all N stayed queued. In the admin route it answered the operator `{ok: true, resolved: true}`
   — the one signal that stops a human from looking again.

### And the null-instrument, one field over

`pinnacle-listings-retry` incremented `rowsWritten` only inside `if (uuid)` — the RARE branch. Pinnacle
editions live in `pinnacle_editions`, which has no `editions` UUID to write, so a tick that resolved a
full batch still reported `rows_written: 0`. Over 30 days: **2,704 runs · 92,164 found · 0 written**, on
a pipeline doing its job — which puts it in every zero-yield sweep forever and trains the reader to
ignore it. `rows_written` now counts the resolutions; the rare backfill is reported separately as
`extra.edition_id_backfilled`.

⭐ **How the tests pin all of it: as an ABSENCE of the destructive act.** Not *"an error was logged"* —
the fixture row sits at `retry_count: 9`, one bump from retirement, and the assertion is that
`listing_resolution_failures` received **zero** UPDATEs. Each of the twelve was mutation-checked by
reverting the route and confirming it reds.

### The sweep that followed, and the DISCRIMINATOR it produced

The line shape above appears **25 times** across `app/`, `lib/` and `workers/` (55 occurrences). Most are
harmless. Crossing that list against files that also contain a retirement expression
(`retry_count` · `RETRY_COUNT_CAP` · `resolved_at` · `UNRESOLVABLE`) narrowed it to **five more files**,
and READING each — the grep is the shortlist, never the finding — gave four distinct landing places:

| route | what a failed read produced |
|---|---|
| `topshot-offers-indexer` | every offer fell to `if (!editionId) { unresolved++; continue }`, **zero rows written, and the cursor advanced anyway** — nothing revisits a block below the cursor, so the offers are **permanently lost** under an `ok: true` run with a plausible `unresolved` count |
| `cron/allday-resolve-unmapped` | `existing` empty ⇒ **every** resolved edition counted "missing" ⇒ one on-chain `getEditionData` **per id**, each with a delay, then a mass upsert back over rows that were already there — a Cadence storm big enough to blow the route's own `maxDuration` |
| `allday-listings-indexer` | every listing of the tick queued into `listing_resolution_failures`, which the retry drainer then works with real Cadence borrows and a finite retry budget, for rows that were never unresolvable |
| `cron/pinnacle-trades-indexer` | every trade row written with `edition_id: null` — indistinguishable from an uncataloged Pin and **never corrected**, because the upsert is `ignoreDuplicates: true` |

👉 **The fix is the same one line in all four** (`if (error) throw …`), and in three of them it lands on
machinery the route ALREADY documents: an aborted tick leaves the cursor where it was and logs
`ok = false`. **One cycle, nothing lost.**

⭐ **The fifth was deliberately LEFT ALONE, and saying so is the point.**
`wallet-backfill`'s `seeded_wallets.last_refreshed_at` read discards its error too — and there a NaN
sends the wallet down the **full-walk** path: more work, never less, never a wrong answer. It now
carries a comment saying it is deliberate, so the next sweep does not re-derive it. **A rule that cannot
name its own exceptions gets applied mechanically until someone breaks something with it.**

