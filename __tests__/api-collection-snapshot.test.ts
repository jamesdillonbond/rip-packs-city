import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/collection-snapshot (backs the public /share
// card). Mocks @supabase/supabase-js so the module-level client's .rpc is
// controllable. Pins the required-param guard, the RPC field mapping, and the
// error fallback shape.

const rpcState: { data: any; error: any; throws: unknown } = { data: null, error: null, throws: null }

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async () => {
      // supabase-js RESOLVES most query errors, but the transport can still
      // THROW (a fetch failure, an abort). That throw is what the route catch
      // handles, and until 2026-08-25 it answered 200 -- so the suite needs a
      // way to produce it.
      if (rpcState.throws) throw rpcState.throws
      return { data: rpcState.data, error: rpcState.error }
    },
  }),
}))

import { GET } from "@/app/api/collection-snapshot/route"

function req(url: string) {
  return { nextUrl: new URL(url) } as any
}

beforeEach(() => {
  rpcState.data = null
  rpcState.error = null
  rpcState.throws = null
})

describe("GET /api/collection-snapshot", () => {
  it("400s when wallet is missing/blank", async () => {
    expect((await GET(req("https://t/api/collection-snapshot"))).status).toBe(400)
    expect((await GET(req("https://t/api/collection-snapshot?wallet=%20%20"))).status).toBe(400)
  })

  it("maps the RPC snapshot into the card payload", async () => {
    rpcState.data = {
      totalMoments: 1200,
      totalFmv: 34567.89,
      topMoments: [{ id: "m1" }],
      badgeCount: 7,
      seriesBreakdown: { "4": 10 },
      perCollection: [{ slug: "nba-top-shot" }],
      rarest: { id: "r1" },
    }
    const res = await GET(req("https://t/api/collection-snapshot?wallet=0xABC"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.wallet).toBe("0xABC")
    expect(body.totalMoments).toBe(1200)
    expect(body.totalFmv).toBe(34567.89)
    expect(body.badgeCount).toBe(7)
    expect(body.topMoments).toHaveLength(1)
  })

  it("defaults missing snapshot fields to safe zeros/empties", async () => {
    rpcState.data = {}
    const body = await (await GET(req("https://t/api/collection-snapshot?wallet=0xABC"))).json()
    expect(body.totalMoments).toBe(0)
    expect(body.totalFmv).toBe(0)
    expect(body.topMoments).toEqual([])
    expect(body.seriesBreakdown).toEqual({})
  })

  it("500s when the RPC returns an error", async () => {
    rpcState.error = { message: "boom" }
    const res = await GET(req("https://t/api/collection-snapshot?wallet=0xABC"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("Failed to fetch wallet data")
  })
})

// ── The branch this file did not exercise, found 2026-08-25 ─────────────────
//
// The suite above pins the `error` branch (500) and the field mapping. It never
// entered the `catch` — and the catch was the one that lied. It returned
//
//   { wallet, totalMoments: 0, totalFmv: 0, ..., error: err.message }
//
// with NO status, i.e. **200**, under `Cache-Control: public, s-maxage=60`.
//
// 🚨 Every one of this route's five consumers discriminates on `res.ok`, each
// with a comment explaining why, exactly as CLAUDE.md's honesty table says to.
// `res.ok` is TRUE for a 200. So five careful consumer-side fixes could not fire
// for the failure that actually happens, and the worst of them —
// /api/og/share — publishes "$0.00 / 0 moments" about a NAMED wallet into an
// edge-cached PNG, which is the precise sentence its own header says it was
// fixed to stop.
//
// These pin the STATUS and the ABSENCE of the fabricated figures, not the
// presence of an error string: a body carrying both `error` and `totalFmv: 0`
// is exactly what shipped, and asserting "has an error field" passes against it.
describe("a THROWN read must not be published as a zeroed collection", () => {
  it("does not answer 200 when the rpc throws", async () => {
    rpcState.throws = new Error("fetch failed")
    const res = await GET(req("https://t/api/collection-snapshot?wallet=0xABC"))
    expect(res.status).not.toBe(200)
    expect(res.status).toBeGreaterThanOrEqual(500)
  })

  it("publishes NO totals at all rather than zeroed ones", async () => {
    rpcState.throws = new Error("fetch failed")
    const body = await (await GET(req("https://t/api/collection-snapshot?wallet=0xABC"))).json()
    // The shipped defect was `totalFmv: 0` beside an `error` key. A reader —
    // and the OG card — cannot tell that from an empty wallet.
    expect(body.totalFmv).toBeUndefined()
    expect(body.totalMoments).toBeUndefined()
    expect(body.badgeCount).toBeUndefined()
  })

  it("is not CDN-cacheable, so a blip is not pinned for the TTL", async () => {
    // The old failure carried `public, s-maxage=60, stale-while-revalidate=120`
    // — a failed read served to everyone for a minute.
    rpcState.throws = new Error("fetch failed")
    const res = await GET(req("https://t/api/collection-snapshot?wallet=0xABC"))
    expect(res.headers.get("cache-control") ?? "").not.toMatch(/s-maxage/)
  })

  it("classifies a statement timeout as a retryable 503, not a hard 500", async () => {
    // Under the saturation this platform actually experiences, the timeout is
    // the common failure. 503 keeps it out of the hard-5xx budget and tells the
    // caller retrying is reasonable.
    rpcState.throws = { code: "57014", message: "canceling statement due to statement timeout" }
    const res = await GET(req("https://t/api/collection-snapshot?wallet=0xABC"))
    expect(res.status).toBe(503)
    expect((await res.json()).retryable).toBe(true)
  })

  it("NO-CHANGE CONTROL: a genuinely empty wallet still answers 200 with zeros", async () => {
    // Without this, "never return zeros" would satisfy every case above by
    // breaking the real answer for a wallet that holds nothing — which is a
    // true statement and must keep rendering.
    rpcState.data = {}
    const res = await GET(req("https://t/api/collection-snapshot?wallet=0xABC"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totalMoments).toBe(0)
    expect(body.totalFmv).toBe(0)
  })
})
