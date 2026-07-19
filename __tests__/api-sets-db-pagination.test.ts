import { describe, it, expect, beforeEach, vi } from "vitest"

// Regression pin for the /api/sets-db PostgREST-1000-row-cap fix (2026-07-19):
// the editions catalog and the wallet's owned moments are now fetched via
// .range() windows, not a bare .limit(50000) that silently clamped to 1,000.
// This mock is page-aware (it slices tableData by the .range(from,to) it
// receives), so a set spanning >1,000 editions must report all of them — if the
// pagination loop were reverted to a single fetch, totalEditions would read 1000.

const tableData: Record<string, any[]> = {}

vi.mock("@/lib/supabase", () => {
  const makeBuilder = (table: string) => {
    let rng: [number, number] | null = null
    const b: any = {
      select: () => b,
      eq: () => b,
      not: () => b,
      limit: () => b,
      order: () => b,
      range: (from: number, to: number) => {
        rng = [from, to]
        return b
      },
      then: (resolve: any) => {
        const all = tableData[table] ?? []
        const data = rng ? all.slice(rng[0], rng[1] + 1) : all
        return resolve({ data, error: null })
      },
    }
    return b
  }
  return { supabaseAdmin: { from: (t: string) => makeBuilder(t) } }
})

import { GET } from "@/app/api/sets-db/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  for (const k of Object.keys(tableData)) delete tableData[k]
})

describe("GET /api/sets-db — pagination (1000-row cap)", () => {
  it("counts all editions of a set that spans more than one 1000-row page", async () => {
    // 1,250 editions in a single set => 2 pages (1000 + 250). A truncated fetch
    // would only see the first 1,000.
    tableData.editions = Array.from({ length: 1250 }, (_, i) => ({
      id: `e${i}`,
      set_id: "s1",
      set_name: "Mega Set",
      player_name: `Player ${i}`,
      tier: "COMMON",
      thumbnail_url: "http://example/img.png",
      external_id: `ext${i}`,
    }))
    tableData.sets = [{ id: "s1", name: "Mega Set" }]
    tableData.wallet_moments_cache = []

    const res = await GET(req("https://t/api/sets-db?wallet=0xabc&collection=nba-top-shot"))
    expect(res.status).toBe(200)
    const body = await res.json()
    const s1 = body.sets.find((s: any) => s.setId === "s1")
    expect(s1).toBeTruthy()
    expect(s1.totalEditions).toBe(1250)
  })

  it("counts owned moments that span more than one 1000-row page", async () => {
    // 1,100 editions, all owned by the wallet => the wmc read must also page.
    tableData.editions = Array.from({ length: 1100 }, (_, i) => ({
      id: `e${i}`,
      set_id: "s1",
      set_name: "Mega Set",
      player_name: `Player ${i}`,
      tier: "COMMON",
      thumbnail_url: "http://example/img.png",
      external_id: `ext${i}`,
    }))
    tableData.sets = [{ id: "s1", name: "Mega Set" }]
    tableData.wallet_moments_cache = Array.from({ length: 1100 }, (_, i) => ({
      moment_id: `m${i}`,
      edition_key: `ext${i}`,
      serial_number: i + 1,
      is_locked: false,
    }))

    const res = await GET(req("https://t/api/sets-db?wallet=0xabc&collection=nba-top-shot"))
    expect(res.status).toBe(200)
    const body = await res.json()
    const s1 = body.sets.find((s: any) => s.setId === "s1")
    expect(s1.totalEditions).toBe(1100)
    // every edition is owned exactly once => full completion across both pages
    expect(s1.ownedCount).toBe(1100)
    expect(s1.completionPct).toBe(100)
  })
})
