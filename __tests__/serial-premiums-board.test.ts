import { describe, it, expect } from "vitest"
import {
  parseHeadlineMode,
  selectCols,
  normalizeRow,
} from "@/lib/serial-premiums-board"

// The #1-serial vs perfect-mint premiums board. parseHeadlineMode validates the
// query param; selectCols picks mode-specific columns; normalizeRow coerces the
// raw DB row into a typed shape (headline_serial defaults to 1 for the #1 board).

describe("parseHeadlineMode", () => {
  it("only 'perfect' selects the perfect board; everything else → no1", () => {
    expect(parseHeadlineMode("perfect")).toBe("perfect")
    expect(parseHeadlineMode("PERFECT")).toBe("perfect")
    expect(parseHeadlineMode("no1")).toBe("no1")
    expect(parseHeadlineMode(null)).toBe("no1")
    expect(parseHeadlineMode("bogus")).toBe("no1")
  })
})

describe("selectCols", () => {
  it("includes shared cols + mode-specific sale cols", () => {
    const no1 = selectCols("no1")
    const perfect = selectCols("perfect")
    expect(no1).toContain("edition_id")
    // the perfect board carries a serial column the no1 board does not
    expect(perfect).toContain("perfect_serial")
    expect(no1).not.toContain("perfect_serial")
  })
})

describe("normalizeRow", () => {
  it("no1 mode defaults headline_serial to 1 and coerces numerics", () => {
    const row = normalizeRow("no1", {
      edition_id: "e1",
      circulation_count: "250",
      premium_multiple: "3.5",
      no1_last_sale_usd: "500",
      is_conflated: true,
    })
    expect(row.edition_id).toBe("e1")
    expect(row.circulation_count).toBe(250)
    expect(row.premium_multiple).toBe(3.5)
    expect(row.headline_serial).toBe(1)
    expect(row.is_conflated).toBe(true)
  })

  it("perfect mode reads the perfect serial + sale columns", () => {
    const row = normalizeRow("perfect", {
      perfect_serial: "77",
      perfect_last_sale_usd: "900",
    })
    expect(row.headline_serial).toBe(77)
    expect(row.headline_last_sale_usd).toBe(900)
  })

  it("coerces empty/invalid numerics to null", () => {
    const row = normalizeRow("no1", { circulation_count: "", premium_multiple: "abc" })
    expect(row.circulation_count).toBeNull()
    expect(row.premium_multiple).toBeNull()
  })
})
