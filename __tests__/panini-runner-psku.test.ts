import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// Guard for the Panini runner's DOM card-image enumeration (method "b"), added
// 2026-07-27. scripts/ingest-panini-runner.mjs is a RESIDENTIAL Playwright
// script that CI cannot run (it needs a logged-in Chrome), so the enumeration
// robustness it provides has no behavioural coverage. This pins BOTH:
//
//   1. the psku-extraction CONTRACT — from a card <img> src, recover only the
//      full 4-field psku (packcard-<setId>_<parallelSetId>_<cardId>_<playerId>),
//      scoped to the WC prefix, so a thumbnail that embeds a truncated base key
//      can never pollute the detail-page walk with a non-resolving psku; and
//   2. that the live runner still USES exactly that regex + selector + prefix
//      filter (a source-drift guard, the same mechanism the edge-fn tests use) —
//      so a future edit that loosens the match trips this test instead of
//      silently re-introducing walk-budget pollution.
//
// The mirror below is intentionally byte-equivalent to the runner's inner loop;
// the drift guard keeps them honest.

const RUNNER_PATH = join(process.cwd(), "scripts", "ingest-panini-runner.mjs")
const WC_PREFIX = "packcard-2332_"

// Byte-equivalent mirror of scripts/ingest-panini-runner.mjs::harvestDomPskus's
// per-src extraction (regex + prefix gate). Returns the psku or null.
function extractWcPsku(src: string, prefix = WC_PREFIX): string | null {
  const m = src.match(/packcard-[0-9]+_[0-9]+_[0-9]+_[0-9]+/)
  if (!m) return null
  const psku = m[0]
  return psku.startsWith(prefix) ? psku : null
}

describe("panini-runner DOM psku extraction (method b)", () => {
  it("extracts the full 4-field psku from a plain card image URL", () => {
    expect(extractWcPsku("https://cdn.x/img/packcard-2332_486964_12579093_31.png")).toBe(
      "packcard-2332_486964_12579093_31",
    )
  })

  it("stops at the 4th field through a thumbnail suffix + query params", () => {
    expect(
      extractWcPsku("https://cdn.x/packcard-2332_486964_12579093_31_thumb.webp?v=3"),
    ).toBe("packcard-2332_486964_12579093_31")
  })

  it("takes the FIRST four fields when the URL carries a 5th numeric segment", () => {
    expect(extractWcPsku("https://cdn.x/packcard-2332_486964_12579093_31_2.png")).toBe(
      "packcard-2332_486964_12579093_31",
    )
  })

  it("REJECTS a truncated base key (fewer than 4 fields) — never pollutes the walk", () => {
    expect(extractWcPsku("https://cdn.x/packcard-2332_12579093.png")).toBeNull()
    expect(extractWcPsku("https://cdn.x/packcard-2332.png")).toBeNull()
  })

  it("REJECTS a full psku from a different product set (prefix gate)", () => {
    // Well-formed 4-field psku, wrong setId ⇒ filtered out by WC_PREFIX.
    expect(extractWcPsku("https://cdn.x/packcard-9999_1_2_3.png")).toBeNull()
  })

  it("REJECTS a non-card image", () => {
    expect(extractWcPsku("https://cdn.x/logo.png")).toBeNull()
    expect(extractWcPsku("")).toBeNull()
  })
})

describe("panini-runner source-drift guard", () => {
  const src = readFileSync(RUNNER_PATH, "utf8")

  it("still scrapes card images via the img[src*=\"packcard-\"] selector", () => {
    expect(src).toContain('querySelectorAll(\'img[src*="packcard-"]\')')
  })

  it("still requires the FULL 4-field psku regex (not a loose packcard-<digits> match)", () => {
    // If this fails, harvestDomPskus was edited. Re-verify the extraction
    // contract above and update the mirror + this literal together.
    expect(src).toContain("/packcard-[0-9]+_[0-9]+_[0-9]+_[0-9]+/")
  })

  it("still gates harvested pskus by WC_PREFIX before adding them to the walk set", () => {
    expect(src).toMatch(/psku\.startsWith\(WC_PREFIX\)[\s\S]*enumPskus\.add\(psku\)/)
  })
})

// --- realized-sales capture (nftSalesData, added 2026-08-08) --------------------------------
// Byte-equivalent mirror of the runner's findSaleRecords. It matches on FIELDS rather than a
// nesting path because the op was observed on exactly one psku — a path assumption drawn from
// n=1 is the likeliest thing to be wrong, and a field match survives a different envelope.
function findSaleRecords(o: any, depth: number, out: any[]): void {
  if (!o || typeof o !== "object" || depth > 6) return
  if (Array.isArray(o)) { for (const v of o) findSaleRecords(v, depth + 1, out); return }
  if (o.url_key != null && o.txn_amount != null) { out.push(o); return }
  for (const k in o) { const v = o[k]; if (v && typeof v === "object") findSaleRecords(v, depth + 1, out) }
}
const collect = (payload: any) => { const out: any[] = []; findSaleRecords(payload, 0, out); return out }

describe("panini-runner sale-record extraction", () => {
  const rec = (n: number) => ({ url_key: `packcard-2332_486956_12680604_40__${n}_10`, txn_amount: 1000 * n, purchased_date: "2026-08-02 10:08:02" })

  it("finds records under the observed nftSalesData envelope", () => {
    expect(collect({ nftSalesData: { data: [rec(1), rec(2)] } })).toHaveLength(2)
  })

  it("finds them under a DIFFERENT envelope or key name (the n=1 shape risk)", () => {
    expect(collect({ someOtherSalesOp: { result: { records: [rec(1)] } } })).toHaveLength(1)
    expect(collect([rec(1), rec(2), rec(3)])).toHaveLength(3)
  })

  it("ignores the ops the walk already captures — no double-counting", () => {
    const payload = {
      getCardMarketStats: { data: { psku: "packcard-2332_1_1_1", floor_price: 5, recent_sale: 9 } },
      getPskuTotalCardsList: { data: { products: [{ sku: "packcard-2332_1_1_1__1_10", brought_at_price: null, best_offer: 3 }] } },
    }
    expect(collect(payload)).toHaveLength(0)
  })

  it("requires BOTH fields — a record missing either is not a sale", () => {
    expect(collect({ d: [{ url_key: "s" }, { txn_amount: 5 }] })).toHaveLength(0)
  })

  it("stops descending at a matched record and survives a cyclic payload", () => {
    // A sale record whose own nested object also looks sale-ish must count once, and the depth
    // bound must keep a self-referencing payload from hanging the response listener.
    const nested: any = { ...rec(1), meta: { url_key: "x", txn_amount: 1 } }
    expect(collect({ d: [nested] })).toHaveLength(1)
    const cyc: any = { a: {} }; cyc.a.self = cyc
    expect(() => collect(cyc)).not.toThrow()
  })
})

describe("panini-runner sales-capture source-drift guard", () => {
  const src = readFileSync(RUNNER_PATH, "utf8")

  it("still matches sale records on url_key + txn_amount (not a nesting path)", () => {
    expect(src).toContain("o.url_key != null && o.txn_amount != null")
  })

  it("still ACTIVATES the sales tab — nftSalesData never fires on page load", () => {
    // Measured over 33,692 captured /onepanini exchanges: nftSalesData appeared 0 times during
    // the walk. Drop the click and the capture silently returns nothing forever.
    expect(src).toMatch(/openSalesHistory/)
    expect(src).toMatch(/sales\\s\*history/i)
    expect(src).toMatch(/if \(got\) \{ \(await openSalesHistory\(\)\)/)
  })

  it("still posts the sales array and keeps a kill switch", () => {
    expect(src).toMatch(/post\(\{ cards, packs, serials, sales \}\)/)
    expect(src).toContain('process.env.PANINI_SALES_HISTORY !== "0"')
  })
})
