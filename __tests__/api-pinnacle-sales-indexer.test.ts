import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/pinnacle-sales-indexer (GET + POST, same
// handler). Bearer/?token auth against a MODULE-LEVEL TOKEN const
// (INGEST_SECRET_TOKEN) read at import time — env set BEFORE import; fail-closed
// 401 when unset. The scan runs inline (no after()), so the first DB touch is a
// cursor read: we drive that to an error to pin the 500 "Failed to read cursor"
// branch without faking the whole Flow-REST scan. We pin the 401s + that 500.

const state: { cursor: any } = { cursor: { data: { last_processed_block: 0 }, error: null } }

vi.mock("@/lib/supabase", () => {
  const build = () => {
    const b: any = {
      select: () => b,
      eq: () => b,
      update: () => b,
      single: async () => state.cursor,
    }
    return b
  }
  return { supabaseAdmin: { from: () => build(), rpc: async () => ({ data: null, error: null }) } }
})
vi.mock("@/lib/pipeline-chain", () => ({ fireNextPipelineStep: async () => {} }))

const TOKEN = "test-ingest-token"
process.env.INGEST_SECRET_TOKEN = TOKEN

const { GET, POST } = await import("@/app/api/pinnacle-sales-indexer/route")

const req = (opts: { auth?: string; token?: string }) =>
  ({
    headers: new Headers(opts.auth ? { authorization: opts.auth } : {}),
    nextUrl: new URL(
      opts.token
        ? `https://t/api/pinnacle-sales-indexer?token=${opts.token}`
        : "https://t/api/pinnacle-sales-indexer"
    ),
  }) as any

beforeEach(() => {
  state.cursor = { data: { last_processed_block: 0 }, error: null }
})

describe("POST /api/pinnacle-sales-indexer", () => {
  it("401s with no authorization", async () => {
    const res = await POST(req({}))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req({ auth: "Bearer wrong" }))).status).toBe(401)
  })

  it("500s when the cursor read fails (authed)", async () => {
    state.cursor = { data: null, error: { message: "cursor boom" } }
    const res = await POST(req({ auth: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("Failed to read cursor")
  })

  it("200s 'already up to date' when the cursor is at the sealed height (authed)", async () => {
    // Cursor read succeeds at block 0; stub the Flow-REST sealed-height fetch to
    // also report 0 so lastBlock >= currentHeight → the up-to-date accept, which
    // fires the (mocked) resolver chain and returns 200 without a real scan.
    state.cursor = { data: { last_processed_block: 0 }, error: null }
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => [{ header: { height: "0" } }],
    })) as any
    try {
      const res = await POST(req({ auth: `Bearer ${TOKEN}` }))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
      expect(body.message).toBe("already up to date")
      expect(body.cursor).toBe(0)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

describe("GET /api/pinnacle-sales-indexer", () => {
  it("delegates to the same handler (401 without auth)", async () => {
    expect((await GET(req({}))).status).toBe(401)
  })
})
