import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for /api/cron/panini-ingest (POST push ingest). Auth:
// Bearer INGEST_SECRET_TOKEN or CRON_SECRET, else 401. Deep legs: the empty-body
// 202 no-op, and the captured after() body — editions dedup + chunked upsert (+
// error branch), the fmv delete-then-insert, the pack-state upsert, the serials
// dedup + upsert (+ error), the success logRun, and the thrown-body catch. The
// normalize helpers are mocked so row shapes are deterministic.

const st = vi.hoisted(() => ({
  edUpsert: { data: [{ id: "e1" }] as { id: string }[] | null, error: null as any },
  serUpsert: { data: [{ id: "s1" }] as { id: string }[] | null, error: null as any },
  // Sale writes are UPDATEs, not upserts — keyed by the sku each call filtered on, so a test can
  // say "this sku matched a row, that one did not" (the sales_missed signal).
  saleUpdate: {} as Record<string, { data: { id: string }[] | null; error: any }>,
  saleUpdateDefault: { data: [{ id: "u1" }] as { id: string }[] | null, error: null as any },
  updates: [] as { table: string; patch: any; sku: string | null; or: string | null }[],
  runs: [] as any[],
  captured: null as null | (() => Promise<void>),
  throwInWalk: false,
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: any) => { st.captured = fn } }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (_n: string, args: any) => { st.runs.push(args); return { data: null, error: null } },
    from(table: string) {
      let isUpdate = false
      let rec: (typeof st.updates)[number] | null = null
      const b: any = {
        upsert: () => b, insert: async () => ({ error: null }), delete: () => b,
        in: () => b, gte: () => b,
        update: (patch: any) => { isUpdate = true; rec = { table, patch, sku: null, or: null }; st.updates.push(rec); return b },
        eq: (_c: string, v: any) => { if (rec) rec.sku = v; return b },
        or: (expr: string) => { if (rec) rec.or = expr; return b },
        select: async () => {
          if (isUpdate) return (rec?.sku != null && st.saleUpdate[rec.sku]) || st.saleUpdateDefault
          return table === "panini_editions" ? st.edUpsert : st.serUpsert
        },
        then: (r: any) => r({ data: [], error: null }),
      }
      return b
    },
  },
}))
vi.mock("@/lib/chains/panini/ingest-normalize", () => ({
  toEditionRow: (c: any) => { if (st.throwInWalk) throw new Error("normalize boom"); return { external_id: c.sku, collection_id: "p1" } },
  toFmvRow: (c: any) => (c.fmv ? { edition_id: c.sku, fmv_usd: c.fmv } : null),
  toPackRow: (p: any) => ({ id: p.pack_sku }),
  toSerialRow: (s: any) => ({ sku: s.sku, edition_external_id: s.ed }),
  // Reducer + filter guard are unit-tested for real in panini-ingest-normalize.test.ts; here they
  // are stubbed so the route's write behaviour is what the assertions are about.
  latestSalesBySku: (recs: any[]) =>
    new Map((recs ?? []).map((r: any) => [r.sku, { sku: r.sku, amount_usd: r.amt, sold_at: r.at ?? null }])),
  isStrictIsoUtc: (v: any) => typeof v === "string" && /Z$/.test(v),
}))

import { POST } from "@/app/api/cron/panini-ingest/route"

const url = "https://t/api/cron/panini-ingest"
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "ingest"
  delete process.env.CRON_SECRET
  st.edUpsert = { data: [{ id: "e1" }], error: null }
  st.serUpsert = { data: [{ id: "s1" }], error: null }
  st.saleUpdate = {}; st.saleUpdateDefault = { data: [{ id: "u1" }], error: null }
  st.updates = []; st.runs = []; st.captured = null; st.throwInWalk = false
})
afterEach(() => { delete process.env.CRON_SECRET })

describe("panini-ingest — auth + empty", () => {
  it("401s with no auth", async () => { expect((await POST(makeReq({ url }))).status).toBe(401) })
  it("401s with a wrong bearer", async () => { expect((await POST(makeReq({ url, auth: "Bearer wrong" }))).status).toBe(401) })
  it("accepts a Bearer CRON_SECRET", async () => {
    process.env.CRON_SECRET = "cron"
    const res = await POST(makeReq({ url, auth: "Bearer cron", body: {} }))
    expect(res.status).toBe(202)
    expect((await res.json()).skipped).toBe("empty")
  })
  it("202 empty no-op logs a skip run", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer ingest", body: {} }))
    expect((await res.json()).accepted).toBe(false)
    expect(st.runs[0].p_extra.skip).toBe("empty")
  })
})

describe("panini-ingest — the after() walk", () => {
  async function accept(body: any) {
    const res = await POST(makeReq({ url, auth: "Bearer ingest", body }))
    return res
  }

  it("upserts editions + fmv + packs + serials and logs a success run", async () => {
    const res = await accept({
      cards: [{ sku: "c1", fmv: 5 }, { sku: "c1", fmv: 6 }, { sku: "c2" }], // c1 deduped; c2 no fmv
      packs: [{ pack_sku: "p1" }],
      serials: [{ sku: "sk1", ed: "c1" }, { sku: "sk1", ed: "c1" }], // deduped by sku
    })
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.accepted).toBe(true)
    expect(body.cards).toBe(3)
    expect(st.captured).toBeTypeOf("function")
    await st.captured!()
    const run = st.runs[0]
    expect(run.p_ok).toBe(true)
    expect(run.p_extra.editions).toBe(1) // e1 written
    expect(run.p_extra.serials).toBe(1)
    expect(run.p_extra.packs).toBe(1)
  })

  it("tolerates editions + serials upsert errors (written stays 0)", async () => {
    st.edUpsert = { data: null, error: { message: "ed err" } }
    st.serUpsert = { data: null, error: { message: "ser err" } }
    await accept({ cards: [{ sku: "c1", fmv: 5 }], serials: [{ sku: "s1", ed: "c1" }] })
    await st.captured!()
    expect(st.runs[0].p_ok).toBe(true)
    expect(st.runs[0].p_extra.editions).toBe(0)
    expect(st.runs[0].p_extra.serials).toBe(0)
  })

  // nftSalesData realized-sale writes (2026-08-08). These are UPDATEs onto serial rows we have
  // already walked — never upserts, because a sale record carries no edition_external_id /
  // collection_id and an insert would violate those NOT NULLs.
  it("writes realized sales onto existing serials and reports applied/missed", async () => {
    st.saleUpdate = { known: { data: [{ id: "u1" }], error: null }, unwalked: { data: [], error: null } }
    await accept({ sales: [{ sku: "known", amt: 22500, at: "2026-08-02T10:08:02Z" }, { sku: "unwalked", amt: 5, at: "2026-08-02T10:08:02Z" }] })
    await st.captured!()
    const run = st.runs[0]
    expect(run.p_ok).toBe(true)
    expect(run.p_extra.sales_seen).toBe(2)
    expect(run.p_extra.sales_applied).toBe(1)
    expect(run.p_extra.sales_missed).toBe(1) // a miss = a serial we have not walked yet, not an error
    expect(st.updates.map((u) => u.table)).toEqual(["panini_card_serials", "panini_card_serials"])
    expect(st.updates[0].patch).toEqual({ last_sale_usd: 22500, last_sale_at: "2026-08-02T10:08:02Z" })
  })

  it("guards against walking a stored price BACKWARDS when the stamp is strict ISO-UTC", () => {
    // nftSalesData pagination depth is unmeasured, so an older page must not overwrite a newer
    // sale. The filter is only ever built from a validated stamp.
    return accept({ sales: [{ sku: "a", amt: 10, at: "2026-08-02T10:08:02Z" }] })
      .then(() => st.captured!())
      .then(() => {
        expect(st.updates[0].or).toBe("last_sale_at.is.null,last_sale_at.lte.2026-08-02T10:08:02Z")
      })
  })

  it("writes unconditionally (no filter, no last_sale_at) when the stamp is unusable", async () => {
    await accept({ sales: [{ sku: "a", amt: 10, at: null }] })
    await st.captured!()
    expect(st.updates[0].or).toBeNull()
    expect(st.updates[0].patch).toEqual({ last_sale_usd: 10 })
    expect(st.runs[0].p_extra.sales_applied).toBe(1)
  })

  it("tolerates a sale update error without failing the run", async () => {
    st.saleUpdate = { a: { data: null, error: { message: "sale err" } } }
    await accept({ sales: [{ sku: "a", amt: 10, at: "2026-08-02T10:08:02Z" }] })
    await st.captured!()
    expect(st.runs[0].p_ok).toBe(true)
    expect(st.runs[0].p_extra.sales_applied).toBe(0)
    expect(st.runs[0].p_extra.sales_missed).toBe(1)
  })

  it("counts a sales-only body as work (not an empty no-op) and echoes it in the 202", async () => {
    const res = await accept({ sales: [{ sku: "a", amt: 10, at: "2026-08-02T10:08:02Z" }] })
    const body = await res.json()
    expect(body.accepted).toBe(true)
    expect(body.sales).toBe(1)
    await st.captured!()
    expect(st.runs[0].p_rows_found).toBe(1)
  })

  it("logs an ok:false run when the walk throws", async () => {
    st.throwInWalk = true
    await accept({ cards: [{ sku: "c1" }] })
    await st.captured!()
    expect(st.runs[0].p_ok).toBe(false)
    expect(st.runs[0].p_error).toContain("normalize boom")
  })
})
