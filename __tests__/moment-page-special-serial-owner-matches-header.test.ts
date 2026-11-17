import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import path from "path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// 2026-10-21 sweep: /moment/52193764 named its owner in the header ("Owner @NolaTom") while the
// Special serials row for that same serial (#1) read "—", because the table read only the
// notable-serials holder index. The page's own serial row must fall back to the owner the header
// shows. Source guard, same convention as moment-page-closed-market-honesty.test.ts (a DB-driven
// server component).
const src = stripComments(readFileSync(path.join(process.cwd(), "app/moment/[id]/page.tsx"), "utf8"))

describe("moment page: the Special serials row for THIS serial names the header's owner", () => {
  it("falls back to ss.owner_address on the row that is this serial", () => {
    const at = src.indexOf("<SectionTitle>Special serials</SectionTitle>")
    expect(at).toBeGreaterThan(-1)
    const table = src.slice(at)
    expect(table).toMatch(/isThisSerial\s*&&\s*ss\?\.owner_address\s*\?\s*\(\s*<OwnerLink address=\{ss\.owner_address\}/)
  })
})

// 2026-10-21 sweep: /moment/50285673 read "1 sale / 30d" beside a listed $594 sale 6 days earlier —
// that sale was to TopShot_Buyback_2, which sales_market (the count's source) excludes by design.
// The label must say what it counts.
describe("moment page: the 30d / 7d sales count says it counts MARKET sales", () => {
  it("labels both windows as market sales", () => {
    expect(src).toMatch(/`\$\{f\.sales_count_30d\} market \$\{/)
    expect(src).toMatch(/`\$\{f\?\.sales_count_7d\} market \$\{/)
    expect(src).not.toMatch(/`\$\{f\?\.sales_count_7d\} sales \/ 7d`/)
  })
})
