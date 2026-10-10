import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/fmv/demo (public, no-auth sample endpoint).
// Mocks @supabase/supabase-js; the handler chains .from().select().order()
// .limit() on fmv_snapshots then .from().select().in() on editions.

const tables: Record<string, { data: any; error?: any }> = {}

vi.mock("@supabase/supabase-js", () => {
  const builder = (table: string) => {
    const payload = () => tables[table] ?? { data: [], error: null }
    const b: any = {
      select: () => b,
      order: () => b,
      in: () => b,
      limit: () => b,
      then: (resolve: any) => resolve(payload()),
    }
    return b
  }
  // 2026-10-10 (#18): the example premiums come from the same fitted batch call /api/fmv makes.
  return { createClient: () => ({
    from: (t: string) => builder(t),
    rpc: async (name: string) => (name === "serial_fmv_multiplier_batch" ? (tables.__serial ?? { data: [], error: null }) : { data: [], error: null }),
  }) }
})

import { GET } from "@/app/api/fmv/demo/route"

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k]
})

describe("GET /api/fmv/demo", () => {
  it("returns the empty-state payload when there are no snapshots", async () => {
    tables.fmv_snapshots = { data: [] }
    const body = await (await GET()).json()
    expect(body.sampleCount).toBe(0)
    expect(body.samples).toEqual([])
    expect(body.note).toContain("No FMV data available")
  })

  it("500s on a snapshot query error", async () => {
    tables.fmv_snapshots = { data: null, error: { message: "db down" } }
    const res = await GET()
    expect(res.status).toBe(500)
    // The driver message must NOT be published — lib/api-error.ts classifies it.
    expect((await res.json()).error).not.toContain("db down")
  })

  it("builds samples whose serial examples come from the fitted batch call (re-pinned 2026-10-10, #18)", async () => {
    tables.fmv_snapshots = {
      data: [{ edition_id: "u1", fmv_usd: 100, confidence: "HIGH", computed_at: "2026-07-12T00:00:00Z" }],
    }
    tables.editions = { data: [{ id: "u1", external_id: "73:2785" }] }
    tables.__serial = { data: [
      { edition_id: "u1", serial: 1, multiplier: 7.66, basis: "first" },
      { edition_id: "u1", serial: 23, multiplier: 1, basis: "no_premium" },
      { edition_id: "u1", serial: 100, multiplier: 1, basis: "no_premium" },
    ], error: null }
    const body = await (await GET()).json()
    expect(body.sampleCount).toBe(1)
    const s = body.samples[0]
    expect(s.edition).toBe("73:2785")
    expect(s.fmv).toBe(100)
    expect(s.confidence).toBe("high") // lower-cased
    expect(s.exampleAdjustments.serial1).toMatchObject({ serialMult: 7.66, serialBasis: "first", adjustedFmv: 766 })
    expect(s.exampleAdjustments.serial23).toMatchObject({ serialMult: 1, adjustedFmv: 100 })
  })

  it("does not publish premiums it could not compute: a failed fitted read is a failure", async () => {
    tables.fmv_snapshots = {
      data: [{ edition_id: "u1", fmv_usd: 100, confidence: "HIGH", computed_at: "2026-07-12T00:00:00Z" }],
    }
    tables.editions = { data: [{ id: "u1", external_id: "73:2785" }] }
    tables.__serial = { data: null, error: { message: "estimator down" } }
    const res = await GET()
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(JSON.stringify(await res.json())).not.toContain("exampleAdjustments")
  })

  // HONESTY CANON. The `editions` read builds the id→external_id map every
  // sample is keyed on. It used to destructure only `data`, so a failed read
  // left the map empty, the sample loop `continue`d past every row, and the
  // route answered `sampleCount: 0, samples: []` next to the note "Real FMV
  // data from our LiveToken-powered ingest pipeline" — at HTTP 200, cached
  // `public, max-age=3600`, on the surface whose whole job is to show a
  // developer what the API returns. Pinned as the ABSENCE of the claim.
  it("does not publish an empty sample set when the editions read errored", async () => {
    tables.fmv_snapshots = {
      data: [{ edition_id: "u1", fmv_usd: 100, confidence: "HIGH", computed_at: "2026-07-12T00:00:00Z" }],
    }
    tables.editions = { data: null, error: { message: "canceling statement due to statement timeout" } }
    const res = await GET()
    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = await res.json()
    expect(body.sampleCount).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain("Real FMV data")
    // and the driver message stays server-side
    expect(JSON.stringify(body)).not.toContain("canceling statement")
  })

  it("dedupes samples by external edition id", async () => {
    tables.fmv_snapshots = {
      data: [
        { edition_id: "u1", fmv_usd: 100, confidence: "HIGH", computed_at: "2026-07-12T00:00:00Z" },
        { edition_id: "u1", fmv_usd: 90, confidence: "HIGH", computed_at: "2026-07-11T00:00:00Z" },
      ],
    }
    tables.editions = { data: [{ id: "u1", external_id: "73:2785" }] }
    const body = await (await GET()).json()
    expect(body.sampleCount).toBe(1)
  })
})
