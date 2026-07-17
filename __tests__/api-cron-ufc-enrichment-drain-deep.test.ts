import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  type FetchStub,
  type RecordedRpcCall,
} from "./helpers/route-harness"

// Deep-drive of POST /api/cron/ufc-enrichment-drain — the UFC wmc null-key drain.
// Pins the on-chain enrichment contract:
//   - null-key rows are read on-chain, keyed via makeEditionKey, tier inferred,
//     player/set/image joined from the editions map, upserted (3-col conflict);
//   - a moment with no edition name is counted (no_edition_name), not written;
//   - a Cadence read error is counted (cadence_errors), not fatal;
//   - an empty null population logs a clean ok=true note;
//   - a candidate scan error logs ok=false at stage candidate_scan;
//   - an upsert throw hits the fatal catch -> ok=false;
//   - the auth guard.

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

process.env.INGEST_SECRET_TOKEN = "ufc-token"

const { POST } = await import("@/app/api/cron/ufc-enrichment-drain/route")

const UFC = "9b4824a8-736d-4a96-b450-8dcc0c46b023"
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64")

// GET_META decode: JSON.parse(atob(body)).value -> [{key:{value}, value:{value}}]
function metaResult(fields: Record<string, string>): string {
  return b64({
    value: Object.entries(fields).map(([k, v]) => ({ key: { value: k }, value: { value: v } })),
  })
}

// Per-moment Flow REST stub, keyed by the encoded UInt64 moment id in the body.
function flowMeta(byMoment: Record<string, { status?: number; body?: string }>): FetchStub {
  return {
    match: (url) => url.includes("rest-mainnet.onflow.org"),
    respond: (_url, init) => {
      const body = JSON.parse(String(init?.body))
      const arg = JSON.parse(Buffer.from(String(body.arguments[1]), "base64").toString("utf8"))
      const momentId = String(arg.value)
      const r = byMoment[momentId] ?? { status: 500, body: "no fixture" }
      return { status: r.status ?? 200, text: r.body ?? "" }
    },
  }
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures, opts?: { failWrites?: string[] }) {
  const spy = makeInstrumentedSupabaseFixture(
    {
      wallet_moments_cache: { data: [], error: null },
      editions: { data: [], error: null },
      "rpc:log_pipeline_run": { data: null, error: null },
      ...fixtures,
    },
    opts,
  )
  state.sb = spy.fixture
  return spy
}

function req(): NextRequest {
  return new NextRequest("https://t/api/cron/ufc-enrichment-drain", {
    method: "POST",
    headers: new Headers({ authorization: "Bearer ufc-token" }),
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

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  state.afterCbs.length = 0
})

describe("ufc-enrichment-drain — enrichment", () => {
  it("derives edition_key/tier and upserts a null-key row, joining player/set from editions", async () => {
    // wmc reads first (null rows), then editions map.
    const spy = install({
      wallet_moments_cache: [
        { data: [{ wallet_address: "0xw1", moment_id: "100", image_url: null }], error: null }, // candidate scan
      ],
      editions: {
        data: [{ external_id: "Conor-Mcgregor-Series-1-100", player_name: "Conor McGregor", set_name: "Series 1", thumbnail_url: "http://img/x.png" }],
        error: null,
      },
    })
    fetchMock = installFetchMock([
      flowMeta({ "100": { body: metaResult({ editionName: "Conor Mcgregor | Series 1", serial: "5", max: "100" }) } }),
    ])

    const res = await POST(req())
    expect(res.status).toBe(202)
    await runDeferred()

    const rows = (spy.writes.wallet_moments_cache ?? []).filter((w) => w.method === "upsert").flatMap((w) => w.rows)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      wallet_address: "0xw1",
      collection_id: UFC,
      moment_id: "100",
      edition_key: "Conor-Mcgregor-Series-1-100", // makeEditionKey(name, max)
      serial_number: 5,
      player_name: "Conor McGregor", // editions wins (valid name)
      set_name: "Series 1",
      image_url: "http://img/x.png",
      tier: "CHALLENGER", // inferTier(100): <=999
    })

    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_pipeline: "ufc-enrichment-drain", p_ok: true, p_rows_found: 1, p_rows_written: 1 })
    expect(log.p_extra).toMatchObject({ enriched: 1, upserted: 1, cadence_errors: 0 })
  })

  it("counts a moment with no on-chain edition name and writes nothing for it", async () => {
    const spy = install({
      wallet_moments_cache: [{ data: [{ wallet_address: "0xw1", moment_id: "100", image_url: null }], error: null }],
      editions: { data: [], error: null },
    })
    fetchMock = installFetchMock([flowMeta({ "100": { body: metaResult({ serial: "5", max: "100" }) } })]) // no editionName/name

    await POST(req())
    await runDeferred()

    expect(spy.writes.wallet_moments_cache ?? []).toHaveLength(0)
    const log = terminalLog(spy.rpcCalls)
    expect(log.p_extra.no_edition_name).toBe(1)
    expect(log.p_extra.enriched).toBe(0)
  })

  it("counts a Cadence read error without failing the run", async () => {
    const spy = install({
      wallet_moments_cache: [{ data: [{ wallet_address: "0xw1", moment_id: "100", image_url: null }], error: null }],
      editions: { data: [], error: null },
    })
    fetchMock = installFetchMock([flowMeta({ "100": { status: 500, body: "flow overloaded" } })])

    await POST(req())
    await runDeferred()

    const log = terminalLog(spy.rpcCalls)
    expect(log.p_ok).toBe(true) // no writes, no upsert error -> ok
    expect(log.p_extra.cadence_errors).toBe(1)
    expect(log.p_extra.enriched).toBe(0)
  })
})

describe("ufc-enrichment-drain — edges + auth", () => {
  it("logs a clean ok=true note when there are no null-key rows", async () => {
    const spy = install({ wallet_moments_cache: { data: [], error: null } })
    await POST(req())
    await runDeferred()

    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 0 })
    expect(log.p_extra.note).toContain("no null-edition_key UFC rows")
  })

  it("a candidate scan error logs ok=false at stage candidate_scan", async () => {
    const spy = install({
      wallet_moments_cache: { data: null, error: { message: "statement timeout" } },
    })
    await POST(req())
    await runDeferred()

    const log = terminalLog(spy.rpcCalls)
    expect(log.p_ok).toBe(false)
    expect(log.p_extra.stage).toBe("candidate_scan")
    expect(String(log.p_error)).toContain("candidate scan: statement timeout")
  })

  it("an upsert throw hits the fatal catch -> ok=false fatal row", async () => {
    const spy = install(
      {
        wallet_moments_cache: [{ data: [{ wallet_address: "0xw1", moment_id: "100", image_url: null }], error: null }],
        editions: { data: [], error: null },
      },
      { failWrites: ["wallet_moments_cache"] },
    )
    fetchMock = installFetchMock([
      flowMeta({ "100": { body: metaResult({ editionName: "Jon Jones | Series 2", serial: "1", max: "50" }) } }),
    ])

    await POST(req())
    await runDeferred()

    const log = terminalLog(spy.rpcCalls)
    expect(log.p_ok).toBe(false)
    expect(String(log.p_error)).toContain("drain crashed:")
    expect(log.p_extra.fatal).toBe(true)
  })

  it("401s without the token and registers no deferred work", async () => {
    install({})
    const res = await POST(new NextRequest("https://t/api/cron/ufc-enrichment-drain", { method: "POST" }))
    expect(res.status).toBe(401)
    expect(state.afterCbs).toHaveLength(0)
  })
})
