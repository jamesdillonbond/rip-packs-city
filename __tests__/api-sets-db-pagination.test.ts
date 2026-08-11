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

describe("GET /api/sets-db — ownership aggregation", () => {
  it("dedupes duplicate-copy ownership, counts locked vs tradeable, and ignores an unknown edition_key", async () => {
    // 5 editions in one set. e0 has NULL tier + NULL player_name (fallback paths).
    tableData.editions = [
      { id: "e0", set_id: "s1", set_name: "Ignored", player_name: null, tier: null, thumbnail_url: null, external_id: "ext0" },
      { id: "e1", set_id: "s1", set_name: "Ignored", player_name: "P1", tier: "RARE", thumbnail_url: "u1", external_id: "ext1" },
      { id: "e2", set_id: "s1", set_name: "Ignored", player_name: "P2", tier: "COMMON", thumbnail_url: "u2", external_id: "ext2" },
      { id: "e3", set_id: "s1", set_name: "Ignored", player_name: "P3", tier: "COMMON", thumbnail_url: "u3", external_id: "ext3" },
      { id: "e4", set_id: "s1", set_name: "Ignored", player_name: "P4", tier: "COMMON", thumbnail_url: "u4", external_id: "ext4" },
    ]
    tableData.sets = [{ id: "s1", name: "Flow Legends" }]
    tableData.wallet_moments_cache = [
      { moment_id: "m1", edition_key: "ext0", serial_number: 5, is_locked: true }, // locked owned
      { moment_id: "m2", edition_key: "ext0", serial_number: 3, is_locked: false }, // duplicate copy of e0
      { moment_id: "m3", edition_key: "ext1", serial_number: 2, is_locked: false }, // tradeable owned
      { moment_id: "m4", edition_key: "extZZ", serial_number: 1, is_locked: false }, // not in editions -> continue
    ]

    const res = await GET(req("https://t/api/sets-db?wallet=0xabc&collection=nba-top-shot"))
    expect(res.status).toBe(200)
    const s1 = (await res.json()).sets.find((s: any) => s.setId === "s1")
    expect(s1.setName).toBe("Flow Legends") // resolved from the sets table, not eds[0].set_name
    expect(s1.totalEditions).toBe(5)
    expect(s1.ownedCount).toBe(2) // e0 (deduped) + e1
    expect(s1.lockedOwnedCount).toBe(1)
    expect(s1.tradeableOwnedCount).toBe(1)
    expect(s1.missingCount).toBe(3)
    expect(s1.completionPct).toBe(40)
    expect(s1.tradeableCompletionPct).toBe(20)
    // e0's null tier/player_name take the COMMON / Unknown fallbacks in owned[]
    const ownedE0 = s1.owned.find((o: any) => o.playId === "e0")
    expect(ownedE0.tier).toBe("COMMON")
    expect(ownedE0.playerName).toBe("Unknown")
    // missing[] uses the em-dash / COMMON fallbacks for its rows
    expect(s1.missing.every((m: any) => typeof m.playerName === "string")).toBe(true)
  })

  it("sorts sets by completion desc, counts complete sets, and falls back to eds[0].set_name when the set row is absent", async () => {
    tableData.editions = [
      // s2 — fully owned (100%), has a sets-table name
      { id: "a", set_id: "s2", set_name: "S2 denorm", player_name: "PA", tier: "COMMON", thumbnail_url: null, external_id: "extA" },
      // s3 — half owned (50%), NO sets-table row -> name falls back to eds[0].set_name
      { id: "b", set_id: "s3", set_name: "S3 fallback", player_name: "PB", tier: "COMMON", thumbnail_url: null, external_id: "extB" },
      { id: "c", set_id: "s3", set_name: "S3 fallback", player_name: "PC", tier: "COMMON", thumbnail_url: null, external_id: "extC" },
    ]
    tableData.sets = [{ id: "s2", name: "S2 Official" }] // s3 deliberately missing
    tableData.wallet_moments_cache = [
      { moment_id: "m1", edition_key: "extA", serial_number: 1, is_locked: false },
      { moment_id: "m2", edition_key: "extB", serial_number: 1, is_locked: false },
    ]

    const res = await GET(req("https://t/api/sets-db?wallet=0xabc&collection=nba-top-shot"))
    const body = await res.json()
    expect(body.totalSets).toBe(2)
    expect(body.completeSets).toBe(1)
    // sorted by completionPct desc -> s2 (100) first, s3 (50) second
    expect(body.sets[0].setId).toBe("s2")
    expect(body.sets[0].completionPct).toBe(100)
    expect(body.sets[0].setName).toBe("S2 Official")
    expect(body.sets[1].setId).toBe("s3")
    expect(body.sets[1].completionPct).toBe(50)
    expect(body.sets[1].setName).toBe("S3 fallback") // eds[0].set_name, since setMeta missed
  })
})
