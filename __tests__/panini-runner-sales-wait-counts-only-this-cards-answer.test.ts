// 2026-11-03 — pins 9dcf8ae (Cowork), which shipped without a test. bfe6467's sales-tab wait ended
// on ANY nftSalesData response; measured from panini-ops-capture.jsonl, every empty (data:null)
// TOP answer was a STALE request for ANOTHER card (797 of 2,468 exchanges, 0 of them carrying
// data), so the wait ended early and the card's real read was dropped (noon walk: 262 sale
// records per 140 cards vs ~895 before). Only an answer for the walked card may end the wait.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const src = readFileSync(join(process.cwd(), "scripts/ingest-panini-runner.mjs"), "utf8")

// The live request shape (GraphQL string; quotes escaped inside the JSON body).
const REAL = JSON.stringify({
  operationName: "nftSalesData",
  variables: {},
  query:
    'query nftSalesData {\n  nftSalesData(\n    sale_type: "top"\n    sale_range: "all"\n    currentPage: 1\n    pageSize: 20\n    appliedFilters: "psku=packcard-1780_338140_8821391_234"\n  ) {\n    items {\n      product_name\n    }\n  }\n}',
})

describe("the runner's request-psku reader works on the live request shape", () => {
  it("extracts the psku with the runner's OWN regex (read from source, not copied)", () => {
    const m = /const saleReqPsku = \(resp\) => \{ const m = \(resp\.request\(\)\.postData\(\) \|\| ""\)\.match\((\/.+?\/[a-z]*)\);/.exec(src)
    expect(m, "saleReqPsku's regex literal must be findable").not.toBeNull()
    const lit = m![1]
    const re = new RegExp(lit.slice(1, lit.lastIndexOf("/")), lit.slice(lit.lastIndexOf("/") + 1))
    expect(REAL.match(re)?.[1]).toBe("packcard-1780_338140_8821391_234")
    // A request naming no psku yields nothing — it is then counted as this card's (the pre-gate rule).
    expect(JSON.stringify({ query: 'nftSalesData(sale_type:"top")' }).match(re)).toBeNull()
  })
})

describe("only THIS card's answer ends the sales-tab wait", () => {
  it("a response for another card is tallied as stale, never as this card's", () => {
    expect(src).toMatch(/if \(currentWalkPsku && rq && rq !== currentWalkPsku\) staleSalesResponses\+\+; else salesResponses\+\+;/)
    // The ungated increment (bfe6467) must not come back.
    expect(src).not.toMatch(/if \(opNameOf\(resp\) === "nftSalesData"\) salesResponses\+\+;/)
  })
  it("the walked card is set before its page is loaded", () => {
    const loop = src.slice(src.indexOf("for (const psku of pskus) {"))
    const set = loop.indexOf("currentWalkPsku = psku;")
    expect(set).toBeGreaterThan(-1)
    expect(set).toBeLessThan(loop.indexOf("page.goto("))
  })
  // Re-pinned 2026-11-03 ~3:35 PM PT (Cowork): the re-click this test first pinned was MEASURED on the
  // 2:00 PM run — it fired no new read on 79 of 82 stale pages and cost ~8 s/card. The PROPERTY kept:
  // a stale-only answer is never reported as this card being empty; the ladder keeps waiting (its
  // later shapes catch the late real read, median 6.5 s after the stale one), and "stale" is the
  // outcome only after every shape.
  it("a stale-only answer falls through to the next shape and is reported stale only at the end, without a re-click", () => {
    const fn = src.slice(src.indexOf("async function openSalesHistory("), src.indexOf("async function openRecentSales("))
    const loopEnd = fn.indexOf("if (staleSalesResponses > beforeStale) return \"stale\";")
    expect(loopEnd).toBeGreaterThan(-1)
    // "stale" is decided after the locator loop, not inside it.
    expect(fn.slice(0, loopEnd)).not.toContain('return "stale"')
    expect(fn.slice(0, loopEnd)).toMatch(/for \(const mk of candidates\)/)
    // Exactly one click per shape — no re-click of an already-open tab.
    expect(fn.match(/el\.click\(/g)?.length).toBe(1)
    expect(src).toContain("stale_responses=${staleSalesResponses}")
  })
})
