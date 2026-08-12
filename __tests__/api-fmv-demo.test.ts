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
  return { createClient: () => ({ from: (t: string) => builder(t) }) }
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

  it("builds samples with serial-adjustment examples (serial1 = 12x)", async () => {
    tables.fmv_snapshots = {
      data: [{ edition_id: "u1", fmv_usd: 100, confidence: "HIGH", computed_at: "2026-07-12T00:00:00Z" }],
    }
    tables.editions = { data: [{ id: "u1", external_id: "73:2785" }] }
    const body = await (await GET()).json()
    expect(body.sampleCount).toBe(1)
    const s = body.samples[0]
    expect(s.edition).toBe("73:2785")
    expect(s.fmv).toBe(100)
    expect(s.confidence).toBe("high") // lower-cased
    expect(s.exampleAdjustments.serial1.adjustedFmv).toBe(1200) // 100 * 12
    expect(s.exampleAdjustments.serial23.adjustedFmv).toBe(280) // 100 * 2.8
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
