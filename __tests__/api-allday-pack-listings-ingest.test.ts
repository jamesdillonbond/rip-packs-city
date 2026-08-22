import { describe, it, expect, beforeEach, vi } from "vitest"

// Complements api-allday-pack-listings-deep.test.ts, which no-ops after() and so
// leaves runPackListings' grouping/upsert math uncovered. Here we CAPTURE the
// after() callback and run it, exercising the deferred ingest body: pagination,
// the set_name::tier grouping with lowest-ask + listed-count, the blank-set and
// non-positive-ask skips, the delete-then-chunked-upsert, and the editions-error
// early abort. Plus GET's rpc-error → 500 (the shaping success lives in the
// sibling file).

let capturedPromise: Promise<unknown> | null = null
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  // The route calls after(runPackListings()) — the ingest body is invoked EAGERLY
  // and its promise handed to after(); capture that promise and await it.
  return { ...actual, after: (p: Promise<unknown>) => { capturedPromise = p } }
})

const st = vi.hoisted(() => ({
  editions: { data: [] as any[] | null, error: null as any },
  listings: { data: [] as any[] | null, error: null as any },
  plc: { error: null as any },
  rpc: { data: [] as any[] | null, error: null as any },
  upserts: [] as any[],
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from(table: string) {
      const b: any = {
        select: () => b, eq: () => b, order: () => b, range: () => b, delete: () => b,
        upsert: (chunk: any[]) => { st.upserts.push(...chunk); return b },
        then: (resolve: any) => {
          if (table === "editions") return resolve(st.editions)
          if (table === "cached_listings") return resolve(st.listings)
          if (table === "pack_listings_cache") return resolve(st.plc)
          return resolve({ data: [], error: null })
        },
      }
      return b
    },
    rpc: async () => st.rpc,
  }),
}))

import { GET, POST } from "@/app/api/allday-pack-listings/route"

const post = (auth = "Bearer tok") => ({ headers: new Headers(auth ? { authorization: auth } : {}) }) as any

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "tok"
  capturedPromise = null
  st.editions = { data: [], error: null }
  st.listings = { data: [], error: null }
  st.plc = { error: null }
  st.rpc = { data: [], error: null }
  st.upserts = []
})

describe("POST /api/allday-pack-listings — deferred ingest body", () => {
  it("401 without the ingest bearer; after() not scheduled", async () => {
    const res = await POST(post(""))
    expect(res.status).toBe(401)
    expect(capturedPromise).toBeNull()
  })

  it("groups by set::tier, takes the lowest ask + listed count, skips blanks, and upserts", async () => {
    st.editions = {
      data: [
        { id: "e1", external_id: "1", set_name: "Base Set", tier: "COMMON", series: 1 },
        { id: "e2", external_id: "2", set_name: "Base Set", tier: "COMMON", series: 1 },
        { id: "e3", external_id: "3", set_name: "", tier: "RARE" }, // blank set → skipped
      ],
      error: null,
    }
    st.listings = {
      data: [
        { id: "l1", set_name: "Base Set", tier: "COMMON", ask_price: "50", thumbnail_url: "img1" },
        { id: "l2", set_name: "Base Set", tier: "COMMON", ask_price: "30", thumbnail_url: "img2" },
        { id: "l3", set_name: "Base Set", tier: "COMMON", ask_price: "0" }, // non-positive → ignored
      ],
      error: null,
    }
    const res = await POST(post())
    expect(res.status).toBe(200)
    await capturedPromise

    const g = st.upserts.find((r) => r.pack_name.startsWith("Base Set"))
    expect(g).toBeTruthy()
    expect(g.total_listed).toBe(2) // two positive-ask listings
    expect(g.lowest_ask_usd).toBe(30) // min ask
    expect(g.metadata.edition_count).toBe(2)
    expect(g.image_url).toBe("img1")
    // the blank-set edition never formed a group
    expect(st.upserts.every((r) => !r.pack_name.startsWith(" "))).toBe(true)
  })

  it("groups with no matching listing carry a null ask + 0 listed count", async () => {
    st.editions = { data: [{ id: "e1", set_name: "Lonely Set", tier: "RARE", series: 2 }], error: null }
    st.listings = { data: [], error: null }
    await POST(post())
    await capturedPromise
    const g = st.upserts.find((r) => r.pack_name.startsWith("Lonely Set"))
    expect(g.total_listed).toBe(0)
    expect(g.lowest_ask_usd).toBeNull()
  })

  it("an editions fetch error aborts before any upsert", async () => {
    st.editions = { data: null, error: { message: "editions down" } }
    await POST(post())
    await capturedPromise
    expect(st.upserts.length).toBe(0)
  })

  it("a cached_listings fetch error also aborts before any upsert", async () => {
    st.editions = { data: [{ id: "e1", set_name: "S", tier: "COMMON" }], error: null }
    st.listings = { data: null, error: { message: "listings down" } }
    await POST(post())
    await capturedPromise
    expect(st.upserts.length).toBe(0)
  })
})

describe("GET /api/allday-pack-listings — rpc error", () => {
  // ⚠ INVERTED 2026-08-22, not deleted. It pinned TWO defects as the contract:
  // `error === "rpc down"` (the /api/sets driver-message leak, on an UNGATED GET
  // whose sibling POST is token-gated) and `listings: []` shipped with the
  // failure. Reversed in place.
  it("rpc error → fails without leaking the driver message or faking an empty list", async () => {
    st.rpc = { data: null, error: { message: "rpc down" } }
    const res = await GET()
    expect(res.ok).toBe(false)
    const body = await res.json()
    expect(JSON.stringify(body)).not.toContain("rpc down")
    expect(body.listings).toBeUndefined()
    // Still says something — silence would be its own defect.
    expect(typeof body.error).toBe("string")
  })
})
