import { describe, it, expect, vi } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * #206 (f), 2026-10-21: for a Top Shot PARALLEL, get_edition_high_offer's one `updated_at` dates
 * the OFFER it returns, not `low_ask`. /moment/52193764 (261:8716::21) read "$915 · 5h old" for an
 * ask last changed 10-15 whose listing sold 10-17. The ask is dated from its own printing row.
 */
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))
import { fetchPrintingAskChangedAt, isParallelExternalId } from "@/lib/market/printing-ask-stamp"

function db(result: { data: unknown; error: { message: string } | null } | Error) {
  const eqs: Array<[string, unknown]> = []
  const b: Record<string, unknown> = {}
  b.select = () => b
  b.eq = (k: string, v: unknown) => (eqs.push([k, v]), b)
  b.maybeSingle = () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result))
  return { eqs, db: { from: (t: string) => (eqs.push(["table", t]), b) } }
}

describe("fetchPrintingAskChangedAt", () => {
  it("dates the ask from the printing's own edition_offers row", async () => {
    const d = db({ data: { low_ask: 915, updated_at: "2026-10-15T20:26:00Z" }, error: null })
    expect(await fetchPrintingAskChangedAt("ts", "261:8716::21", d.db)).toEqual({ at: "2026-10-15T20:26:00Z", ok: true })
    expect(d.eqs).toContainEqual(["table", "edition_offers"])
    expect(d.eqs).toContainEqual(["external_id", "261:8716::21"])
    expect(d.eqs).toContainEqual(["collection_id", "ts"])
  })
  it("a row with no ask has no ask age; a failed read is ok:false (the page then shows NO age)", async () => {
    expect(await fetchPrintingAskChangedAt("ts", "1:2::3", db({ data: { low_ask: null, updated_at: "x" }, error: null }).db)).toEqual({ at: null, ok: true })
    expect(await fetchPrintingAskChangedAt("ts", "1:2::3", db({ data: null, error: { message: "57014" } }).db)).toEqual({ at: null, ok: false })
    expect(await fetchPrintingAskChangedAt("ts", "1:2::3", db(new Error("fetch failed")).db)).toEqual({ at: null, ok: false })
  })
  it("CONTROL: a base edition is not asked", async () => {
    const d = db({ data: null, error: null })
    expect(await fetchPrintingAskChangedAt("ts", "1:2", d.db)).toEqual({ at: null, ok: true })
    expect(d.eqs).toEqual([])
    expect(isParallelExternalId("1:2")).toBe(false)
    expect(isParallelExternalId("1:2::3")).toBe(true)
  })
})

describe("both pages date a parallel's ask from the printing row, never the offer's stamp (source facts)", () => {
  const moment = readFileSync(join(process.cwd(), "app/moment/[id]/page.tsx"), "utf8")
  const edition = readFileSync(join(process.cwd(), "app/(collections)/[collection]/edition/[slug]/page.tsx"), "utf8")
  it("moment page", () => {
    expect(moment).toMatch(/const askAt = isParallelExternalId\(e\.external_id\)\s*\? \(printingAskRes\.ok \? printingAskRes\.at : null\)\s*: askVerifiedAt\(highOffer\)/)
    expect(moment).toContain("askAgeStamp(askAt, highOffer?.low_ask, collectionSlugUrl)")
  })
  it("edition page", () => {
    expect(edition).toMatch(/: isParallelPage\s*(\/\/[^\n]*\n\s*)?\? \(highOffer\?\.low_ask != null && printingAsk\.ok \? printingAsk\.at : null\)\s*: askVerifiedAt\(highOffer\)/)
  })
})
