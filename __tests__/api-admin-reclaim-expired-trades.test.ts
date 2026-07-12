import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/admin/reclaim-expired-trades (POST/GET).
// verifyAdminRequest-gated. Trade Hub is shelved: when authed but
// RPC_TRADE_ESCROW_ADDRESS is unset, run() short-circuits to 503. Pins the
// fail-closed 401 and the 503 not-available guard.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: () => ({}) } }))
vi.mock("@/lib/trade-escrow/fcl-submit", () => ({
  submitReclaimExpired: async () => ({ tx_id: "0xstub" }),
}))

import { POST, GET } from "@/app/api/admin/reclaim-expired-trades/route"

const ADMIN = "test-admin-token"

function req(method: "GET" | "POST", auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/admin/reclaim-expired-trades", { method, headers })
}

beforeEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
  delete process.env.RPC_TRADE_ESCROW_ADDRESS
})
afterEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
  delete process.env.RPC_TRADE_ESCROW_ADDRESS
})

describe("/api/admin/reclaim-expired-trades", () => {
  it("401s fail-closed when RPC_ADMIN_TOKEN is unset", async () => {
    expect((await POST(req("POST", `Bearer ${ADMIN}`))).status).toBe(401)
  })

  it("503s when authed but Trade Hub (escrow address) is not configured", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    const res = await GET(req("GET", `Bearer ${ADMIN}`))
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe("Trade Hub is not available yet.")
  })
})
