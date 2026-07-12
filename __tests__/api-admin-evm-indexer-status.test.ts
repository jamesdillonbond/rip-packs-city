import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/admin/evm-indexer-status (GET).
// authorized() accepts only Bearer RPC_ADMIN_TOKEN (or ?token=), fail-closed.
// Happy path with an empty contract registry never reaches getBlockNumber, so
// no evm-rpc network mock is needed — only the supabaseAdmin reads.

vi.mock("@/lib/supabase", () => {
  const result = { data: [], error: null }
  const chain: any = {
    select: () => chain,
    order: () => Promise.resolve(result),
    then: (resolve: any) => resolve(result),
  }
  return { supabaseAdmin: { from: () => chain } }
})

import { GET } from "@/app/api/admin/evm-indexer-status/route"

const ADMIN = "test-admin-token"

function req(auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/admin/evm-indexer-status", { headers })
}

beforeEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
})
afterEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
})

describe("GET /api/admin/evm-indexer-status", () => {
  it("401s fail-closed when RPC_ADMIN_TOKEN is unset", async () => {
    expect((await GET(req(`Bearer ${ADMIN}`))).status).toBe(401)
  })

  it("returns ok with an empty contracts list when the registry is empty", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    const res = await GET(req(`Bearer ${ADMIN}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.contracts).toEqual([])
  })
})
