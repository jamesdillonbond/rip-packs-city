# Scoping: deep-loop response-fixture layer (2026-07-17)

Status: **SCOPED, NOT BUILT.** This is the one remaining lever for pushing route
coverage past the current ~44.7% — it drives the parts of the flagship handlers
that the existing route-integration harness deliberately stops short of. Nothing
here is implemented yet; this doc is the design + phasing + effort estimate so the
work can be greenlit (or declined) deliberately.

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
- **Phase 2 — Component B + sniper-feed compute.** The flagship GQL-fan-out.
- **Phase 3 — pack-ev fresh compute.** Reuses Phase 2's `gqlRoute`.

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

## Definition of done (per phase)

1. New helper(s) added under `__tests__/helpers/` (no `.test.` in the name).
2. Deep-loop tests assert on handler-computed output, not fixture echo.
3. `npm run test:coverage` green; ratchet raised to just-below the new actual with
   the ~0.2 concurrent-churn buffer.
4. Ledger entry with revert path; this doc updated to mark the phase BUILT.
