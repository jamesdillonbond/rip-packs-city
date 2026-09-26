import { describe, it, expect } from "vitest"
import { fetchPaniniMoreBoards, PANINI_BOARD_LIMIT } from "@/lib/insights/panini-more-boards"

/**
 * The Panini more-boards snapshot. Stated as absences: a failed board read is
 * flagged (never an empty list), a payload missing any board is never cached
 * (`ok:false`), no Panini username leaves the fetcher, and a full page says it
 * is capped.
 */

type Res = { data?: unknown; error?: unknown; count?: number | null }
function db(over: Record<string, Res> = {}) {
  const selects: Record<string, string[]> = {}
  const base: Record<string, Res> = {
    panini_deal_board: { data: [{ sku: "a", deal_basis: "fmv_and_recent_sales" }] },
    panini_pack_ev_board: { data: [{ pack_type: "hobby" }] },
    panini_special_serials_board: { data: [{ sku: "s" }], count: 10 },
    panini_player_board: { data: [{ player_name: "P" }] },
    panini_coverage_summary: { data: [{ total_editions: 5094, pct_trustworthy: 35.1 }] },
    ...over,
  }
  return {
    selects,
    from(table: string) {
      const b: any = {
        select: (cols: string) => {
          ;(selects[table] ??= []).push(cols)
          return b
        },
        eq: () => b,
        order: () => b,
        limit: () => b,
        then: (resolve: any) => resolve({ data: null, error: null, count: null, ...base[table] }),
      }
      return b
    },
  }
}

describe("fetchPaniniMoreBoards", () => {
  it("assembles all four boards + coverage and is cacheable when every read succeeds", async () => {
    const r = await fetchPaniniMoreBoards(db())
    expect(r.ok).toBe(true)
    expect(r.payload.deals).toHaveLength(1)
    expect(r.payload.packs).toHaveLength(1)
    expect(r.payload.specials).toHaveLength(1)
    expect(r.payload.players).toHaveLength(1)
    expect(r.payload.coverage).toMatchObject({ pct_trustworthy: 35.1 })
    expect(r.payload.deals_error).toBe(false)
  })

  it("a FAILED board is flagged, not an empty list — and the payload is NOT cached", async () => {
    const r = await fetchPaniniMoreBoards(db({ panini_deal_board: { data: null, error: { message: "57014" } } }))
    expect(r.payload.deals).toBeNull()
    expect(r.payload.deals_error).toBe(true)
    expect(r.ok).toBe(false)
    expect(r.error).toContain("panini_deal_board")
    // The other boards still arrive for the live render.
    expect(r.payload.packs).toHaveLength(1)
  })

  it("never selects a Panini username", async () => {
    const d = db()
    await fetchPaniniMoreBoards(d)
    for (const cols of Object.values(d.selects).flat()) expect(cols).not.toMatch(/\bowner\b/)
  })

  it("a full page says it is capped", async () => {
    const full = Array.from({ length: PANINI_BOARD_LIMIT }, (_, i) => ({ sku: String(i) }))
    const r = await fetchPaniniMoreBoards(db({ panini_deal_board: { data: full } }))
    expect(r.payload.deals_capped).toBe(true)
  })
})
