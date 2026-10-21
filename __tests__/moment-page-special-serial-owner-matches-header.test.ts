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
