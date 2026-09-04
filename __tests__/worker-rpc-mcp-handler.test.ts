import { describe, it, expect, afterEach, vi } from "vitest"
import worker from "@/workers/rpc-mcp-proxy/index.ts"

// ── rpc-mcp-proxy worker: fetch() ENTRY HANDLER coverage ────────────────────
//
// The sibling __tests__/worker-rpc-mcp-lib.test.ts covers only the pure helpers
// in mcp-lib.ts (token parse, slug map, limit clamp, JSON-RPC envelopes). The
// worker's actual HTTP surface — the landing page, /health probe, the /mcp
// JSON-RPC endpoint with its Bearer-key auth, per-wallet quota gate, body
// validation, and the tools/call dispatch loop — was entirely untested (worker
// coverage measured ~11% before this file). This is the public MCP API a paying
// collector's key hits: a dropped auth or quota check bills the wrong wallet or
// serves data unauthenticated.
//
// Pattern mirrors worker-topshot-proxy-routing / worker-hybrid-custody-proxy:
// invoke worker.fetch(request, env, ctx) with a stubbed global fetch that routes
// by Supabase RPC name so validate/quota/tool/log calls are deterministic.

const env = {
  SUPABASE_URL: "https://db.example",
  SUPABASE_SERVICE_ROLE_KEY: "svc-key",
  BUILD_SHA: "testsha",
} as any

const KEY = "rpc_mcp_live_testkey123"

function ctx() {
  const waited: Promise<unknown>[] = []
  return { waitUntil: (p: Promise<unknown>) => void waited.push(p), passThroughOnException: () => {}, waited } as any
}

/**
 * Stub global fetch, routing Supabase `/rest/v1/rpc/<fn>` calls by fn name.
 * `rpcs` maps a fn name to either a value (→ 200 JSON) or a {status, body}.
 * An unmapped RPC returns [] (200) so a happy path never trips on an
 * incidental call (e.g. mcp_log_tool_call via ctx.waitUntil).
 */
function stubSupabase(rpcs: Record<string, unknown | { status: number; body?: string }>) {
  const spy = vi.fn(async (input: any) => {
    const url = typeof input === "string" ? input : input.url
    const m = url.match(/\/rest\/v1\/rpc\/([a-z_]+)/)
    const fn = m?.[1]
    const entry = fn && fn in rpcs ? rpcs[fn] : []
    if (entry && typeof entry === "object" && "status" in (entry as any)) {
      const e = entry as { status: number; body?: string }
      return new Response(e.body ?? "", { status: e.status })
    }
    return new Response(JSON.stringify(entry), { status: 200, headers: { "Content-Type": "application/json" } })
  })
  vi.stubGlobal("fetch", spy)
  return spy
}

function mcpPost(body: unknown, opts: { key?: string | null } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  const key = opts.key === undefined ? KEY : opts.key
  if (key !== null) headers["Authorization"] = `Bearer ${key}`
  return new Request("https://mcp.example/mcp", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

/** A principal row as mcp_validate_api_key returns it. */
const VALID_PRINCIPAL = [{ key_id: "k1", wallet_address: "0xabc", plan: "pro", scopes: ["read"] }]
const QUOTA_OK = { allowed: true, reason: "ok", plan: "pro", daily_limit: 1000, used_today: 1, remaining: 999 }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("rpc-mcp-proxy — top-level routing", () => {
  it("204s an OPTIONS preflight with CORS", async () => {
    const res = await worker.fetch(new Request("https://mcp.example/mcp", { method: "OPTIONS" }), env, ctx())
    expect(res.status).toBe(204)
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*")
  })

  it("serves the HTML landing on GET /", async () => {
    const res = await worker.fetch(new Request("https://mcp.example/", { method: "GET" }), env, ctx())
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toContain("text/html")
    expect((await res.text()).length).toBeGreaterThan(0)
  })

  it("404s an unknown path and echoes it", async () => {
    const res = await worker.fetch(new Request("https://mcp.example/nope", { method: "GET" }), env, ctx())
    expect(res.status).toBe(404)
    expect((await res.json()) as any).toMatchObject({ error: "not_found", path: "/nope" })
  })

  it("405s GET /mcp (no server-initiated SSE) with Allow: POST", async () => {
    const res = await worker.fetch(new Request("https://mcp.example/mcp", { method: "GET" }), env, ctx())
    expect(res.status).toBe(405)
    expect(res.headers.get("Allow")).toBe("POST")
  })

  it("405s an unsupported /mcp method (PUT)", async () => {
    const res = await worker.fetch(new Request("https://mcp.example/mcp", { method: "PUT" }), env, ctx())
    expect(res.status).toBe(405)
  })
})

describe("rpc-mcp-proxy — /health", () => {
  it("reports ok:true (200) when both probes succeed", async () => {
    stubSupabase({
      mcp_validate_api_key: [],
      mcp_get_fmv: { error: "edition_not_found" },
    })
    const res = await worker.fetch(new Request("https://mcp.example/health", { method: "GET" }), env, ctx())
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body).toMatchObject({ ok: true, supabase_reachable: true, rpcs_reachable: true, build_sha: "testsha" })
  })

  it("reports ok:false (503) when the supabase probe errors", async () => {
    stubSupabase({
      mcp_validate_api_key: { status: 500, body: "db down" },
      mcp_get_fmv: { error: "edition_not_found" },
    })
    const res = await worker.fetch(new Request("https://mcp.example/health", { method: "GET" }), env, ctx())
    expect(res.status).toBe(503)
    const body = (await res.json()) as any
    expect(body.ok).toBe(false)
    expect(body.supabase_reachable).toBe(false)
  })
})

describe("rpc-mcp-proxy — /mcp auth + quota gate", () => {
  it("401s a request with no / malformed Bearer key (no upstream call)", async () => {
    const spy = stubSupabase({})
    const res = await worker.fetch(mcpPost({ jsonrpc: "2.0", id: 1, method: "ping" }, { key: null }), env, ctx())
    expect(res.status).toBe(401)
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer")
    expect(spy).not.toHaveBeenCalled() // regex rejects before any DB round-trip
  })

  it("401s a well-formed key that resolves to no principal", async () => {
    stubSupabase({ mcp_validate_api_key: [] })
    const res = await worker.fetch(mcpPost({ jsonrpc: "2.0", id: 1, method: "ping" }), env, ctx())
    expect(res.status).toBe(401)
  })

  it("503s when the key-validation upstream is down", async () => {
    stubSupabase({ mcp_validate_api_key: { status: 500, body: "pool timeout" } })
    const res = await worker.fetch(mcpPost({ jsonrpc: "2.0", id: 1, method: "ping" }), env, ctx())
    expect(res.status).toBe(503)
    expect((await res.json()) as any).toMatchObject({ error: { message: "upstream_supabase_unavailable" } })
  })

  it("503s when the quota check upstream is down", async () => {
    stubSupabase({
      mcp_validate_api_key: VALID_PRINCIPAL,
      check_feature_quota: { status: 500, body: "boom" },
    })
    const res = await worker.fetch(mcpPost({ jsonrpc: "2.0", id: 1, method: "ping" }), env, ctx())
    expect(res.status).toBe(503)
  })

  it("429s with Retry-After when quota is exceeded", async () => {
    stubSupabase({
      mcp_validate_api_key: VALID_PRINCIPAL,
      check_feature_quota: { allowed: false, reason: "daily_limit", plan: "free", daily_limit: 50, used_today: 50 },
    })
    const res = await worker.fetch(mcpPost({ jsonrpc: "2.0", id: 1, method: "ping" }), env, ctx())
    expect(res.status).toBe(429)
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0)
    expect((await res.json()) as any).toMatchObject({ error: { code: -32002, message: "quota_exceeded" } })
  })
})

describe("rpc-mcp-proxy — /mcp body validation (post-auth)", () => {
  const authed = { mcp_validate_api_key: VALID_PRINCIPAL, check_feature_quota: QUOTA_OK }

  it("400s parse_error on a non-JSON body", async () => {
    stubSupabase(authed)
    const res = await worker.fetch(mcpPost("{ not json"), env, ctx())
    expect(res.status).toBe(400)
    expect((await res.json()) as any).toMatchObject({ error: { code: -32700, message: "parse_error" } })
  })

  it("400s invalid_request when jsonrpc is not 2.0", async () => {
    stubSupabase(authed)
    const res = await worker.fetch(mcpPost({ jsonrpc: "1.0", id: 1, method: "ping" }), env, ctx())
    expect(res.status).toBe(400)
    expect((await res.json()) as any).toMatchObject({ error: { code: -32600, message: "invalid_request" } })
  })

  it("400s invalid_request when method is missing", async () => {
    stubSupabase(authed)
    const res = await worker.fetch(mcpPost({ jsonrpc: "2.0", id: 1 }), env, ctx())
    expect(res.status).toBe(400)
  })
})

describe("rpc-mcp-proxy — /mcp JSON-RPC dispatch", () => {
  const authed = { mcp_validate_api_key: VALID_PRINCIPAL, check_feature_quota: QUOTA_OK }

  it("initialize returns the protocol version + serverInfo", async () => {
    stubSupabase(authed)
    const res = await worker.fetch(mcpPost({ jsonrpc: "2.0", id: 1, method: "initialize" }), env, ctx())
    expect(res.status).toBe(200)
    expect(res.headers.get("MCP-Protocol-Version")).toBeTruthy()
    const body = (await res.json()) as any
    expect(body.result.protocolVersion).toBeTruthy()
    expect(body.result.capabilities).toHaveProperty("tools")
  })

  it("a notification (notifications/initialized) returns 202 with no body", async () => {
    stubSupabase(authed)
    const res = await worker.fetch(mcpPost({ jsonrpc: "2.0", method: "notifications/initialized" }), env, ctx())
    expect(res.status).toBe(202)
    expect(await res.text()).toBe("")
  })

  it("ping returns an empty result", async () => {
    stubSupabase(authed)
    const res = await worker.fetch(mcpPost({ jsonrpc: "2.0", id: 7, method: "ping" }), env, ctx())
    expect(res.status).toBe(200)
    expect((await res.json()) as any).toEqual({ jsonrpc: "2.0", id: 7, result: {} })
  })

  it("tools/list returns the tool catalog", async () => {
    stubSupabase(authed)
    const res = await worker.fetch(mcpPost({ jsonrpc: "2.0", id: 2, method: "tools/list" }), env, ctx())
    const body = (await res.json()) as any
    expect(Array.isArray(body.result.tools)).toBe(true)
    expect(body.result.tools.length).toBeGreaterThan(0)
  })

  it("an unknown method returns method_not_found (-32601)", async () => {
    stubSupabase(authed)
    const res = await worker.fetch(mcpPost({ jsonrpc: "2.0", id: 3, method: "does/not/exist" }), env, ctx())
    expect(res.status).toBe(200)
    expect((await res.json()) as any).toMatchObject({ error: { code: -32601 } })
  })

  it("tools/call with an unknown tool returns -32602", async () => {
    stubSupabase(authed)
    const res = await worker.fetch(
      mcpPost({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "no_such_tool", arguments: {} } }),
      env,
      ctx(),
    )
    expect((await res.json()) as any).toMatchObject({ error: { code: -32602 } })
  })

  it("tools/call get_fmv wraps the adapter result as MCP text content", async () => {
    const c = ctx()
    stubSupabase({ ...authed, mcp_get_fmv: { edition_id: "e1", fmv_usd: 42 }, mcp_log_tool_call: null })
    const res = await worker.fetch(
      mcpPost({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "get_fmv", arguments: { edition_key: "1:2", collection_slug: "nba_top_shot" } },
      }),
      env,
      c,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.result.content[0].type).toBe("text")
    expect(JSON.parse(body.result.content[0].text)).toMatchObject({ edition_id: "e1", fmv_usd: 42 })
    expect(body.result.isError).toBeUndefined()
    // logToolCall was scheduled on the execution context (waitUntil).
    expect(c.waited.length).toBeGreaterThan(0)
  })

  it("tools/call surfaces an upstream failure as an isError gap result (still 200)", async () => {
    stubSupabase({
      ...authed,
      mcp_get_fmv: { status: 500, body: "db exploded" },
      mcp_log_tool_call: null,
    })
    const res = await worker.fetch(
      mcpPost({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "get_fmv", arguments: { edition_key: "1:2", collection_slug: "nba_top_shot" } },
      }),
      env,
      ctx(),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.result.isError).toBe(true)
    const payload = JSON.parse(body.result.content[0].text)
    expect(payload.error).toBe("upstream_supabase_unavailable")
    expect(Array.isArray(payload.gaps)).toBe(true)
  })
})
