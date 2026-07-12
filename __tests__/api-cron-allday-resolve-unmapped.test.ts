import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for POST /api/cron/allday-resolve-unmapped.
// Auth: Bearer INGEST_SECRET_TOKEN OR ?token=, captured into a module-level
// `TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""` at import. We exercise both the
// guard (missing/wrong credential → 401) AND the real accept via the two-regime
// resetModules pattern: with the secret SET at import, the correct bearer/?token=
// reaches the immediate 202 { status:"accepted", collection_id, started_at, note }.
// The on-chain borrow/scan drain runs inside after() (stubbed no-op), so the ack
// is observable without any Flow REST / DB I/O.

const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (_fn?: any) => {} }
})
const sb: any = vi.hoisted(() => {
  const s: any = {}
  for (const m of ["from", "select", "eq", "in", "order", "limit", "gte", "lte", "lt", "gt", "is", "not", "neq", "or", "range", "match", "insert", "update", "upsert", "delete", "returns"]) s[m] = () => s
  s.single = async () => ({ data: {}, error: null })
  s.maybeSingle = async () => ({ data: null, error: null })
  s.rpc = async () => ({ data: null, error: null })
  s.then = (resolve: any) => resolve({ data: [], error: null })
  return s
})
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: sb, supabase: sb }))
vi.mock("@/lib/chains/flow/dapper-v1-tx-decode", () => ({
  decodeV1SaleTx: async () => ({ buyer: null, seller: null }),
}))
vi.mock("@/lib/chains/flow/allday-edition-onchain", () => ({
  ALLDAY_COLLECTION_ID: "dee28451-5d62-409e-a1ad-a83f763ac070",
  COLLECTION_SLUG: "nfl_all_day",
  ALLDAY_DEPOSIT_EVENT: "A.e4cf4bdc1751c65d.AllDay.Deposit",
  ALLDAY_WITHDRAW_EVENT: "A.e4cf4bdc1751c65d.AllDay.Withdraw",
  BORROW_MOMENT_SCRIPT: "",
  GET_EDITION_DATA_SCRIPT: "",
  buildOnChainEditionRow: () => ({}),
  fetchTxBuyers: async () => [],
  normalizeAddress: (a: string) => a,
  runAllDayScript: async () => null,
  scanAllDayDepositsForNft: async () => [],
}))

const url = "https://t/api/cron/allday-resolve-unmapped"

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL(url),
  }) as any

// Existing guard coverage — top-level import, module-load TOKEN. A missing/wrong
// credential 401s regardless of the captured TOKEN value.
import { POST } from "@/app/api/cron/allday-resolve-unmapped/route"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  process.env.CRON_SECRET = "test-cron-secret"
})

describe("POST /api/cron/allday-resolve-unmapped", () => {
  it("401s with no authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong-token"))).status).toBe(401)
  })
})

describe("POST /api/cron/allday-resolve-unmapped — secret configured (success path)", () => {
  const TOKEN = "allday-resolve-ingest-token"
  let POST2: (req: any) => Promise<Response>
  beforeAll(async () => {
    vi.resetModules()
    process.env.INGEST_SECRET_TOKEN = TOKEN
    const mod = await import("@/app/api/cron/allday-resolve-unmapped/route")
    POST2 = mod.POST as any
  })

  it("still 401s with a wrong bearer token", async () => {
    expect((await POST2(makeReq({ url, auth: "Bearer wrong" }))).status).toBe(401)
  })

  it("202s and reports status:accepted + collection_id with the correct bearer token", async () => {
    const res = await POST2(makeReq({ url, auth: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.status).toBe("accepted")
    expect(body.collection_id).toBe(ALLDAY_COLLECTION_ID)
    expect(typeof body.started_at).toBe("string")
    expect(body.note).toContain("pipeline_runs")
  })

  it("202s with the correct ?token= query param", async () => {
    const res = await POST2(makeReq({ url, token: TOKEN }))
    expect(res.status).toBe(202)
    expect((await res.json()).status).toBe("accepted")
  })
})
