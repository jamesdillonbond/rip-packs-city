import { describe, it, expect, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for POST /api/breaks/[id]/distribute.
// Admin-gated: `!TOKEN || authorization !== "Bearer BREAKS_ADMIN_TOKEN"` → 401
// (TOKEN is module-level from BREAKS_ADMIN_TOKEN; unset ⇒ every request 401s)
// before any Flow transfer. Mock the FCL/authz/supabase deps so the module
// imports cleanly; we pin the fail-closed admin guard.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))
vi.mock("@/lib/breaks/server-authz", () => ({
  configureFcl: () => {},
  buildHotWalletAuthz: () => ({}),
}))

import { POST } from "@/app/api/breaks/[id]/distribute/route"

function req(auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/breaks/b1/distribute", { method: "POST", headers })
}

const ctx = { params: Promise.resolve({ id: "b1" }) }

describe("POST /api/breaks/[id]/distribute", () => {
  it("401s without an admin token", async () => {
    expect((await POST(req(), ctx)).status).toBe(401)
  })

  it("401s with a wrong admin token", async () => {
    expect((await POST(req("Bearer wrong"), ctx)).status).toBe(401)
  })
})
