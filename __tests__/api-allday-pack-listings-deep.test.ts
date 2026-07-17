import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeSupabaseFixture } from "./helpers/route-harness"

// Deep test for GET /api/allday-pack-listings — drives the full row-shaping
// contract (title, lowercased tier, moments-per-pack default, wei→dollar retail
// normalization, ask/listing coercion, startTime fallback) the shallow test only
// spot-checks, plus the POST accepted-envelope. NOTE: `after(runPackListings())`
// invokes the ingest body eagerly (before after() sees the promise), so the
// client is fully stubbed and empty editions/listings drive that deferred body
// to a clean no-op — its heavy grouping/upsert math over real data is left
// uncovered (deliberate: it's after-deferred ingest, not a user-facing read).

const state = vi.hoisted(() => ({ sb: null as unknown }))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})

import { GET, POST } from "@/app/api/allday-pack-listings/route"

const TOKEN = "test-ingest-token"

function install(fixtures: Record<string, unknown>) {
  state.sb = makeSupabaseFixture(fixtures as never)
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
  state.sb = null
})

describe("GET /api/allday-pack-listings — row shaping", () => {
  it("maps every field, lowercases tier, defaults moments-per-pack, and normalizes wei retail price", async () => {
    install({
      "rpc:get_pack_listings_by_collection": {
        data: [
          {
            id: "allday:base-rare",
            pack_name: "Base — RARE",
            tier: "RARE",
            image_url: "http://img/1",
            moments_per_pack: null,
            retail_price_usd: 900000000, // wei-denominated → $9
            lowest_ask_usd: 12.5,
            total_listed: 3,
            first_seen_at: null,
            cached_at: "2026-01-01T00:00:00Z",
          },
        ],
        error: null,
      },
    })

    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.listings).toHaveLength(1)
    expect(body.listings[0]).toMatchObject({
      packListingId: "allday:base-rare",
      distId: "allday:base-rare",
      title: "Base — RARE",
      tier: "rare", // lowercased
      imageUrl: "http://img/1",
      momentsPerPack: 1, // null → 1
      retailPrice: 9, // 900000000 / 1e8
      lowestAsk: 12.5,
      startTime: "2026-01-01T00:00:00Z", // first_seen_at null → cached_at
      listingCount: 3,
      packType: "standard",
      seriesLabel: null,
    })
  })

  it("returns an empty listings array when the RPC yields non-array data", async () => {
    install({ "rpc:get_pack_listings_by_collection": { data: null, error: null } })
    const body = await (await GET()).json()
    expect(body.listings).toEqual([])
  })
})

describe("POST /api/allday-pack-listings — accept envelope", () => {
  it("202-accepts with a startedAt timestamp for an authorized ingest trigger", async () => {
    // Empty editions/listings drive the eagerly-invoked runPackListings to a
    // clean no-op so no unhandled rejection escapes the fire-and-forget body.
    install({
      editions: { data: [], error: null },
      cached_listings: { data: [], error: null },
      pack_listings_cache: { data: null, error: null },
    })
    const headers = new Headers({ authorization: `Bearer ${TOKEN}` })
    const res = await POST(new NextRequest("https://t/api/allday-pack-listings", { method: "POST", headers }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("accepted")
    expect(typeof body.startedAt).toBe("string")
  })
})
