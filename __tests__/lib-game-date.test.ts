import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { parseGameDate } from "@/lib/game-date"

describe("parseGameDate", () => {
  it("treats All Day's 1899-12-30 placeholder as no date", () => {
    expect(parseGameDate("1899-12-30")).toBeNull()
    expect(parseGameDate("1899-12-30T00:00:00Z")).toBeNull()
  })
  // 2026-11-06: Top Shot's off-court content (set 102 "Fit Check") carries the UNIX epoch, and 14
  // edition titles rendered "Jan 1, 1970" live. Vintage plays stay dates: the test is the exact day.
  it("treats Top Shot's 1970-01-01 epoch sentinel as no date, but keeps real vintage dates", () => {
    expect(parseGameDate("1970-01-01T00:00:00Z")).toBeNull()
    expect(parseGameDate("1970-01-01")).toBeNull()
    expect(parseGameDate("1970-05-08")).toBe("1970-05-08")
    expect(parseGameDate("1958-04-13")).toBe("1958-04-13")
  })
  it("keeps a real date, and rejects junk", () => {
    expect(parseGameDate("2022-09-11T20:00:00Z")).toBe("2022-09-11")
    expect(parseGameDate("1967-01-15")).toBe("1967-01-15")
    expect(parseGameDate("")).toBeNull()
    expect(parseGameDate(null)).toBeNull()
    expect(parseGameDate("Sept 11")).toBeNull()
  })
  // Every All Day edition writer must route the date through it, or the next sale re-writes 1899.
  // Every Top Shot edition writer too (2026-11-06), or the next ingest re-writes 1970-01-01.
  it("is what every All Day and Top Shot edition writer uses", () => {
    for (const f of [
      "app/api/allday-sales-indexer/route.ts",
      "app/api/cron/allday-sales-history-backfill/route.ts",
      "app/api/allday-seed-editions/route.ts",
      "app/api/ingest/route.ts",
      "app/api/admin/backfill-topshot-catalog/route.ts",
    ]) {
      const src = readFileSync(f, "utf8")
      expect(src, f).toMatch(/game_date:\s*(gameDate|parseGameDate\()/)
      expect(src, f).toMatch(/parseGameDate\(/)
    }
  })
  // The READERS that turn game_date into copy: the edition title/tile context and the moment page.
  // A reader that formats the raw column republishes a sentinel the writers no longer write.
  it("is what the title context and the moment page format from", () => {
    expect(readFileSync("lib/edition-title-context.ts", "utf8")).toMatch(/parseGameDate\(v\)/)
    const moment = readFileSync("app/moment/[id]/page.tsx", "utf8")
    expect(moment).not.toMatch(/fmtAbsDate\(e\.game_date\)/)
    expect(moment).toMatch(/fmtAbsDate\(parseGameDate\(e\.game_date\)\)/)
  })
})
