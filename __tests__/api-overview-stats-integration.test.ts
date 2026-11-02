import { describe, it, expect, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeSupabaseFixture } from "./helpers/route-harness"

// Route-integration test for GET /api/overview-stats. Fans out to count queries
// + market-pulse / mover RPCs; makeSupabaseFixture's empty default drives the
// whole GET (standardStats + pinnacleStats dispatch, volume/mover assembly) to a
// stable 200 with zeroed stats, plus the unknown-collection branch.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: makeSupabaseFixture({}) }))

const { GET } = await import("@/app/api/overview-stats/route")
const get = (qs: string) => new NextRequest(`https://t/api/overview-stats${qs}`)

describe("GET /api/overview-stats — integration", () => {
  // INVERTED 2026-11-02: an unknown collection is refused, never answered with "empty stats".
  it("404s an unknown collection (no fabricated empty stats)", async () => {
    const res = await GET(get("?collection=not-real"))
    expect(res.status).toBe(404)
  })

  it("drives the standard (Top Shot) stats path to a stable 200", async () => {
    const res = await GET(get("?collection=nba-top-shot"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toBeTypeOf("object")
  })

  it("drives the Pinnacle stats path to a stable 200", async () => {
    const res = await GET(get("?collection=disney-pinnacle"))
    expect(res.status).toBe(200)
  })
})
