# Route-integration test harness + coverage strategy (2026-07-16)

## Where unit coverage stands

`npm run test:coverage` baseline (2026-07-16): **stmts 43.8 / branch 36.1 / funcs 51.5 / lines 45.9** across `lib/**` + `app/api/**/route.ts`.

Two layers are in good shape and mostly done:

- **`lib/**` pure logic — ~89% stmts.** The pricing/selection cores are extracted and unit-tested: `computeDualPrice` + `bestPrice` + `serialPremiumLabel` (`lib/pack-ev-pricing`), the sniper-feed helpers (`lib/sniper/feed-helpers`), `selectCrossMarketFloor` (`lib/cross-market-floor`), and the edge-fn cores in `supabase/functions/_shared` (`editionExtKey` / `normalizeTier` / `mergePackPoolNodes`).
- **Documented footguns — all guarded** by `__tests__/invariants-*.test.ts` (collection-vocab, confidence-enum, fmv-recalc-chunking, max-duration) + `scripts/check-brand-tokens.mjs` in CI.

## The remaining gap is route *bodies*, not helpers

Most `app/api/**/route.ts` handlers sit at 10–40% line coverage. That is **expected and by design** (see the note in `vitest.config.ts`): their bodies are live TopShot/AllDay/Flowty GraphQL fan-outs, Flow REST/Cadence scans, and SSE streams that the guard-only tests can't drive. Squeezing the number by extracting ever-smaller helpers has reached diminishing returns.

The real lever is a **route-integration tier**: drive the actual handler through its two external seams — `global.fetch` and the Supabase client — with declarative fixtures, and assert on the response the handler produces.

## The harness (`__tests__/helpers/route-harness.ts`)

Makes both seams declarative so a new route test is fixtures, not bespoke mocking:

- `installFetchMock([...stubs])` — replaces `global.fetch`; dispatches by matcher; **an unmatched request throws** (a test can never silently hit the network or pass on an unexpected call). Returns `{ calls, restore }` so you can assert exactly which venues were hit.
- `jsonRoute(urlSubstring, json, { status })` — the common stub: match by URL substring, return JSON.
- `makeSupabaseFixture({ table: { data, error }, "rpc:name": {...} })` — chainable Supabase stub resolving to per-table fixtures (promoted from the ad-hoc builder in `api-fmv.test.ts`).

### Worked proof-of-concept: `api-edition-floor-integration.test.ts`

`GET/POST /api/edition-floor` (non-persist) resolve each edition through exactly two fetches (Top Shot GQL + Flowty) and no Supabase — a clean, bounded body. The POC stubs those two venues and asserts the real cross-market merge: TS-vs-Flowty floor selection, source attribution, the LiveToken FMV passthrough, per-venue error degradation, and the batch POST path. This drives `resolveEditionFloor` / `fetchTopShotFloor` / `fetchFlowtyFloor` / `selectCrossMarketFloor` + the GET/POST orchestration — the body the guard-only test never reached.

## Prioritized routes for this tier (highest value first)

Each is a flagship, low-coverage, business-critical handler. Fan-out counts are the mocking surface (`fetch` + Supabase seams):

1. **`sniper-feed`** (~9%) — flagship deal-finder. Largest surface (~18 Supabase seams + GQL); mock the TS pool + resolution seams to drive one deal through merge→sort→dedup. Highest value, most work.
2. **`pack-ev`** (~18%) — pack EV. GQL pool + a few RPCs; the pricing helpers are already unit-tested, so the integration test covers the orchestration + pool assembly.
3. **`fmv-recalc`** (~5%) — the silent-stall incident route. The chunking invariant already guards the regression; an integration test would cover the recompute orchestration.
4. **`support-chat`** (~8%) — concierge tool routing. Mock the Anthropic + tool seams.
5. **`market-feed` / `market-analytics` / `wallet-search`** (24–29%) — mid-size bodies, good ROI.

## What is explicitly NOT worth doing

- Forcing more `lib/**` extraction — the pure cores are done.
- Hand-wiring per-route mocks without the harness — that is the fragility trap; use `installFetchMock` / `makeSupabaseFixture`.
- Wiring the edge `compute-*-pack-ev` functions to import the `_shared` extractions — that needs a Deno edge deploy (verify_jwt reset hazard) and is unverifiable without a Deno toolchain. Queued in the ledger, gated on sign-off.

## Ratchet discipline (learned this session)

On this multi-session repo (Cowork + night pass + CC all pushing), keep a **~0.1–0.2 buffer** below actual in `vitest.config.ts` thresholds. A near-zero-margin bump was reddened by a concurrent feature merge adding uncovered code (`af087a5c`); the fix was to re-baseline with buffer, not to chase every 0.01. Raise as coverage climbs, never lower to green a build, but leave headroom for concurrent churn.
