import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/special-serial-owners. The route
// validates collection/tag/tier against the board vocab, then delegates the read
// to fetchSpecialSerialOwners (lib/special-serial-owners-board). Keep the real
// consts (importOriginal) and stub only the fetch fn. We return rows with a null
// holder_address so the post-fetch @username resolve (a supabase read) short-
// circuits, keeping the test to the handler's own logic. Pins the 400 collection
// guard, the happy path, and the fetch-error → 500.

const fetchState: { rows: any[]; err: any; byPlayer: Record<string, any[]> | null; resolve: any } = { rows: [], err: null, byPlayer: null, resolve: null }

vi.mock("@/lib/special-serial-owners-board", async (importOriginal) => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    fetchSpecialSerialOwners: async (_sb: unknown, opts: { player?: string | null }) => {
      if (fetchState.err) throw fetchState.err
      if (fetchState.byPlayer) return fetchState.byPlayer[opts.player ?? ""] ?? []
      return fetchState.rows
    },
  }
})

// supabaseAdmin is only touched for the username resolve, which we skip by
// returning holder_address: null; provide a harmless stub so the import resolves.
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => ({}),
    // #207: resolve_player_name, for the accent-blind retry.
    rpc: async () => ({ data: fetchState.resolve, error: null }),
  },
}))

import { GET } from "@/app/api/public/special-serial-owners/route"

const req = (url: string) => ({ url, nextUrl: new URL(url) }) as any
const BASE = "https://t/api/public/special-serial-owners"

beforeEach(() => {
  fetchState.rows = []
  fetchState.err = null
  fetchState.byPlayer = null
  fetchState.resolve = null
})

describe("GET /api/public/special-serial-owners", () => {
  it("400s on an invalid collection", async () => {
    const res = await GET(req(`${BASE}?collection=bogus`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("collection must be one of")
  })

  it("400s on a tag invalid for the collection", async () => {
    const res = await GET(req(`${BASE}?tag=notatag`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("tag must be one of")
  })

  it("returns rows + meta on the happy path (default collection)", async () => {
    fetchState.rows = [{ holder_address: null, serial_number: 1, tag: "#1" }]
    const res = await GET(req(`${BASE}?sort=fmv`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.meta.source).toBe("topshot_special_serial_owners_mv")
    expect(body.meta.total_rows).toBe(1)
    expect(body.rows).toHaveLength(1)
  })

  it("500s when the fetch throws", async () => {
    fetchState.err = new Error("rpc boom")
    const res = await GET(req(BASE))
    expect(res.status).toBe(500)
    const body = await res.json()
    // The driver's own text must never reach an anon caller (deep-audit D3):
    // this route is under app/api/public/**, so proxy.ts serves it unauthenticated.
    expect(body.error).not.toContain("rpc boom")
    expect(body.code).toBe("internal")
    expect(body.retryable).toBe(false)
  })
})

// #207 (2026-10-21): the board RPC ILIKEs p_player accent-sensitively.
describe("GET /api/public/special-serial-owners — accent-blind player retry (#207)", () => {
  const ONE = { status: "one", query: "luka doncic", query_slug: "luka-doncic", matched_via: "exact", namesakes: [], aliases: [], identity: null, relations: [], matched_query_as: "exact",
    player: { id: "p1", name: "Luka Dončić", slug: "luka-doncic", team: null, edition_count: 1, labels: ["Luka Dončić"] } }
  const ROW = { holder_address: null, serial_number: 77, tag: "jersey", player_name: "Luka Dončić" }

  it("an empty unaccented search is retried with the resolved spelling and reported", async () => {
    fetchState.byPlayer = { "Luka Dončić": [ROW] }
    fetchState.resolve = ONE
    const body = await (await GET(req(`${BASE}?player=luka%20doncic`))).json()
    expect(body.rows).toHaveLength(1)
    expect(body.meta.player_resolved).toEqual({ from: "luka doncic", to: "Luka Dončić" })
  })

  it("a search that matched is untouched (no note), and an unresolvable name stays empty", async () => {
    fetchState.byPlayer = { "Luka Dončić": [ROW] }
    fetchState.resolve = ONE
    const hit = await (await GET(req(`${BASE}?player=Luka%20Don%C4%8Di%C4%87`))).json()
    expect(hit.rows).toHaveLength(1)
    expect(hit.meta.player_resolved).toBeUndefined()
    fetchState.resolve = { status: "none", query: "zzz" }
    const miss = await (await GET(req(`${BASE}?player=zzz`))).json()
    expect(miss.rows).toEqual([])
    expect(miss.meta.player_resolved).toBeUndefined()
  })
})
