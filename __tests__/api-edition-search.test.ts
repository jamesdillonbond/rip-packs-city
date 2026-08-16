import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/edition-search. No auth gate. Mocks
// @/lib/supabase supabaseAdmin with a thenable builder — the handler builds
// .from().select().limit() then conditionally .eq()/.ilike() and awaits the
// query. Pins the empty-`q` short-circuit, the happy path (mapped rows), and
// the query-error → 500.

const state: { data: any; error: any } = { data: [], error: null }

// ⚠ The stub HONOURS .limit(n). It used to ignore the argument and return
// state.data whole, which made the route's over-fetch-then-de-duplicate
// property untestable: shrinking the fetch limit to the result limit changed
// nothing observable, so a mutation that reintroduced "cap before de-dupe"
// passed. A mock that quietly ignores the very parameter under test turns its
// assertions into decoration.
vi.mock("@/lib/supabase", () => {
  let cap = Infinity
  const b: any = {
    select: () => b,
    limit: (n: number) => {
      cap = n
      return b
    },
    eq: () => b,
    ilike: () => b,
    then: (resolve: any) =>
      resolve({
        data: Array.isArray(state.data) ? state.data.slice(0, cap) : state.data,
        error: state.error,
      }),
  }
  return { supabaseAdmin: { from: () => b } }
})

import { GET } from "@/app/api/edition-search/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.data = []
  state.error = null
})

describe("GET /api/edition-search", () => {
  it("returns an empty result set for a blank query", async () => {
    const res = await GET(req("https://t/api/edition-search"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ results: [] })
  })

  it("maps rows for a player-name query", async () => {
    state.data = [
      { id: "u1", external_id: "84:2892", player_name: "Damian Lillard", set_name: "Base", tier: "COMMON", collection_id: "c1" },
    ]
    const res = await GET(req("https://t/api/edition-search?q=Lillard"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results).toHaveLength(1)
    expect(body.results[0]).toMatchObject({ external_id: "84:2892", player_name: "Damian Lillard" })
  })

  it("500s on a query error", async () => {
    state.error = { message: "db down" }
    const res = await GET(req("https://t/api/edition-search?q=84:2892"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain("db down")
  })
})

describe("GET /api/edition-search — Top Shot's dual key convention", () => {
  const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
  const AD = "dee28451-5d62-409e-a1ad-a83f763ac070"

  // This route backs the alert-create modal. `editions` stores every Top Shot
  // moment under BOTH the int setID:playID key and a UUID pair, so an
  // unfiltered name search shows the same moment twice, indistinguishably.
  // Picking the twin creates an alert against an FMV that is not maintained:
  // measured 2026-08-15, twin snapshots average 63.4 days old (max 75) while
  // canonical ones average 1.2 and none exceed 7 — the alert never fires right.
  it("returns one row per moment, keeping the int-keyed Top Shot row", async () => {
    state.data = [
      { id: "u1", external_id: "48:1652", player_name: "Damian Lillard", set_name: "Archive Set", tier: "COMMON", collection_id: TS },
      { id: "u2", external_id: "9e89b552-0236-4ffc-ab6b:d01a3af4-dce1-499a", player_name: "Damian Lillard", set_name: "Archive Set", tier: "COMMON", collection_id: TS },
    ]
    const res = await GET(req("https://t/api/edition-search?q=Lillard"))
    const body = await res.json()
    expect(body.results).toHaveLength(1)
    expect(body.results[0].external_id).toBe("48:1652")
  })

  it("keeps a UUID-keyed row from a collection where that IS canonical", async () => {
    // ⚠ All Day / Golazos / UFC / Candy are 100% UUID-keyed; filtering them by
    // the int-key predicate would return nothing at all.
    state.data = [
      { id: "u3", external_id: "9e89b552-0236-4ffc-ab6b", player_name: "Patrick Mahomes", set_name: "Base", tier: "COMMON", collection_id: AD },
    ]
    const res = await GET(req("https://t/api/edition-search?q=Mahomes"))
    expect((await res.json()).results).toHaveLength(1)
  })

  it("still fills ten results when duplicates are present", async () => {
    // The cap is applied AFTER de-duplication — filtering a .limit(10) would
    // silently return fewer than ten rows to the modal.
    state.data = Array.from({ length: 30 }, (_, i) =>
      i % 2 === 0
        ? { id: `c${i}`, external_id: `48:${i}`, player_name: "Dame", set_name: "S", tier: "COMMON", collection_id: TS }
        : { id: `t${i}`, external_id: `9e89b552-0236-4ffc-ab6b:${i}`, player_name: "Dame", set_name: "S", tier: "COMMON", collection_id: TS },
    )
    const res = await GET(req("https://t/api/edition-search?q=Dame"))
    const body = await res.json()
    expect(body.results).toHaveLength(10)
    expect(body.results.every((r: any) => /^\d+:\d+/.test(r.external_id))).toBe(true)
  })
})
