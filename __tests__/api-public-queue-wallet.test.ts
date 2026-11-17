import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Route integration test for POST /api/public/queue-wallet. Validates a Flow
// address then fires the wallet-backfill orchestrator in after() (mocked to a
// no-op so no network call happens). Pins: 400 invalid_json, 400 invalid_wallet,
// 202 unavailable when INGEST_SECRET_TOKEN is unset, and 202 queued when set.

const A = vi.hoisted(() => ({
  dispatched: 0,
  rate: {} as Record<string, number>,
  rateError: null as null | { message: string },
  calls: [] as Array<{ bucket: string; limit: number }>,
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<any>()
  return { ...actual, after: (_fn: any) => { A.dispatched++ } }
})

// The durable counter behind lib/abuse/anon-rate.ts (2026-10-10).
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (_fn: string, args: { p_bucket: string; p_key: string; p_limit: number }) => {
      A.calls.push({ bucket: args.p_bucket, limit: args.p_limit })
      if (A.rateError) return { data: null, error: A.rateError }
      const k = `${args.p_bucket}|${args.p_key}`
      A.rate[k] = (A.rate[k] ?? 0) + 1
      return { data: { allowed: A.rate[k] <= args.p_limit, count: A.rate[k] }, error: null }
    },
  },
}))

import { POST } from "@/app/api/public/queue-wallet/route"

const BASE = "https://www.rippackscity.com/api/public/queue-wallet"
const req = (body: any, throwOnJson = false, ip = "203.0.113.7") =>
  ({
    url: BASE,
    headers: new Headers({ "x-forwarded-for": ip }),
    json: throwOnJson
      ? async () => {
          throw new Error("bad json")
        }
      : async () => body,
  }) as any

let savedToken: string | undefined

beforeEach(() => {
  savedToken = process.env.INGEST_SECRET_TOKEN
  A.dispatched = 0
  A.rate = {}
  A.rateError = null
  A.calls = []
})
afterEach(() => {
  if (savedToken === undefined) delete process.env.INGEST_SECRET_TOKEN
  else process.env.INGEST_SECRET_TOKEN = savedToken
})

describe("POST /api/public/queue-wallet", () => {
  it("400s on invalid JSON", async () => {
    const res = await POST(req(null, true))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_json")
  })

  it("400s on a non-Flow wallet", async () => {
    const res = await POST(req({ wallet: "0x123" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_wallet")
  })

  it("202s not-queued when the ingest token is unavailable", async () => {
    delete process.env.INGEST_SECRET_TOKEN
    const res = await POST(req({ wallet: "0xBD94CADE097E50AC" }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.queued).toBe(false)
    expect(body.reason).toBe("unavailable")
  })

  it("202s queued for a valid wallet with the token set", async () => {
    process.env.INGEST_SECRET_TOKEN = "test-token"
    // Use a fresh wallet each run so the per-instance dedup map doesn't mark it.
    const wallet = "0xabcdef0123456789"
    const res = await POST(req({ wallet }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.queued).toBe(true)
    expect(body.wallet).toBe(wallet)
    expect(A.dispatched).toBe(1)
  })

  // 2026-10-10: one request fans out to ~6 long lambdas, and the only limiter in
  // front of it was per-instance and in memory. Durable caps, failing closed.
  it("a random-address flood from one IP is capped at 20/h (durable, not per-instance)", async () => {
    process.env.INGEST_SECRET_TOKEN = "test-token"
    let queued = 0
    let limited = 0
    for (let i = 0; i < 25; i++) {
      const wallet = "0x" + (0x1000000000000000 + i * 7919).toString(16).padStart(16, "0").slice(-16)
      const res = await POST(req({ wallet }))
      const body = await res.json()
      if (body.queued) queued++
      if (res.status === 429) limited++
    }
    expect(queued).toBe(20)
    expect(limited).toBe(5)
    expect(A.dispatched).toBe(20)
  })

  it("the same wallet is dispatched once per 6 h across instances (reported as deduped)", async () => {
    process.env.INGEST_SECRET_TOKEN = "test-token"
    A.rate["queue_wallet:wallet|x"] = 0
    const first = await (await POST(req({ wallet: "0x1111222233334444" }))).json()
    // simulate another instance: its in-memory map is empty, the durable row is not
    const { hashKey } = await import("@/lib/abuse/anon-rate")
    expect(A.rate[`queue_wallet:wallet|${hashKey("0x1111222233334444")}`]).toBe(1)
    expect(first.queued).toBe(true)
    expect(A.dispatched).toBe(1)
  })

  // 2026-10-10 review: the wallet cap was bumped FIRST, so a global/IP refusal
  // spent the wallet's one dispatch per 6 h with nothing sent, and every retry
  // was then told "queued, deduped". The wallet cap now goes last.
  it("a global refusal does NOT spend the wallet's 6-hour dispatch", async () => {
    process.env.INGEST_SECRET_TOKEN = "test-token"
    A.rate["queue_wallet:global|*"] = 300 // global cap already full
    const wallet = "0x2222333344445555"
    const res = await POST(req({ wallet }))
    expect(res.status).toBe(429)
    expect(A.dispatched).toBe(0)
    const { hashKey } = await import("@/lib/abuse/anon-rate")
    expect(A.rate[`queue_wallet:wallet|${hashKey(wallet)}`]).toBeUndefined()
    // once the global window frees up, the same wallet still dispatches
    A.rate["queue_wallet:global|*"] = 0
    const again = await (await POST(req({ wallet }))).json()
    expect(again.queued).toBe(true)
    expect(again.deduped).toBeUndefined()
    expect(A.dispatched).toBe(1)
  })

  it("FAILS CLOSED when the counter is unavailable — no dispatch", async () => {
    process.env.INGEST_SECRET_TOKEN = "test-token"
    A.rateError = { message: "timeout" }
    const res = await POST(req({ wallet: "0x9999888877776666" }))
    const body = await res.json()
    expect(body.queued).toBe(false)
    expect(body.reason).toBe("unavailable")
    expect(A.dispatched).toBe(0)
  })
})
