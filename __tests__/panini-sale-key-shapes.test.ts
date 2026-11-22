import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { PANINI_SALE_KEY_SHAPES, unrecognisedSaleKeys } from "@/lib/chains/panini/ingest-normalize"

// 2026-11-22: panini_sales_ingest silently dropped every Moonbirds sale (single-underscore keys).
// The route now counts the keys the RPC will refuse; these tests pin (1) the classification and
// (2) that the TypeScript shapes MIRROR the SQL function's `WHERE` — a header saying so is a claim.

describe("unrecognisedSaleKeys", () => {
  it("accepts every shape the ingest stores", () => {
    expect(
      unrecognisedSaleKeys([
        { url_key: "packcard-2332_486903_12491229_25__1_10" }, // 4-part card
        { url_key: "packcard-850180_100_864__125_501" }, // Stickers (3-part, double underscore)
        { sku: "packcard-850178_104_7_7_10" }, // Moonbirds (3-part, single underscore)
      ]),
    ).toEqual([])
  })

  it("names a key the ingest would drop — never a silent zero", () => {
    const out = unrecognisedSaleKeys([
      { url_key: "packcard-2332_486903_12491229_25_1_10" }, // 4-part card with single underscores: 6 parts
      { url_key: "subpack-1058" },
      { url_key: "packcard-2332_486903_12491229_25__1_10" },
      {},
    ])
    expect(out).toEqual(["packcard-2332_486903_12491229_25_1_10", "subpack-1058", ""])
  })
})

describe("PANINI_SALE_KEY_SHAPES mirrors public.panini_sales_ingest", () => {
  it("every shape appears in the newest migration that defines the function, and nothing else does", () => {
    const dir = join(process.cwd(), "supabase", "migrations")
    const defining = readdirSync(dir)
      .filter((f) => /^\d{14}_.*\.sql$/.test(f))
      .sort()
      .filter((f) => /FUNCTION\s+public\.panini_sales_ingest\s*\(/i.test(readFileSync(join(dir, f), "utf8")))
    expect(defining.length).toBeGreaterThan(0)
    const src = readFileSync(join(dir, defining[defining.length - 1]), "utf8")
    const where = /WHERE\s+(sku\s+~\s+'[^']+'(?:\s+OR\s+sku\s+~\s+'[^']+')*)\s*\n/i.exec(src)
    expect(where, "the parsed-CTE WHERE on sku was not found").not.toBeNull()
    const sqlShapes = [...where![1].matchAll(/sku\s+~\s+'([^']+)'/g)].map((m) => m[1])
    expect(sqlShapes).toEqual(PANINI_SALE_KEY_SHAPES.map((re) => re.source))
  })
})
