import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for POST /api/subscribe.
// Pre-DB guards, in order:
//   1. req.json() throws → 400 "Invalid JSON"
//   2. missing email / no "@" → 400 "Invalid email"
// Then it upserts email_subscribers (supabaseAdmin, mocked) and — only when
// RESEND_API_KEY is set — fires a Resend email. We delete RESEND_API_KEY so the
// happy path stays network-free and returns { success: true }.

const upsert: { error: any } = { error: null }

vi.mock("@/lib/supabase", () => {
  const b: any = { from: () => b, upsert: async () => ({ error: upsert.error }) }
  return { supabaseAdmin: b }
})

import { POST } from "@/app/api/subscribe/route"

function post(body: string): NextRequest {
  return new NextRequest("https://t/api/subscribe", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body,
  })
}

beforeEach(() => {
  upsert.error = null
  delete process.env.RESEND_API_KEY
})
afterEach(() => {
  delete process.env.RESEND_API_KEY
})

describe("POST /api/subscribe", () => {
  it("400s on invalid JSON", async () => {
    const res = await POST(post("not-json"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Invalid JSON")
  })

  it("400s on an email without an @", async () => {
    const res = await POST(post(JSON.stringify({ email: "nope" })))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Invalid email")
  })

  it("returns success on a valid subscription (Resend disabled)", async () => {
    const res = await POST(post(JSON.stringify({ email: "A@B.com" })))
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
  })

  it("500s with the message when the upsert errors", async () => {
    upsert.error = { message: "dup key" }
    const res = await POST(post(JSON.stringify({ email: "a@b.com" })))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).toBe("dup key")
  })
})
