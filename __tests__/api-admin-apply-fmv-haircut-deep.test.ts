import { describe, it, expect, beforeEach, vi } from "vitest"

// Deep drive of POST /api/admin/apply-fmv-haircut (the sibling only pins auth).
// mode=dry is synchronous (returns the preview counts); mode=live is 202 +
// after() (the daily cron). Legs pinned: auth, mode validation, unknown-collection
// 400, the dry-run success + rpc-error 500, and the deferred live body — rpc
// returned-error vs THROW both logging ok:false (the 2026-06-11 dark-run guard),
// the success log with the examined/haircut/skipped split, and the log-throw swallow.

let capturedAfter: null | (() => Promise<void>) = null
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: () => Promise<void>) => { capturedAfter = fn } }
})
// ⚠ THE PER-LEG SPLIT (2026-08-16, `d50ca1b3`) CHANGED THIS ROUTE'S SHAPE AND
// THIS SUITE DID NOT FOLLOW, WHICH IS WHY IT IS WORTH A NOTE. `mode=live` now
// reads `collections` and calls the RPC ONCE PER COLLECTION, so the stub's
// `supabaseAdmin` — which only ever had `.rpc` — threw
// `TypeError: supabaseAdmin.from is not a function` on all four live cases and
// left the blocking `unit-tests` job red on `main`.
//   The counts below are consequently SUMS ACROSS LEGS, not one call's return.
// Each leg is given a DIFFERENT payload on purpose: a sum of distinct values
// (166/19) cannot be produced by a single leg or by one value multiplied, so
// the assertions prove per-leg aggregation rather than merely surviving.
const LEGS = [
  { id: "95f28a17-224a-4025-96ad-adf8a4c63bfd", slug: "topshot", examined: 100, haircut: 12, dollars: 340.5 },
  { id: "dee28451-5d62-409e-a1ad-a83f763ac070", slug: "allday", examined: 50, haircut: 5, dollars: 120.25 },
  { id: "06248cc4-b85f-47cd-af67-1855d14acd75", slug: "golazos", examined: 10, haircut: 1, dollars: 9.5 },
  { id: "9b4824a8-736d-4a96-b450-8dcc0c46b023", slug: "ufc", examined: 4, haircut: 0, dollars: 0 },
  { id: "209ade70-32c5-4470-bc7c-4793d660f713", slug: "candy_mlb", examined: 2, haircut: 1, dollars: 30 },
]
const SUM = {
  examined: LEGS.reduce((s, l) => s + l.examined, 0),   // 166
  haircut: LEGS.reduce((s, l) => s + l.haircut, 0),     // 19
  dollars: LEGS.reduce((s, l) => s + l.dollars, 0),     // 500.25
}

const st = vi.hoisted(() => ({
  authed: true,
  haircut: { data: null as any, error: null as any },
  haircutThrows: false,
  logThrows: false,
  // The `collections` catalogue read the split introduced.
  collections: { data: null as any, error: null as any },
  // Per-collection-id override so ONE leg can fail while the others succeed.
  perLeg: {} as Record<string, { data: any; error: any } | "throw">,
  fromTables: [] as string[],
}))
const rpc = vi.hoisted(() => vi.fn(async (name: string, p?: any) => {
  if (name === "fmv_apply_thin_sale_haircut") {
    const per = st.perLeg[String(p?.p_collection_id ?? "null")]
    if (per === "throw") throw new Error("pool timeout")
    if (per) return per
    if (st.haircutThrows) throw new Error("pool timeout")
    return st.haircut
  }
  if (name === "log_pipeline_run") { if (st.logThrows) throw new Error("log down"); return { data: null, error: null } }
  return { data: null, error: null }
}))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: (...a: any[]) => rpc(...(a as [string, any?])),
    // `.from("collections").select(...).order(...)` — awaited directly, so
    // `order` is the thenable. Records the table so a case can assert the route
    // derives its legs from the CATALOGUE rather than a hardcoded member list
    // (the route's own comment explains why that distinction matters: a
    // hardcoded map omits candy_mlb and includes pinnacle, which has zero rows).
    from: (table: string) => {
      st.fromTables.push(table)
      return { select: () => ({ order: async () => st.collections }) }
    },
  },
}))
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminRequest: () => st.authed,
  adminUnauthorizedResponse: () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
}))

import { POST } from "@/app/api/admin/apply-fmv-haircut/route"

const post = (qs = "?mode=dry") => ({ nextUrl: new URL(`https://t/api/admin/apply-fmv-haircut${qs}`) }) as any

beforeEach(() => {
  st.authed = true
  st.haircut = { data: [{ rows_examined: 100, rows_haircut: 12, total_dollars_removed: 340.5 }], error: null }
  st.haircutThrows = false
  st.logThrows = false
  st.collections = { data: LEGS.map((l) => ({ id: l.id, slug: l.slug })), error: null }
  st.perLeg = Object.fromEntries(
    LEGS.map((l) => [l.id, { data: [{ rows_examined: l.examined, rows_haircut: l.haircut, total_dollars_removed: l.dollars }], error: null }]),
  )
  st.fromTables = []
  capturedAfter = null
  rpc.mockClear()
})
function logParams() { return rpc.mock.calls.find((c) => c[0] === "log_pipeline_run")?.[1] }

describe("POST /api/admin/apply-fmv-haircut", () => {
  it("401 when not an admin", async () => {
    st.authed = false
    expect((await POST(post())).status).toBe(401)
  })
  it("400 for an invalid mode", async () => {
    expect((await POST(post("?mode=bogus"))).status).toBe(400)
  })
  it("400 for an unknown collection", async () => {
    const res = await POST(post("?mode=dry&collection=nope"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("unknown collection")
  })
  it("mode=dry returns the preview counts synchronously", async () => {
    const body = await (await POST(post("?mode=dry&collection=topshot"))).json()
    expect(body.mode).toBe("dry")
    expect(body.rows_examined).toBe(100)
    expect(body.rows_haircut).toBe(12)
    expect(body.total_dollars_removed).toBe(340.5)
  })
  it("mode=dry rpc error → 500", async () => {
    st.haircut = { data: null, error: { message: "rpc down" } }
    expect((await POST(post("?mode=dry"))).status).toBe(500)
  })

  it("mode=live: 202 accepted, then the deferred body logs ok:true with the split", async () => {
    const res = await POST(post("?mode=live"))
    expect(res.status).toBe(202)
    expect(typeof capturedAfter).toBe("function")
    await capturedAfter!()
    const p = logParams()
    expect(p.p_ok).toBe(true)
    // Sums across the five legs, from five DIFFERENT payloads — 166 is not
    // reachable by one leg or by a single value multiplied.
    expect(p.p_rows_found).toBe(SUM.examined)
    expect(p.p_rows_written).toBe(SUM.haircut)
    expect(p.p_rows_skipped).toBe(SUM.examined - SUM.haircut)
    expect(p.p_extra.total_dollars_removed).toBeCloseTo(SUM.dollars, 2)
    expect(p.p_extra.legs_total).toBe(LEGS.length)
    expect(p.p_extra.legs_failed).toBe(0)
  })
  it("mode=live: one RPC per collection, each scoped to that collection's id", async () => {
    // The whole point of the split: five bounded statements instead of one
    // un-scoped statement that exceeded the 120s global timeout. A regression to
    // a single un-scoped call still sums correctly, so the SHAPE needs its own
    // assertion — the ids are what prove each leg carries its own budget.
    await POST(post("?mode=live"))
    await capturedAfter!()
    const ids = rpc.mock.calls.filter((c) => c[0] === "fmv_apply_thin_sale_haircut").map((c) => (c[1] as any).p_collection_id)
    expect(ids).toEqual(LEGS.map((l) => l.id))
    expect(ids).not.toContain(null)
  })
  it("mode=live: derives the legs from the collections CATALOGUE, not a hardcoded list", async () => {
    // The route's own comment: the in-file COLLECTION_UUID map omits candy_mlb
    // (which has live snapshots) and includes pinnacle (which has none), so
    // splitting on it would silently drop a collection while looking complete.
    await POST(post("?mode=live"))
    await capturedAfter!()
    expect(st.fromTables).toContain("collections")
    const slugs = logParams().p_extra.legs.map((l: any) => l.slug)
    expect(slugs).toContain("candy_mlb")
  })
  it("mode=live?collection=topshot: exactly ONE scoped leg, no catalogue read", async () => {
    await POST(post("?mode=live&collection=topshot"))
    await capturedAfter!()
    const calls = rpc.mock.calls.filter((c) => c[0] === "fmv_apply_thin_sale_haircut")
    expect(calls).toHaveLength(1)
    expect((calls[0][1] as any).p_collection_id).toBe("95f28a17-224a-4025-96ad-adf8a4c63bfd")
    expect(st.fromTables).not.toContain("collections")
  })
  it("mode=live: a failed catalogue read falls back to ONE un-scoped leg, never a narrowed sweep", async () => {
    // ⚠ The dangerous failure here is silence, not an error: skipping the run,
    // or sweeping a subset, both look like success. The fallback deliberately
    // restores the pre-split un-scoped call rather than doing less work.
    st.collections = { data: null, error: { message: "catalogue down" } }
    await POST(post("?mode=live"))
    await capturedAfter!()
    const calls = rpc.mock.calls.filter((c) => c[0] === "fmv_apply_thin_sale_haircut")
    expect(calls).toHaveLength(1)
    expect((calls[0][1] as any).p_collection_id).toBeNull()
    expect(logParams().p_ok).toBe(true)
  })
  it("mode=live: an EMPTY catalogue also falls back rather than sweeping nothing", async () => {
    // An empty array is a successful read returning no rows — distinct from an
    // error, and the more dangerous of the two, since zero legs would report
    // ok:true having done nothing at all.
    st.collections = { data: [], error: null }
    await POST(post("?mode=live"))
    await capturedAfter!()
    const calls = rpc.mock.calls.filter((c) => c[0] === "fmv_apply_thin_sale_haircut")
    expect(calls).toHaveLength(1)
    expect((calls[0][1] as any).p_collection_id).toBeNull()
  })
  it("mode=live: a PARTIAL failure reports ok:false but keeps the surviving legs' counts", async () => {
    // ⚠ The defect this guards is publishing 0. Before the split any failure
    // rolled the whole statement back, so 0 was true; now four legs really did
    // apply their haircut, and reporting 0 would understate applied work — the
    // mirror of the drain-fmv-cold-tail "healthy pipeline reports nothing" bug.
    st.perLeg["95f28a17-224a-4025-96ad-adf8a4c63bfd"] = { data: null, error: { message: "statement timeout" } }
    await POST(post("?mode=live"))
    await capturedAfter!()
    const p = logParams()
    expect(p.p_ok).toBe(false)
    expect(p.p_error).toContain("1/5 legs failed")
    expect(p.p_error).toContain("topshot: statement timeout")
    // The four survivors: 166 - topshot's 100 examined, 19 - its 12 haircut.
    expect(p.p_rows_found).toBe(SUM.examined - 100)
    expect(p.p_rows_written).toBe(SUM.haircut - 12)
    expect(p.p_extra.legs_failed).toBe(1)
    expect(p.p_extra.legs_total).toBe(LEGS.length)
  })
  it("mode=live: one leg THROWING does not discard the other four", async () => {
    // A throw takes a different path from a returned error (the 2026-06-11
    // dark-run guard) and is per-leg now, so it needs its own case.
    st.perLeg["dee28451-5d62-409e-a1ad-a83f763ac070"] = "throw"
    await POST(post("?mode=live"))
    await capturedAfter!()
    const p = logParams()
    expect(p.p_ok).toBe(false)
    expect(p.p_error).toContain("allday: pool timeout")
    expect(p.p_rows_found).toBe(SUM.examined - 50)
  })
  it("mode=live: a returned rpc error logs ok:false", async () => {
    st.perLeg = {}
    st.haircut = { data: null, error: { message: "rpc error" } }
    await POST(post("?mode=live"))
    await capturedAfter!()
    const p = logParams()
    expect(p.p_ok).toBe(false)
    // Now an AGGREGATE message; every leg failed, which is the old whole-run
    // failure and must still read as one.
    expect(p.p_error).toContain("5/5 legs failed")
    expect(p.p_error).toContain("rpc error")
  })
  it("mode=live: a THROWN rpc still logs ok:false (the dark-run guard)", async () => {
    st.perLeg = {}
    st.haircutThrows = true
    await POST(post("?mode=live"))
    await capturedAfter!()
    const p = logParams()
    expect(p.p_ok).toBe(false)
    expect(p.p_error).toContain("pool timeout")
  })
  it("mode=live: a log_pipeline_run throw is swallowed", async () => {
    st.logThrows = true
    await POST(post("?mode=live"))
    await expect(capturedAfter!()).resolves.toBeUndefined()
  })
})
