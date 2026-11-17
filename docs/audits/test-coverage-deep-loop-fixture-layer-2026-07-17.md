# Scoping: deep-loop response-fixture layer (2026-07-17)

Status: **BUILT (Phases 1–3 + the Phase-4 wave below).** Phases 1–3 shipped
2026-07-17 (morning); the same day's coverage-analysis session shipped a fourth
wave applying the layer to the ops-critical routes — see "Phase 4" at the end.

## What is still uncovered, and why the current harness can't reach it

The route-integration harness (`__tests__/helpers/route-harness.ts`) drives a
handler's *pre-loop* logic — guards, dispatch, param math, response shaping — by
stubbing fetch + Supabase with static per-key fixtures. It intentionally does NOT
drive the handlers' **deep loops**, which is where the remaining uncovered lines
live:

- **support-chat** (~2,900 lines): the Anthropic **tool-use loop** — the model
  returns `tool_use` blocks, the route executes one of 23 tools, feeds the result
  back, and loops until `end_turn`. Also the streaming (SSE) variant. Everything
  after the greeting fast-path is this loop.
- **sniper-feed** (~1,590 lines): `computeSniperFeed` — a Top Shot GQL pool fetch
  plus ~18 Supabase resolution seams, feeding a merge → sort → dedup → enrich
  pipeline that emits deals.
- **pack-ev** (~817 lines): the fresh-EV compute — a paginated `packEditionsV3`
  GQL pool + FMV RPCs.
- **indexers / ingest / wallet-backfill**: Flow REST/Cadence cursor scans.

The blocker is the same in every case: the loop only executes if an **upstream
response** (LLM message, GraphQL page, Flow REST payload) comes back in the exact
shape the handler parses. Static per-key fixtures can't express "first call
returns a tool_use, second returns end_turn" or "page 1 has a cursor, page 2
doesn't." The layer below adds **scripted, sequence-aware upstream responses**.

## The layer: two components

### Component A — scripted Anthropic client (`__tests__/helpers/anthropic-fixture.ts`)

Grounds directly on the seam support-chat actually uses
(`app/api/support-chat/route.ts` ~2707–2760):

- non-stream: `anthropic.messages.create(args)` → a `Message` with
  `.stop_reason` (`"tool_use" | "end_turn"`) and `.content` (blocks:
  `{type:"text",text}` / `{type:"tool_use",id,name,input}`).
- stream: `anthropic.messages.stream(args)` → an object exposing
  `.on("text", cb)` and `.finalMessage(): Promise<Message>`.

Proposed API:

```ts
// A script is the ordered list of model turns the route will receive.
type Turn =
  | { tools: Array<{ id?: string; name: string; input: unknown }> } // -> stop_reason "tool_use"
  | { text: string }                                                // -> stop_reason "end_turn"

scriptedAnthropic(script: Turn[]): { default: <AnthropicCtor> }
```

`scriptedAnthropic` returns a `vi.mock("@anthropic-ai/sdk")` factory whose class
yields each `Turn` in order from both `messages.create` and
`messages.stream().finalMessage()` (and replays `text` turns through
`.on("text")` for the streaming assertion). A one-tool script
(`[{tools:[{name:"get_fmv",input:{...}}]}, {text:"FMV is $X"}]`) exercises: the
tool-dispatch switch, the tool's own execution (which hits Supabase — composes
with `makeSupabaseFixture`), the `tool_result` assembly, the second iteration,
and the `end_turn` extraction. Distinct scripts cover multi-tool turns, the
`escalate_to_human` path, `MAX_ITERATIONS` exhaustion, and the streaming SSE
frames.

### Component B — sequence-aware upstream + Supabase fixtures (extend `route-harness.ts`)

1. `gqlRoute(operationName, response | response[])` — a `FetchStub` that matches
   on the GraphQL request body's `operationName` (parse `init.body`) rather than
   URL substring, and, given an array, returns a different page per call. Unblocks
   the `packEditionsV3` / `searchMarketplaceEditions` pagination loops.
2. `makeSupabaseFixture` **matcher mode** — today it keys only by table name, so
   two different queries on the same table return the same rows. Add an optional
   matcher form: `makeSupabaseFixture([{ table, selectIncludes?, eq?, respond }])`
   so `sniper-feed`'s many `editions` reads (edition-key resolve vs FMV join vs
   badge join) can each return their own shape. Back-compat: the existing
   `{table: fixture}` object form stays.

## Per-route application (the coverage work, gated behind the layer)

| Route | What the layer unlocks | Effort | Est. aggregate Δ |
|---|---|---|---|
| support-chat tool loop | tool dispatch (spot-check 3–4 of 23 tools) + escalation + MAX_ITERATIONS + streaming | ~1–2 days | biggest single file; ~+1.5–2.5 pts |
| sniper-feed compute | one TS deal through pool→merge→sort→dedup→enrich | ~1 day | ~+0.5–1 pt |
| pack-ev fresh compute | GQL pool pagination + EV assembly | ~1 day | ~+0.5 pt |
| indexers / ingest | Flow REST cursor scans | — | **skip** (see non-goals) |

Phasing (each independently shippable, CI-green, ratchet-bumped):

- **Phase 1 — Anthropic scripted stub + support-chat tool loop. ✅ BUILT
  (`f74cad25`, 2026-07-17).** `__tests__/helpers/anthropic-fixture.ts`
  (`buildAnthropicClass`) + `__tests__/api-support-chat-tool-loop.test.ts`. Drives
  the real loop (dispatch/iteration/escalation/MAX_ITERATIONS); support-chat route
  11%→22.6%. Highest value, most self-contained (Component A only).
- **Phase 2 — Component B + sniper-feed compute. ✅ BUILT (`5cd03ca0`,
  2026-07-17).** Component B landed (`gqlRoute`, sequence-aware fixtures,
  proper-thenable builder). Discovery: sniper-feed's TS pool is Supabase-sourced
  (`ts_listings`), not a live GQL fetch, so `makeSupabaseFixture` alone drives the
  real `computeSniperFeed` end-to-end (`api-sniper-feed-compute.test.ts`); route
  9%→48.2%. `gqlRoute` remains for Phase 3's actual GQL pagination.
- **Phase 3 — pack-ev fresh compute. ✅ BUILT (`88135040`, 2026-07-17).** The
  payoff for `gqlRoute`: pack-ev's fresh compute is a real TopShot GQL fan-out, so
  `gqlRoute` drives `PACK_DYNAMIC_QUERY` + paginated `packEditionsV3` + the EV loop
  (`api-pack-ev-compute.test.ts`); route 18%→69%. **All three phases built.**

## Risks and the guardrail

- **Fragility.** Sequence-aware fixtures couple to the handler's internal call
  order; a refactor that reorders calls breaks the test. Mitigate by asserting on
  the *response contract* (final JSON shape, escalation flag, tool-used list), not
  on intermediate call counts, wherever possible.
- **Asserting on scaffolding.** The real hazard: a scripted-model test can pass
  while proving nothing about production behavior if it just echoes the fixture.
  Every deep-loop test must assert something the *handler* computes from the
  upstream response (a tool result merged into the answer, a deal's discount, a
  paginated pool total) — never just that the fixture came back.
- **Streaming SSE** is the finickiest surface; keep those tests to a couple of
  smoke-level frame assertions, not exhaustive.
- **Maintenance cost** rises with each sequence-coupled test. Keep the count
  deliberate — cover the loop's *branches* (tool_use, end_turn, escalate, max-iter,
  error-classify), not every tool.

## Non-goals

- **100% coverage** — still not achievable or meaningful; the config note stands.
- **Indexer / ingest / wallet-backfill deep coverage** — Flow REST cursor scans
  with low product-logic density; the ROI is poor and they're the config's
  designated expected-low set. Explicitly out of scope.
- **Exhaustive per-tool coverage** in support-chat — spot-check a representative
  few (a read tool like `get_fmv`, a wallet tool, `escalate_to_human`); the tool
  bodies themselves are better covered by their own `lib/**` unit tests.

## Phase 4 — ops-critical rollout (BUILT, 2026-07-17 coverage-analysis session)

The layer applied beyond the original three flagships, prioritized by
incident-consequence rather than raw size:

- **Harness additions** (`__tests__/helpers/route-harness.ts`):
  `makeInstrumentedSupabaseFixture` — records every `rpc(name, args)` call and
  per-table insert/upsert/update payload, with `failWrites` to throw from a
  table's write methods (drives fatal-catch paths). The anthropic fixture gained
  an `{ error: {...} }` script turn so a model call can REJECT mid-loop (drives
  `classifyAnthropicError` in both stream and non-stream paths).
- **fmv-recalc deferred sweep** (`api-fmv-recalc-deep-loop.test.ts`, route
  6.5%→63.9% lines): captures the `after()` callback and drives the full sweep —
  happy-path pricing (WAP/confidence/insert shape), the grail-dampener and
  mis-key guards as business-logic assertions, and the 2026-05-25 incident
  class: EVERY exit path (step1a fail, empty-page wrap, step1b saturation,
  step3 purge fail + retry, fatal throw) must write its `log_pipeline_run` row.
- **sentinel** (`api-sentinel-deep.test.ts`, 14.5%→86.1% lines): full check battery via
  a `createClient` mock; pins the saturation/empty-error inconclusive
  classification (the 2026-06-10 + 2026-07-16 false-CRITICAL pages), the
  silent-alert-failure guard (`telegram-FAILED`), config threshold overrides,
  and disabled-check neutralization.
- **check-alerts** (`api-check-alerts-deep.test.ts`, 12.5%→88.3% lines): debounce
  stamp/skip, all-channels-failed does NOT stamp (retry next tick), FMV-alert
  cooldown vs fresh-send, and the 2026-06-11 fatal-catch logging class.
- **wallet-search** (`api-wallet-search-deep.test.ts`, 27%→79.0% lines): the real
  enrichment body via fcl/topshotGraphql/Supabase stubs — row assembly from two
  upstream sources, edition-scope ownership counts, the cached-listings ask
  override, the >$10K FMV sanity ceiling (both arms), pagination, per-moment
  degradation, and error mapping.
- **support-chat streaming** (`api-support-chat-streaming.test.ts`): smoke-level
  frame assertions per this doc's guardrail — text chunks + `\x1e` meta trailer,
  escalation through the trailer, and the mid-stream model-failure canned
  message with a guaranteed close.
- **Zero-coverage stragglers**: `api-admin-bridges.test.ts` (decode-tx /
  pinnacle-render-cache-fill / allday-unmapped-fill guards + happy paths) and
  `lib-stripe.test.ts`.

**Phase 5 — sales-indexer family deep-drive (BUILT, same session, follow-up
wave).** The four live sales indexers are now driven end-to-end with fixtures in
the exact encodings their seams serve (test-only; the routes are untouched):

- `__tests__/helpers/flow-cdc-fixture.ts` — JSON-CDC event/script-result
  builders (base64-typed payloads exactly as Flow REST serves them), so the
  routes' inline `unwrapCdc` / `extractNftTypeId` decode paths run unmodified.
- **allday-sales-indexer** (8.1%→78.9%): V2 Dapper happy path (wmc edition+serial,
  tx-decoded buyer, venue/source tags, cursor advance), non-AllDay + cancellation
  filtering, V1 reduced-payload enrichment (cached_listings_v2 price + borrow
  fallback + `nft_edition_map`/hydrate writes), the price-UNCERTAIN V1 rule
  (never lands in `sales`; goes to unmapped with the extraction hint), the
  unresolvable→unmapped path, already-up-to-date, and the fatal exit.
- **sales-indexer (TopShot)** (7.5%→80.5%): the resolution ladder — wmc (4a),
  canonical-guarded moments (4b, pins the **UUID-dupe drop rule**), GQL int-pair
  fallback + `ensure_topshot_edition_stub` self-heal (4d), and the **F9 parallel
  split guard** (confirmed parallel redirected onto its ::subID edition) —
  plus tx buyer/exec decode, no-events cursor advance, and the fatal exit.
- **golazos + ufc indexers** (9.4%→54.1% / 11.6%→53.4%): per-collection
  venue-tag + NFT-type-filter happy paths (the copy-paste-drift constants).
  Aggregate after Phase 5: **50.41 stmts / 41.13 branch / 58.15 funcs / 52.59
  lines** (3,701 tests).

## Phase 6 — remaining-family sweep (BUILT, same session, final wave)

Everything queued after Phase 5 landed in one parallel wave (three subagents on
the route families + interactive work on the rest; all test-only):

- **History backfills**: topshot-sales-history-backfill 16.3%→90.1% lines
  (synthetic tx-hash dedup, Phase-4 parallel redirect, play-uuid ladder,
  attempt-freeze after 4 GQL failures), allday-sales-history-backfill
  36%→87% (venue classification, backward cursor, spork-floor short-circuit,
  price-uncertain → unmapped). Discovery: the AllDay history route chains
  fmv-recalc even on a fatal run (drift vs the forward indexer, pinned as-is).
- **Listings indexers**: allday-listings-indexer 11.3%→94.2% (V1/V2 pricing +
  currency derivation, completion accounting, resolution-failure queueing,
  Sentry spike-page gating), golazos 81.8% / ufc 74.6%. Discovery: the lean
  Golazos/UFC siblings write unresolved listings with edition_id NULL instead
  of queueing failures — a real divergence, pinned explicitly.
- **smoke-test** 9%→78.1%: the full 52-check battery driven end-to-end —
  green envelope, genuine needle-absence HARD fail, the 2026-07-16
  streamed-abort inconclusive class THROUGH the route, transient-retry
  classes, the health-RPC vs security-guard retry asymmetry, RLS-regression
  paging. (The route has no auth guard of its own — proxy.ts gates the path;
  the outbound bearer-injection contract is pinned instead.)
- **ingest** 5.1%→85.8%: the mis-attribution writer rules — full column
  contract on the int-pair path, the Item-B UUID→int hydrate redirect, the
  HARD canonical guard (chain-resolve or SKIP, never a UUID-dupe write, with
  the ingest-canonical-guard telemetry), and flag-gated subedition keying
  (base circ never written onto a ::subID row).
- **badge-sync** 14%→92.5%: parallels merge into one int-pair row with union
  badges, sets-table-bridge keying, badge_score/three-star derivation, the
  re-key-safe delete-then-upsert, catalog-mode cursor wrap + resume-on-error.
- **cache-refresh** 11.9%→76.1%: on-chain diff → 3-column-conflict stubs,
  unknown-acquisition seeding that never clobbers real attribution, the May-9
  canonical-key preference, refreshLocked backfill.
- **allday-sets** 11.6%→83.6%: the completion math (owned/missing split,
  totalMissingCost gating, tier classification), username resolution.
- **seed-wallet-refresh** 20.6%→81.7%: dispatch policy (skip_cached vs forced
  full walk on truncation signatures, low-priority interval gate, cohorts).
- **offers-sweep** 12.5%→89.6%: the 2026-07-07 parallel-keying contract
  (unmapped parallels SKIPPED, never blended), best-of-dupes accumulation,
  cursor wrap-vs-resume, partial-harvest-on-error honesty.
- **pack-events-ingest WORKER** (`worker-pack-events-ingest.test.ts`, outside
  the coverage include — functional safety, not ratchet): the event_kind
  classifier driven through the real fetch handler — secondary_sale pairing +
  DUC derivation, primary_withdraw contract-reserve rule, the
  no-deposit-no-sale rule, cursor advance. First test coverage on any of the
  15 Cloudflare workers.
- **Component spot-fills** (jsdom layer): PackTable (B6 rarity-ranked tier
  sort incl. UFC mapping, null-sink sort rule), MomentDetailModal (Moment-V3
  a11y: dialog role, Escape/backdrop close, flowty CTA suppression),
  GrailsView (at-least-once probability math, error/empty envelopes).

Aggregate after Phase 6: **56.63 stmts / 45.71 branch / 65.2 funcs / 58.86
lines** (3,806 tests).

With Phase 6 the deep-loop program is complete for every family identified in
the 2026-07-17 coverage analysis. Remaining low-coverage routes are the
long-tail (~80-line cron utilities and admin tools) where guard tests already
exist and marginal ROI is low.

## Definition of done (per phase)

1. New helper(s) added under `__tests__/helpers/` (no `.test.` in the name).
2. Deep-loop tests assert on handler-computed output, not fixture echo.
3. `npm run test:coverage` green; ratchet raised to just-below the new actual with
   the ~0.2 concurrent-churn buffer.
4. Ledger entry with revert path; this doc updated to mark the phase BUILT.
