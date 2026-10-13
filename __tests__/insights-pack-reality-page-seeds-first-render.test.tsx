// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest"

// app/insights/pack-reality/page.tsx (review E2, 2026-10-13): the page reads
// the route body ONCE on the server, bounded, and hands it to the client as
// `initialData`. Three outcomes, pinned: clean read → the body is the seed;
// PARTIAL read (any leg in `errors`) → NULL, so ISR never caches a degraded
// payload as a claim (#33); total outage / bounded-read throw → NULL.

const read = vi.fn()
vi.mock("@/lib/insights/topshot-pack-reality", () => ({
  readTopshotPackReality: (...a: unknown[]) => read(...a),
}))
// fetchBoardForPage supplies the service-role client; the page never imports one.
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { tag: "admin-stub" } }))
const seen: unknown[] = []
vi.mock("@/app/insights/pack-reality/PackRealityClient", () => ({
  default: (props: { initialData?: unknown }) => {
    seen.push(props.initialData)
    return null
  },
}))

import PackRealityPage from "@/app/insights/pack-reality/page"

async function seed() {
  const el = await PackRealityPage()
  return (el as { props: { initialData?: unknown } }).props.initialData
}

const body = { meta: { fetched_at: "2026-10-13T14:00:00Z", errors: [] }, stats: { rips_60d: 69956 }, distribution: [], top_ev: [] }

beforeEach(() => {
  read.mockReset()
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("pack-reality page seeds the client from the shared route body", () => {
  it("seeds the body on a clean read, handing the lib the client fetchBoardForPage supplies and the route's default limit", async () => {
    read.mockResolvedValueOnce({ totalOutage: false, body, errors: [] })
    expect(await seed()).toEqual(body)
    expect(read).toHaveBeenLastCalledWith({ tag: "admin-stub" }, 10)
  })
  it("seeds NULL on a PARTIAL read — a degraded payload must not be ISR-cached as the first frame", async () => {
    read.mockResolvedValueOnce({
      totalOutage: false,
      body: { ...body, stats: null, meta: { ...body.meta, errors: [{ source: "topshot_pack_reality_stats", message: "unavailable" }] } },
      errors: [{ source: "topshot_pack_reality_stats", message: "unavailable" }],
    })
    expect(await seed()).toBeNull()
  })
  it("seeds NULL on a total outage", async () => {
    read.mockResolvedValueOnce({ totalOutage: true, error: new Error("boom"), errors: [] })
    expect(await seed()).toBeNull()
  })
  it("seeds NULL when the bounded read rejects — never throws out of the page", async () => {
    read.mockRejectedValueOnce(new Error("[insights/Top Shot pack reality] read exceeded 8000ms"))
    expect(await seed()).toBeNull()
  })
  it("the segment revalidates on the route's cache window, not per request", async () => {
    const mod = await import("@/app/insights/pack-reality/page")
    expect(mod.revalidate).toBe(300)
  })
})
