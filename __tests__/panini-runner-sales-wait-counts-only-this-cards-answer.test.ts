// 2026-11-03 — pins the runner's sales-tab wait. History, all the same day:
//  * bfe6467 (Cowork) ended the wait on ANY nftSalesData response — a response for another card
//    ended it early (noon walk: 262 sale records per 140 cards vs ~895 before).
//  * 9dcf8ae (Cowork) counted only THIS card's answers, read the other-card answers as a STALE
//    request the SPA fires, and RE-CLICKED the tab on a stale-only answer, skipping RECENT.
//  * ~3:30 PM PT, read from the 2 PM run's ops capture (112 cards): the "stale" answer is the
//    PREVIOUS card's own TOP request, unanswered when the walk left it (body read fails, stamped with
//    the new page's URL at t=0, before that page's own ops). 85 of 112 cards had only that. TOP is
//    slow / never answers; RECENT answers ~0.7 s after TOP when TOP answers. The re-clicks fired
//    more slow TOP reads and skipped RECENT: 1.2 records/card, 19 min per 50 cards.
// So: only this card's answer counts; an other-card answer is LATE; the walk switches to RECENT as
// soon as the tab has FIRED this card's request, and TOP gets a bounded grace — never a re-click.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const src = readFileSync(join(process.cwd(), "scripts/ingest-panini-runner.mjs"), "utf8")
const tabFn = src.slice(src.indexOf("async function openSalesHistory("), src.indexOf("async function openRecentSales("))
const recentFn = src.slice(src.indexOf("async function openRecentSales("), src.indexOf("// SERIAL PAGING"))
const walk = src.slice(src.indexOf("for (const psku of pskus) {"))

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

describe("only THIS card's answer counts", () => {
  it("a response for another card is tallied as LATE, never as this card's", () => {
    expect(src).toMatch(/if \(currentWalkPsku && rq && rq !== currentWalkPsku\) lateSalesResponses\+\+;/)
    // The ungated increment (bfe6467) must not come back.
    expect(src).not.toMatch(/if \(opNameOf\(resp\) === "nftSalesData"\) salesResponses\+\+;/)
    expect(src).toContain("late_responses=${lateSalesResponses}")
  })
  it("the walked card — and its per-card counters — are set before its page is loaded", () => {
    const set = walk.indexOf("currentWalkPsku = psku;")
    const reset = walk.indexOf("cardSales = { reqTop: 0, reqRecent: 0, respTop: 0, respRecent: 0 };")
    expect(set).toBeGreaterThan(-1)
    expect(reset).toBeGreaterThan(-1)
    expect(set).toBeLessThan(walk.indexOf("page.goto("))
    expect(reset).toBeLessThan(walk.indexOf("page.goto("))
  })
  it("requests are counted from the request event, so a slow TOP is seen as FIRED before it answers", () => {
    expect(src).toMatch(/pg\.on\("request", onSalesRequest\)/)
  })
})

describe("a slow TOP never costs the card its RECENT read (inverted from 9dcf8ae's re-click)", () => {
  it("the tab step ends when this card's request FIRES, not when TOP answers, and never re-clicks", () => {
    expect(tabFn).toMatch(/cardSales\.reqTop \+ cardSales\.reqRecent > firedBefore/)
    expect(tabFn).not.toContain('return "stale"')
    // exactly one click per locator shape — the re-click loop must not come back
    expect(tabFn.match(/\.click\(/g)?.length).toBe(1)
    expect(tabFn).not.toMatch(/sales\.length === before/)
  })
  it("RECENT is read on every card whose tab fired, before TOP's grace is spent", () => {
    const opened = walk.indexOf("const clickedAt = await openSalesHistory();")
    const recent = walk.indexOf("await openRecentSales()", opened)
    const grace = walk.indexOf("clickedAt + TOP_WAIT_MS", opened)
    expect(opened).toBeGreaterThan(-1)
    expect(recent).toBeGreaterThan(opened)
    expect(grace).toBeGreaterThan(recent)
    expect(walk).not.toContain('tab === "stale"')
  })
  it("the RECENT wait ends on the RECENT answer only — a late TOP landing meanwhile cannot end it", () => {
    expect(recentFn).toMatch(/while \(Date\.now\(\) < deadline && cardSales\.respRecent === beforeResp\)/)
    expect(recentFn).not.toMatch(/sales\.length === before/)
  })
  it("TOP's grace is bounded and tunable", () => {
    expect(src).toMatch(/const TOP_WAIT_MS = Number\(process\.env\.PANINI_SALES_TOP_WAIT_MS \|\| \d+\)/)
    expect(src).toContain("top_answered=${topAnswered} top_unanswered=${topUnanswered}")
  })
})
