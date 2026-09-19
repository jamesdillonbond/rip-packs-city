import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/cache-refresh. This route is public (no
// bearer auth) but guards on the `wallet` (must start with 0x) and `collection`
// (must be a supported slug) params before any on-chain / DB work. We mock the
// FCL default export (@/lib/flow) so the zero-moments happy path returns without
// touching Supabase, and stub @onflow/types so the module imports cleanly.

const state: { ids: any; throwIds: boolean } = { ids: [], throwIds: false }

vi.mock("@/lib/chains/flow/flow", () => ({
  default: {
    query: async () => {
      if (state.throwIds) throw new Error("fcl down")
      return state.ids
    },
  },
}))
vi.mock("@onflow/types", () => ({ Address: "Address", UInt64: "UInt64" }))
vi.mock("@supabase/supabase-js", () => ({
  // The R98 cooldown read (select/eq/eq/order/limit) runs BEFORE the FCL call, so the
  // stub must be chainable; it answers "no cached rows", which never triggers a skip.
  createClient: () => ({
    from: () => {
      const b: any = {}
      for (const m of ["select", "eq", "in", "order", "limit", "update", "upsert", "insert"]) b[m] = () => b
      b.then = (resolve: any) => resolve({ data: [], error: null })
      return b
    },
  }),
}))

import { GET } from "@/app/api/cache-refresh/route"

const req = (url: string) => ({ nextUrl: new URL(url), headers: new Headers() }) as any

beforeEach(() => {
  state.ids = []
  state.throwIds = false
})

describe("GET /api/cache-refresh", () => {
  it("400s when wallet is missing", async () => {
    const res = await GET(req("https://t/api/cache-refresh"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("wallet param required")
  })

  it("400s when wallet does not start with 0x, and says THAT rather than 'required'", async () => {
    const res = await GET(req("https://t/api/cache-refresh?wallet=deadbeef"))
    expect(res.status).toBe(400)
    // ⚠ "absent" and "present but not a Flow address" were one message until
    // 2026-09-19 — `wallet param required (0x...)` for a param that was there.
    const err = (await res.json()).error
    expect(err).toContain("Flow address")
    expect(err).not.toContain("required")
  })

  // ⛔ 2026-09-19 — A CANDY WALLET WAS TOLD ITS WALLET PARAM WAS MISSING. Both
  // guards were real; they were SEQUENCED so the wrong one spoke. This route is
  // Cadence-script-driven — COLLECTION_SCRIPTS holds exactly two entries — so
  // the honest diagnosis for candy-mlb is the collection, and it is the same
  // answer Golazos, Pinnacle and UFC have always received here.
  it("diagnoses the COLLECTION first, so a base58 wallet is not told its param is missing", async () => {
    const CANDY = "12J1uhKQcBYauomKvXDP2MA6msT3k8wx8oHHhV8gENAK"
    const res = await GET(req(`https://t/api/cache-refresh?wallet=${CANDY}&collection=candy-mlb`))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain("Unsupported collection: candy-mlb")
    expect(body.error).not.toContain("wallet param required")
    // Names what it CAN serve, rather than leaving the caller to guess.
    expect(body.supported).toEqual(["nba-top-shot", "nfl-all-day"])
  })

  it("no-change control: the same answer for the Flow collections this route never served", async () => {
    // Candy is not a special case — it is the fourth member of an existing set.
    for (const slug of ["laliga-golazos", "disney-pinnacle", "ufc"]) {
      const res = await GET(req(`https://t/api/cache-refresh?wallet=0xbd94cade097e50ac&collection=${slug}`))
      expect(res.status, slug).toBe(400)
      expect((await res.json()).error, slug).toContain("Unsupported collection")
    }
  })

  it("400s on an unsupported collection slug", async () => {
    const res = await GET(
      req("https://t/api/cache-refresh?wallet=0xbd94cade097e50ac&collection=bogus-chain")
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("Unsupported collection")
  })

  it("returns a clean zero-state when the wallet holds no on-chain moments", async () => {
    state.ids = []
    const res = await GET(req("https://t/api/cache-refresh?wallet=0xbd94cade097e50ac"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.total_on_chain).toBe(0)
    expect(body.new_stubs_inserted).toBe(0)
  })

  it("502s when the FCL getIDs query throws", async () => {
    state.throwIds = true
    // The route awaits fcl.query(); a throw is caught → 502.
    const res = await GET(req("https://t/api/cache-refresh?wallet=0xbd94cade097e50ac"))
    expect(res.status).toBe(502)
  })
})
