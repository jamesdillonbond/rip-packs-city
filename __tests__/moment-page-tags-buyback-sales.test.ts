import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// 2026-10-25 production sweep: /moment/51492798 read "1 market sale / 30d" above three
// sales in Recent activity, two of them bought by TopShot_Buyback_2. The count reads
// sales_market (buyback purchases excluded, on purpose); the rows did not say which
// were excluded. get_moment_detail now returns `buyback` per row (20261025215633, pinned
// in supabase/tests/get_moment_detail.sql) and the table tags it.
//
// The moment page is an inline DB-driven server component, so this is a source guard
// (same convention as moment-page-closed-market-honesty.test.ts). The rendered tag's
// behaviour is exercised on the edition table (component-SalesTablePaginated.test.tsx),
// which shares BUYBACK_TITLE.

const SRC = stripComments(readFileSync("app/moment/[id]/page.tsx", "utf8"))

describe("moment page Recent activity tags buyback purchases", () => {
  const block = SRC.slice(SRC.indexOf("recentSales.map("), SRC.indexOf("</tbody>", SRC.indexOf("recentSales.map(")))

  it("reads the Recent activity rows (positive control)", () => {
    expect(block.length).toBeGreaterThan(200)
    expect(block).toMatch(/fmtUsd\(s\.price_usd\)/)
  })

  it("renders the shared BUYBACK_TITLE tag, gated on the row's own flag", () => {
    expect(block).toMatch(/s\.buyback === true \?/)
    expect(block).toMatch(/title=\{BUYBACK_TITLE\}/)
    expect(SRC).toMatch(/import \{ BUYBACK_TITLE \} from "@\/lib\/entity\/buyback-copy"/)
  })

  it("the row type carries the flag the RPC returns", () => {
    expect(SRC).toMatch(/interface RecentSale \{[\s\S]*?buyback\?: boolean \| null[\s\S]*?\}/)
  })
})
