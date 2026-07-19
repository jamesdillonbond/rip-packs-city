import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture, type RecordedRpcCall } from "./helpers/route-harness"

// Deep-drive of /api/cron/topshot-deal-floor-serials — the deal-board floor-serial
// capture. Pins the "price+serial from the SAME listing, parallel-correct" contract:
//   - one price-sorted page per set:play serves the base row AND its :: siblings,
//     each picking the floor whose parallelID matches its printing;
//   - a printing with no matching listing in the page is SKIPPED (never a
//     cross-printing floor);
//   - a GQL fault increments gql_errors / throttled_giveups (429), run still ok;
//   - a deal-board read error flips ok=false via the fatal fetchError;
//   - the GET introspection returns the computed count;
//   - the auth guard.

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sb: null as unknown,
  gql: null as unknown,
  gqlThrow: null as string | null,
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
vi.mock("@/lib/chains/flow/topshot", () => ({
  topshotGraphql: async () => {
    if (state.gqlThrow) throw new Error(state.gqlThrow)
    return state.gql
  },
}))

process.env.INGEST_SECRET_TOKEN = "deal-token"

const { POST, GET } = await import("@/app/api/cron/topshot-deal-floor-serials/route")

const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

function floorPage(moments: Array<{ flowId: string; flowSerialNumber: string; price: string; parallelID: number }>) {
  return { searchMintedMoments: { data: { searchSummary: { data: { data: moments } } } } }
}

function target(external_id: string, opts: { serial?: number | null } = {}) {
  return {
    external_id,
    set_uuid: "set-uuid-1",
    play_uuid: "play-uuid-1",
    low_ask_serial: opts.serial ?? null,
    updated_at: null,
  }
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture({
    "rpc:get_topshot_deal_external_ids": { data: [], error: null },
    edition_offers: { data: [], error: null },
    "rpc:log_pipeline_run": { data: null, error: null },
    ...fixtures,
  })
  state.sb = spy.fixture
  return spy
}

function req(): NextRequest {
  return new NextRequest("https://t/api/cron/topshot-deal-floor-serials", {
    method: "POST",
    headers: new Headers({ authorization: "Bearer deal-token" }),
  })
}

async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) await cb()
}

function terminalLog(rpcCalls: RecordedRpcCall[]) {
  return rpcCalls.filter((c) => c.name === "log_pipeline_run").at(-1)?.args as any
}

beforeEach(() => {
  state.afterCbs.length = 0
  state.gql = floorPage([])
  state.gqlThrow = null
})

describe("topshot-deal-floor-serials — floor capture", () => {
  it("picks each printing's parallel-matched floor from one shared page and writes price+serial+nft together", async () => {
    state.gql = floorPage([
      // cheapest Standard first, then the parallel printing 19.
      { flowId: "n1", flowSerialNumber: "12", price: "40", parallelID: 0 },
      { flowId: "n2", flowSerialNumber: "3", price: "75", parallelID: 19 },
    ])
    const spy = install({
      "rpc:get_topshot_deal_external_ids": { data: ["3:45", "3:45::19"], error: null },
      edition_offers: { data: [target("3:45"), target("3:45::19")], error: null },
    })

    const res = await POST(req())
    expect(res.status).toBe(202)
    await runDeferred()

    const rows = (spy.writes.edition_offers ?? []).flatMap((w) => w.rows)
    expect(rows).toHaveLength(2)
    const byId = Object.fromEntries(rows.map((r) => [r.external_id, r]))
    // Standard (parallelID 0) floor.
    expect(byId["3:45"]).toMatchObject({ collection_id: TS, low_ask: 40, low_ask_serial: 12, low_ask_nft_id: "n1" })
    // Parallel 19 floor — NOT the cheaper Standard listing.
    expect(byId["3:45::19"]).toMatchObject({ low_ask: 75, low_ask_serial: 3, low_ask_nft_id: "n2" })

    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_pipeline: "topshot-deal-floor-serials", p_ok: true, p_rows_written: 2 })
    expect(log.p_extra).toMatchObject({ listings_found: 2, deal_editions_total: 2 })
  })

  it("skips a printing with no matching listing in the page (never a cross-printing floor)", async () => {
    // Page has only a Standard listing; the ::19 printing must be skipped.
    state.gql = floorPage([{ flowId: "n1", flowSerialNumber: "12", price: "40", parallelID: 0 }])
    const spy = install({
      "rpc:get_topshot_deal_external_ids": { data: ["3:45", "3:45::19"], error: null },
      edition_offers: { data: [target("3:45"), target("3:45::19")], error: null },
    })

    await POST(req())
    await runDeferred()

    const rows = (spy.writes.edition_offers ?? []).flatMap((w) => w.rows)
    expect(rows).toHaveLength(1)
    expect(rows[0].external_id).toBe("3:45")
    expect(terminalLog(spy.rpcCalls)).toMatchObject({ p_rows_skipped: 1, p_ok: true })
  })
})

describe("topshot-deal-floor-serials — degradation + auth", () => {
  it("a 429 GQL fault increments gql_errors + throttled_giveups but the run stays ok", async () => {
    state.gqlThrow = "429 Too Many Requests"
    const spy = install({
      "rpc:get_topshot_deal_external_ids": { data: ["3:45"], error: null },
      edition_offers: { data: [target("3:45")], error: null },
    })

    await POST(req())
    await runDeferred()

    const log = terminalLog(spy.rpcCalls)
    expect(log.p_ok).toBe(true) // per-edition faults don't fail the whole run
    expect(log.p_rows_written).toBe(0)
    expect(log.p_extra).toMatchObject({ gql_errors: 1, throttled_giveups: 1 })
  })

  it("a deal-board read error flips ok=false via the fatal path", async () => {
    const spy = install({
      "rpc:get_topshot_deal_external_ids": { data: null, error: { message: "statement timeout" } },
    })

    await POST(req())
    await runDeferred()

    const log = terminalLog(spy.rpcCalls)
    expect(log.p_ok).toBe(false)
    expect(String(log.p_error)).toContain("deal board read: statement timeout")
  })

  it("GET returns the computed floor-serial count", async () => {
    install({ edition_offers: { count: 42, error: null } as never })
    const res = await GET()
    expect(res.status).toBe(200)
    expect((await res.json()).editionsWithFloorSerial).toBe(42)
  })

  it("401s POST without the token and registers no deferred work", async () => {
    install({})
    const res = await POST(new NextRequest("https://t/api/cron/topshot-deal-floor-serials", { method: "POST" }))
    expect(res.status).toBe(401)
    expect(state.afterCbs).toHaveLength(0)
  })
})
