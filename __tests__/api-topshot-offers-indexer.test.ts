import { describe, it, expect, vi } from "vitest"

// Route integration test for /api/topshot-offers-indexer. POST is Bearer
// INGEST_SECRET_TOKEN (or ?token=) gated → fail-closed 401. GET is an unauthed
// status probe returning the open TopShot offer count. Mocks supabaseAdmin (the
// GET count query).

const state: { count: number; error: any } = { count: 3, error: null }
vi.mock("@/lib/supabase", () => {
  const b: any = { select: () => b, eq: () => b, then: (r: any) => r({ count: state.count, error: state.error }) }
  return { supabaseAdmin: { from: () => b, rpc: async () => ({ data: null, error: null }) } }
})

import { GET, POST } from "@/app/api/topshot-offers-indexer/route"

const req = (u: string, headers: Record<string, string> = {}) =>
  ({ nextUrl: new URL(u), headers: new Headers(headers) }) as any

describe("/api/topshot-offers-indexer", () => {
  it("POST 401s without a token (fail-closed)", async () => {
    expect((await POST(req("https://t/api/topshot-offers-indexer"))).status).toBe(401)
  })
  it("GET returns the open-offer count", async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.openTopShotOffers).toBe(3)
  })
})
