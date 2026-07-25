import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for GET /api/pro-payment-scanner.
// Auth is Bearer against a module-level TOKEN read at IMPORT time, so the env is
// set before the dynamic import. The prior version asserted only the guards on
// the grounds that the Flow REST scan had "no clean mock seam" — it does:
// global fetch. Here the treasury scan is driven end-to-end: the base64 JSON-CDC
// decode, the known-vs-new moment diff against pro_payment_log, the per-row
// insert tally (including an insert that errors and is NOT counted), the empty
// -capability [] response, and both failure paths (non-ok Flow status, and a
// body that isn't decodable) landing on the 500.

const st = {
  ids: ["101", "102"] as string[],
  known: { data: [] as any[] } as any,
  insertErr: null as any,
  flowOk: true,
  flowBody: null as string | null, // override the encoded payload
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from() {
      const b: any = {
        select: () => b,
        insert: async () => ({ error: st.insertErr }),
        then: (resolve: any) => resolve(st.known),
      }
      return b
    },
  },
}))

const TOKEN = "test-ingest-token"
process.env.INGEST_SECRET_TOKEN = TOKEN

const { GET } = await import("@/app/api/pro-payment-scanner/route")

function get(auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/pro-payment-scanner", { method: "GET", headers })
}
const authed = () => get(`Bearer ${TOKEN}`)

// Flow returns a base64-encoded JSON-CDC payload wrapped in quotes.
function cdcPayload(ids: string[]): string {
  const decoded = { type: "Array", value: ids.map((v) => ({ type: "UInt64", value: v })) }
  return `"${Buffer.from(JSON.stringify(decoded), "utf8").toString("base64")}"`
}

beforeEach(() => {
  st.ids = ["101", "102"]
  st.known = { data: [] }
  st.insertErr = null
  st.flowOk = true
  st.flowBody = null
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: st.flowOk,
    status: st.flowOk ? 200 : 503,
    text: async () => (st.flowOk ? (st.flowBody ?? cdcPayload(st.ids)) : "flow unavailable"),
  })))
})
afterEach(() => vi.unstubAllGlobals())

describe("GET /api/pro-payment-scanner — auth", () => {
  it("401s with a wrong bearer token", async () => {
    const res = await GET(get("Bearer wrong"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })
  it("401s with no authorization header", async () => {
    expect((await GET(get())).status).toBe(401)
  })
})

describe("GET /api/pro-payment-scanner — treasury scan", () => {
  it("logs every on-chain moment when nothing is known yet", async () => {
    const body = await (await GET(authed())).json()
    expect(body.scanned).toBe(true)
    expect(body.total_on_chain).toBe(2)
    expect(body.new_moments).toBe(2)
    expect(body.logged).toBe(2)
    expect(body.pro_activated).toBe(0)
  })

  it("diffs against pro_payment_log and only logs the unseen ids", async () => {
    st.ids = ["101", "102", "103"]
    st.known = { data: [{ moment_nft_id: "101" }, { moment_nft_id: "102" }] }
    const body = await (await GET(authed())).json()
    expect(body.total_on_chain).toBe(3)
    expect(body.new_moments).toBe(1)
    expect(body.logged).toBe(1)
  })

  it("does not count an insert that errors", async () => {
    st.insertErr = { message: "insert down" }
    const body = await (await GET(authed())).json()
    expect(body.new_moments).toBe(2)
    expect(body.logged).toBe(0)
  })

  it("handles a treasury with no TopShot capability (empty id array)", async () => {
    st.ids = []
    const body = await (await GET(authed())).json()
    expect(body.total_on_chain).toBe(0)
    expect(body.new_moments).toBe(0)
    expect(body.logged).toBe(0)
  })

  it("tolerates a null pro_payment_log read (treats everything as new)", async () => {
    st.known = { data: null }
    expect((await (await GET(authed())).json()).new_moments).toBe(2)
  })

  it("500s when the Flow script call returns a non-ok status", async () => {
    st.flowOk = false
    const res = await GET(authed())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toContain("Flow script failed: 503")
  })

  it("500s when the Flow body is not a decodable JSON-CDC payload", async () => {
    st.flowBody = '"bm90LWpzb24="' // base64 of "not-json"
    expect((await GET(authed())).status).toBe(500)
  })
})
