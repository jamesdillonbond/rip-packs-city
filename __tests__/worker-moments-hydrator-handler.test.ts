import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"

// ── topshot-moments-hydrator worker: fetch() entry coverage ─────────────────
//
// The sibling __tests__/worker-moments-hydrator-parse.test.ts covers only the
// pure parse helpers. The worker's actual entry — the /health liveness probe,
// method/path gate, the Bearer INGEST_SECRET_TOKEN auth gate, the env-config
// guards (supabase + ts-proxy), and the candidate-read outcome legs (empty ->
// ok:true no-op; read-fatal -> logged ok:false but still HTTP 200) — was
// untested. This worker enriches moment->edition mappings; a broken tick stalls
// hydration silently.
//
// Supabase is mocked via vi.mock("@supabase/supabase-js") with a chainable
// query builder. The deep GraphQL/edition-resolve/write path (env.TOPSHOT_PROXY
// fan-out) is intentionally out of scope here — this file pins the entry gate +
// candidate-read decision, the parts reachable without a full GQL fixture.

const H = vi.hoisted(() => ({ sb: null as any }))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => H.sb,
  SupabaseClient: class {},
}))

import worker from "@/workers/topshot-moments-hydrator/index.ts"

const TOKEN = "ingest-secret"
const env = {
  SUPABASE_URL: "https://db.example",
  SUPABASE_SERVICE_ROLE_KEY: "svc",
  INGEST_SECRET_TOKEN: TOKEN,
  TOPSHOT_PROXY: { fetch: vi.fn() },
  TS_PROXY_SECRET: "ts-secret",
} as any

/**
 * Chainable supabase stub. readCandidates does
 *   .from(..).select(..).eq(..).order(..).limit(..)
 * awaiting the terminal .limit(); every other method returns the builder.
 * .rpc(name) resolves the configured per-name response (default {error:null}).
 */
function makeSb(opts: { candidates?: unknown[] | null; candidatesError?: unknown; rpc?: Record<string, unknown> } = {}) {
  const rpc = opts.rpc ?? {}
  const builder: any = {
    from: () => builder,
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    limit: () => Promise.resolve({ data: opts.candidates ?? [], error: opts.candidatesError ?? null }),
    rpc: vi.fn(async (name: string) => (name in rpc ? rpc[name] : { data: null, error: null })),
  }
  return builder
}

function req(path: string, opts: { method?: string; auth?: string | null } = {}): Request {
  const headers: Record<string, string> = {}
  const auth = opts.auth === undefined ? `Bearer ${TOKEN}` : opts.auth
  if (auth !== null) headers["Authorization"] = auth
  return new Request(`https://mh.example${path}`, { method: opts.method ?? "POST", headers })
}

beforeEach(() => {
  H.sb = makeSb()
})
afterEach(() => vi.restoreAllMocks())

describe("topshot-moments-hydrator — entry gate", () => {
  it("serves /health (GET) without auth", async () => {
    const res = await worker.fetch(req("/health", { method: "GET", auth: null }), env)
    expect(res.status).toBe(200)
    expect((await res.json()) as any).toMatchObject({ ok: true, worker: "topshot-moments-hydrator" })
  })

  it("serves GET / as a liveness probe too", async () => {
    const res = await worker.fetch(req("/", { method: "GET", auth: null }), env)
    expect(res.status).toBe(200)
  })

  it("405s a non-POST to / and a POST to the wrong path", async () => {
    expect((await worker.fetch(req("/", { method: "PUT" }), env)).status).toBe(405)
    expect((await worker.fetch(req("/other", { method: "POST" }), env)).status).toBe(405)
  })

  it("401s a POST with no / wrong Bearer token", async () => {
    expect((await worker.fetch(req("/", { auth: null }), env)).status).toBe(401)
    expect((await worker.fetch(req("/", { auth: "Bearer nope" }), env)).status).toBe(401)
  })

  it("401s when the ingest token env is unset (fail closed)", async () => {
    const res = await worker.fetch(req("/"), { ...env, INGEST_SECRET_TOKEN: "" } as any)
    expect(res.status).toBe(401)
  })

  it("500s supabase_env_missing when supabase env is absent", async () => {
    const res = await worker.fetch(req("/"), { INGEST_SECRET_TOKEN: TOKEN, TOPSHOT_PROXY: {}, TS_PROXY_SECRET: "x" } as any)
    expect(res.status).toBe(500)
    expect((await res.json()) as any).toEqual({ error: "supabase_env_missing" })
  })

  it("500s ts_proxy_env_missing when the ts-proxy binding is absent", async () => {
    const res = await worker.fetch(
      req("/"),
      { INGEST_SECRET_TOKEN: TOKEN, SUPABASE_URL: "u", SUPABASE_SERVICE_ROLE_KEY: "k" } as any,
    )
    expect(res.status).toBe(500)
    expect((await res.json()) as any).toEqual({ error: "ts_proxy_env_missing" })
  })
})

describe("topshot-moments-hydrator — candidate-read outcomes", () => {
  it("returns ok:true no-op (200) and logs a run when there are no candidates", async () => {
    H.sb = makeSb({ candidates: [], rpc: { log_pipeline_run: { error: null } } })
    const res = await worker.fetch(req("/"), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body).toMatchObject({ ok: true, candidates_read: 0, moments_written: 0 })
    const logCall = H.sb.rpc.mock.calls.find((c: any[]) => c[0] === "log_pipeline_run")
    expect(logCall).toBeTruthy()
  })

  it("degrades a fatal candidate read to ok:false BUT still answers 200 (so the cron records it)", async () => {
    H.sb = makeSb({ candidatesError: { message: "pool exhausted" }, rpc: { log_pipeline_run: { error: null } } })
    const res = await worker.fetch(req("/"), env)
    expect(res.status).toBe(200) // NOT a 5xx — the failure is in the JSON body
    const body = (await res.json()) as any
    expect(body.ok).toBe(false)
    expect(body.errors?.[0]?.source).toBe("candidate_read")
    const logCall = H.sb.rpc.mock.calls.find((c: any[]) => c[0] === "log_pipeline_run")
    expect(logCall[1]).toMatchObject({ p_ok: false })
  })
})
