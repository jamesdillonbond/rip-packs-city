import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  type FetchStub,
  type RecordedRpcCall,
} from "./helpers/route-harness"

// Deep-drive of GET /api/cron/pinnacle-metadata-backfill — the on-chain Pinnacle
// metadata/catalog backfill (synchronous; no after()). Pins:
//   - a Q1 mint_count fill: sample wmc row -> Cadence PinInfo decode -> the
//     computed edition_key + mint_count are written and reported;
//   - empty queues short-circuit to a clean ok=true zero-row response + log;
//   - a Q1 load error returns 500 before any Cadence work;
//   - a Cadence read failure is counted (gql_errors) and flips ok=false;
//   - the auth guard.
// Note: thumbnail_url is a documented dead-end — images_filled is always 0.

const state = vi.hoisted(() => ({ sb: null as unknown }))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () =>
    new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))

process.env.INGEST_SECRET_TOKEN = "pin-token"
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co"
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc"

const { GET } = await import("@/app/api/cron/pinnacle-metadata-backfill/route")

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64")
const T = {
  int: (v: number) => ({ type: "Int", value: String(v) }),
  uint64: (v: number | string) => ({ type: "UInt64", value: String(v) }),
  str: (v: string) => ({ type: "String", value: v }),
  bool: (v: boolean) => ({ type: "Bool", value: v }),
  optNull: () => ({ type: "Optional", value: null }),
}

interface Pin {
  royaltyCode: string
  variant: string
  printing: number
  numberMinted: number
  isLimited: boolean
  isChaser: boolean
  characterName: string
  franchise: string
  setName: string
  editionType: string
}
function pinStruct(p: Pin) {
  return {
    type: "Struct",
    value: {
      id: "A.edf9df96c92f4595.Pinnacle.PinInfo",
      fields: [
        { name: "editionId", value: T.int(1) },
        { name: "royaltyCode", value: T.str(p.royaltyCode) },
        { name: "variant", value: T.str(p.variant) },
        { name: "printing", value: T.uint64(p.printing) },
        { name: "numberMinted", value: T.uint64(p.numberMinted) },
        { name: "maxMintSize", value: T.uint64(0) },
        { name: "isLimited", value: T.bool(p.isLimited) },
        { name: "isChaser", value: T.bool(p.isChaser) },
        { name: "characterName", value: T.str(p.characterName) },
        { name: "franchise", value: T.str(p.franchise) },
        { name: "setName", value: T.str(p.setName) },
        { name: "editionType", value: T.str(p.editionType) },
        { name: "serialNumber", value: T.optNull() }, // open edition -> no serial fill
      ],
    },
  }
}
// Base64 JSON-CDC Dictionary {UInt64: PinInfo} as Flow REST /scripts serves it.
function pinDict(entries: Record<string, Pin>): string {
  return b64({
    type: "Dictionary",
    value: Object.entries(entries).map(([k, v]) => ({ key: T.uint64(k), value: pinStruct(v) })),
  })
}

function flowScript(results: Array<{ status?: number; body?: string }>): FetchStub {
  let call = 0
  return {
    match: (url) => url.includes("rest-mainnet.onflow.org"),
    respond: () => {
      const r = results[Math.min(call, results.length - 1)]
      call++
      return { status: r.status ?? 200, text: r.body ?? "" }
    },
  }
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture({
    pinnacle_editions: { data: [], error: null },
    wallet_moments_cache: { data: [], error: null },
    pinnacle_nft_map: { data: [], error: null },
    "rpc:log_pipeline_run": { data: null, error: null },
    ...fixtures,
  })
  state.sb = spy.fixture
  return spy
}

function req(): NextRequest {
  return new NextRequest("https://t/api/cron/pinnacle-metadata-backfill", {
    method: "GET",
    headers: new Headers({ authorization: "Bearer pin-token" }),
  })
}

function terminalLog(rpcCalls: RecordedRpcCall[]) {
  return rpcCalls.filter((c) => c.name === "log_pipeline_run").at(-1)?.args as any
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {})

describe("pinnacle-metadata-backfill — Q1 mint_count fill", () => {
  it("decodes the on-chain PinInfo and writes the computed edition_key + mint_count", async () => {
    // pinnacle_editions: [Q1 candidates, Q4 all-pe(empty), the mint_count UPDATE]
    // wmc: [Q1 lookup(sample), Q2(empty), Q3 pool(empty), Q4 pool(empty)]
    const spy = install({
      pinnacle_editions: [
        { data: [{ id: "pe1", edition_key: "RC:Std:1" }], error: null },
        { data: [], error: null },
        { data: null, error: null }, // update success
      ],
      wallet_moments_cache: [
        { data: [{ wallet_address: "0xw1", moment_id: "12345", edition_key: "RC:Std:1" }], error: null },
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
      ],
    })
    fetchMock = installFetchMock([
      flowScript([
        {
          body: pinDict({
            "12345": {
              royaltyCode: "RC",
              variant: "Std",
              printing: 1,
              numberMinted: 250,
              isLimited: true,
              isChaser: false,
              characterName: "Mickey",
              franchise: "Disney",
              setName: "Series 1",
              editionType: "Standard",
            },
          }),
        },
      ]),
    ])

    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.mint_count_filled).toBe(1)
    expect(body.images_filled).toBe(0) // documented dead-end

    // The UPDATE carried the on-chain numberMinted + is_serialized from PinInfo.
    const updates = (spy.writes.pinnacle_editions ?? []).filter((w) => w.method === "update").flatMap((w) => w.rows)
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({ mint_count: 250, is_serialized: true })

    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_pipeline: "pinnacle-metadata-backfill", p_ok: true, p_collection_slug: "disney_pinnacle" })
    expect(log.p_extra).toMatchObject({ gql_errors: 0, images_filled: 0 })
    expect(body.samples.mint_count[0]).toMatchObject({ edition_pk: "pe1", mint_count: 250 })
  })
})

describe("pinnacle-metadata-backfill — edges", () => {
  it("empty queues short-circuit to an ok=true zero-row response + clean log", async () => {
    const spy = install({}) // all defaults empty
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      ok: true,
      mint_count_filled: 0,
      edition_keys_resolved: 0,
      catalog_upserted: 0,
      gql_errors: 0,
    })
    // No Cadence work with an empty work list.
    expect(fetchMock?.calls ?? []).toHaveLength(0)
    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 0, p_rows_written: 0 })
  })

  it("a Q1 load error returns 500 before any Cadence work", async () => {
    install({ pinnacle_editions: { data: null, error: { message: "relation timeout" } } })
    fetchMock = installFetchMock([flowScript([{ body: "" }])])
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(String(body.error)).toContain("q1 load: relation timeout")
    expect(fetchMock.calls).toHaveLength(0)
  })

  it("a Cadence read failure is counted and flips ok=false", async () => {
    const spy = install({
      pinnacle_editions: [
        { data: [{ id: "pe1", edition_key: "RC:Std:1" }], error: null },
        { data: [], error: null },
      ],
      wallet_moments_cache: [
        { data: [{ wallet_address: "0xw1", moment_id: "12345", edition_key: "RC:Std:1" }], error: null },
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
      ],
    })
    fetchMock = installFetchMock([flowScript([{ status: 502, body: "bad gateway" }])])

    const res = await GET(req())
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.gql_errors).toBe(1)
    expect(body.mint_count_filled).toBe(0)

    const log = terminalLog(spy.rpcCalls)
    expect(log.p_ok).toBe(false)
    expect(String(log.p_error)).toContain("cadence:")
  })

  it("401s without the token", async () => {
    install({})
    const res = await GET(new NextRequest("https://t/api/cron/pinnacle-metadata-backfill", { method: "GET" }))
    expect(res.status).toBe(401)
  })
})
