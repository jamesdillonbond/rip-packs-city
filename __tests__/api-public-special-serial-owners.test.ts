import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/special-serial-owners. The route
// validates collection/tag/tier against the board vocab, then delegates the read
// to fetchSpecialSerialOwners (lib/special-serial-owners-board). Keep the real
// consts (importOriginal) and stub only the fetch fn. We return rows with a null
// holder_address so the post-fetch @username resolve (a supabase read) short-
// circuits, keeping the test to the handler's own logic. Pins the 400 collection
// guard, the happy path, and the fetch-error → 500.

const fetchState: { rows: any[]; err: any } = { rows: [], err: null }

vi.mock("@/lib/special-serial-owners-board", async (importOriginal) => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    fetchSpecialSerialOwners: async () => {
      if (fetchState.err) throw fetchState.err
      return fetchState.rows
    },
  }
})

// supabaseAdmin is only touched for the username resolve, which we skip by
// returning holder_address: null; provide a harmless stub so the import resolves.
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: () => ({}) } }))

import { GET } from "@/app/api/public/special-serial-owners/route"

const req = (url: string) => ({ url, nextUrl: new URL(url) }) as any
const BASE = "https://t/api/public/special-serial-owners"

beforeEach(() => {
  fetchState.rows = []
  fetchState.err = null
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
    expect((await res.json()).error).toBe("rpc boom")
  })
})
