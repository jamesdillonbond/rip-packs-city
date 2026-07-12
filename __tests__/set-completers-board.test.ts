import { describe, it, expect } from "vitest"
import { EMPTY_BOARD, METHOD_NOTE } from "@/lib/set-completers-board"

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
