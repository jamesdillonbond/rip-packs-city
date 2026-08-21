// ⚠ THE HTTP PATH OF THE CURSOR HOLD, DRIVEN THROUGH EVERY BLOCK-SCAN INDEXER.
//
// WHAT THIS EXISTS TO PREVENT (measured 2026-08-21, not hypothesised). Each of
// these routes scans Flow in 250-block chunks and, when a chunk fails, caps the
// cursor at `firstFailedChunkStart - 1` so the failed range is re-scanned next
// tick. That cap is driven by the chunk loop's `catch`, which only ever sees
// THROWN errors. Every one of these routes' `fetchEventRange` used to swallow a
// non-2xx into `return []` — so an upstream HTTP 500 read as a chunk that was
// GENUINELY EMPTY, the cap never fired, and the cursor advanced past blocks
// nothing had read. Nothing revisits a block below the cursor, so those sales
// and listings were lost PERMANENTLY, behind a clean `ok: true` run with no
// `partial_scan` flag. 7 of the 8 indexers in the family shared the swallow.
//
// ⚠ WHY THE EXISTING PER-ROUTE TESTS COULD NOT CATCH IT, which is the durable
// lesson: every cursor-hold test in this repo simulated chunk failure by
// THROWING (ECONNRESET) — the path that already worked. "The chunk failed" and
// "the chunk threw" were different sets, and the whole family was blind to the
// difference by construction. This file drives the OTHER member of that set.
//
// It is deliberately table-driven over the routes rather than bespoke per route:
// the defect spread by copy-paste across seven files, so the regression has to be
// asserted at the population, not at one instance. `__tests__/indexer-cursor-hold-
// on-partial-scan-guard.test.ts` bans the swallow in SOURCE; this proves the
// behaviour it is standing in for is really there.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
  type FetchStub,
  type RecordedRpcCall,
} from "./helpers/route-harness"

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sb: null as unknown,
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (cb: () => unknown) => void state.afterCbs.push(cb) }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))
vi.mock("@/lib/pipeline-chain", () => ({ fireNextPipelineStep: async () => {} }))
vi.mock("@/lib/chains/flow/dapper-v1-tx-decode", () => ({
  decodeV1SaleTx: async () => ({
    buyer: null,
    seller: null,
    priceDuc: null,
    priceCertain: false,
    priceReason: "no_duc_transfer",
    sampleAmounts: [],
  }),
}))

process.env.INGEST_SECRET_TOKEN = "hold-token"

const routes = {
  "allday-listings-indexer": await import("@/app/api/allday-listings-indexer/route"),
  "allday-sales-indexer": await import("@/app/api/allday-sales-indexer/route"),
  "golazos-listings-indexer": await import("@/app/api/golazos-listings-indexer/route"),
  "golazos-sales-indexer": await import("@/app/api/golazos-sales-indexer/route"),
  "topshot-listings-indexer": await import("@/app/api/topshot-listings-indexer/route"),
  "ufc-listings-indexer": await import("@/app/api/ufc-listings-indexer/route"),
  "ufc-sales-indexer": await import("@/app/api/ufc-sales-indexer/route"),
} as const

type RouteName = keyof typeof routes

// ⚠ A SECOND FAMILY, FOUND THE SAME DAY AND ONLY BECAUSE A TEST NAME GAVE IT
// AWAY. The three offers indexers carry the identical swallow, but they were
// invisible to the source guard, which derives its population from
// `firstFailedChunkStart` — a symbol these routes do not contain, because they
// have no per-chunk cursor hold at all. The guard's own derivation put them
// outside its blast radius by construction, exactly the shape CLAUDE.md records
// for the anon driver-message guard.
//
// Their correct behaviour is DIFFERENT from the seven above, so they get their
// own assertions rather than being bolted onto the table. The whole scan sits
// inside one try/catch and the cursor update is the last step after the loop,
// so a thrown error aborts the tick with the cursor UNTOUCHED and ok=false.
// There is no partial_scan to check because there is no partial progress to
// report — the tick simply re-runs the range next time.
const offersRoutes = {
  "allday-offers-indexer": await import("@/app/api/allday-offers-indexer/route"),
  "golazos-offers-indexer": await import("@/app/api/golazos-offers-indexer/route"),
  "topshot-offers-indexer": await import("@/app/api/topshot-offers-indexer/route"),
} as const

type OffersRouteName = keyof typeof offersRoutes

// Sealed tip 1500 with the cursor at 750 gives exactly three 250-block chunks:
// 751-1000 (ok), 1001-1250 (HTTP 500), 1251-1500 (ok). The THIRD chunk is what
// makes this a real test: a route that merely stopped at the first failure would
// also pass with two chunks, but here a later SUCCESS must not lift the cursor
// back over the hole. 1000 is the only correct answer — 1250 (last failed chunk)
// and 1500 (sealed tip) are both silent data loss.
const SEALED = 1500
const CURSOR_START = 750
const FAILED_CHUNK_START = 1001
const EXPECTED_HOLD = 1000

function stubs(): FetchStub[] {
  return [
    jsonRoute("blocks?height=sealed", [{ header: { height: String(SEALED) } }]),
    // ⚠ The failure is an HTTP status, NOT a thrown network error. `ok:false`
    // with a body is exactly what a Flow access node returns when it is
    // overloaded, and it is the shape that used to be swallowed. Matching on
    // `start_height=1001` alone covers every event type the route asks for in
    // that chunk, so the chunk fails whichever stream it reaches first.
    {
      match: (u: string) => u.includes(`start_height=${FAILED_CHUNK_START}`),
      respond: () => ({ status: 500, ok: false, json: {}, text: "upstream overloaded" }),
    },
    jsonRoute("/v1/scripts", { value: "" }),
    jsonRoute("/v1/transactions/", { proposal_key: null, authorizers: [], payer: null }),
    // Every other chunk reads clean and EMPTY. That is the point: an empty chunk
    // and a failed chunk must not be the same thing to the cursor.
    jsonRoute("/v1/events", []),
  ]
}

function install() {
  const spy = makeInstrumentedSupabaseFixture({
    event_cursor: { data: { last_processed_block: CURSOR_START }, error: null },
    wallet_moments_cache: { data: [], error: null },
    editions: { data: [], error: null },
    sales: { data: null, error: null },
    listings: { data: null, error: null },
  })
  state.sb = spy.fixture
  return spy
}

function req(name: RouteName): NextRequest {
  return new NextRequest(`https://t/api/${name}`, {
    method: "POST",
    headers: new Headers({ authorization: "Bearer hold-token" }),
  })
}

async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) await cb()
}

function terminalLog(rpcCalls: RecordedRpcCall[], pipeline: string) {
  return rpcCalls
    .filter((c) => c.name === "log_pipeline_run" && c.args?.p_pipeline === pipeline)
    .at(-1)?.args
}

// Every cursor value the run wrote, in order. ⚠ Read ALL of them, not just the
// last: `ufc-sales-indexer` advances the cursor PER CHUNK inside the loop while
// its siblings write once at the end, so "the final value is 1000" and "the
// cursor never passed 1000" are different claims and only the second is the
// property that protects the data.
function cursorWrites(writes: Record<string, { rows: Record<string, unknown>[] }[]>): number[] {
  return (writes.event_cursor ?? [])
    .flatMap((w) => w.rows)
    .map((r) => r.last_processed_block)
    .filter((v): v is number => typeof v === "number")
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "hold-token"
  state.afterCbs.length = 0
})

describe("an upstream HTTP error holds the block cursor in every block-scan indexer", () => {
  // A no-slack membership assertion: this suite is only coverage of the
  // POPULATION if the population is what the fix touched. A new indexer added to
  // the family without a case here would otherwise leave this file reading as
  // complete while the new route carried the swallow.
  it("covers all 7 routes the 2026-08-21 fix touched", () => {
    expect(Object.keys(routes).sort()).toEqual([
      "allday-listings-indexer",
      "allday-sales-indexer",
      "golazos-listings-indexer",
      "golazos-sales-indexer",
      "topshot-listings-indexer",
      "ufc-listings-indexer",
      "ufc-sales-indexer",
    ])
  })

  for (const name of Object.keys(routes) as RouteName[]) {
    it(`${name}: an HTTP 500 on chunk 1001-1250 holds the cursor at 1000`, async () => {
      fetchMock = installFetchMock(stubs())
      const spy = install()

      const res = await routes[name].POST(req(name))
      expect(res.status).toBe(200)
      await runDeferred()

      const written = cursorWrites(spy.writes)

      // ⚠ THE ASSERTION THAT PROTECTS THE DATA, stated as an ABSENCE. Not "the
      // final cursor is 1000" — "no write ever put the cursor past 1000". A
      // route that advanced to 1500 and then corrected itself would still have
      // skipped the range on a tick that died mid-run.
      expect(
        written.filter((v) => v > EXPECTED_HOLD),
        `${name} advanced the cursor past the failed chunk — blocks ${FAILED_CHUNK_START}-1250 would never be re-scanned`,
      ).toEqual([])

      // And it must actually WRITE the hold, rather than pass the check above by
      // writing nothing at all — a route that crashed before touching the cursor
      // would satisfy an absence-only assertion vacuously.
      expect(
        written.at(-1),
        `${name} must persist the held cursor, not skip the write entirely`,
      ).toBe(EXPECTED_HOLD)

      // ⚠ And it must be REPORTED as partial. If the hold works but the run logs
      // a clean full scan, no operator ever learns the range was short — the
      // failure becomes unfalsifiable, which is the honesty canon's worst shape.
      const extra = terminalLog(spy.rpcCalls, name)?.p_extra as Record<string, unknown> | undefined
      expect(extra?.partial_scan, `${name} must flag the run partial`).toBe(true)
      expect(extra?.first_failed_chunk, `${name} must name the failed chunk`).toBe(
        FAILED_CHUNK_START,
      )
    })
  }
})

describe("an upstream HTTP error aborts the tick in the offers indexers", () => {
  it("covers all 3 offers indexers", () => {
    expect(Object.keys(offersRoutes).sort()).toEqual([
      "allday-offers-indexer",
      "golazos-offers-indexer",
      "topshot-offers-indexer",
    ])
  })

  for (const name of Object.keys(offersRoutes) as OffersRouteName[]) {
    it(`${name}: an HTTP 500 leaves the cursor untouched and reports the failure`, async () => {
      fetchMock = installFetchMock(stubs())
      const spy = install()

      const res = await offersRoutes[name].POST(
        new NextRequest(`https://t/api/${name}`, {
          method: "POST",
          headers: new Headers({ authorization: "Bearer hold-token" }),
        }),
      )
      const body = (await res.json()) as { ok?: boolean; error?: unknown }
      await runDeferred()

      // ⚠ Stated as an ABSENCE. These routes have no hold expression to check —
      // the protection IS that the cursor write never happens, so asserting a
      // value would miss the case where it is written at all.
      expect(
        cursorWrites(spy.writes),
        `${name} advanced the cursor over a range it failed to read — those offers are gone`,
      ).toEqual([])

      // ⚠ And it must not report success. ok:true with zero offers is
      // indistinguishable from a genuinely quiet range, which is what made this
      // class unfalsifiable for as long as it survived.
      expect(body.ok, `${name} must not report a failed read as a clean tick`).toBe(false)
      expect(String(body.error ?? ""), `${name} must name the HTTP failure`).toMatch(/HTTP 500/)
    })
  }
})
