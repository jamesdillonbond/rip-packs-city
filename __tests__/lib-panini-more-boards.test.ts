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
  const orders: Record<string, string[]> = {}
  const eqs: Record<string, string[]> = {}
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
    eqs,
    orders,
    from(table: string) {
      const b: any = {
        select: (cols: string) => {
          ;(selects[table] ??= []).push(cols)
          return b
        },
        eq: (col: string, v: unknown) => {
          ;(eqs[table] ??= []).push(`${col}=${String(v)}`)
          return b
        },
        order: (col: string) => {
          ;(orders[table] ??= []).push(col)
          return b
        },
        limit: () => b,
        then: (resolve: any) => resolve({ data: null, error: null, count: null, ...base[table] }),
      }
      return b
    },
  }
}

describe("fetchPaniniMoreBoards", () => {
  it("orders sale-backed deals FIRST so the cap can only cut FMV-only rows (2026-09-25)", async () => {
    const d = db() as any
    await fetchPaniniMoreBoards(d)
    expect(d.orders.panini_deal_board?.[0]).toBe("deal_basis")
    // ...and the enum's string order puts the sale-backed basis first.
    expect(["fmv_only_no_recent_sales", "fmv_and_recent_sales"].sort()[0]).toBe("fmv_and_recent_sales")
  })


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

// Multi-product (2026-09-28): panini_pack_ev_board now also carries packs the model does not price.
// This snapshot feeds the WC Pack EV board, so it must read only modeled rows — by the view's own
// discriminator — AND on the WC product since 2026-09-30, when a second product (2420, 2026 Prizm
// WNBA) got a model: ev_modeled=true alone would put a WNBA pack on this WC board.
describe("fetchPaniniMoreBoards — pack EV rows are the modeled product's only", () => {
  it("filters the pack board on ev_modeled=true AND the WC product", async () => {
    const d = db()
    await fetchPaniniMoreBoards(d as any)
    expect(d.eqs.panini_pack_ev_board).toEqual(["ev_modeled=true", "product_set_id=2332"])
  })
})

