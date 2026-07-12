import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for POST /api/backfill-player-names (edge-fn proxy).
// Reads INGEST_SECRET_TOKEN at call time: unset -> 500 (misconfigured), set +
// wrong/missing token -> 401, both before the upstream edge-function fetch. We
// pin both fail-closed branches AND the 2xx success path: authed -> the route
// proxies the edge function via fetch and returns its JSON verbatim (fetch
// stubbed to an ok response so no live I/O runs).

import { POST } from "@/app/api/backfill-player-names/route"

const TOKEN = "test-ingest-token"

function req(auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/backfill-player-names", { method: "POST", headers })
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
})
afterEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
})

describe("POST /api/backfill-player-names", () => {
  it("500s when the server token is unset", async () => {
    delete process.env.INGEST_SECRET_TOKEN
    expect((await POST(req(`Bearer ${TOKEN}`))).status).toBe(500)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong"))).status).toBe(401)
  })

  it("401s without an authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("200s and proxies the edge-function response when authed", async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ done: true, updated: 7 }),
    })) as any
    try {
      const res = await POST(req(`Bearer ${TOKEN}`))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.done).toBe(true)
      expect(body.updated).toBe(7)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
