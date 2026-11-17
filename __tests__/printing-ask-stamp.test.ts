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
  // Re-pinned 2026-10-27: the stamp is the row's low_ask_confirmed_at (the ASK's own check time). updated_at is also
  // bumped by an OFFER-only change, so it read 150 of 4,221 parallel asks 1 h+ fresher than they were.
  it("dates the ask from the printing's own edition_offers row — its ask check time, never updated_at", async () => {
    const d = db({ data: { low_ask: 915, low_ask_confirmed_at: "2026-10-15T20:26:00Z", updated_at: "2026-10-27T15:00:00Z" }, error: null })
    expect(await fetchPrintingAskChangedAt("ts", "261:8716::21", d.db)).toEqual({ at: "2026-10-15T20:26:00Z", ok: true })
    expect(d.eqs).toContainEqual(["table", "edition_offers"])
    expect(d.eqs).toContainEqual(["external_id", "261:8716::21"])
    expect(d.eqs).toContainEqual(["collection_id", "ts"])
  })
  it("a row with no ask has no ask age; a failed read is ok:false (the page then shows NO age)", async () => {
    expect(await fetchPrintingAskChangedAt("ts", "1:2::3", db({ data: { low_ask: null, low_ask_confirmed_at: "x" }, error: null }).db)).toEqual({ at: null, ok: true })
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
    expect(moment).toMatch(/askAgeStamp\(askAt, highOffer\?\.low_ask, collectionSlugUrl, undefined, isParallelExternalId\(e\.external_id\) \? PRINTING_ASK_STAMP_KIND : undefined\)/)
  })
  it("edition page", () => {
    expect(edition).toMatch(/: isParallelPage\s*(\/\/[^\n]*\n\s*)?\? \(highOffer\?\.low_ask != null && printingAsk\.ok \? printingAsk\.at : null\)\s*: askVerifiedAt\(highOffer\)/)
  })
})

describe("askAgeStamp kind override (2026-10-27)", () => {
  it("a parallel's check-time stamp is titled as a check, not a change, on Top Shot", async () => {
    const { askAgeStamp, askAgeTitle } = await import("@/lib/market/ask-freshness")
    const now = Date.parse("2026-10-27T20:00:00Z")
    const at = "2026-10-27T10:00:00Z"
    const checked = askAgeStamp(at, 915, "nba-top-shot", now, "checked")!
    const changed = askAgeStamp(at, 915, "nba-top-shot", now)!
    expect(checked.title).toBe(askAgeTitle(10, "checked"))
    expect(changed.title).toBe(askAgeTitle(10, "changed"))
    expect(checked.title).not.toBe(changed.title)
  })
})
