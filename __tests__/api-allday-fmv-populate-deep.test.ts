import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  type FetchStub,
} from "./helpers/route-harness"

// Deep-drive of GET /api/allday-fmv-populate — the AllDay marketplace FMV cursor
// sweep. The sibling test pins auth plus one empty completed page; this one drives
// the sweep machinery that actually decides what lands in fmv_snapshots:
//
//   - the CONCURRENCY LOCK (status='running' within 3 min short-circuits; a stale
//     lock does not, so a crashed run can't wedge the sweep forever);
//   - the STALL RESET, both arms — ?reset=true and the auto-detector that spots
//     two consecutive runs parked on the same cursor with 0 editions (the
//     upstream feed really does pin a cursor; one did from 2026-03-23);
//   - PAGINATION across PAGES_PER_RUN, the hasNextPage stop, the null-endCursor
//     stop, and a mid-loop page failure surfacing in debug_last_error;
//   - the DOUBLE **ULTIMATE guard**. fmv_snapshots ULTIMATE rows are owned
//     exclusively by recalc_ultimate_fmv (the ultimate-v1 algo, which excludes
//     special-serial sales), so this writer must never insert one. There is a
//     pre-filter AND a write-site re-check; both are pinned, including the case
//     where the tier lookup THROWS (non-fatal — but then nothing is filtered, so
//     the write-site guard is the only thing standing between a failed lookup and
//     a corrupted ULTIMATE row);
//   - every non-fatal error arm (tier lookup, stall-detect read, state update,
//     log_pipeline_run, the video-backfill tail) — each must leave ok:true.

const state = vi.hoisted(() => ({ sb: null as unknown, videoThrows: false }))

vi.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return state.sb
  },
}))
vi.mock("@/lib/chains/flow/allday-video", () => ({
  backfillAllDayEditionVideos: async () => {
    if (state.videoThrows) throw new Error("video leg down")
    return { scanned: 3, updated: 1 }
  },
}))

process.env.INGEST_SECRET_TOKEN = "adfmv-token"
process.env.ALLDAY_PROXY_URL = "https://proxy.test/allday"
process.env.TS_PROXY_SECRET = "proxy-secret"

const { GET } = await import("@/app/api/allday-fmv-populate/route")

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]

function install(fixtures: Fixtures, opts: { rpcThrows?: string[] } = {}) {
  const spy = makeInstrumentedSupabaseFixture({
    backfill_state: { data: { cursor: null, total_ingested: 0, status: "complete", last_run_at: null }, error: null },
    pipeline_runs: { data: [], error: null },
    editions: { data: [], error: null },
    "rpc:upsert_allday_marketplace_fmv": { data: [{ upserted: 0, skipped: 0, no_edition: 0 }], error: null },
    "rpc:log_pipeline_run": { data: null, error: null },
    ...fixtures,
  })
  if (opts.rpcThrows?.length) {
    const base = (spy.fixture as { rpc: (n: string, a?: unknown) => Promise<unknown> }).rpc.bind(spy.fixture)
    ;(spy.fixture as { rpc: (n: string, a?: unknown) => Promise<unknown> }).rpc = async (n, a) => {
      if (opts.rpcThrows!.includes(n)) throw new Error(`${n} exploded`)
      return base(n, a)
    }
  }
  state.sb = spy.fixture
  return spy
}

/** Same as install(), but every read of `table` REJECTS. */
function installThrowingOn(fixtures: Fixtures, table: string) {
  const spy = install(fixtures)
  const base = (spy.fixture as { from: (t: string) => unknown }).from.bind(spy.fixture)
  ;(spy.fixture as { from: (t: string) => unknown }).from = (t: string) => {
    if (t !== table) return base(t)
    const b: unknown = new Proxy(
      {},
      {
        get: (_x, prop) => {
          if (prop === "then") {
            return (onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
              Promise.reject(new Error(`${table} read exploded`)).then(onF, onR)
          }
          if (prop === "single") return async () => Promise.reject(new Error(`${table} read exploded`))
          return () => b
        },
      },
    )
    return b
  }
  state.sb = spy.fixture
  return spy
}

interface Page {
  ids?: string[]
  endCursor?: string | null
  hasNextPage?: boolean
  /** Non-2xx HTTP instead of a page. */
  http?: number
  /** A 200 whose body has no searchMarketplaceEditions. */
  noData?: boolean
}

function gqlPages(pages: Page[]): FetchStub {
  let call = 0
  return {
    match: (url) => url.includes("proxy.test"),
    respond: () => {
      const p = pages[Math.min(call, pages.length - 1)] ?? {}
      call++
      if (p.http) return { status: p.http, text: "upstream boom" }
      if (p.noData) return { json: { errors: [{ message: "nope" }] } }
      return {
        json: {
          data: {
            searchMarketplaceEditions: {
              pageInfo: { endCursor: p.endCursor ?? null, hasNextPage: p.hasNextPage ?? false },
              edges: (p.ids ?? []).map((id) => ({
                node: { editionFlowID: id, lowestPrice: "1.5", averageSale: "2.0", totalListings: "3" },
              })),
            },
          },
        },
      }
    },
  }
}

const req = (qs = "") =>
  new NextRequest(`https://t/api/allday-fmv-populate${qs}`, {
    headers: new Headers({ authorization: "Bearer adfmv-token" }),
  })

/** The row handed to upsert_allday_marketplace_fmv (the only fmv write site). */
function upsertRows(spy: ReturnType<typeof install>) {
  const call = spy.rpcCalls.find((c) => c.name === "upsert_allday_marketplace_fmv")
  return (call?.args as { p_rows?: Array<{ editionFlowID: string }> } | undefined)?.p_rows ?? []
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  state.videoThrows = false
})

describe("allday-fmv-populate — state guards", () => {
  it("500s when backfill_state cannot be read (never sweeps blind)", async () => {
    install({ backfill_state: { data: null, error: { message: "state down" } } })
    fetchMock = installFetchMock([]) // any GQL call would throw
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).detail).toBe("state down")
    expect(fetchMock.calls).toHaveLength(0)
  })

  it("short-circuits on the concurrency lock while a run is fresh", async () => {
    install({
      backfill_state: {
        data: { cursor: "c1", total_ingested: 5, status: "running", last_run_at: new Date().toISOString() },
        error: null,
      },
    })
    fetchMock = installFetchMock([])
    const body = await (await GET(req())).json()
    expect(body).toMatchObject({ ok: false, reason: "concurrency_guard" })
    expect(fetchMock.calls).toHaveLength(0)
  })

  it("ignores a STALE lock so a crashed run cannot wedge the sweep", async () => {
    install({
      backfill_state: [
        {
          data: {
            cursor: null,
            total_ingested: 5,
            status: "running",
            last_run_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
          },
          error: null,
        },
        { data: null, error: null },
      ],
      pipeline_runs: { data: [], error: null },
    })
    fetchMock = installFetchMock([gqlPages([{ ids: [] }])])
    const body = await (await GET(req())).json()
    expect(body.ok).toBe(true)
    expect(fetchMock.calls.length).toBeGreaterThan(0)
  })
})

describe("allday-fmv-populate — stall reset", () => {
  it("?reset=true drops a parked cursor and restarts from the head of the feed", async () => {
    const spy = install({
      backfill_state: [
        { data: { cursor: "stuck-cursor", total_ingested: 9, status: "pending", last_run_at: null }, error: null },
        { data: null, error: null },
      ],
    })
    fetchMock = installFetchMock([gqlPages([{ ids: [] }])])

    const body = await (await GET(req("?reset=true"))).json()
    expect(body.stall_reset).toBe(true)
    // The cursor was cleared BEFORE the first page fetch, so the sweep restarts.
    expect(JSON.parse(String(fetchMock.calls[0].init?.body)).variables.after).toBeNull()
    expect((spy.writes.backfill_state ?? []).flatMap((w) => w.rows)).toContainEqual({
      cursor: null,
      status: "pending",
    })
  })

  it("auto-detects a parked cursor from two identical zero-edition runs", async () => {
    const parked = { editions_fetched: 0, cursor_before: "stuck", cursor_after: "stuck" }
    install({
      backfill_state: [
        { data: { cursor: "stuck", total_ingested: 9, status: "pending", last_run_at: null }, error: null },
        { data: null, error: null },
      ],
      pipeline_runs: { data: [{ extra: parked }, { extra: parked }], error: null },
    })
    fetchMock = installFetchMock([gqlPages([{ ids: [] }])])
    expect((await (await GET(req())).json()).stall_reset).toBe(true)
  })

  it("does NOT reset when the two prior runs actually made progress", async () => {
    install({
      backfill_state: [
        { data: { cursor: "live", total_ingested: 9, status: "pending", last_run_at: null }, error: null },
        { data: null, error: null },
      ],
      pipeline_runs: {
        data: [
          { extra: { editions_fetched: 100, cursor_before: "a", cursor_after: "live" } },
          { extra: { editions_fetched: 0, cursor_before: "live", cursor_after: "live" } },
        ],
        error: null,
      },
    })
    fetchMock = installFetchMock([gqlPages([{ ids: [] }])])
    const body = await (await GET(req())).json()
    expect(body.stall_reset).toBe(false)
    expect(JSON.parse(String(fetchMock!.calls[0].init?.body)).variables.after).toBe("live")
  })

  it("treats a failed stall-detect read as non-fatal and sweeps anyway", async () => {
    installThrowingOn(
      {
        backfill_state: [
          { data: { cursor: "live", total_ingested: 0, status: "pending", last_run_at: null }, error: null },
          { data: null, error: null },
        ],
      },
      "pipeline_runs",
    )
    fetchMock = installFetchMock([gqlPages([{ ids: [] }])])
    const body = await (await GET(req())).json()
    expect(body.ok).toBe(true)
    expect(body.stall_reset).toBe(false)
  })
})

describe("allday-fmv-populate — pagination", () => {
  it("walks up to PAGES_PER_RUN pages and reports an incomplete sweep with the live cursor", async () => {
    install({})
    fetchMock = installFetchMock([
      gqlPages([
        { ids: ["1"], endCursor: "c1", hasNextPage: true },
        { ids: ["2"], endCursor: "c2", hasNextPage: true },
        { ids: ["3"], endCursor: "c3", hasNextPage: true },
        { ids: ["4"], endCursor: "c4", hasNextPage: true },
        { ids: ["5"], endCursor: "c5", hasNextPage: true },
      ]),
    ])

    const body = await (await GET(req())).json()
    expect(fetchMock.calls).toHaveLength(5) // PAGES_PER_RUN
    expect(body.editions_fetched).toBe(5)
    expect(body.sweep_complete).toBe(false)
    expect(body.cursor_after).toBe("c5")
  })

  it("stops early and clears the cursor when the feed reports hasNextPage=false", async () => {
    install({})
    fetchMock = installFetchMock([
      gqlPages([
        { ids: ["1"], endCursor: "c1", hasNextPage: true },
        { ids: ["2"], endCursor: "c2", hasNextPage: false },
      ]),
    ])
    const body = await (await GET(req())).json()
    expect(fetchMock.calls).toHaveLength(2)
    expect(body.sweep_complete).toBe(true)
    expect(body.cursor_after).toBeNull()
  })

  it("stops when the feed claims hasNextPage but hands back no cursor", async () => {
    install({})
    fetchMock = installFetchMock([gqlPages([{ ids: ["1"], endCursor: null, hasNextPage: true }])])
    const body = await (await GET(req())).json()
    expect(fetchMock.calls).toHaveLength(1)
    expect(body.sweep_complete).toBe(true)
  })

  it("breaks on a page HTTP error and surfaces it without failing the run", async () => {
    install({})
    fetchMock = installFetchMock([
      gqlPages([{ ids: ["1"], endCursor: "c1", hasNextPage: true }, { http: 503 }]),
    ])
    const body = await (await GET(req())).json()
    expect(body.ok).toBe(true)
    expect(body.editions_fetched).toBe(1) // page 1 kept, page 2 aborted the loop
    expect(body.debug_last_error).toContain("503")
  })

  it("breaks on a 200 whose payload carries no searchMarketplaceEditions", async () => {
    install({})
    fetchMock = installFetchMock([gqlPages([{ noData: true }])])
    const body = await (await GET(req())).json()
    expect(body.debug_last_error).toContain("GQL missing data")
    expect(body.editions_fetched).toBe(0)
  })

  it("sends the proxy secret header when ALLDAY_PROXY_URL is configured", async () => {
    install({})
    fetchMock = installFetchMock([gqlPages([{ ids: [] }])])
    await GET(req())
    const headers = fetchMock.calls[0].init?.headers as Record<string, string>
    expect(headers["X-Proxy-Secret"]).toBe("proxy-secret")
  })
})

describe("allday-fmv-populate — the ULTIMATE guard", () => {
  it("filters ULTIMATE editions out before the upsert and counts them", async () => {
    const spy = install({
      editions: {
        data: [
          { external_id: "u1", tier: "ULTIMATE" },
          { external_id: "n1", tier: "COMMON" },
        ],
        error: null,
      },
      "rpc:upsert_allday_marketplace_fmv": { data: [{ upserted: 1, skipped: 0, no_edition: 0 }], error: null },
    })
    fetchMock = installFetchMock([gqlPages([{ ids: ["u1", "n1"] }])])

    const body = await (await GET(req())).json()
    expect(body.ultimate_skipped).toBe(1)
    expect(body.editions_fetched).toBe(2)
    expect(body.upserted).toBe(1)
    // The write site never saw the ULTIMATE row — fmv_snapshots ULTIMATE rows
    // belong to recalc_ultimate_fmv alone.
    expect(upsertRows(spy).map((r) => r.editionFlowID)).toEqual(["n1"])
  })

  it("treats a failed tier lookup as non-fatal — nothing is filtered, so the run still completes", async () => {
    const spy = installThrowingOn({}, "editions")
    fetchMock = installFetchMock([gqlPages([{ ids: ["u1"] }])])
    const body = await (await GET(req())).json()
    expect(body.ok).toBe(true)
    expect(body.ultimate_skipped).toBe(0)
    expect(upsertRows(spy).map((r) => r.editionFlowID)).toEqual(["u1"])
  })

  it("skips the tier lookup entirely when the sweep returned nothing", async () => {
    const spy = install({})
    fetchMock = installFetchMock([gqlPages([{ ids: [] }])])
    const body = await (await GET(req())).json()
    expect(body.editions_fetched).toBe(0)
    // No rows -> no upsert RPC at all (an empty p_rows call would be wasted work).
    expect(spy.rpcCalls.some((c) => c.name === "upsert_allday_marketplace_fmv")).toBe(false)
  })
})

describe("allday-fmv-populate — write + tail arms", () => {
  it("parses the upsert RPC counters and advances total_ingested", async () => {
    const spy = install({
      backfill_state: [
        { data: { cursor: null, total_ingested: 40, status: "pending", last_run_at: null }, error: null },
        { data: null, error: null },
        { data: null, error: null },
      ],
      "rpc:upsert_allday_marketplace_fmv": { data: [{ upserted: 2, skipped: 1, no_edition: 3 }], error: null },
    })
    fetchMock = installFetchMock([gqlPages([{ ids: ["a", "b"] }])])

    const body = await (await GET(req())).json()
    expect(body).toMatchObject({ upserted: 2, skipped: 1, no_edition: 3 })
    const final = (spy.writes.backfill_state ?? []).flatMap((w) => w.rows).find((r) => "total_ingested" in r)
    expect(final?.total_ingested).toBe(42)
    expect(final?.status).toBe("complete")
  })

  it("surfaces an upsert RPC error without failing the run or inflating counters", async () => {
    install({ "rpc:upsert_allday_marketplace_fmv": { data: null, error: { message: "rpc down" } } })
    fetchMock = installFetchMock([gqlPages([{ ids: ["a"] }])])
    const body = await (await GET(req())).json()
    expect(body.ok).toBe(true)
    expect(body.upserted).toBe(0)
    expect(body.debug_rpc_error).toBe("rpc down")
  })

  it("tolerates a state-update error and a log_pipeline_run throw", async () => {
    install(
      {
        backfill_state: [
          { data: { cursor: null, total_ingested: 0, status: "pending", last_run_at: null }, error: null },
          { data: null, error: { message: "lock write down" } },
        ],
      },
      { rpcThrows: ["log_pipeline_run"] },
    )
    fetchMock = installFetchMock([gqlPages([{ ids: [] }])])
    expect((await (await GET(req())).json()).ok).toBe(true)
  })

  it("reports the video-backfill tail, and nulls it when that leg throws", async () => {
    install({})
    fetchMock = installFetchMock([gqlPages([{ ids: [] }])])
    expect((await (await GET(req())).json()).video_backfill).toEqual({ scanned: 3, updated: 1 })

    state.videoThrows = true
    install({})
    fetchMock.restore()
    fetchMock = installFetchMock([gqlPages([{ ids: [] }])])
    const body = await (await GET(req())).json()
    expect(body.ok).toBe(true)
    expect(body.video_backfill).toBeNull()
  })
})
