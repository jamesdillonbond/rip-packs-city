import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Deep drive of /api/cron/pinnacle-wmc-render-id's DEFERRED after() body (the
// sibling test only pins auth + the 202 ack). This route pulls unresolved Pinnacle
// wmc rows, resolves render_id/serial via the Dapper studio GQL, updates wmc,
// derives catalog fields, and drains a batch of pinnacle_sales render_ids — all in
// after(). The legs worth pinning (each a documented 2026-06-10 dark-500 risk or a
// best-effort guard):
//   - candidate-read { error } → logs ok:false "candidate_read: ..." and returns
//     (the statement that used to 500 before log_pipeline_run)
//   - happy path → GQL-resolved rows update wmc, derive runs, sales drain updates,
//     final log ok:true with the telemetry envelope
//   - a GQL chunk throwing → gqlErrors++ and final ok:false "N gql chunk errors"
//   - the sales drain is best-effort (its throw never fails the wmc pipeline)
//   - null-render_id nodes are skipped

vi.hoisted(() => {
  process.env.INGEST_SECRET_TOKEN = "tok"
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc"
})

let capturedAfter: null | (() => Promise<void>) = null
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: () => Promise<void>) => { capturedAfter = fn } }
})

// Configurable Supabase behavior.
const st = vi.hoisted(() => ({
  selectResult: { data: [] as any, error: null as any },
  updateResult: { data: null as any, error: null as any },
  rpcImpl: {} as Record<string, (params?: any) => Promise<any>>,
}))
const rpc = vi.hoisted(() => vi.fn(async (name: string, params?: any) => {
  const impl = st.rpcImpl[name]
  return impl ? impl(params) : { data: null, error: null }
}))
function makeBuilder() {
  let op: "select" | "update" = "select"
  const b: any = {
    select: () => { op = "select"; return b },
    update: () => { op = "update"; return b },
    eq: () => b,
    is: () => b,
    limit: () => b,
    then: (resolve: any) => resolve(op === "update" ? st.updateResult : st.selectResult),
  }
  return b
}
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: () => makeBuilder(), rpc: (...a: any[]) => rpc(...(a as [string, any?])) }),
}))

import { GET } from "@/app/api/cron/pinnacle-wmc-render-id/route"

const url = "https://t/api/cron/pinnacle-wmc-render-id"
const req = (opts: { auth?: string; token?: string } = {}) => {
  const u = new URL(url + (opts.token ? `?token=${opts.token}` : ""))
  const headers = new Headers()
  if (opts.auth) headers.set("authorization", opts.auth)
  return { headers, nextUrl: u, url: u.toString() } as any
}

// GQL fetch fixture: id -> { serial_number, render_id }. fetchByIds echoes back
// an edge per requested id.
const gqlFixture: Record<string, { serial_number: string | null; render_id: string | null }> = {}
let fetchMode: "ok" | "notok" | "errors" = "ok"

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => {
    if (fetchMode === "notok") return { ok: false, status: 502, json: async () => ({}) }
    const body = JSON.parse(init.body)
    const ids: string[] = body.variables.ids
    if (fetchMode === "errors") return { ok: true, json: async () => ({ errors: [{ message: "boom" }] }) }
    return {
      ok: true,
      json: async () => ({
        data: {
          searchPinnacleNft: {
            edges: ids
              .filter((id) => gqlFixture[id])
              .map((id) => ({ node: { id, serial_number: gqlFixture[id].serial_number, edition: { render_id: gqlFixture[id].render_id } } })),
          },
        },
      }),
    }
  }))
}

function logParams() {
  return rpc.mock.calls.find((c) => c[0] === "log_pipeline_run")?.[1]
}
async function drive(r = req({ auth: "Bearer tok" })) {
  const res = await GET(r)
  expect(res.status).toBe(202)
  expect(typeof capturedAfter).toBe("function")
  await capturedAfter!()
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "tok"
  capturedAfter = null
  rpc.mockClear()
  st.selectResult = { data: [], error: null }
  st.updateResult = { data: null, error: null }
  st.rpcImpl = {
    log_pipeline_run: async () => ({ data: null, error: null }),
    derive_pinnacle_wmc_from_catalog: async () => ({ error: null }),
    pinnacle_sales_unresolved_render_nft_ids: async () => ({ data: [] }),
    pinnacle_sales_set_render_ids: async () => ({ data: 0 }),
  }
  for (const k of Object.keys(gqlFixture)) delete gqlFixture[k]
  fetchMode = "ok"
  installFetch()
})
afterEach(() => vi.unstubAllGlobals())

describe("/api/cron/pinnacle-wmc-render-id — deferred body", () => {
  it("401 without a token; accepts bearer OR ?token= query", async () => {
    expect((await GET(req({ auth: "Bearer nope" }))).status).toBe(401)
    // ?token= form is accepted
    st.selectResult = { data: [], error: null }
    const res = await GET(req({ token: "tok" }))
    expect(res.status).toBe(202)
  })

  it("candidate-read { error } → logs ok:false 'candidate_read:' and returns early (no GQL)", async () => {
    st.selectResult = { data: null, error: { message: "statement timeout" } }
    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(false)
    expect(p.p_error).toBe("candidate_read: statement timeout")
    expect((globalThis.fetch as any).mock.calls.length).toBe(0)
    expect(p.p_extra.stage).toBe("candidate_read")
  })

  it("happy path → GQL-resolved rows update wmc, derive runs, sales drain updates, ok:true", async () => {
    st.selectResult = { data: [{ moment_id: "1" }, { moment_id: "2" }], error: null }
    gqlFixture["1"] = { serial_number: "5", render_id: "r1" }
    gqlFixture["2"] = { serial_number: null, render_id: null } // no render_id → skipped
    gqlFixture["9"] = { serial_number: "2", render_id: "r9" }
    st.rpcImpl.pinnacle_sales_unresolved_render_nft_ids = async () => ({ data: ["9"] })
    st.rpcImpl.pinnacle_sales_set_render_ids = async () => ({ data: 3 })

    await drive()

    const p = logParams()
    expect(p.p_ok).toBe(true)
    expect(p.p_error).toBeNull()
    expect(p.p_rows_found).toBe(2) // unresolved ids
    expect(p.p_rows_written).toBe(1) // only id 1 had a render_id
    expect(p.p_extra.resolved).toBe(1)
    expect(p.p_extra.derived).toBe(1) // derive ran because resolved>0
    expect(p.p_extra.sales_resolved).toBe(1)
    expect(p.p_extra.sales_updated).toBe(3)
    expect(p.p_extra.gql_errors).toBe(0)
  })

  it("a GQL chunk throwing (HTTP not-ok) → gqlErrors++ and final ok:false", async () => {
    st.selectResult = { data: [{ moment_id: "1" }], error: null }
    fetchMode = "notok"
    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(false)
    expect(p.p_error).toContain("gql chunk errors")
    expect(p.p_extra.resolved).toBe(0)
  })

  it("derive is skipped when nothing resolved (resolved===0 guard)", async () => {
    st.selectResult = { data: [{ moment_id: "7" }], error: null }
    gqlFixture["7"] = { serial_number: null, render_id: null } // resolves nothing
    const deriveSpy = vi.fn(async () => ({ error: null }))
    st.rpcImpl.derive_pinnacle_wmc_from_catalog = deriveSpy
    await drive()
    expect(deriveSpy).not.toHaveBeenCalled()
    expect(logParams().p_extra.derived).toBe(0)
  })

  it("the sales drain is best-effort — its RPC throwing never fails the wmc pipeline", async () => {
    st.selectResult = { data: [{ moment_id: "1" }], error: null }
    gqlFixture["1"] = { serial_number: "1", render_id: "r1" }
    st.rpcImpl.pinnacle_sales_unresolved_render_nft_ids = async () => { throw new Error("sales rpc down") }
    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(true) // wmc side succeeded
    expect(p.p_extra.resolved).toBe(1)
    expect(p.p_extra.sales_resolved).toBe(0)
  })
})
