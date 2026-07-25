import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Route integration test for GET /api/wallet/profile (no prior coverage).
// Public read keyed by ?ownerKey, backed by get_user_profile plus an in-process
// 30s / 500-entry cache added to stop pooler saturation. Legs pinned: the
// missing/"null"/"undefined" 400 guards, the RPC error 500 and the thrown-RPC
// 500, the cache MISS→HIT transition (x-rpc-cache header + a single RPC call),
// TTL expiry re-fetching, and LRU eviction past the cap. Every test uses a unique
// ownerKey because the cache is module-level and persists across tests.

const st = { data: { name: "trevor" } as any, error: null as any, throws: false, calls: 0 }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => {
      st.calls++
      if (st.throws) throw new Error("pool exhausted")
      return { data: st.data, error: st.error }
    },
  },
}))

import { GET } from "@/app/api/wallet/profile/route"

const req = (ownerKey?: string) =>
  ({ nextUrl: new URL(`https://t/api/wallet/profile${ownerKey === undefined ? "" : `?ownerKey=${ownerKey}`}`) }) as any

let seq = 0
const uniqueKey = () => `owner-${Date.now()}-${seq++}`

beforeEach(() => {
  st.data = { name: "trevor" }
  st.error = null
  st.throws = false
  st.calls = 0
})
afterEach(() => vi.useRealTimers())

describe("GET /api/wallet/profile — guards", () => {
  it("400s without an ownerKey", async () => {
    const res = await GET(req())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("ownerKey param required")
  })
  it("400s on the literal string 'null' (empty-localStorage coercion)", async () => {
    expect((await GET(req("null"))).status).toBe(400)
  })
  it("400s on the literal string 'undefined'", async () => {
    expect((await GET(req("undefined"))).status).toBe(400)
  })
  it("400s on a whitespace-only ownerKey", async () => {
    expect((await GET(req("%20%20"))).status).toBe(400)
  })
})

describe("GET /api/wallet/profile — RPC failures", () => {
  it("500s and surfaces the message when the RPC returns an error", async () => {
    st.error = { message: "statement timeout", code: "57014", hint: "h", details: "d" }
    const res = await GET(req(uniqueKey()))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("statement timeout")
  })
  it("500s when the RPC throws outright", async () => {
    st.throws = true
    const res = await GET(req(uniqueKey()))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("pool exhausted")
  })
  it("does not cache a failed lookup (the next call re-hits the RPC)", async () => {
    const key = uniqueKey()
    st.error = { message: "down" }
    await GET(req(key))
    st.error = null
    const res = await GET(req(key))
    expect(res.status).toBe(200)
    expect(st.calls).toBe(2)
  })
})

describe("GET /api/wallet/profile — cache", () => {
  it("MISSes then HITs, calling the RPC only once", async () => {
    const key = uniqueKey()
    const first = await GET(req(key))
    expect(first.headers.get("x-rpc-cache")).toBe("miss")
    expect(await first.json()).toEqual({ name: "trevor" })

    st.data = { name: "changed-underneath" }
    const second = await GET(req(key))
    expect(second.headers.get("x-rpc-cache")).toBe("hit")
    expect(await second.json()).toEqual({ name: "trevor" }) // served from cache
    expect(st.calls).toBe(1)
  })

  it("re-fetches once the 30s TTL expires", async () => {
    const key = uniqueKey()
    await GET(req(key))
    expect(st.calls).toBe(1)

    const realNow = Date.now
    try {
      Date.now = () => realNow() + 31_000 // past the 30s TTL
      const res = await GET(req(key))
      expect(res.headers.get("x-rpc-cache")).toBe("miss")
      expect(st.calls).toBe(2)
    } finally {
      Date.now = realNow
    }
  })

  it("logs a slow-RPC warning past 3s without changing the response", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const realNow = Date.now
    let n = 0
    try {
      // first call = rpcStart, second = after the await → 3.5s elapsed
      Date.now = () => realNow() + (n++ >= 1 ? 3_500 : 0)
      const res = await GET(req(uniqueKey()))
      expect(res.status).toBe(200)
    } finally {
      Date.now = realNow
      warn.mockRestore()
    }
  })

  it("evicts the oldest entry once the 500-entry cap is reached", async () => {
    const firstKey = uniqueKey()
    await GET(req(firstKey)) // cached
    // Fill past the cap so firstKey is evicted (oldest-out).
    for (let i = 0; i < 505; i++) await GET(req(`filler-${i}`))
    const callsBefore = st.calls
    const res = await GET(req(firstKey))
    expect(res.headers.get("x-rpc-cache")).toBe("miss") // evicted → re-fetched
    expect(st.calls).toBe(callsBefore + 1)
  })
})
