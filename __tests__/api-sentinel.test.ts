import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for POST /api/sentinel.
// The ONLY pre-DB guard is the Bearer check, read at CALL time:
//   auth !== `Bearer ${process.env.INGEST_SECRET_TOKEN}` → 401 "Unauthorized".
// There is NO 500-when-unset branch here (an unset token just makes the compare
// string "Bearer undefined", so every real request still 401s). Everything past
// the guard is live Supabase + Telegram/Resend + a self-fetch to /api/sniper-feed
// with no simple mock seam, so we pin the guard only. The module builds a
// @supabase/supabase-js client at import time, but the vitest.setup.ts env
// placeholders satisfy that constructor, so no mock is needed for import.

const TOKEN = "test-sentinel-token"

import { POST } from "@/app/api/sentinel/route"

function post(auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/sentinel", { method: "POST", headers })
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
})
afterEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
})

describe("POST /api/sentinel", () => {
  it("exports a POST handler", () => {
    expect(typeof POST).toBe("function")
  })

  it("401s with a wrong Bearer token", async () => {
    const res = await POST(post("Bearer wrong"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("401s with no authorization header", async () => {
    const res = await POST(post())
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })
})
