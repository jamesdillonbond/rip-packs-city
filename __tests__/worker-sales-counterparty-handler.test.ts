import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"

// ── sales-counterparty-backfill worker: scheduled() + fetch() coverage ──────
//
// The sibling __tests__/worker-sales-counterparty-decode.test.ts covers only
// the pure decodeCounterparties() logic in decode.ts. The worker's actual
// entry surface — the Cloudflare Cron `scheduled()` handler and the Bearer-
// gated manual `fetch()` handler, plus the runTick() orchestration around them
// (claim → decode-with-retry → apply → log) — was untested. This is the
// self-scheduled indexer that writes buyer/seller onto the partitioned `sales`
// table, so a broken tick silently stops counterparty recovery.
//
// Supabase is mocked via vi.mock("@supabase/supabase-js"); Flow REST via a
// stubbed global fetch. The happy path uses a single successfully-decoding row,
// which trips NEITHER the chunk-pause (1 < CONCURRENCY) NOR the retry sleep (no
// miss) — so no real timers fire.

const H = vi.hoisted(() => ({
  sb: null as any,
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => H.sb,
}))

// Import AFTER the mock is registered (vi.mock is hoisted, so a static import is
// fine, but keep it explicit for clarity).
import worker from "@/workers/sales-counterparty-backfill/index.ts"

const TOKEN = "ingest-secret"
const env = {
  SUPABASE_URL: "https://db.example",
  SUPABASE_SERVICE_ROLE_KEY: "svc",
  INGEST_SECRET_TOKEN: TOKEN,
} as any

/** A supabase stub whose .rpc(name) resolves the per-name configured response. */
function makeSb(rpc: Record<string, { data?: unknown; error?: unknown }> = {}) {
  return { rpc: vi.fn(async (name: string) => rpc[name] ?? { data: null, error: null }) }
}

function cdcAddressField(name: string, addr: string) {
  return { name, value: { type: "Optional", value: { type: "Address", value: addr } } }
}
function b64(o: unknown): string {
  return btoa(JSON.stringify(o))
}
/** A Flow REST transaction_results body with a clean single-moment TopShot sale. */
function saleEventsBody(seller: string, buyer: string) {
  return {
    events: [
      {
        type: "A.0b2a3299cc857e29.TopShot.Withdraw",
        payload: b64({ value: { fields: [cdcAddressField("from", seller)] } }),
      },
      {
        type: "A.0b2a3299cc857e29.TopShot.Deposit",
        payload: b64({ value: { fields: [cdcAddressField("to", buyer)] } }),
      },
    ],
  }
}

function fetchReq(path: string, opts: { auth?: string | null } = {}): Request {
  const headers: Record<string, string> = {}
  const auth = opts.auth === undefined ? `Bearer ${TOKEN}` : opts.auth
  if (auth !== null) headers["Authorization"] = auth
  return new Request(`https://scb.example${path}`, { method: "GET", headers })
}

function stubFlowRest(make: (url: string) => Response) {
  const spy = vi.fn(async (input: any) => {
    const url = typeof input === "string" ? input : input.url
    return make(url)
  })
  vi.stubGlobal("fetch", spy)
  return spy
}

beforeEach(() => {
  H.sb = makeSb()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("sales-counterparty-backfill — fetch() gate", () => {
  it("answers /health without auth", async () => {
    const res = await worker.fetch(fetchReq("/health", { auth: null }), env)
    expect(res.status).toBe(200)
    expect((await res.json()) as any).toMatchObject({ ok: true, worker: "sales-counterparty-backfill" })
  })

  it("401s a tick with no Authorization header", async () => {
    const res = await worker.fetch(fetchReq("/tick", { auth: null }), env)
    expect(res.status).toBe(401)
  })

  it("401s a tick with a wrong Bearer token", async () => {
    const res = await worker.fetch(fetchReq("/tick", { auth: "Bearer nope" }), env)
    expect(res.status).toBe(401)
  })

  it("401s when the ingest token env is unset (fail closed)", async () => {
    const res = await worker.fetch(fetchReq("/tick"), { ...env, INGEST_SECRET_TOKEN: "" } as any)
    expect(res.status).toBe(401)
  })

  it("500s when supabase env is missing", async () => {
    const res = await worker.fetch(fetchReq("/tick"), { INGEST_SECRET_TOKEN: TOKEN } as any)
    expect(res.status).toBe(500)
  })
})

describe("sales-counterparty-backfill — runTick via fetch()", () => {
  it("reports drained (200) when the claim batch is empty, and logs a drained run", async () => {
    H.sb = makeSb({ claim_sales_counterparty_batch: { data: [], error: null } })
    const res = await worker.fetch(fetchReq("/tick"), env)
    expect(res.status).toBe(200)
    expect((await res.json()) as any).toEqual({ batch: 0, applied: 0, drained: true })
    // logRun was called with the FULL 11-arg log_pipeline_run overload.
    const logCall = H.sb.rpc.mock.calls.find((c: any[]) => c[0] === "log_pipeline_run")
    expect(logCall).toBeTruthy()
    expect(logCall[1]).toMatchObject({ p_pipeline: "sales-counterparty-backfill", p_ok: true })
  })

  it("decodes a claimed row, applies counterparties, and returns recovery stats", async () => {
    H.sb = makeSb({
      claim_sales_counterparty_batch: {
        data: [{ sale_id: "s1", tx_hash: "0xtx1", sold_at: "2026-01-01T00:00:00Z" }],
        error: null,
      },
      apply_sales_counterparty: { data: { applied: 1, cursor_sold_at: "2026-01-01T00:00:00Z" }, error: null },
    })
    stubFlowRest(() => new Response(JSON.stringify(saleEventsBody("0x1111111111111111", "0x2222222222222222")), { status: 200 }))
    const res = await worker.fetch(fetchReq("/tick?limit=1"), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body).toMatchObject({ batch: 1, recovered: 1, applied: 1 })
    // apply_sales_counterparty received the decoded seller/buyer.
    const applyCall = H.sb.rpc.mock.calls.find((c: any[]) => c[0] === "apply_sales_counterparty")
    expect(applyCall[1].p_rows[0]).toMatchObject({ sale_id: "s1", seller: "0x1111111111111111", buyer: "0x2222222222222222" })
  })

  it("clamps ?limit into [1,500] (a bad limit falls back to the default batch)", async () => {
    H.sb = makeSb({ claim_sales_counterparty_batch: { data: [], error: null } })
    const res = await worker.fetch(fetchReq("/tick?limit=99999"), env)
    expect(res.status).toBe(200)
    const claimCall = H.sb.rpc.mock.calls.find((c: any[]) => c[0] === "claim_sales_counterparty_batch")
    expect(claimCall[1].p_limit).toBe(500) // clamped max
  })

  it("500s when the claim RPC errors", async () => {
    H.sb = makeSb({ claim_sales_counterparty_batch: { data: null, error: { message: "pool timeout" } } })
    const res = await worker.fetch(fetchReq("/tick"), env)
    expect(res.status).toBe(500)
    expect((await res.json()) as any).toMatchObject({ error: expect.stringContaining("claim failed") })
  })
})

describe("sales-counterparty-backfill — scheduled()", () => {
  function ctx() {
    const waited: Promise<unknown>[] = []
    return { waitUntil: (p: Promise<unknown>) => void waited.push(p), waited } as any
  }

  it("runs a drained tick on the cron schedule (no auth path)", async () => {
    H.sb = makeSb({ claim_sales_counterparty_batch: { data: [], error: null } })
    const c = ctx()
    await worker.scheduled({} as any, env, c)
    await Promise.all(c.waited) // let the waitUntil work settle
    const logCall = H.sb.rpc.mock.calls.find((c2: any[]) => c2[0] === "log_pipeline_run")
    expect(logCall[1]).toMatchObject({ p_ok: true })
  })

  it("logs an ok:false run when the scheduled tick throws", async () => {
    H.sb = makeSb({ claim_sales_counterparty_batch: { data: null, error: { message: "boom" } } })
    const c = ctx()
    await worker.scheduled({} as any, env, c)
    await Promise.all(c.waited)
    const logCall = H.sb.rpc.mock.calls.find((c2: any[]) => c2[0] === "log_pipeline_run")
    expect(logCall[1]).toMatchObject({ p_ok: false, p_extra: { phase: "scheduled" } })
  })
})
