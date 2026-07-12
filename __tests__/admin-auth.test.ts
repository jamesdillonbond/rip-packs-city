import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { verifyAdminRequest } from "@/lib/admin-auth"

// Deny-by-default admin bearer check. A missing RPC_ADMIN_TOKEN must reject
// everything (fail-closed); a correct Bearer header OR ?token= query passes.

const TOKEN = "s3cret-admin-token"

function req(opts: { auth?: string; token?: string } = {}): NextRequest {
  const url = new URL("https://www.rippackscity.com/api/admin/x")
  if (opts.token) url.searchParams.set("token", opts.token)
  const headers = new Headers()
  if (opts.auth) headers.set("authorization", opts.auth)
  return new NextRequest(url, { headers })
}

describe("verifyAdminRequest", () => {
  afterEach(() => {
    delete process.env.RPC_ADMIN_TOKEN
  })

  it("fails closed when RPC_ADMIN_TOKEN is unset", () => {
    delete process.env.RPC_ADMIN_TOKEN
    expect(verifyAdminRequest(req({ auth: `Bearer ${TOKEN}` }))).toBe(false)
  })

  describe("with a configured token", () => {
    beforeEach(() => {
      process.env.RPC_ADMIN_TOKEN = TOKEN
    })

    it("accepts a correct Bearer header", () => {
      expect(verifyAdminRequest(req({ auth: `Bearer ${TOKEN}` }))).toBe(true)
    })
    it("accepts a correct ?token= query (cron-job.org path)", () => {
      expect(verifyAdminRequest(req({ token: TOKEN }))).toBe(true)
    })
    it("rejects a wrong or missing token", () => {
      expect(verifyAdminRequest(req({ auth: "Bearer nope" }))).toBe(false)
      expect(verifyAdminRequest(req({ token: "nope" }))).toBe(false)
      expect(verifyAdminRequest(req())).toBe(false)
    })
    it("rejects a bare token without the 'Bearer ' prefix", () => {
      expect(verifyAdminRequest(req({ auth: TOKEN }))).toBe(false)
    })
  })
})
