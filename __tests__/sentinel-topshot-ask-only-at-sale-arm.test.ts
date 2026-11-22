import { describe, it, expect } from "vitest"
import { summariseTopShotAskOnlyAtSale } from "@/lib/sentinel/topshot-ask-only-at-sale"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// 2026-11-22: on the 11-11 Series 9 launch 37.6 % of Top Shot sales cleared against an ASK_ONLY
// price at a median 2.16x the sale, and nothing alarmed. These payloads are the REAL 6 h windows
// read from check_topshot_ask_only_at_sale's query the same morning (16-day calibration).

const win = (over: Record<string, unknown> = {}) => ({
  hours: 6, sales_priced: 1582, ask_only_sales: 930, ask_only_pct: 58.8, ask_only_median_ratio: 2.25, within_25_pct: 38.0, ...over,
})

describe("summariseTopShotAskOnlyAtSale", () => {
  it("warns on the 11-11 6 PM PT drop window (58.8 % ASK_ONLY at 2.25x)", () => {
    const v = summariseTopShotAskOnlyAtSale(win())
    expect(v.status).toBe("warn")
    expect(v.value).toBe(58.8)
    expect(v.detail).toContain("930 (58.8 %) against ASK_ONLY at a median 2.25× the sale")
  })

  it("warns on the weakest drop window too (11-12 6 AM PT: 22.6 % at 2.43x)", () => {
    expect(summariseTopShotAskOnlyAtSale(win({ sales_priced: 1219, ask_only_pct: 22.6, ask_only_median_ratio: 2.43 })).status).toBe("warn")
  })

  it("CONTROL: the worst non-drop window in 16 days (11-21: 4.7 % at 1.09x) is ok", () => {
    expect(summariseTopShotAskOnlyAtSale(win({ sales_priced: 718, ask_only_pct: 4.7, ask_only_median_ratio: 1.09 })).status).toBe("ok")
  })

  it("CONTROL: many ASK_ONLY sales that cleared AT the ask (ratio ~1) are not a pricing miss", () => {
    expect(summariseTopShotAskOnlyAtSale(win({ ask_only_pct: 30, ask_only_median_ratio: 1.05 })).status).toBe("ok")
  })

  it("under 100 sales is too thin to call — ok, with the count stated", () => {
    const v = summariseTopShotAskOnlyAtSale(win({ sales_priced: 40, ask_only_pct: 80 }))
    expect(v.status).toBe("ok")
    expect(v.detail).toContain("40 Top Shot sales priced")
    expect(v.detail).toContain("too thin to call")
  })

  it("an unreadable payload is UNMEASURED, never clean", () => {
    for (const bad of [null, undefined, [], "x" as unknown, {}, { sales_priced: 500, ask_only_pct: null }]) {
      const v = summariseTopShotAskOnlyAtSale(bad)
      expect(v.status).toBe("warn")
      expect(v.detail).toMatch(/UNMEASURED/)
    }
  })

  it("a window with zero sales is measured (ok), not unmeasured", () => {
    const v = summariseTopShotAskOnlyAtSale({ hours: 6, sales_priced: 0, ask_only_sales: 0, ask_only_pct: null, ask_only_median_ratio: null, within_25_pct: null })
    expect(v.status).toBe("ok")
    expect(v.detail).not.toMatch(/UNMEASURED/)
  })

  it("numeric strings (PostgREST numeric) read as numbers", () => {
    expect(summariseTopShotAskOnlyAtSale(win({ sales_priced: "1582", ask_only_pct: "58.8", ask_only_median_ratio: "2.25" })).status).toBe("warn")
  })
})

describe("the sentinel route wires the arm", () => {
  const src = stripComments(readFileSync(join(process.cwd(), "app/api/sentinel/route.ts"), "utf8")) as string
  it("calls check_topshot_ask_only_at_sale over 6 h and pushes its verdict under the arm's name", () => {
    expect(src).toMatch(/rpc\("check_topshot_ask_only_at_sale",\s*\{\s*p_hours:\s*6\s*\}\)/)
    expect(src).toMatch(/summariseTopShotAskOnlyAtSale\(aoData\)/)
    expect([...src.matchAll(/name: TOPSHOT_ASK_ONLY_AT_SALE_CHECK_NAME/g)].length).toBeGreaterThanOrEqual(3)
  })
})
