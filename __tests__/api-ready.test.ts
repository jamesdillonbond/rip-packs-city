import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/ready (GET, no auth). Runs the heavy
// health_check RPC via a @supabase/supabase-js createClient seam and folds
// per-collection telemetry into one response. Pins: RPC error → 500, a healthy
// payload → 200 "ok", and a stale payload → 503 "degraded".

const state: { data: any; error: any } = { data: null, error: null }

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ rpc: async () => ({ data: state.data, error: state.error }) }),
}))

import { GET } from "@/app/api/ready/route"

beforeEach(() => {
  state.data = null
  state.error = null
})

describe("GET /api/ready", () => {
  it("500s on a health_check RPC error", async () => {
    state.error = { message: "db down" }
    const res = await GET()
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.status).toBe("error")
    expect(body.error).toBe("db down")
  })

  it("returns 200 ok for a healthy payload", async () => {
    state.data = {
      fmv_pipeline: { is_stale: false, staleness_minutes: 3, per_collection: [] },
      data_integrity: { orphaned_editions_ok: true },
      sales_pipeline: { per_collection: [] },
      listing_cache: { per_collection: [] },
      collections: [{ slug: "nba_top_shot", name: "NBA Top Shot", editions: 100 }],
    }
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("ok")
    expect(body.per_collection[0].slug).toBe("nba-top-shot")
    expect(body.per_collection[0].db_slug).toBe("nba_top_shot")
    expect(body.overall_staleness_minutes).toBe(3)
  })

  it("returns 503 degraded when the fmv pipeline is stale", async () => {
    state.data = {
      fmv_pipeline: { is_stale: true, staleness_minutes: 999, per_collection: [] },
      data_integrity: { orphaned_editions_ok: true },
      collections: [],
    }
    const res = await GET()
    expect(res.status).toBe(503)
    expect((await res.json()).status).toBe("degraded")
  })
})
