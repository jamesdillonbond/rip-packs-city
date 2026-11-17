import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))
import { fetchTrophiesBoard } from "@/lib/insights/trophies-board"

// 2026-10-18 (Trevor: "All supported collections should be usable there"):
// Disney Pinnacle's pins live in pinnacle_catalog, not `editions`, so the board
// reads them alongside the view and merges. Either leg failing is an error —
// never a shorter list read as the whole board.
function fakeDb(byTable: Record<string, { data: unknown[] | null; error: { message: string } | null }>) {
  return {
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      for (const fn of ["select", "eq", "in", "not", "or", "order"]) b[fn] = () => b
      b.limit = async () => byTable[table] ?? { data: [], error: null }
      return b
    },
  }
}

const view = (fmv: number | null, name: string) => ({ edition_id: name, collection: "nba_top_shot", fmv_usd: fmv, circulation_count: 1 })
const pin = (fmv: number | null, id: string, extra: Record<string, unknown> = {}) => ({
  render_id: id, character_name: "Pin " + id, characters: ["Mickey Mouse"], set_name: "S", edition_type: "Legendary Edition",
  total_minted: 5, thumbnail_url: "https://x/y.png", fmv_usd: fmv, fmv_computed_at: null, ...extra,
})

describe("fetchTrophiesBoard — Pinnacle merges into the ranked board", () => {
  it("maps pins into the board shape and ranks both legs together by FMV", async () => {
    const db = fakeDb({
      v_insights_trophies: { data: [view(900, "ts-a"), view(100, "ts-b")], error: null },
      pinnacle_catalog: { data: [pin(500, "r1"), pin(null, "r2", { total_minted: 1, edition_type: "Open Edition" })], error: null },
    })
    const { data, error } = await fetchTrophiesBoard({ limit: 3 }, db)
    expect(error).toBeNull()
    const rows = data as Array<Record<string, unknown>>
    expect(rows.map((r) => r.edition_id)).toEqual(["ts-a", "r1", "ts-b"])
    const p = rows[1]
    expect(p).toMatchObject({ collection: "disney_pinnacle", external_id: "r1", name: "Pin r1", player_name: "Mickey Mouse", tier: "Legendary Edition", is_top_tier: true, is_one_of_one: false })
  })

  it("a failed Pinnacle read fails the board (no partial list)", async () => {
    const db = fakeDb({
      v_insights_trophies: { data: [view(900, "ts-a")], error: null },
      pinnacle_catalog: { data: null, error: { message: "timeout" } },
    })
    const { data, error } = await fetchTrophiesBoard({ limit: 10 }, db)
    expect(data).toBeNull()
    expect(error?.message).toBe("timeout")
  })

  it("a failed view read fails the board too", async () => {
    const db = fakeDb({
      v_insights_trophies: { data: null, error: { message: "boom" } },
      pinnacle_catalog: { data: [pin(1, "r1")], error: null },
    })
    expect((await fetchTrophiesBoard({ limit: 10 }, db)).error?.message).toBe("boom")
  })
})
