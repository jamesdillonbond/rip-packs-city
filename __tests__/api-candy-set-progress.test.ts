import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * GET /api/candy-set-progress — the Candy MLB (Solana) Set Tracker backend.
 *
 * The arms that matter are stated as the ABSENCE of a false claim: a base58
 * key must reach the holdings read VERBATIM (folded, it matches nothing and
 * reads "0 of 100"), a Flow wallet must be refused rather than answered with
 * zeros, a Rainbow parallel must not count as an extra checklist slot, a
 * truncated read must not surface as a smaller answer, and a stale or failed
 * floor map must not surface as a cost to finish.
 */

type Row = Record<string, any>

const state: {
  editions: Array<{ data: Row[] | null; error: any }>
  owned: Array<{ data: Row[] | null; error: any }>
  sets: { data: Row[] | null; error: any }
  fmv: { data: Row[] | null; error: any }
  floor: { data: Row[] | null; error: any }
} = {
  editions: [],
  owned: [],
  sets: { data: [], error: null },
  fmv: { data: [], error: null },
  floor: { data: [], error: null },
}
const calls = { editions: 0, owned: 0 }
const ownedFilters: Array<[string, unknown]> = []

vi.mock("@/lib/supabase", () => {
  function builder(table: string) {
    const b: any = {
      select: () => b,
      eq: (col: string, val: unknown) => {
        if (table === "wallet_moments_cache") ownedFilters.push([col, val])
        return b
      },
      not: () => b,
      order: () => b,
      range: () => b,
      then: (resolve: any) => {
        if (table === "editions") {
          const i = Math.min(calls.editions, state.editions.length - 1)
          calls.editions++
          return resolve(state.editions[i] ?? { data: [], error: null })
        }
        if (table === "wallet_moments_cache") {
          const i = Math.min(calls.owned, state.owned.length - 1)
          calls.owned++
          return resolve(state.owned[i] ?? { data: [], error: null })
        }
        if (table === "sets") return resolve(state.sets)
        if (table === "candy_fmv_current") return resolve(state.fmv)
        if (table === "candy_listing_floor") return resolve(state.floor)
        return resolve({ data: [], error: null })
      },
    }
    return b
  }
  return { supabaseAdmin: { from: (t: string) => builder(t) } }
})

import { GET, CANDY_FLOOR_MAP_STALE_HOURS } from "@/app/api/candy-set-progress/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any
// A real-shaped base58 key with mixed case — the property under test.
const WALLET = "1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix"
const URL_OK = `https://t/api/candy-set-progress?wallet=${WALLET}`
const FRESH = new Date(Date.now() - 60 * 60 * 1000).toISOString()
const STALE = new Date(Date.now() - (CANDY_FLOOR_MAP_STALE_HOURS + 6) * 3_600_000).toISOString()
const SET = "381ae129-7dc7-47f4-9022-dd9e0fc21e39"

function ed(ext: string, over: Row = {}): Row {
  return {
    id: `id-${ext}`,
    external_id: ext,
    set_id: SET,
    set_name: "2026 MLB Base Series ICONs",
    player_id: `p-${ext}`,
    player_name: ext,
    name: ext,
    tier: "COMMON",
    circulation_count: 250,
    thumbnail_url: null,
    ...over,
  }
}
const page = (rows: Row[]) => ({ data: rows, error: null })
const floor = (ext: string, usd: number | null, seen = FRESH) => ({ edition_id: `id-${ext}`, confirmed_floor_usd: usd, last_seen_at: seen })

beforeEach(() => {
  calls.editions = 0
  calls.owned = 0
  ownedFilters.length = 0
  state.editions = [page([])]
  state.owned = [page([])]
  state.sets = { data: [{ id: SET, name: "2026 MLB Base Series ICONs", series: 1 }], error: null }
  state.fmv = { data: [], error: null }
  state.floor = { data: [], error: null }
})

async function body(url = URL_OK) {
  const res = await GET(req(url))
  return { status: res.status, json: await res.json() }
}

describe("GET /api/candy-set-progress", () => {
  it("400s without a wallet", async () => {
    const { status } = await body("https://t/api/candy-set-progress")
    expect(status).toBe(400)
  })

  it("REFUSES a Flow wallet instead of answering it with zeros", async () => {
    state.editions = [page([ed("aaron-judge")])]
    const { status, json } = await body("https://t/api/candy-set-progress?wallet=0x1234567890abcdef")
    expect(status).toBe(400)
    expect(json.sets).toBeUndefined()
    expect(json.error).toMatch(/Solana/)
    expect(calls.owned).toBe(0)
  })

  it("reads holdings with the base58 key VERBATIM — never folded", async () => {
    state.editions = [page([ed("aaron-judge")])]
    await body()
    const w = ownedFilters.find(([c]) => c === "wallet_address")?.[1]
    expect(w).toBe(WALLET)
    expect(w).not.toBe(WALLET.toLowerCase())
  })

  it("counts one slot per PLAYER: a Rainbow parallel is depth, not an extra slot", async () => {
    state.editions = [
      page([
        ed("mike-trout"),
        ed("mike-trout-pink", { player_id: "p-mike-trout", player_name: "mike-trout", name: "mike-trout - PINK", tier: "LEGENDARY", circulation_count: 15 }),
        ed("aaron-judge"),
      ]),
    ]
    // Holds only the PINK Trout and the Judge base.
    state.owned = [
      page([
        { moment_id: "m1", edition_key: "mike-trout-pink", serial_number: 3, is_locked: false },
        { moment_id: "m2", edition_key: "aaron-judge", serial_number: 99, is_locked: false },
      ]),
    ]
    const s = (await body()).json.sets[0]
    expect(s.totalEditions).toBe(2)
    expect(s.ownedCount).toBe(2)
    expect(s.completionPct).toBe(100)
    expect(s.tier).toBe("complete")
    expect(s.totalPrintings).toBe(3)
    expect(s.ownedPrintings).toBe(2)
    // The owned Trout is shown as the printing actually held, named by colour.
    expect(s.owned.find((p: Row) => p.playId === "id-mike-trout-pink")?.tier).toBe("PINK")
  })

  it("prices the missing slot at its cheapest live printing and totals only real asks", async () => {
    state.editions = [
      page([
        ed("mike-trout"),
        ed("mike-trout-pink", { player_id: "p-mike-trout", name: "mike-trout - PINK", tier: "LEGENDARY", circulation_count: 15 }),
        ed("aaron-judge"),
        ed("ben-rice"),
      ]),
    ]
    state.owned = [page([{ moment_id: "m1", edition_key: "aaron-judge", serial_number: 1, is_locked: false }])]
    state.floor = { data: [floor("mike-trout", 4), floor("mike-trout-pink", 80), floor("ben-rice", 2)], error: null }
    const s = (await body()).json.sets[0]
    expect(s.missingCount).toBe(2)
    expect(s.totalMissingCost).toBe(6)
    expect(s.lowestSingleAsk).toBe(2)
    expect(s.asksEnriched).toBe(true)
    expect(s.costConfidence).toBe("high")
    expect(s.missing.map((p: Row) => p.playId)).toEqual(["id-ben-rice", "id-mike-trout"])
    expect(s.missing[0].topshotUrl).toBe("/candy-mlb/edition/ben-rice")
  })

  it("an unlisted missing slot is NOT free — cost is 'mixed', never a full bill", async () => {
    state.editions = [page([ed("aaron-judge"), ed("ben-rice"), ed("bo-bichette")])]
    state.owned = [page([{ moment_id: "m1", edition_key: "aaron-judge", serial_number: 1, is_locked: false }])]
    state.floor = { data: [floor("ben-rice", 3)], error: null }
    const s = (await body()).json.sets[0]
    expect(s.listedCount).toBe(1)
    expect(s.costConfidence).toBe("mixed")
    expect(s.missing.find((p: Row) => p.playId === "id-bo-bichette")?.lowestAsk).toBeNull()
  })

  it("a STALE floor map quotes no cost at all", async () => {
    state.editions = [page([ed("aaron-judge"), ed("ben-rice")])]
    state.owned = [page([{ moment_id: "m1", edition_key: "aaron-judge", serial_number: 1, is_locked: false }])]
    state.floor = { data: [floor("ben-rice", 3, STALE)], error: null }
    const s = (await body()).json.sets[0]
    expect(s.asksEnriched).toBe(false)
    expect(s.totalMissingCost).toBeNull()
    expect(s.missing[0].lowestAsk).toBeNull()
    expect(s.tier).toBe("unpriced")
  })

  it("a FAILED floor read degrades to unpriced — completion is still exact", async () => {
    state.editions = [page([ed("aaron-judge"), ed("ben-rice")])]
    state.owned = [page([{ moment_id: "m1", edition_key: "aaron-judge", serial_number: 1, is_locked: false }])]
    state.floor = { data: null, error: { message: "boom" } }
    const { status, json } = await body()
    expect(status).toBe(200)
    expect(json.sets[0].completionPct).toBe(50)
    expect(json.sets[0].totalMissingCost).toBeNull()
  })

  it("a TRUNCATED holdings read is a 503, never a smaller completion", async () => {
    state.editions = [page([ed("aaron-judge")])]
    const full = Array.from({ length: 1000 }, (_, i) => ({ moment_id: `m${i}`, edition_key: "aaron-judge", serial_number: i, is_locked: false }))
    state.owned = [page(full)]
    const { status, json } = await body()
    expect(status).toBeGreaterThanOrEqual(500)
    expect(json.sets).toBeUndefined()
    // Paged to its ceiling, then refused.
    expect(calls.owned).toBe(20)
  })

  it("a FAILED checklist read is an error, never 'no sets'", async () => {
    state.editions = [{ data: null, error: { message: "canceling statement due to statement timeout" } }]
    const { status, json } = await body()
    expect(status).toBeGreaterThanOrEqual(500)
    expect(json.sets).toBeUndefined()
    expect(JSON.stringify(json)).not.toMatch(/canceling statement/)
  })

  it("names the published-checklist players RPC has no card for — never implies 100 is the whole checklist", async () => {
    state.editions = [page([ed("aaron-judge", { player_name: "Aaron Judge" })])]
    const { json } = await body()
    expect(json.publishedChecklist.total).toBeGreaterThanOrEqual(100)
    expect(json.publishedChecklist.notIndexed).toContain("Edwin Díaz")
    expect(json.publishedChecklist.notIndexed).not.toContain("Aaron Judge")
  })

  it("an ask not SEEN recently prices nothing — the confirmed floor is null, the slot is unlisted", async () => {
    state.editions = [page([ed("aaron-judge"), ed("ben-rice")])]
    state.owned = [page([{ moment_id: "m1", edition_key: "aaron-judge", serial_number: 1, is_locked: false }])]
    // The map is fresh (another edition was seen now) but ben-rice has only an old ask.
    state.floor = { data: [floor("aaron-judge", 5), floor("ben-rice", null)], error: null }
    const s = (await body()).json.sets[0]
    expect(s.asksEnriched).toBe(true)
    expect(s.missing[0].lowestAsk).toBeNull()
    expect(s.totalMissingCost).toBeNull()
  })
})
