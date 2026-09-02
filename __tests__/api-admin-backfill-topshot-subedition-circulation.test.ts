import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Route integration test for /api/admin/backfill-topshot-subedition-circulation
// (GET + POST share handle()). Auth via authed(): verifyAdminRequest OR
// INGEST_SECRET_TOKEN OR CRON_SECRET. Deep legs: the :: editions select error
// →500, the empty-catalog exhaust, ?probe=1 (returns the distribution without
// writing), a gql_fault termination (non-ok fetch page), and a matched parallel
// that GREATEST-updates circulation + captures the ask + logs pipeline_runs (with
// the update-error → ok:false variant).

const st = vi.hoisted(() => ({
  editionRows: [] as any[],
  selErr: null as any,
  updResult: { error: null as any },
  askResult: { error: null as any },
}))

vi.mock("@/lib/supabase", () => {
  const sb: any = {
    from: () => sb,
    select: () => sb, eq: () => sb, like: () => sb, not: () => sb, order: () => sb, update: () => sb, delete: () => sb, in: () => sb, gte: () => sb,
    range: async () => ({ data: st.selErr ? null : st.editionRows, error: st.selErr }),
    upsert: async () => st.askResult,
    insert: async () => ({ data: null, error: null }),
    then: (resolve: any) => resolve(st.updResult), // the awaited update chain (.update().eq())
  }
  return { supabaseAdmin: sb }
})

import { GET, POST } from "@/app/api/admin/backfill-topshot-subedition-circulation/route"

// A page queue for fetchPage: each fetch() call shifts the next page.
let pageQueue: Array<{ ok: boolean; status?: number; body?: string; editions?: any[]; cursor?: string | null }> = []
function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async () => {
    const p = pageQueue.shift()
    // ⚠ `text` is required, not decorative: the route reads a non-ok RESPONSE BODY,
    // because a Cloudflare 530 says "origin is down" only in its body and that is
    // the signature rpc_ops_snapshot's failure buckets classify on. A mock without
    // it makes the route's own catch fire and reports the wrong fault reason.
    if (!p || p.ok === false) {
      return {
        ok: false,
        status: p?.status ?? 500,
        text: async () => p?.body ?? "",
        json: async () => ({}),
      }
    }
    return {
      ok: true,
      json: async () => ({ data: { searchMarketplaceEditions: { data: { searchSummary: { data: { data: p.editions ?? [] }, pagination: { rightCursor: p.cursor ?? null } } } } } }),
    }
  }))
}
const gqlEdition = (pid: number, circ: number | null, playFlow: number, ask: number | null = null) =>
  ({ parallelID: pid, circulationCount: circ, lowAsk: ask, set: { flowId: 0 }, play: { flowID: playFlow } })

const auth = (qs = "", token = "secret") => adminReq(`https://t/api/admin/backfill-topshot-subedition-circulation${qs}`, { authorization: `Bearer ${token}` })

beforeEach(() => {
  delete process.env.RPC_ADMIN_TOKEN; delete process.env.INGEST_SECRET_TOKEN; delete process.env.CRON_SECRET
  st.editionRows = []; st.selErr = null; st.updResult = { error: null }; st.askResult = { error: null }
  pageQueue = [{ ok: true, editions: [], cursor: null }] // default: exhaust immediately
  installFetch()
})
afterEach(() => {
  delete process.env.RPC_ADMIN_TOKEN; delete process.env.INGEST_SECRET_TOKEN; delete process.env.CRON_SECRET
  vi.unstubAllGlobals()
})

describe("subedition-circulation — auth + select", () => {
  it("GET 401s when no secret is configured", async () => {
    expect((await GET(adminReq("https://t/x"))).status).toBe(401)
  })
  it("POST 401s with a wrong bearer", async () => {
    process.env.CRON_SECRET = "cron"
    expect((await POST(adminReq("https://t/x", { authorization: "Bearer nope" }))).status).toBe(401)
  })
  it("200s exhausting the catalog with 0 needed triples", async () => {
    process.env.RPC_ADMIN_TOKEN = "secret"
    const body = await (await GET(auth())).json()
    expect(body.ok).toBe(true)
    expect(body.needed_triples).toBe(0)
  })
  it("500s on a :: editions select error", async () => {
    process.env.RPC_ADMIN_TOKEN = "secret"
    st.selErr = { message: "select down" }
    expect((await GET(auth())).status).toBe(500)
  })
})

describe("subedition-circulation — probe + faults", () => {
  beforeEach(() => { process.env.RPC_ADMIN_TOKEN = "secret" })

  it("?probe=1 returns the parallel distribution without writing", async () => {
    pageQueue = [{ ok: true, editions: [gqlEdition(5, 250, 188), gqlEdition(7, 15, 188)], cursor: null }]
    const body = await (await GET(auth("?probe=1"))).json()
    expect(body.mode).toBe("probe")
    expect(body.parallel_rows_seen).toBe(2)
    expect(body.distinct_parallel_ids).toEqual([5, 7])
  })

  it("terminates gql_fault on a non-ok fetch page", async () => {
    pageQueue = [{ ok: false }]
    const body = await (await GET(auth())).json()
    expect(body.terminated_reason).toBe("gql_fault")
  })

  // ── a run that read NOTHING is not a success (2026-09-02) ────────────────
  //
  // Every daily run in the retained window logged `ok: true` with `pages: 0`,
  // `gql_editions_seen: 0`, `rows_written: 0` and `errors_sample: []`, because
  // `ok` was derived from per-edition WRITE errors while the failure was the
  // upstream READ. It therefore appeared in no failure bucket and could not trip
  // `check_pipelines_running_but_not_succeeding`, which requires ok_runs = 0.
  it("reports ok:false and NAMES the upstream fault when the first page fails", async () => {
    pageQueue = [{ ok: false, status: 530, body: "<head><title>An error has occured</title></head>" }]
    const body = await (await GET(auth())).json()

    expect(body.terminated_reason).toBe("gql_fault")
    expect(body.ok, "a run that read nothing and wrote nothing is not a success").toBe(false)
    // The reason must survive to where an operator reads it — a count of zero with
    // no error beside it cannot distinguish "nothing to do" from "could not look".
    expect(body.gql_fault_reason).toContain("530")
    expect(body.gql_fault_reason).toContain("An error has occured")
  })

  it("CONTROL — a fault AFTER a page of data stays ok: a partial sweep that committed is productive", async () => {
    // This is the distinction the scoping exists for. Without it the fix would
    // redden every run that loses its upstream mid-sweep, which the repo's own
    // rule calls productive rather than stalled.
    pageQueue = [
      { ok: true, editions: [gqlEdition(3, 25, 7001)], cursor: "C2" },
      { ok: false, status: 530 },
    ]
    const body = await (await GET(auth())).json()
    expect(body.terminated_reason).toBe("gql_fault")
    expect(body.ok).toBe(true)
    // Still NAMED, even when it does not redden the run.
    expect(body.gql_fault_reason).toContain("530")
  })

  it("caps pages via ?maxPages and honors the page cursor loop", async () => {
    // one page that points its cursor at itself → cursor_loop guard on the next iter
    pageQueue = [{ ok: true, editions: [], cursor: "C" }, { ok: true, editions: [], cursor: "C" }]
    const body = await (await GET(auth("?maxPages=5"))).json()
    expect(body.ok).toBe(true)
  })
})

describe("subedition-circulation — matched update", () => {
  beforeEach(() => { process.env.RPC_ADMIN_TOKEN = "secret" })

  it("GREATEST-updates a matched parallel, captures its ask, and logs the run", async () => {
    st.editionRows = [
      { id: "e1", external_id: "134:5038::5", set_id_onchain: 134, play_id_onchain: 188, subedition_id: 5, circulation_count: 100 },
    ]
    // GQL reports a higher circ (250 > 100 floor) + an ask → update + ask upsert
    pageQueue = [{ ok: true, editions: [gqlEdition(5, 250, 188, 12.5)], cursor: null }]
    const body = await (await GET(auth())).json()
    expect(body.matched).toBe(1)
    expect(body.updated).toBe(1)
    expect(body.ask_upserts).toBe(1)
    expect(body.ok).toBe(true)
  })

  it("marks ok:false when the circulation update errors", async () => {
    st.editionRows = [
      { id: "e1", external_id: "134:5038::5", set_id_onchain: 134, play_id_onchain: 188, subedition_id: 5, circulation_count: 100 },
    ]
    st.updResult = { error: { message: "update down" } }
    pageQueue = [{ ok: true, editions: [gqlEdition(5, 250, 188)], cursor: null }]
    const body = await (await GET(auth())).json()
    expect(body.ok).toBe(false)
    expect(body.errors_count).toBe(1)
  })

  it("skips a parallel whose GQL circ is ambiguous across sets (never below the floor)", async () => {
    st.editionRows = [
      { id: "e1", external_id: "134:5038::5", set_id_onchain: 134, play_id_onchain: 188, subedition_id: 5, circulation_count: 100 },
    ]
    // same (play,parallel) key reported with two different circs → ambiguous → null → skipped
    pageQueue = [{ ok: true, editions: [gqlEdition(5, 250, 188), gqlEdition(5, 300, 188)], cursor: null }]
    const body = await (await GET(auth())).json()
    expect(body.matched).toBe(0)
    expect(body.updated).toBe(0)
  })
})
