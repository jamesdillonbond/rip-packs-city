import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Route integration test for /api/admin/backfill-pinnacle-sales-render-id
// (GET + POST share handle()). Bearer-gated via verifyAdminRequest. Deep legs:
// the ids-rpc throw, the GQL drain loop (fetch ok mapping node.render_id vs
// edition.render_id, non-ok HTTP + GQL-errors→gqlErrors, empty edges skip), the
// set_render_ids RPC (count + error), the residual query, the limit param, and
// the pipeline_runs telemetry ok/not-ok.

const st = vi.hoisted(() => ({
  ids: [] as string[],
  residual: [] as string[],
  setCount: 5 as any,
  setErr: null as any,
  idsErr: null as any,
  runs: [] as any[],
}))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (name: string, args: any) => {
      if (name === "pinnacle_sales_unresolved_render_nft_ids") {
        if (st.idsErr && args.p_limit !== 100000) return { data: null, error: st.idsErr }
        return { data: args.p_limit === 100000 ? st.residual : st.ids, error: null }
      }
      if (name === "pinnacle_sales_set_render_ids") return { data: st.setCount, error: st.setErr }
      if (name === "log_pipeline_run") { st.runs.push(args); return { data: null, error: null } }
      return { data: null, error: null }
    },
  },
}))

import { GET, POST } from "@/app/api/admin/backfill-pinnacle-sales-render-id/route"

let fetchMode: "ok" | "notok" | "gqlerr" | "empty" = "ok"
function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async () => {
    if (fetchMode === "notok") return { ok: false, status: 502, json: async () => ({}) }
    if (fetchMode === "gqlerr") return { ok: true, json: async () => ({ errors: [{ message: "boom" }] }) }
    if (fetchMode === "empty") return { ok: true, json: async () => ({ data: { searchPinnacleNft: { edges: [] } } }) }
    return {
      ok: true,
      json: async () => ({
        data: { searchPinnacleNft: { edges: [
          { node: { id: "1", render_id: "R1", edition: null } },
          { node: { id: "2", render_id: null, edition: { render_id: "R2" } } }, // falls back to edition
          { node: { id: "3", render_id: null, edition: { render_id: null } } }, // no render → dropped
          { node: null }, // null node skipped
        ] } },
      }),
    }
  }))
}

beforeEach(() => {
  process.env.RPC_ADMIN_TOKEN = "secret"
  st.ids = []; st.residual = []; st.setCount = 5; st.setErr = null; st.idsErr = null; st.runs = []
  fetchMode = "ok"
  installFetch()
})
afterEach(() => { delete process.env.RPC_ADMIN_TOKEN; vi.unstubAllGlobals() })

const authed = (qs = "") => adminReq(`https://t/api/admin/backfill-pinnacle-sales-render-id${qs}`, { authorization: "Bearer secret" })

describe("pinnacle-sales-render-id — auth", () => {
  it("GET 401s when the token is unset", async () => {
    delete process.env.RPC_ADMIN_TOKEN
    expect((await GET(adminReq("https://t/x"))).status).toBe(401)
  })
  it("POST 401s on a wrong bearer", async () => {
    expect((await POST(adminReq("https://t/x", { authorization: "Bearer nope" }))).status).toBe(401)
  })
})

describe("pinnacle-sales-render-id — drain", () => {
  it("200s with 0 attempted when there are no unresolved ids", async () => {
    const body = await (await GET(authed())).json()
    expect(body.ok).toBe(true)
    expect(body.distinct_nft_attempted).toBe(0)
  })

  it("resolves render ids (node + edition fallback) and stamps sales via the set RPC", async () => {
    st.ids = ["1", "2", "3"]
    st.residual = ["3"] // one stays unresolved
    const body = await (await GET(authed("?limit=500"))).json()
    expect(body.distinct_nft_attempted).toBe(3)
    expect(body.nfts_resolved).toBe(2) // ids 1 + 2 (3 has no render, node null skipped)
    expect(body.sales_rows_updated).toBe(5)
    expect(body.distinct_nft_residual).toBe(1)
    expect(st.runs[0].p_ok).toBe(true)
  })

  it("counts a non-ok GQL response as a gql error and stays ok:false", async () => {
    st.ids = ["9"]
    fetchMode = "notok"
    const body = await (await GET(authed())).json()
    expect(body.gql_errors).toBe(1)
    expect(body.ok).toBe(false)
    expect(body.errors[0]).toContain("GQL 502")
  })

  it("treats GQL top-level errors as a chunk failure", async () => {
    st.ids = ["9"]
    fetchMode = "gqlerr"
    const body = await (await GET(authed())).json()
    expect(body.gql_errors).toBe(1)
  })

  it("skips a chunk that returns no edges (no set RPC)", async () => {
    st.ids = ["9"]
    fetchMode = "empty"
    const body = await (await GET(authed())).json()
    expect(body.nfts_resolved).toBe(0)
    expect(body.sales_rows_updated).toBe(0)
    expect(body.ok).toBe(true)
  })

  it("records the set-render RPC error without aborting", async () => {
    st.ids = ["1"]
    st.setErr = { message: "set down" }
    const body = await (await GET(authed())).json()
    expect(body.ok).toBe(false)
    expect(body.errors.some((e: string) => e.includes("set rpc"))).toBe(true)
  })

  it("surfaces the unresolved-ids RPC error", async () => {
    st.idsErr = { message: "ids rpc down" }
    const body = await (await GET(authed())).json()
    expect(body.ok).toBe(false)
    expect(body.errors[0]).toContain("unresolved ids rpc")
  })
})
