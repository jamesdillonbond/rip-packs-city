import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { parseGameDate } from "@/lib/game-date"

describe("parseGameDate", () => {
  it("treats All Day's 1899-12-30 placeholder as no date", () => {
    expect(parseGameDate("1899-12-30")).toBeNull()
    expect(parseGameDate("1899-12-30T00:00:00Z")).toBeNull()
  })
  it("keeps a real date, and rejects junk", () => {
    expect(parseGameDate("2022-09-11T20:00:00Z")).toBe("2022-09-11")
    expect(parseGameDate("1967-01-15")).toBe("1967-01-15")
    expect(parseGameDate("")).toBeNull()
    expect(parseGameDate(null)).toBeNull()
    expect(parseGameDate("Sept 11")).toBeNull()
  })
  // Every All Day edition writer must route the date through it, or the next sale re-writes 1899.
  it("is what every All Day edition writer uses", () => {
    for (const f of ["app/api/allday-sales-indexer/route.ts", "app/api/cron/allday-sales-history-backfill/route.ts", "app/api/allday-seed-editions/route.ts"]) {
      const src = readFileSync(f, "utf8")
      expect(src, f).toMatch(/game_date:\s*(gameDate|parseGameDate\()/)
      expect(src, f).toMatch(/parseGameDate\(/)
    }
  })
})
