import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/collection-snapshot (backs the public /share
// card). Mocks @supabase/supabase-js so the module-level client's .rpc is
// controllable. Pins the required-param guard, the RPC field mapping, and the
// error fallback shape.

const rpcState: { data: any; error: any; throws: unknown; delayMs: number } = { data: null, error: null, throws: null, delayMs: 0 }
// #237: lib/wallet-indexed.ts existence reads (.from(t).select().eq().limit()); absent = no rows.
const idxState: { tables: Record<string, { data: any; error: any }>; reads: string[] } = { tables: {}, reads: [] }

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async () => {
      // supabase-js RESOLVES most query errors, but the transport can still
      // THROW (a fetch failure, an abort). That throw is what the route catch
      // handles, and until 2026-08-25 it answered 200 -- so the suite needs a
      // way to produce it.
      if (rpcState.delayMs) await new Promise((r) => setTimeout(r, rpcState.delayMs))
      if (rpcState.throws) throw rpcState.throws
      return { data: rpcState.data, error: rpcState.error }
    },
    from: (t: string) => ({
      select: () => ({
        eq: () => ({
          limit: async () => {
            idxState.reads.push(t)
            return idxState.tables[t] ?? { data: [], error: null }
          },
        }),
      }),
    }),
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
  rpcState.delayMs = 0
  idxState.tables = {}
  idxState.reads = []
  vi.useRealTimers()
})

describe("GET /api/collection-snapshot — indexed (#237)", () => {
  const EMPTY = { totalMoments: 0, totalFmv: 0, topMoments: [] }
  const W = "https://t/api/collection-snapshot?wallet=0xbd94cade097e50ac"

  it("⚠ an empty snapshot of a wallet RPC never walked says indexed:false", async () => {
    rpcState.data = EMPTY
    const body = await (await GET(req(W))).json()
    expect(body.totalMoments).toBe(0)
    expect(body.indexed).toBe(false)
  })

  it("an empty snapshot of a wallet walked clean says indexed:true (it really holds nothing)", async () => {
    rpcState.data = EMPTY
    idxState.tables = { wmc_clean_walks: { data: [{ wallet_address: "0xbd94cade097e50ac" }], error: null } }
    expect((await (await GET(req(W))).json()).indexed).toBe(true)
  })

  it("a failed index read is indexed:null — unknown, never false — and the answer still comes", async () => {
    rpcState.data = EMPTY
    idxState.tables = { wallet_moments_cache: { data: null, error: { message: "timeout" } } }
    const res = await GET(req(W))
    expect(res.status).toBe(200)
    expect((await res.json()).indexed).toBeNull()
  })

  it("a non-Flow address is indexed:null (the helper cannot judge it)", async () => {
    rpcState.data = EMPTY
    const body = await (await GET(req("https://t/api/collection-snapshot?wallet=7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"))).json()
    expect(body.indexed).toBeNull()
  })

  it("a populated snapshot is indexed:true and pays no index read", async () => {
    rpcState.data = { ...EMPTY, totalMoments: 3 }
    expect((await (await GET(req(W))).json()).indexed).toBe(true)
    expect(idxState.reads).toEqual([])
  })
})

describe("GET /api/collection-snapshot", () => {
  // 2026-10-22: an EMPTY snapshot is transitional (the share page's empty state polls and reloads
  // on it); pinned at the CDN for 300 s it made /share/<wallet> reload every ~9 s for ~6 minutes.
  it("an empty snapshot is never CDN-cached; a populated one is (control)", async () => {
    rpcState.data = { totalMoments: 0 }
    const empty = await GET(req("https://t/api/collection-snapshot?wallet=0xABC"))
    expect(empty.status).toBe(200)
    expect(empty.headers.get("Cache-Control")).toBe("no-store")
    rpcState.data = { totalMoments: 5 }
    const full = await GET(req("https://t/api/collection-snapshot?wallet=0xABC"))
    expect(full.headers.get("Cache-Control")).toContain("s-maxage=300")
  })

  // #228 lever (b), 2026-11-08: a whale's snapshot reads 11–24 s cold, and its visits come hours
  // apart, so the CDN must keep answering from the last good copy while it recomputes.
  it("a populated snapshot is served stale for 6 h while it revalidates; a failed read is never stored", async () => {
    rpcState.data = { totalMoments: 53604 }
    const full = await GET(req("https://t/api/collection-snapshot?wallet=0xf5d1b36f376ee7f3"))
    const cc = full.headers.get("Cache-Control") ?? ""
    expect(cc).toContain("s-maxage=300")
    expect(Number(cc.match(/stale-while-revalidate=(\d+)/)?.[1])).toBeGreaterThanOrEqual(21600)
    rpcState.data = null
    rpcState.error = { message: "canceling statement due to statement timeout", code: "57014" }
    const failed = await GET(req("https://t/api/collection-snapshot?wallet=0xf5d1b36f376ee7f3"))
    expect(failed.ok).toBe(false)
    expect(failed.headers.get("cache-control") ?? "").not.toMatch(/s-maxage|stale-while-revalidate/)
  })

  // #228 (2026-11-09): four 11-08 timeouts could not be tied to a wallet because the
  // shared error line carries no query string. The failure line now names it.
  it("a failed read logs WHICH wallet and how long it waited", async () => {
    rpcState.error = { message: "canceling statement due to statement timeout", code: "57014" }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const res = await GET(req("https://t/api/collection-snapshot?wallet=0xb7700366fa738a43"))
      expect(res.status).toBe(503)
      const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes("read_failed"))
      expect(line).toMatch(/wallet=0xb7700366fa738a43 elapsed_ms=\d+/)
    } finally {
      warn.mockRestore()
    }
  })

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
      seriesBars: [{ label: "Series 3", count: 10, series_number: 4 }],
      seriesCollection: { slug: "nba_top_shot", name: "NBA Top Shot" },
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
    // 2026-09-24: the ordered one-collection bars travel with their collection.
    expect(body.seriesBars).toEqual([{ label: "Series 3", count: 10, series_number: 4 }])
    expect(body.seriesCollection).toEqual({ slug: "nba_top_shot", name: "NBA Top Shot" })
  })

  it("defaults missing snapshot fields to safe zeros/empties", async () => {
    rpcState.data = {}
    const body = await (await GET(req("https://t/api/collection-snapshot?wallet=0xABC"))).json()
    expect(body.totalMoments).toBe(0)
    expect(body.totalFmv).toBe(0)
    expect(body.topMoments).toEqual([])
    expect(body.seriesBreakdown).toEqual({})
    expect(body.seriesBars).toEqual([])
    expect(body.seriesCollection).toBeNull()
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

  // #228, 2026-11-04: an 11 s cold whale read used to be abandoned at the 8 s default and answered
  // 503 while the query finished in the database anyway. It now answers; a stuck read still 503s.
  it("a cold whale read slower than 8 s answers 200; one past the route budget is still an honest 503", async () => {
    vi.useFakeTimers()
    rpcState.data = { totalMoments: 70280, totalFmv: 1 }
    rpcState.delayMs = 11_300
    const slow = GET(req("https://t/api/collection-snapshot?wallet=0xABC"))
    await vi.advanceTimersByTimeAsync(11_300)
    const ok = await slow
    expect(ok.status).toBe(200)
    expect((await ok.json()).totalMoments).toBe(70280)

    rpcState.delayMs = 25_000
    const stuck = GET(req("https://t/api/collection-snapshot?wallet=0xABC"))
    await vi.advanceTimersByTimeAsync(25_000)
    const res = await stuck
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
