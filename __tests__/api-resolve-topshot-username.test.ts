import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for POST /api/resolve-topshot-username.
// Auth is a CALL-TIME Bearer check: `if (!expected || authHeader !== Bearer …)`
// → 401. Because the unset-secret branch collapses into the same 401 (via
// `!expected`), an unset INGEST_SECRET_TOKEN is 401, NOT 500. We pin unset /
// wrong / missing → 401, then the body guards (400), then a mocked found path.

const resolveState: { outcome: any; runs: any[]; logThrows: boolean } = {
  outcome: { found: false, reason: "not_found" },
  runs: [],
  logThrows: false,
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (name: string, args: any) => {
      if (name === "log_pipeline_run") {
        if (resolveState.logThrows) throw new Error("log down")
        resolveState.runs.push(args)
      }
      return { data: null, error: null }
    },
  },
}))
vi.mock("@/lib/chains/flow/topshot-username-resolve", () => ({
  resolveTopShotUsernameCacheAware: async () => resolveState.outcome,
}))

import { POST } from "@/app/api/resolve-topshot-username/route"

const TOKEN = "test-ingest-secret"

function req(opts: { auth?: string; body?: any; badJson?: boolean }) {
  return {
    headers: new Headers(opts.auth ? { authorization: opts.auth } : {}),
    json: async () => {
      if (opts.badJson) throw new Error("bad json")
      return opts.body ?? {}
    },
  } as any
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
  resolveState.outcome = { found: false, reason: "not_found" }
  resolveState.runs = []
  resolveState.logThrows = false
})

describe("POST /api/resolve-topshot-username", () => {
  it("401s when INGEST_SECRET_TOKEN is unset", async () => {
    delete process.env.INGEST_SECRET_TOKEN
    expect((await POST(req({ auth: "Bearer whatever" }))).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req({ auth: "Bearer wrong" }))).status).toBe(401)
  })

  it("401s with no authorization header", async () => {
    expect((await POST(req({}))).status).toBe(401)
  })

  it("400s on an invalid JSON body", async () => {
    const res = await POST(req({ auth: `Bearer ${TOKEN}`, badJson: true }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_json_body")
  })

  it("400s when username is empty", async () => {
    const res = await POST(req({ auth: `Bearer ${TOKEN}`, body: { username: "   " } }))
    expect(res.status).toBe(400)
    expect((await res.json()).reason).toBe("username_required")
  })

  it("returns the resolved wallet on a found outcome", async () => {
    resolveState.outcome = {
      found: true,
      walletAddress: "0xabc",
      username: "someone",
      source: "seeded_wallets",
      cacheLayer: "seeded_wallets",
    }
    const res = await POST(req({ auth: `Bearer ${TOKEN}`, body: { username: "someone" } }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.found).toBe(true)
    expect(body.wallet_address).toBe("0xabc")
    expect(body.cache_layer).toBe("seeded_wallets")
  })
})

// --- the pipeline_runs logging POLICY: only outbound GQL work is recorded ---

describe("POST /api/resolve-topshot-username — logging policy", () => {
  const ok = (body: any) => req({ auth: `Bearer ${TOKEN}`, body })

  it("logs a live-GQL hit (the only found case that costs an outbound call)", async () => {
    resolveState.outcome = {
      found: true, walletAddress: "0xabc", username: "someone",
      source: "topshot_gql", cacheLayer: "topshot_gql_live",
    }
    await POST(ok({ username: "someone" }))
    expect(resolveState.runs).toHaveLength(1)
    expect(resolveState.runs[0]).toMatchObject({
      p_pipeline: "resolve-topshot-username",
      p_ok: true,
      p_rows_found: 1,
      p_rows_written: 1,
      p_collection_slug: "nba_top_shot",
    })
    expect(resolveState.runs[0].p_extra.cache_layer).toBe("topshot_gql_live")
    expect(resolveState.runs[0].p_extra.wallet_address).toBe("0xabc")
  })

  it("does NOT log a cached hit (layers 1-4 would drown pipeline_runs)", async () => {
    resolveState.outcome = {
      found: true, walletAddress: "0xabc", username: "someone",
      source: "seeded_wallets", cacheLayer: "seeded_wallets",
    }
    await POST(ok({ username: "someone" }))
    expect(resolveState.runs).toHaveLength(0)
  })

  it("includes dapper_id only when the outcome carries one", async () => {
    resolveState.outcome = {
      found: true, walletAddress: "0xabc", username: "u", source: "s",
      cacheLayer: "seeded_wallets", dapperId: "dap-1",
    }
    expect((await (await POST(ok({ username: "u" }))).json()).dapper_id).toBe("dap-1")

    resolveState.outcome = { found: true, walletAddress: "0xabc", username: "u", source: "s", cacheLayer: "seeded_wallets" }
    expect(await (await POST(ok({ username: "u" }))).json()).not.toHaveProperty("dapper_id")
  })

  it("logs a miss as ok:false and still answers 200", async () => {
    resolveState.outcome = { found: false, reason: "not_found" }
    const res = await POST(ok({ username: "ghost" }))
    expect(res.status).toBe(200)
    expect((await res.json()).reason).toBe("not_found")
    expect(resolveState.runs).toHaveLength(1)
    expect(resolveState.runs[0].p_ok).toBe(false)
    expect(resolveState.runs[0].p_error).toBe("not_found")
    expect(resolveState.runs[0].p_rows_found).toBe(0)
  })

  it("surfaces an upstream detail on a miss when present", async () => {
    resolveState.outcome = { found: false, reason: "upstream_error", detail: "HTTP 502" }
    const body = await (await POST(ok({ username: "ghost" }))).json()
    expect(body.detail).toBe("HTTP 502")
  })

  it("does NOT log an empty_username miss (a 400 caller bug, not upstream)", async () => {
    resolveState.outcome = { found: false, reason: "empty_username" }
    const res = await POST(ok({ username: "ghost" }))
    expect(res.status).toBe(400)
    expect(resolveState.runs).toHaveLength(0)
  })

  it("swallows a log_pipeline_run failure rather than failing the resolution", async () => {
    resolveState.logThrows = true
    resolveState.outcome = { found: false, reason: "not_found" }
    const res = await POST(ok({ username: "ghost" }))
    expect(res.status).toBe(200)
  })
})
