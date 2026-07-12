import { describe, it, expect, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for GET /api/auth/callback (magic-link callback).
// With no code / token_hash / error_description on the URL there's nothing
// actionable → 307 redirect to /login?error=missing_code. An error_description
// with no code redirects to /login?error=auth_failed. Mock the supabase deps so
// the module imports cleanly; we pin the no-op redirect guards (the happy path
// exchanges a real session).

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))
vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({}) }))

import { GET } from "@/app/api/auth/callback/route"

const req = (qs = "") => new NextRequest("https://t/api/auth/callback" + qs)

describe("GET /api/auth/callback", () => {
  it("redirects to /login?error=missing_code with no actionable params", async () => {
    const res = await GET(req())
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toContain("/login?error=missing_code")
  })

  it("redirects to /login?error=auth_failed on an error_description", async () => {
    const res = await GET(req("?error_description=expired"))
    expect(res.status).toBe(307)
    const loc = res.headers.get("location") ?? ""
    expect(loc).toContain("/login")
    expect(loc).toContain("error=auth_failed")
  })
})
