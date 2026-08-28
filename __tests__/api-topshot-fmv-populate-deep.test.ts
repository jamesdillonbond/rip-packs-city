import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  gqlRoute,
  type FetchStub,
} from "./helpers/route-harness"

// Deep-drive of /api/topshot-fmv-populate — the cursor-paginated Top Shot
// marketplace FMV sweep. Captures after() and drives the real runSweep body
// through GQL page fixtures + the Supabase seam. Pins:
//   - the setUUID -> set_id_onchain resolution and the exact
//     upsert_topshot_marketplace_fmv row contract (numeric coercions, null
//     lowAsk/avg, salesCount default 0, unresolved-set skip accounting);
//   - cursor mechanics: resume from backfill_state, per-page persist, wrap to
//     "" with status=complete on feed exhaustion, repeated-cursor stall
//     detection;
//   - honest termination: gql/http errors and RPC failures produce ok=false
//     pipeline_runs rows with the pending cursor preserved;
//   - the sets-read failure short-circuit and the after() fatal catch.

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

// TOKEN is read into a module const at import time.
process.env.INGEST_SECRET_TOKEN = "fmv-token"

const { POST } = await import("@/app/api/topshot-fmv-populate/route")

const SET_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"
const SET_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"
const SET_UNKNOWN = "cccccccc-3333-4333-8333-cccccccccccc"
const PLAY = "dddddddd-4444-4444-8444-dddddddddddd"

type Node = {
  id: string
  lowAsk?: number | string | null
  salesCount?: number | string | null
  play?: { flowID?: number | string | null }
  averageSaleData?: { averagePrice?: number | string | null } | null
}

function node(setUuid: string, over: Partial<Node> = {}): Node {
  return {
    id: `${setUuid}+${PLAY}+1`,
    lowAsk: "12.5",
    salesCount: "7",
    play: { flowID: "2634" },
    averageSaleData: { averagePrice: "10.1" },
    ...over,
  }
}

function page(nodes: Node[], rightCursor: string | null) {
  return {
    data: {
      searchMarketplaceEditions: {
        data: {
          searchSummary: {
            pagination: { rightCursor },
            data: { data: nodes },
          },
        },
      },
    },
  }
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture({
    sets: {
      data: [
        { external_id: SET_A, set_id_onchain: 12 },
        { external_id: SET_B, set_id_onchain: 34 },
        { external_id: "not-a-uuid", set_id_onchain: 99 }, // must be ignored
      ],
      error: null,
    },
    backfill_state: [{ data: { cursor: "" }, error: null }, { data: null, error: null }],
    "rpc:upsert_topshot_marketplace_fmv": {
      data: [{ upserted: 2, skipped: 0, no_edition: 0 }],
      error: null,
    },
    ...fixtures,
  })
  state.sb = spy.fixture
  return spy
}

function req(auth: string | null = "Bearer fmv-token"): NextRequest {
  const headers = new Headers()
  if (auth !== null) headers.set("authorization", auth)
  return new NextRequest("https://t/api/topshot-fmv-populate", { method: "POST", headers })
}

async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) await cb()
}

function pipelineInsert(spy: ReturnType<typeof install>) {
  return (spy.writes.pipeline_runs ?? []).flatMap((w) => w.rows).at(-1)
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "fmv-token"
  process.env.TS_PROXY_URL = "https://ts-proxy.test/graphql"
  process.env.TS_PROXY_SECRET = "proxy-secret"
  state.afterCbs.length = 0
})

describe("topshot-fmv-populate — sweep happy path", () => {
  it("paginates to exhaustion, maps setUUIDs on-chain, writes the exact RPC rows, and wraps the cursor", async () => {
    fetchMock = installFetchMock([
      gqlRoute("TopshotMarketplaceFmv", [
        // Page 1: one resolvable node + one whose setUUID has no on-chain map.
        page([node(SET_A), node(SET_UNKNOWN)], "c2"),
        // Page 2: null lowAsk / missing sales -> null/0 coercions; feed ends.
        page([node(SET_B, { lowAsk: null, salesCount: null, averageSaleData: null })], null),
      ]),
    ])
    const spy = install({})

    const res = await POST(req())
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({ accepted: true, pipeline: "topshot-fmv-populate" })
    await runDeferred()

    // Both pages requested through the proxy with the mandatory stable sort.
    expect(fetchMock.calls).toHaveLength(2)
    const body1 = JSON.parse(String(fetchMock.calls[0].init?.body))
    expect(body1.variables.input.sortBy).toBe("UPDATED_AT_DESC")
    expect(body1.variables.input.searchInput.pagination).toEqual({
      cursor: "",
      direction: "RIGHT",
      limit: 100,
    })
    expect((fetchMock.calls[0].init?.headers as Record<string, string>)["X-Proxy-Secret"]).toBe("proxy-secret")
    const body2 = JSON.parse(String(fetchMock.calls[1].init?.body))
    expect(body2.variables.input.searchInput.pagination.cursor).toBe("c2")

    // One final flush with the handler-computed rows (unresolved set dropped).
    const rpc = spy.rpcCalls.filter((c) => c.name === "upsert_topshot_marketplace_fmv")
    expect(rpc).toHaveLength(1)
    expect(rpc[0].args?.p_rows).toEqual([
      { set_id_onchain: 12, play_id_onchain: 2634, lowest_ask: 12.5, average_price: 10.1, total_sales: 7 },
      { set_id_onchain: 34, play_id_onchain: 2634, lowest_ask: null, average_price: null, total_sales: 0 },
    ])

    // Cursor persisted per page, then wrapped to "" complete at end of feed.
    const stateUpdates = (spy.writes.backfill_state ?? []).flatMap((w) => w.rows)
    expect(stateUpdates).toHaveLength(2)
    expect(stateUpdates[0]).toMatchObject({ cursor: "c2", status: "pending" })
    expect(stateUpdates[1]).toMatchObject({ cursor: "", status: "complete" })

    const run = pipelineInsert(spy)
    expect(run).toMatchObject({
      pipeline: "topshot-fmv-populate",
      collection_slug: "nba_top_shot",
      ok: true,
      rows_found: 3,
      rows_written: 2,
      rows_skipped: 0,
      cursor_before: null, // empty start
      cursor_after: null, // wrapped
      error: null,
    })
    expect(run?.extra).toMatchObject({
      pages_fetched: 2,
      nodes_fetched: 3,
      upserted: 2,
      unresolved_set: 1,
      sweep_complete: true,
      terminated_reason: "feed_exhausted",
      sets_mapped: 2, // the non-uuid sets row was ignored
    })
  })

  it("detects an upstream cursor stall (repeated rightCursor) as end-of-feed", async () => {
    fetchMock = installFetchMock([
      gqlRoute("TopshotMarketplaceFmv", [
        page([node(SET_A)], "cX"),
        page([node(SET_B)], "cX"), // same cursor again -> stall
      ]),
    ])
    const spy = install({})

    await POST(req())
    await runDeferred()

    expect(fetchMock.calls).toHaveLength(2)
    const run = pipelineInsert(spy)
    expect(run).toMatchObject({ ok: true, cursor_after: null })
    expect(run?.extra).toMatchObject({
      pages_fetched: 2,
      nodes_fetched: 2,
      sweep_complete: true,
      terminated_reason: "feed_exhausted",
    })
  })
})

describe("topshot-fmv-populate — honest termination", () => {
  it("resumes from the stored cursor and a GQL error preserves it as pending", async () => {
    fetchMock = installFetchMock([
      gqlRoute("TopshotMarketplaceFmv", [{ errors: [{ message: "upstream sadness" }] }]),
    ])
    const spy = install({
      backfill_state: [{ data: { cursor: "resume-c" }, error: null }, { data: null, error: null }],
    })

    await POST(req())
    await runDeferred()

    // Resumed from the persisted cursor.
    const body1 = JSON.parse(String(fetchMock.calls[0].init?.body))
    expect(body1.variables.input.searchInput.pagination.cursor).toBe("resume-c")

    const run = pipelineInsert(spy)
    expect(run).toMatchObject({
      ok: false,
      rows_found: 0,
      cursor_before: "resume-c",
      cursor_after: "resume-c", // NOT wrapped — the sweep did not complete
    })
    expect(String(run?.error)).toContain("upstream sadness")
    expect(run?.extra).toMatchObject({ pages_fetched: 0, terminated_reason: "gql_error" })
    const finalState = (spy.writes.backfill_state ?? []).flatMap((w) => w.rows).at(-1)
    expect(finalState).toMatchObject({ cursor: "resume-c", status: "pending" })
  })

  it("an HTTP-level proxy failure is captured as the gql error", async () => {
    const http500: FetchStub = {
      match: (url) => url.includes("ts-proxy.test"),
      respond: () => ({ status: 500, text: "cf blocked" }),
    }
    fetchMock = installFetchMock([http500])
    const spy = install({})

    await POST(req())
    await runDeferred()

    const run = pipelineInsert(spy)
    expect(run?.ok).toBe(false)
    expect(String(run?.error)).toContain("http 500: cf blocked")
  })

  it("an RPC failure on the final flush yields ok=false with zero upserted", async () => {
    fetchMock = installFetchMock([
      gqlRoute("TopshotMarketplaceFmv", [page([node(SET_A)], null)]),
    ])
    const spy = install({
      "rpc:upsert_topshot_marketplace_fmv": { data: null, error: { message: "perm denied" } },
    })

    await POST(req())
    await runDeferred()

    const run = pipelineInsert(spy)
    expect(run).toMatchObject({ ok: false, error: "perm denied", rows_written: 0 })
    expect(run?.extra).toMatchObject({ upserted: 0 })
  })

  it("a sets-read failure short-circuits before any GQL call with an ok=false log", async () => {
    fetchMock = installFetchMock([gqlRoute("TopshotMarketplaceFmv", page([], null))])
    const spy = install({ sets: { data: null, error: { message: "boom" } } })

    await POST(req())
    await runDeferred()

    expect(fetchMock.calls).toHaveLength(0)
    // ⚠ NARROWED 2026-08-28, and INVERTED rather than deleted. This assertion's
    // property is "the terminal run is logged through the log_pipeline_run RPC,
    // not a raw insert". It was SPELLED as "no pipeline_runs insert at all",
    // which the invocation heartbeat trips: `writeInvocationHeartbeat` writes its
    // marker DIRECTLY on purpose, and after-route-heartbeat-ratchet.test.ts
    // asserts it must never reach log_pipeline_run. Pin the property, not the
    // spelling.
    const inserted = (spy.writes.pipeline_runs ?? []).flatMap((w) => w.rows) as any[]
    expect(inserted.filter((r) => !String(r.pipeline).endsWith("-heartbeat"))).toHaveLength(0)
    // ...and STRENGTHENED: the marker must actually be there. Without it a kill
    // on this path is indistinguishable from a cron that never fired, which is
    // the whole reason this route was converted.
    expect(inserted.map((r) => r.pipeline)).toEqual(["topshot-fmv-populate-heartbeat"])
    const log = spy.rpcCalls.find((c) => c.name === "log_pipeline_run")?.args
    expect(log).toMatchObject({ p_ok: false, p_error: "sets read failed: boom" })
    expect(log?.p_extra).toMatchObject({ stage: "sets_read" })
  })

  it("a sweep crash is caught by the after() wrapper and logged as fatal", async () => {
    fetchMock = installFetchMock([gqlRoute("TopshotMarketplaceFmv", page([], null))])
    // data:null with no error -> iterating the sets rows throws inside runSweep.
    const spy = install({ sets: { data: null, error: null } })

    await POST(req())
    await runDeferred()

    const log = spy.rpcCalls.find((c) => c.name === "log_pipeline_run")?.args
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("sweep crashed:")
    expect(log?.p_extra).toMatchObject({ fatal: true })
  })

  it("401s without the token and defers nothing", async () => {
    install({})
    const res = await POST(req(null))
    expect(res.status).toBe(401)
    expect(state.afterCbs).toHaveLength(0)
  })
})
