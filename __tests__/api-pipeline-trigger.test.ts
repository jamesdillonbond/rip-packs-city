import { describe, it, expect, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for GET /api/pipeline-trigger.
// Auth is Bearer only (?token= retired 2026-11-26) against a module-level TOKEN read from
// INGEST_SECRET_TOKEN at IMPORT time, so the env must be set before the dynamic
// import. Fail-closed: 401 on wrong/missing credential. The real work is fired
// via after() (stubbed no-op) so the immediate 200 is observable.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})

const TOKEN = "test-ingest-token"
process.env.INGEST_SECRET_TOKEN = TOKEN

const { GET } = await import("@/app/api/pipeline-trigger/route")

function get(auth?: string, token?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  const url = `https://t/api/pipeline-trigger${token ? `?token=${token}` : ""}`
  return new NextRequest(url, { method: "GET", headers })
}

describe("GET /api/pipeline-trigger", () => {
  it("401s with a wrong bearer token", async () => {
    const res = await GET(get("Bearer wrong"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("401s with no credential", async () => {
    expect((await GET(get())).status).toBe(401)
  })

  it("returns 200 triggered with the matching Bearer token", async () => {
    const res = await GET(get(`Bearer ${TOKEN}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.message).toBe("Pipeline triggered")
  })

  it("401s with the correct secret in ?token= — the query form is retired (2026-11-26)", async () => {
    const res = await GET(get(undefined, TOKEN))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.ok).not.toBe(true)
    expect(body.message).not.toBe("Pipeline triggered")
  })
})
