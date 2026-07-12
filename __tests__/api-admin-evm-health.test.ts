import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/admin/evm-health (GET).
// Its own authorized() gate accepts only Bearer RPC_ADMIN_TOKEN (or ?token=),
// fail-closed when unset. An unsupported ?chain= 400s before any RPC network
// call, so the real @/lib/evm-rpc slug set is exercised without mocking.

import { GET } from "@/app/api/admin/evm-health/route"

const ADMIN = "test-admin-token"

function req(opts: { auth?: string; chain?: string } = {}): NextRequest {
  const url = new URL("https://t/api/admin/evm-health")
  if (opts.chain) url.searchParams.set("chain", opts.chain)
  const headers = new Headers()
  if (opts.auth) headers.set("authorization", opts.auth)
  return new NextRequest(url, { headers })
}

beforeEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
})
afterEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
})

describe("GET /api/admin/evm-health", () => {
  it("401s fail-closed when RPC_ADMIN_TOKEN is unset", async () => {
    const res = await req({ auth: `Bearer ${ADMIN}` })
    expect((await GET(res)).status).toBe(401)
  })

  it("401s on a wrong token", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    expect((await GET(req({ auth: "Bearer nope" }))).status).toBe(401)
  })

  it("400s on an unsupported chain slug (authed, pre-network)", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    const res = await GET(req({ auth: `Bearer ${ADMIN}`, chain: "not-a-chain" }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain("Unsupported chain")
    expect(Array.isArray(body.supported)).toBe(true)
  })
})
