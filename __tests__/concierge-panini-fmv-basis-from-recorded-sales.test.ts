// 2026-11-08: on 11-07 the concierge told a Panini collector Yan Diomande's
// Base Choice Prizms Elephant ($159, HIGH) was "priced from plenty of recent
// sales" — panini_sales held two sales of it, the last 47 days earlier. A Panini
// basis is now derived from RPC's recorded sales of the edition; the tier never
// reaches the model. Three states: sales · none recorded · read failed.

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import {
  paniniPricingBasis,
  paniniSaleRecordFromRows,
  readPaniniSaleRecord,
  stripPaniniTiers,
  withPaniniSaleBasis,
} from "@/lib/concierge/panini-sale-record"
import { scrubConfidence } from "@/lib/concierge/scrub-confidence"

const NOW = Date.parse("2026-11-07T21:45:00Z")

describe("paniniPricingBasis", () => {
  it("says an old last sale is old — the Elephant case", () => {
    const rec = paniniSaleRecordFromRows(
      [{ sold_at: "2026-09-21T10:00:00Z", amount_usd: 168 }, { sold_at: "2026-09-10T10:00:00Z", amount_usd: 150 }],
      2,
      NOW,
    )
    const basis = paniniPricingBasis({ ok: true, record: rec })
    expect(basis).toMatch(/2 recorded sales/)
    expect(basis).toMatch(/47 days ago/)
    expect(basis).toMatch(/out of date/)
    expect(basis).not.toMatch(/plenty/i)
  })
  it("calls a recent but thin record rough", () => {
    const rec = paniniSaleRecordFromRows([{ sold_at: "2026-11-04T00:00:00Z", amount_usd: 42 }], 1, NOW)
    expect(paniniPricingBasis({ ok: true, record: rec })).toMatch(/only 1 recorded sale,.*rough/)
  })
  it("states a well-sold, recent edition plainly", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ sold_at: `2026-11-0${6 - i}T00:00:00Z`, amount_usd: 32 }))
    const rec = paniniSaleRecordFromRows(rows, 52, NOW)
    expect(rec.recent_sale_prices_usd).toEqual([32, 32, 32, 32, 32])
    expect(paniniPricingBasis({ ok: true, record: rec })).toBe("based on 52 recorded sales, the most recent 1 day ago")
  })
  it("says 'no recorded sale', never 'no sales'", () => {
    const basis = paniniPricingBasis({ ok: true, record: paniniSaleRecordFromRows([], 0, NOW) })
    expect(basis).toMatch(/no recorded sale/)
  })
  it("a failed read is neither an answer nor a basis", () => {
    const basis = paniniPricingBasis({ ok: false })
    expect(basis).toMatch(/couldn't check/)
    expect(basis).not.toMatch(/based on|no recorded sale/)
  })
})

describe("readPaniniSaleRecord", () => {
  function fakeDb(opts: { countErr?: boolean; rowsErr?: boolean }) {
    return {
      from: () => {
        const q: any = {
          _head: false,
          select(_c: string, o?: { head?: boolean }) { this._head = !!o?.head; return this },
          eq() { return this }, not() { return this }, order() { return this },
          limit() { return Promise.resolve(opts.rowsErr ? { data: null, error: { message: "x" } } : { data: [{ sold_at: "2026-11-01T00:00:00Z", amount_usd: 10 }], error: null }) },
          then(res: any, rej: any) {
            return Promise.resolve(opts.countErr ? { count: null, error: { message: "x" } } : { count: 1, error: null }).then(res, rej)
          },
        }
        return q
      },
    }
  }
  it("fails closed when either read errors", async () => {
    expect((await readPaniniSaleRecord(fakeDb({ countErr: true }), "k", NOW)).ok).toBe(false)
    expect((await readPaniniSaleRecord(fakeDb({ rowsErr: true }), "k", NOW)).ok).toBe(false)
  })
  it("reads a record when both succeed", async () => {
    const r = await readPaniniSaleRecord(fakeDb({}), "k", NOW)
    expect(r.ok && r.record.sales_on_record).toBe(1)
  })
})

describe("explain_fmv wiring", () => {
  it("does not hand a Panini tier to the model", () => {
    const src = readFileSync("app/api/support-chat/route.ts", "utf8")
    const i = src.indexOf('if (toolName === "explain_fmv")')
    const body = src.slice(i, src.indexOf("if (toolName ===", i + 10))
    expect(body).toMatch(/salesCountUnknown \? await readPaniniSaleRecord\(supabase, editionKey\)/)
    expect(body).toMatch(/: \{ confidence: snapshot\.confidence \}\)/)
  })
})

describe("get_fmv answers on Panini (11-08 live probe still saw the tier via get_fmv)", () => {
  it("single: the tier is replaced by the recorded-sale basis, so the scrubber has nothing to call 'plenty'", () => {
    const out = JSON.stringify({ status: "ok", mode: "single", edition: { fmv: 159, confidence: "HIGH" } })
    const rec = paniniSaleRecordFromRows([{ sold_at: "2026-09-21T10:00:00Z", amount_usd: 168 }], 2, NOW)
    const scrubbed = scrubConfidence(withPaniniSaleBasis(out, { ok: true, record: rec }))
    expect(scrubbed).not.toMatch(/plenty/i)
    expect(JSON.parse(scrubbed).edition.pricing_basis).toMatch(/2 recorded sales.*out of date/)
  })
  it("distribution: per-edition tiers are dropped", () => {
    const out = JSON.stringify({ status: "ok", mode: "distribution", sample_editions: [{ fmv: 1, confidence: "HIGH" }] })
    const scrubbed = scrubConfidence(stripPaniniTiers(out))
    expect(scrubbed).not.toMatch(/plenty of recent sales"/)
    expect(JSON.parse(scrubbed).sample_editions[0].pricing_basis).toBeUndefined()
  })
})
