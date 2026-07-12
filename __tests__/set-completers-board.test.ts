import { describe, it, expect } from "vitest"
import { EMPTY_BOARD, METHOD_NOTE, fetchSetCompletersBoard } from "@/lib/set-completers-board"

// The Set Completers insights board. fetchSetCompletersBoard reads a SECDEF RPC
// (DB), so only the pure shared constants are unit-tested: the empty-board
// sentinel the page/route render before data lands, and the base-play
// methodology note surfaced to users.

describe("EMPTY_BOARD", () => {
  it("is a board with no rows", () => {
    expect(EMPTY_BOARD).toEqual({ rows: [] })
    expect(Array.isArray(EMPTY_BOARD.rows)).toBe(true)
    expect(EMPTY_BOARD.rows).toHaveLength(0)
  })
})

describe("METHOD_NOTE", () => {
  it("describes base-play completion and daily refresh", () => {
    expect(METHOD_NOTE).toMatch(/base-play/)
    expect(METHOD_NOTE).toMatch(/parallels ignored/)
    expect(METHOD_NOTE).toMatch(/refreshed daily/)
  })
})

// fetchSetCompletersBoard takes the (typed-any) Supabase client as an argument,
// so its RPC seam is trivially fakeable. Pins the numeric coercion, the
// completion-rate division guard, the sort order, and the error propagation.
const sb = (data: any, error: any = null) => ({ rpc: async () => ({ data, error }) })

describe("fetchSetCompletersBoard", () => {
  it("throws when the RPC returns an error", async () => {
    await expect(fetchSetCompletersBoard(sb(null, { message: "rpc boom" }))).rejects.toThrow("rpc boom")
  })

  it("returns an empty board for null/empty data", async () => {
    expect(await fetchSetCompletersBoard(sb(null))).toEqual({ rows: [] })
    expect(await fetchSetCompletersBoard(sb([]))).toEqual({ rows: [] })
  })

  it("coerces numerics and derives completion_rate = completers / holders", async () => {
    const board = await fetchSetCompletersBoard(
      sb([
        { set_id_onchain: "10", set_name: "Base", total_plays: "50", completers: "20", holders_with_any: "80" },
      ]),
    )
    expect(board.rows[0]).toMatchObject({
      set_id_onchain: 10,
      set_name: "Base",
      total_plays: 50,
      completers: 20,
      holders_with_any: 80,
    })
    expect(board.rows[0].completion_rate).toBeCloseTo(0.25, 5)
  })

  it("guards divide-by-zero (no holders → rate 0) and defaults a null set_name to ''", async () => {
    const board = await fetchSetCompletersBoard(
      sb([{ set_id_onchain: 1, set_name: null, total_plays: 5, completers: 0, holders_with_any: 0 }]),
    )
    expect(board.rows[0].completion_rate).toBe(0)
    expect(board.rows[0].set_name).toBe("")
  })

  it("sorts by completers desc, then total_plays desc", async () => {
    const board = await fetchSetCompletersBoard(
      sb([
        { set_id_onchain: 1, set_name: "A", total_plays: 10, completers: 5, holders_with_any: 10 },
        { set_id_onchain: 2, set_name: "B", total_plays: 30, completers: 9, holders_with_any: 10 },
        { set_id_onchain: 3, set_name: "C", total_plays: 40, completers: 9, holders_with_any: 10 },
      ]),
    )
    // B and C tie on completers (9); C wins the total_plays tie-break (40 > 30).
    expect(board.rows.map((r) => r.set_name)).toEqual(["C", "B", "A"])
  })
})
