import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for /api/cron/panini-ingest (POST push ingest). Auth:
// Bearer INGEST_SECRET_TOKEN or CRON_SECRET, else 401. Deep legs: the empty-body
// 202 no-op, and the captured after() body — editions dedup + chunked upsert (+
// error branch), the fmv insert-then-supersede-delete, the pack-state upsert, the serials
// dedup + upsert (+ error), the success logRun, and the thrown-body catch. The
// normalize helpers are mocked so row shapes are deterministic.

const st = vi.hoisted(() => ({
  edUpsert: { data: [{ id: "e1" }] as { id: string }[] | null, error: null as any },
  serUpsert: { data: [{ id: "s1" }] as { id: string }[] | null, error: null as any },
  // R120: the fmv insert sits behind the same FK that was aborting the editions upsert, so its
  // error has to be injectable — it was previously unreadable by construction (`insert` resolved
  // to a bare { error: null } and nothing looked at it).
  fmvInsert: { data: [{ id: "f1" }] as { id: string }[] | null, error: null as any },
  packUpsert: { data: [{ id: "p1" }] as { id: string }[] | null, error: null as any },
  // Sale writes are UPDATEs, not upserts — keyed by the sku each call filtered on, so a test can
  // say "this sku matched a row, that one did not" (the sales_missed signal).
  saleUpdate: {} as Record<string, { data: { id: string }[] | null; error: any }>,
  saleUpdateDefault: { data: [{ id: "u1" }] as { id: string }[] | null, error: null as any },
  updates: [] as { table: string; patch: any; sku: string | null; or: string | null }[],
  runs: [] as any[],
  captured: null as null | (() => Promise<void>),
  throwInWalk: false,
  recent: { data: [] as unknown[] | null, error: null as null | { message: string } },
  recentCalls: [] as unknown[],
  // 2026-09-25: order of the fmv writes, so a test can pin insert-BEFORE-delete.
  fmvOps: [] as string[],
  fmvDelete: { data: null, error: null as null | { message: string } },
  // Multi-product gate (2026-09-28): the panini_products registry read, and every registry write.
  products: { data: [{ set_id: 2332, name: "2026 Panini NFT Prizm World Cup Soccer", walk_cards: true }] as unknown[] | null, error: null as null | { message: string } },
  registryUpserts: [] as { table: string; rows: any; opts: any }[],
  packRowsArgs: [] as unknown[][],
  // 2026-09-28: panini_sales_ingest — every sale record into panini_sales.
  salesHist: { data: { valid: 0, stored_new: 0, refreshed: 0, recent_reads: 0, gaps_now: 0 } as unknown, error: null as null | { message: string } },
  salesHistCalls: [] as unknown[],
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: any) => { st.captured = fn } }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    // panini_recent_sales_fmv (the 1.1.0 FMV input, 2026-09-24) is a READ, not a pipeline log —
    // kept out of st.runs so every "st.runs[i] is a logRun" assertion below still holds.
    rpc: async (n: string, args: unknown) => {
      if (n === "panini_recent_sales_fmv") { st.recentCalls.push(args); return st.recent }
      if (n === "panini_sales_ingest") { st.salesHistCalls.push(args); return st.salesHist }
      st.runs.push(args); return { data: null, error: null }
    },
    from(table: string) {
      let isUpdate = false
      let isInsert = false
      let isDelete = false
      let isUpsert = false
      let rec: (typeof st.updates)[number] | null = null
      const b: any = {
        upsert: (rows: any, opts: any) => { isUpsert = true; if (table === "panini_products" || table === "panini_pack_pages" || table === "panini_pack_state") st.registryUpserts.push({ table, rows, opts }); return b },
        insert: () => { isInsert = true; if (table === "panini_fmv_snapshots") st.fmvOps.push("insert"); return b },
        delete: () => { if (table === "panini_fmv_snapshots") { st.fmvOps.push("delete"); isDelete = true } return b },
        in: () => b, gte: () => b,
        lt: (c: string) => { if (isDelete && table === "panini_fmv_snapshots") st.fmvOps.push(`lt:${c}`); return isDelete ? Promise.resolve(st.fmvDelete) : b },
        update: (patch: any) => { isUpdate = true; rec = { table, patch, sku: null, or: null }; st.updates.push(rec); return b },
        eq: (_c: string, v: any) => { if (rec) rec.sku = v; return b },
        or: (expr: string) => { if (rec) rec.or = expr; return b },
        select: async () => {
          if (table === "panini_products" && !isUpsert) return st.products
          if (table === "panini_products" || table === "panini_pack_pages") return { data: [{ id: "r" }], error: null }
          if (isUpdate) return (rec?.sku != null && st.saleUpdate[rec.sku]) || st.saleUpdateDefault
          if (isInsert && table === "panini_fmv_snapshots") return st.fmvInsert
          if (table === "panini_pack_state") return st.packUpsert
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
  toFmvRow: (c: any) => (c.fmv ? { edition_id: c.sku, fmv_usd: c.fmv, algo_version: "panini-1.0.0" } : null),
  toFmvRowV11: (c: { sku: string; fmv?: number }, _n: string, r?: { fmv_usd: number } | null) => (c.fmv ? { edition_id: c.sku, fmv_usd: r?.fmv_usd ?? c.fmv, algo_version: "panini-1.1.0" } : null),
  toPackRow: (p: any, _n: string, sid: number | null = null) => { st.packRowsArgs.push([p, sid]); return { id: p.pack_sku, product_set_id: sid } },
  // The real parser, except that the fixtures' short skus ("c1", "a") stand for WC cards — the
  // product the route has always written — so every pre-existing case keeps its meaning.
  pskuSetId: (k: unknown) => { const m = typeof k === "string" ? k.match(/^packcard-(\d+)_/) : null; return m ? Number(m[1]) : (typeof k === "string" && !k.startsWith("packcard-") ? 2332 : null) },
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
  st.fmvInsert = { data: [{ id: "f1" }], error: null }
  st.packUpsert = { data: [{ id: "p1" }], error: null }
  st.saleUpdate = {}; st.saleUpdateDefault = { data: [{ id: "u1" }], error: null }
  st.updates = []; st.runs = []; st.captured = null; st.throwInWalk = false
  st.recent = { data: [], error: null }; st.recentCalls = []
  st.fmvOps = []; st.fmvDelete = { data: null, error: null }
  st.products = { data: [{ set_id: 2332, name: "2026 Panini NFT Prizm World Cup Soccer", walk_cards: true }], error: null }
  st.registryUpserts = []; st.packRowsArgs = []
  st.salesHist = { data: { valid: 0, stored_new: 0, refreshed: 0, recent_reads: 0, gaps_now: 0 }, error: null }; st.salesHistCalls = []
  delete process.env.PANINI_FMV_ENGINE
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

/**
 * The per-walk enumeration marker (2026-08-15).
 *
 * The runner posts `{ enum: {...} }` once per walk, BEFORE the long per-card walk, because how
 * much of the grid was enumerated previously existed nowhere in the DB — only a console line and
 * a size-capped local JSONL — which is why a ~6x throughput collapse went unnoticed for days.
 *
 * ⚠ THE PROPERTY THAT MATTERS: this marker carries no rows, so it must NOT be logged under the
 * `panini-ingest` pipeline name. `detect_stalled_pipelines()` keys on
 * `max(started_at) WHERE pipeline = w.pipeline`, and `panini-ingest` is on
 * `pipeline_cadence_watchlist` (360 min, calibrated for the home box going dark). A marker under
 * the watched name would refresh `last_run` at the start of every walk and silence that arm on
 * precisely the failure it exists to expose — a walk that enumerates and then dies having
 * captured nothing would still read as alive.
 */
describe("panini-ingest — the enumeration marker must not silence the stall arm", () => {
  const WATCHED_PIPELINE = "panini-ingest" // the name on pipeline_cadence_watchlist
  const enumBody = { enum: { enum_stop: "stable", grid_pages: 41, grid_items: 1230, wc_pskus: 392 } }

  it("logs the marker under a DIFFERENT pipeline than the watched one", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer ingest", body: enumBody }))
    expect(res.status).toBe(202)
    expect(st.runs).toHaveLength(1)
    expect(st.runs[0].p_pipeline).not.toBe(WATCHED_PIPELINE)
    // …and it is still attributed to Panini, so the row is findable.
    expect(st.runs[0].p_pipeline).toContain("panini")
    expect(st.runs[0].p_extra.enum.grid_pages).toBe(41)
  })

  it("does not count the marker as ingested rows", async () => {
    await POST(makeReq({ url, auth: "Bearer ingest", body: enumBody }))
    // A marker describes the walk; counting it would inflate rows_found on a payload that
    // wrote nothing, making a dead walk look productive in exactly the rollup used to spot this.
    expect(st.runs[0].p_rows_found).toBe(0)
    expect(st.runs[0].p_rows_written).toBe(0)
    expect(st.runs[0].p_ok).toBe(true)
  })

  it("a genuinely empty body still logs under the watched pipeline (marker did not move it)", async () => {
    await POST(makeReq({ url, auth: "Bearer ingest", body: {} }))
    expect(st.runs[0].p_pipeline).toBe(WATCHED_PIPELINE)
    expect(st.runs[0].p_extra.skip).toBe("empty")
  })

  it("keeps ONE home for the marker even when rows ride along in the same payload", async () => {
    // The runner posts the marker standalone today, so this is the forward-compatible case: if a
    // payload ever carries both, the marker must still land under the marker pipeline rather than
    // being attached to the ingest row — otherwise the same telemetry lives in two pipelines and
    // any later reader has to know to union them.
    const res = await POST(makeReq({
      url, auth: "Bearer ingest", body: { ...enumBody, cards: [{ sku: "c1", fmv: 5 }] },
    }))
    expect(res.status).toBe(202)
    await st.captured!()

    const markerRuns = st.runs.filter((r: any) => r.p_extra?.enum)
    expect(markerRuns).toHaveLength(1)
    expect(markerRuns[0].p_pipeline).not.toBe(WATCHED_PIPELINE)

    // The rows are still ingested normally, under the watched pipeline.
    const ingestRuns = st.runs.filter((r: any) => r.p_pipeline === WATCHED_PIPELINE)
    expect(ingestRuns).toHaveLength(1)
    expect(ingestRuns[0].p_rows_found).toBe(1)
    expect(ingestRuns[0].p_extra.enum).toBeUndefined()
  })

  it.each([
    ["an array", [1, 2, 3]],
    ["a string", "41 pages"],
    ["null", null],
  ])("treats %s as no marker and falls back to the empty no-op", async (_label, value) => {
    // The marker is spread into `extra` as an object; a non-object would produce a row whose
    // `extra.enum` cannot be read by the queries this telemetry exists to serve.
    const res = await POST(makeReq({ url, auth: "Bearer ingest", body: { enum: value } }))
    expect((await res.json()).accepted).toBe(false)
    expect(st.runs[0].p_pipeline).toBe(WATCHED_PIPELINE)
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

  // R120 (2026-09-20) INVERTED this arm; it is not a new test. It asserted `p_ok === true`
  // on a rejected write, which is the claim that let the defect live: a PK rewrite blocked by
  // `panini_fmv_snapshots_edition_id_fkey` aborted the WHOLE multi-row editions statement twice
  // per walk for 66 days, the error was only console.log-ged, and the run reported success — so
  // ~4.8% of the day's edition-walk records were discarded with nothing in pipeline_runs to read
  // it off. The property pinned is the ABSENCE of the false claim, not the text of any message.
  it("records rejected editions + serials upserts as a FAILED run, each zero paired to its own error", async () => {
    st.edUpsert = { data: null, error: { message: "ed err" } }
    st.serUpsert = { data: null, error: { message: "ser err" } }
    await accept({ cards: [{ sku: "c1", fmv: 5 }], serials: [{ sku: "s1", ed: "c1" }] })
    await st.captured!()
    expect(st.runs[0].p_ok).toBe(false)
    expect(st.runs[0].p_extra.editions).toBe(0)
    expect(st.runs[0].p_extra.serials).toBe(0)
    expect(st.runs[0].p_extra.editions_error).toBe("ed err")
    expect(st.runs[0].p_extra.serials_error).toBe("ser err")
  })

  // The control that keeps the arm above from being satisfied by "always fail". A run that wrote
  // nothing because there WAS nothing to write is healthy, and the _error field is the only thing
  // that tells the two zeros apart — which is the whole reason each count carries one.
  it("a zero with NO error is still a healthy run — the paired error field is what makes a zero readable", async () => {
    st.edUpsert = { data: [], error: null }
    st.serUpsert = { data: [], error: null }
    await accept({ cards: [{ sku: "c1", fmv: 5 }], serials: [{ sku: "s1", ed: "c1" }] })
    await st.captured!()
    expect(st.runs[0].p_ok).toBe(true)
    expect(st.runs[0].p_extra.editions).toBe(0)
    expect(st.runs[0].p_extra.editions_error).toBeNull()
    expect(st.runs[0].p_extra.serials_error).toBeNull()
  })

  // R120. `fmv` reported `fmvRows.length` — rows OFFERED — under a name every reader takes for
  // rows written, and neither the delete nor the insert had its error read at all. A count that
  // cannot go DOWN when the write fails is not a measurement of the write.
  it("reports fmv rows WRITTEN, not rows offered, and fails the run when the insert is rejected", async () => {
    st.fmvInsert = { data: null, error: { message: "fmv err" } }
    await accept({ cards: [{ sku: "c1", fmv: 5 }, { sku: "c2", fmv: 7 }] })
    await st.captured!()
    expect(st.runs[0].p_ok).toBe(false)
    expect(st.runs[0].p_extra.fmv).toBe(0)
    expect(st.runs[0].p_extra.fmv_offered).toBe(2)
    expect(st.runs[0].p_extra.fmv_error).toBe("fmv err")
  })

  it("on a healthy fmv write the written count and the offered count agree", async () => {
    st.fmvInsert = { data: [{ id: "f1" }, { id: "f2" }], error: null }
    await accept({ cards: [{ sku: "c1", fmv: 5 }, { sku: "c2", fmv: 7 }] })
    await st.captured!()
    expect(st.runs[0].p_ok).toBe(true)
    expect(st.runs[0].p_extra.fmv).toBe(2)
    expect(st.runs[0].p_extra.fmv_offered).toBe(2)
    expect(st.runs[0].p_extra.fmv_error).toBeNull()
  })

  // 2026-09-25: delete-then-insert lost two editions' same-day rows when the insert failed.
  it("inserts fmv rows BEFORE deleting the same-day rows they supersede", async () => {
    await accept({ cards: [{ sku: "c1", fmv: 5 }] }); await st.captured!()
    expect(st.fmvOps).toEqual(["insert", "delete", "lt:computed_at"])
    expect(st.runs[0].p_ok).toBe(true)
  })

  it("a failed fmv insert deletes NOTHING, so the existing price survives", async () => {
    st.fmvInsert = { data: null, error: { message: "TypeError: fetch failed" } }
    await accept({ cards: [{ sku: "c1", fmv: 5 }] }); await st.captured!()
    expect(st.fmvOps).toEqual(["insert"])
    expect(st.runs[0].p_ok).toBe(false)
    expect(st.runs[0].p_extra.fmv_error).toBe("TypeError: fetch failed")
  })

  it("a failed supersede-delete fails the run but keeps the written count", async () => {
    st.fmvDelete = { data: null, error: { message: "del boom" } }
    await accept({ cards: [{ sku: "c1", fmv: 5 }] }); await st.captured!()
    expect(st.runs[0].p_extra.fmv).toBe(1)
    expect(st.runs[0].p_extra.fmv_error).toBe("delete: del boom")
    expect(st.runs[0].p_ok).toBe(false)
  })

  // FMV engine panini-1.1.0 (2026-09-24).
  it("prices from the recent-sales read and reports the engine", async () => {
    st.recent = { data: [{ edition_id: "c1", fmv_usd: 3, n_recent: 3 }], error: null }
    await accept({ cards: [{ sku: "c1", fmv: 5 }] }); await st.captured!()
    expect(st.recentCalls[0]).toEqual({ p_edition_ids: ["c1"] })
    expect(st.runs[0].p_extra.fmv_engine).toBe("panini-1.1.0")
    expect(st.runs[0].p_extra.fmv_recent_hits).toBe(1)
    expect(st.runs[0].p_ok).toBe(true)
  })

  it("a failed recent-sales read falls back to 1.0.0 AND fails the run (no silent downgrade)", async () => {
    st.recent = { data: null, error: { message: "recent boom" } }
    await accept({ cards: [{ sku: "c1", fmv: 5 }] }); await st.captured!()
    expect(st.runs[0].p_extra.fmv_engine).toBe("panini-1.0.0")
    expect(st.runs[0].p_extra.fmv_recent_error).toBe("recent boom")
    expect(st.runs[0].p_ok).toBe(false)
  })

  it("PANINI_FMV_ENGINE=1.0 is the kill switch: no recent read, 1.0.0 rows", async () => {
    process.env.PANINI_FMV_ENGINE = "1.0"
    await accept({ cards: [{ sku: "c1", fmv: 5 }] }); await st.captured!()
    expect(st.recentCalls).toHaveLength(0)
    expect(st.runs[0].p_extra.fmv_engine).toBe("panini-1.0.0")
  })

  // R120 second pass. The pack-state upsert was the LAST write in this function with no error
  // binding at all — `await …upsert(...)` with nothing destructured — so no test could reach it
  // and `packs` published rows OFFERED beside three counts that had just been made honest. A
  // fleet sweep found the same shape in 20+ other writers; this arm closes it here.
  it("records a rejected pack-state upsert as a FAILED run and reports packs WRITTEN, not offered", async () => {
    st.packUpsert = { data: null, error: { message: "pack err" } }
    await accept({ packs: [{ pack_sku: "p1" }, { pack_sku: "p2" }] })
    await st.captured!()
    expect(st.runs[0].p_ok).toBe(false)
    expect(st.runs[0].p_extra.packs).toBe(0)
    expect(st.runs[0].p_extra.packs_offered).toBe(2)
    expect(st.runs[0].p_extra.packs_error).toBe("pack err")
  })

  it("on a healthy pack-state write the written and offered counts agree", async () => {
    st.packUpsert = { data: [{ id: "p1" }, { id: "p2" }], error: null }
    await accept({ packs: [{ pack_sku: "p1" }, { pack_sku: "p2" }] })
    await st.captured!()
    expect(st.runs[0].p_ok).toBe(true)
    expect(st.runs[0].p_extra.packs).toBe(2)
    expect(st.runs[0].p_extra.packs_offered).toBe(2)
    expect(st.runs[0].p_extra.packs_error).toBeNull()
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

  // R120 (2026-09-20) INVERTED this arm too. It asserted `sales_missed === 1` on an ERRORED
  // update — contradicting the sibling test's own comment three tests up ("a miss = a serial we
  // have not walked yet, not an error"). A failed write was being counted as a clean absence.
  it("a sale update ERROR is recorded as an error, never as a not-yet-walked miss", async () => {
    st.saleUpdate = { a: { data: null, error: { message: "sale err" } } }
    await accept({ sales: [{ sku: "a", amt: 10, at: "2026-08-02T10:08:02Z" }] })
    await st.captured!()
    expect(st.runs[0].p_ok).toBe(false)
    expect(st.runs[0].p_extra.sales_applied).toBe(0)
    expect(st.runs[0].p_extra.sales_missed).toBe(0)
    expect(st.runs[0].p_extra.sales_errors).toBe(1)
    expect(st.runs[0].p_extra.sales_error).toBe("sale err")
  })

  it("stores EVERY sale record in panini_sales (raw records, as received) and reports what the RPC wrote", async () => {
    st.salesHist = { data: { valid: 2, stored_new: 1, refreshed: 1, recent_reads: 1, gaps_now: 0 }, error: null }
    const recs = [{ sku: "a", amt: 10, at: "2026-08-02T10:08:02Z", __list: "recent" }, { sku: "a", amt: 12, at: "2026-08-01T10:08:02Z", __list: "top" }]
    await accept({ sales: recs })
    await st.captured!()
    // The raw records go to the RPC — not the newest-per-card reduction.
    expect(st.salesHistCalls).toEqual([{ p_records: recs }])
    expect(st.runs[0].p_ok).toBe(true)
    expect(st.runs[0].p_extra).toMatchObject({ sales_history_new: 1, sales_history_refreshed: 1, sales_history_recent_reads: 1, sales_history_error: null })
  })

  it("a failed sales-history write fails the run and says so", async () => {
    st.salesHist = { data: null, error: { message: "hist boom" } }
    await accept({ sales: [{ sku: "a", amt: 10, at: "2026-08-02T10:08:02Z" }] })
    await st.captured!()
    expect(st.runs[0].p_ok).toBe(false)
    expect(st.runs[0].p_error).toContain("sales_history: hist boom")
    expect(st.runs[0].p_extra.sales_history_new).toBe(0)
  })

  it("an RPC answer without a write count is a failure, not zero sales", async () => {
    st.salesHist = { data: {}, error: null }
    await accept({ sales: [{ sku: "a", amt: 10, at: "2026-08-02T10:08:02Z" }] })
    await st.captured!()
    expect(st.runs[0].p_ok).toBe(false)
    expect(st.runs[0].p_extra.sales_history_error).toMatch(/no write count/)
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

// Multi-product gate (2026-09-28). Only products with walk_cards=true may reach panini_editions /
// _card_serials / _fmv_snapshots, because every Panini board and the WC pack-EV model still read
// those tables as "the WC catalogue". A card from any other product written there would be averaged
// into World Cup EV — so the gate is what keeps a widened runner from publishing a substitution.
describe("panini-ingest — product gate", () => {
  const run = async (body: unknown) => {
    const res = await POST(makeReq({ url, auth: "Bearer ingest", body }))
    expect(res.status).toBe(202)
    if (st.captured) await st.captured()
    return st.runs[st.runs.length - 1]
  }

  it("holds back cards/serials/sales of a product that is not admitted, and counts them by setId", async () => {
    const r = await run({
      cards: [{ sku: "packcard-2332_1_1_1", psku: "packcard-2332_1_1_1" }, { sku: "packcard-4100_1_1_1", psku: "packcard-4100_1_1_1" }],
      serials: [{ sku: "packcard-4100_1_1_1__1_10", ed: "packcard-4100_1_1_1" }],
    })
    expect(r.p_extra.skipped_by_set).toEqual({ "4100": 2 })
    expect(r.p_extra.admitted_set_ids).toEqual([2332])
    expect(r.p_ok).toBe(true)
  })

  it("admits a product once the registry says walk_cards=true", async () => {
    st.products = { data: [{ set_id: 2332, name: "WC", walk_cards: true }, { set_id: 4100, name: "WNBA", walk_cards: true }], error: null }
    const r = await run({ cards: [{ sku: "packcard-4100_1_1_1", psku: "packcard-4100_1_1_1" }] })
    expect(r.p_extra.skipped_by_set).toEqual({})
  })

  it("a registry read failure admits ONLY the historical WC product and fails the run loudly", async () => {
    st.products = { data: null, error: { message: "registry down" } }
    const r = await run({ cards: [{ sku: "packcard-2332_1_1_1", psku: "packcard-2332_1_1_1" }, { sku: "packcard-4100_1_1_1", psku: "packcard-4100_1_1_1" }] })
    expect(r.p_extra.admitted_set_ids).toEqual([2332])
    expect(r.p_extra.skipped_by_set).toEqual({ "4100": 1 })
    expect(r.p_ok).toBe(false)
    expect(r.p_error).toMatch(/registry down/)
  })

  it("resolves a pack's product by its published name; unknown products stay null (NOT MODELED)", async () => {
    await run({ packs: [
      { pack_sku: "1039", collection_name: "2026 Panini NFT Prizm World Cup Soccer" },
      { pack_sku: "WNBA-FOTL", collection_name: "2026 Panini NFT Prizm WNBA" },
    ] })
    expect(st.packRowsArgs.map((a) => a[1])).toEqual([2332, null])
  })

  it("⚠ a registry read failure does NOT write product_set_id at all — a null would un-model WC packs", async () => {
    st.products = { data: null, error: { message: "registry down" } }
    await run({ packs: [{ pack_sku: "1039", collection_name: "2026 Panini NFT Prizm World Cup Soccer" }] })
    const up = st.registryUpserts.find((u) => u.table === "panini_pack_state")
    expect(up).toBeTruthy()
    expect("product_set_id" in up!.rows[0]).toBe(false)
  })
})

describe("panini-ingest — discovery registry", () => {
  it("records sightings without ever admitting a product, and logs under the enum pipeline", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer ingest", body: { products: [{ set_id: 4100, sport: "Basketball", grid_items: 30 }, { set_id: 4100, sport: "Soccer", grid_items: 2 }, { set_id: "x" }] } }))
    expect(res.status).toBe(202)
    const up = st.registryUpserts.find((u) => u.table === "panini_products")!
    expect(up.rows).toHaveLength(1)
    expect(up.rows[0]).toMatchObject({ set_id: 4100, last_grid_items: 30, last_grid_sport: "Basketball" })
    expect("walk_cards" in up.rows[0]).toBe(false)
    expect(st.runs.at(-1).p_pipeline).toBe("panini-ingest-enum")
    expect(st.runs.every((r) => r.p_pipeline !== "panini-ingest")).toBe(true)
  })

  it("keeps only Panini-hosted pack links, inserts discoveries without overwriting, stamps captures", async () => {
    await POST(makeReq({ url, auth: "Bearer ingest", body: { pack_pages: [
      { url: "https://nft.paniniamerica.net/pack-2026_X.html", discovered: true },
      { url: "https://evil.example/pack-1.html", discovered: true },
      { url: "https://nft.paniniamerica.net/marketplace-details/subpack-1-1038.html", walked: true, captured: true, pack_id: "1038" },
    ] } }))
    const up = st.registryUpserts.find((u) => u.table === "panini_pack_pages")!
    expect(up.rows).toEqual([{ url: "https://nft.paniniamerica.net/pack-2026_X.html", source: "discovered" }])
    expect(up.opts.ignoreDuplicates).toBe(true)
    const upd = st.updates.find((u) => u.table === "panini_pack_pages")!
    expect(upd.patch).toMatchObject({ last_pack_id: "1038" })
    expect(upd.patch.last_captured_at).toBeTruthy()
  })
})

describe("panini-ingest — one pack product, one row", () => {
  it("dedupes two captures of the same pack id within a batch (an upsert may not touch a row twice)", async () => {
    await POST(makeReq({ url, auth: "Bearer ingest", body: { packs: [{ pack_sku: "A", collection_name: "x" }, { pack_sku: "A", collection_name: "x" }] } }))
    if (st.captured) await st.captured()
    const up = st.registryUpserts.find((u) => u.table === "panini_pack_state")!
    expect(up.rows).toHaveLength(1)
  })
})

describe("panini-ingest — sales history respects the product gate", () => {
  it("never sends a non-admitted product's sale records to panini_sales_ingest", async () => {
    await POST(makeReq({ url, auth: "Bearer ingest", body: { sales: [
      { sku: "packcard-2332_1_1_1__1_10", url_key: "packcard-2332_1_1_1__1_10", amt: 5 },
      { sku: "packcard-4100_1_1_1__1_10", url_key: "packcard-4100_1_1_1__1_10", amt: 7 },
    ] } }))
    if (st.captured) await st.captured()
    const sent = st.salesHistCalls.flatMap((a: any) => a.p_records)
    expect(sent.map((r: any) => r.url_key)).toEqual(["packcard-2332_1_1_1__1_10"])
  })
})

describe("panini-ingest — discovery evidence (2026-09-28)", () => {
  it("stores a product's identifying sample, and never writes one it was not sent", async () => {
    await POST(makeReq({ url, auth: "Bearer ingest", body: { products: [
      { set_id: 4100, sport: "Basketball", grid_items: 3, sample: { psku: "packcard-4100_1_1_1", athlete: "A'ja Wilson", team: "Las Vegas Aces", cardset: "Base Prizms Silver" } },
      { set_id: 4200, sport: "Football", grid_items: 1 },
    ] } }))
    const up = st.registryUpserts.find((u) => u.table === "panini_products")!
    const byId = Object.fromEntries(up.rows.map((r: any) => [r.set_id, r]))
    expect(byId[4100].sample).toMatchObject({ team: "Las Vegas Aces" })
    expect("sample" in byId[4200]).toBe(false)
  })

  it("stamps a pack page's fired ops and pack-like evidence; an oversize blob is marked dropped, not truncated", async () => {
    const big = Object.fromEntries(Array.from({ length: 800 }, (_, i) => [`op${i}`, i]))
    await POST(makeReq({ url, auth: "Bearer ingest", body: { pack_pages: [
      { url: "https://nft.paniniamerica.net/pack-a.html", walked: true, captured: false, ops: { getDropDetails: 2 }, pack_like: { op: "getDropDetails", keys: ["pack_sku"] } },
      { url: "https://nft.paniniamerica.net/pack-b.html", walked: true, captured: false, ops: big },
      { url: "https://nft.paniniamerica.net/pack-c.html", walked: true, captured: false },
    ] } }))
    const ups = st.updates.filter((u) => u.table === "panini_pack_pages")
    expect(ups[0].patch).toMatchObject({ last_ops: { getDropDetails: 2 }, last_pack_like: { op: "getDropDetails" } })
    expect(ups[1].patch.last_ops).toMatchObject({ dropped: "over size bound" })
    expect("last_ops" in ups[2].patch).toBe(false)
    expect("last_pack_like" in ups[2].patch).toBe(false)
  })
})
