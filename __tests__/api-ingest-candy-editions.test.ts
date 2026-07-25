import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for /api/ingest/candy-editions (GET + POST). FAIL-CLOSED
// auth accepts Bearer INGEST_SECRET_TOKEN or CRON_SECRET. Deep legs added: the
// discovery_pending 202 short-circuit, and the captured after() DAS walk —
// paginateGroup fan-out, the burnt/pack skip filter, per-page edition dedup +
// chunked upsert, the serial→wmc map (null wallet/moment dropped), the upsert
// error branches, the logRun success telemetry, and the thrown-walk catch.

const st = vi.hoisted(() => ({
  ready: true,
  pages: [] as any[][],
  edUpsert: { data: [{ id: "e1" }], error: null as any },
  wmcUpsert: { data: [{ moment_id: "m1" }], error: null as any },
  paginateThrows: false,
  runs: [] as any[],
  captured: null as null | (() => Promise<void>),
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: any) => { st.captured = fn } }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (_name: string, args: any) => { st.runs.push(args); return { data: null, error: null } },
    from(table: string) {
      return {
        upsert: () => ({ select: async () => (table === "editions" ? st.edUpsert : st.wmcUpsert) }),
      }
    },
  },
}))
vi.mock("@/lib/chains/solana/das", () => ({
  paginateGroup: async (_addr: string, cb: (items: any[]) => Promise<void>) => {
    if (st.paginateThrows) throw new Error("DAS down")
    let seen = 0
    for (const page of st.pages) { seen += page.length; await cb(page) }
    return seen
  },
}))
vi.mock("@/lib/chains/solana/normalize", () => ({
  CANDY_MLB_COLLECTION_ADDRESS: "col-addr",
  CANDY_MLB_SLUG: "candy_mlb",
  candyDiscoveryReady: () => st.ready,
  isBurnt: (a: any) => a.kind === "burnt",
  isPack: (a: any) => a.kind === "pack",
  normalizeEdition: (a: any) => ({ external_id: a.ed ?? null, collection_id: "c1" }),
  normalizeSerial: (a: any) => ({ wallet_address: a.w ?? null, moment_id: a.m ?? null, tier: "COMMON" }),
}))

import { GET, POST } from "@/app/api/ingest/candy-editions/route"

beforeEach(() => {
  vi.unstubAllEnvs()
  vi.stubEnv("CRON_SECRET", "")
  st.ready = true
  st.pages = [[{ kind: "icon", ed: "ed1", w: "w1", m: "m1" }, { kind: "burnt" }, { kind: "pack" }]]
  st.edUpsert = { data: [{ id: "e1" }], error: null }
  st.wmcUpsert = { data: [{ moment_id: "m1" }], error: null }
  st.paginateThrows = false
  st.runs = []
  st.captured = null
})

describe("candy-editions — auth", () => {
  it("401s FAIL-CLOSED when no auth secret is set", async () => {
    vi.stubEnv("INGEST_SECRET_TOKEN", "")
    expect((await POST(makeReq({ url: "https://t/api/ingest/candy-editions" }))).status).toBe(401)
  })
  it("401s on a non-matching Bearer", async () => {
    vi.stubEnv("INGEST_SECRET_TOKEN", "secret")
    expect((await POST(makeReq({ url: "https://t/api/ingest/candy-editions", auth: "Bearer wrong" }))).status).toBe(401)
  })
  it("GET 401s FAIL-CLOSED", async () => {
    vi.stubEnv("INGEST_SECRET_TOKEN", "")
    expect((await GET(makeReq({ url: "https://t/api/ingest/candy-editions", method: "GET" }))).status).toBe(401)
  })
})

describe("candy-editions — accept + discovery gate", () => {
  it("202-accepts on a valid INGEST token and captures the after() walk", async () => {
    vi.stubEnv("INGEST_SECRET_TOKEN", "secret")
    const res = await POST(makeReq({ url: "https://t/api/ingest/candy-editions", auth: "Bearer secret" }))
    expect(res.status).toBe(202)
    expect((await res.json()).accepted).toBe(true)
    expect(st.captured).toBeTypeOf("function")
  })
  it("GET 202-accepts on Bearer CRON_SECRET (Vercel cron path)", async () => {
    vi.stubEnv("CRON_SECRET", "cronsecret")
    const res = await GET(makeReq({ url: "https://t/api/ingest/candy-editions", method: "GET", auth: "Bearer cronsecret" }))
    expect(res.status).toBe(202)
  })
  it("202 discovery_pending (no walk) when discovery isn't ready", async () => {
    st.ready = false
    vi.stubEnv("INGEST_SECRET_TOKEN", "secret")
    const res = await POST(makeReq({ url: "https://t/api/ingest/candy-editions", auth: "Bearer secret" }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.accepted).toBe(false)
    expect(body.skipped).toBe("discovery_pending")
    expect(st.captured).toBeNull() // after() never scheduled
    // logRun recorded the skip
    expect(st.runs[0].p_extra.skip_reason).toBe("discovery_pending")
  })
})

describe("candy-editions — the after() DAS walk", () => {
  async function accept() {
    vi.stubEnv("INGEST_SECRET_TOKEN", "secret")
    await POST(makeReq({ url: "https://t/api/ingest/candy-editions", auth: "Bearer secret" }))
  }

  it("filters burnt+pack, upserts editions + serials, and logs a success run", async () => {
    await accept()
    await st.captured!()
    const run = st.runs[0]
    expect(run.p_ok).toBe(true)
    expect(run.p_extra.assets_seen).toBe(3)
    expect(run.p_extra.editions_written).toBe(1)
    expect(run.p_extra.serials_written).toBe(1)
    expect(run.p_extra.burnt_skipped).toBe(1)
    expect(run.p_extra.packs_skipped).toBe(1)
  })

  it("drops serials with a null wallet/moment and tolerates upsert errors", async () => {
    st.pages = [[{ kind: "icon", ed: "ed1", w: null, m: null }]] // serial dropped
    st.edUpsert = { data: null, error: { message: "ed err" } } // edition upsert error branch
    await accept()
    await st.captured!()
    const run = st.runs[0]
    expect(run.p_ok).toBe(true)
    expect(run.p_extra.editions_written).toBe(0)
    expect(run.p_extra.serials_written).toBe(0)
  })

  it("logs an ok:false run when the DAS walk throws", async () => {
    st.paginateThrows = true
    await accept()
    await st.captured!()
    expect(st.runs[0].p_ok).toBe(false)
    expect(st.runs[0].p_error).toContain("DAS down")
  })
})
