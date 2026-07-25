import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for /api/cron/panini-ingest (POST push ingest). Auth:
// Bearer INGEST_SECRET_TOKEN or CRON_SECRET, else 401. Deep legs: the empty-body
// 202 no-op, and the captured after() body — editions dedup + chunked upsert (+
// error branch), the fmv delete-then-insert, the pack-state upsert, the serials
// dedup + upsert (+ error), the success logRun, and the thrown-body catch. The
// normalize helpers are mocked so row shapes are deterministic.

const st = vi.hoisted(() => ({
  edUpsert: { data: [{ id: "e1" }], error: null as any },
  serUpsert: { data: [{ id: "s1" }], error: null as any },
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
      const b: any = {
        upsert: () => b, insert: async () => ({ error: null }), delete: () => b,
        in: () => b, gte: () => b,
        select: async () => (table === "panini_editions" ? st.edUpsert : st.serUpsert),
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
}))

import { POST } from "@/app/api/cron/panini-ingest/route"

const url = "https://t/api/cron/panini-ingest"
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "ingest"
  delete process.env.CRON_SECRET
  st.edUpsert = { data: [{ id: "e1" }], error: null }
  st.serUpsert = { data: [{ id: "s1" }], error: null }
  st.runs = []; st.captured = null; st.throwInWalk = false
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

  it("logs an ok:false run when the walk throws", async () => {
    st.throwInWalk = true
    await accept({ cards: [{ sku: "c1" }] })
    await st.captured!()
    expect(st.runs[0].p_ok).toBe(false)
    expect(st.runs[0].p_error).toContain("normalize boom")
  })
})
