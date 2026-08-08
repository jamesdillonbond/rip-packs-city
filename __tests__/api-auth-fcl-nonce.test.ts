import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/auth/fcl-nonce.
// Mints a single-use nonce by inserting into fcl_auth_nonces. Mock @/lib/supabase
// so the insert resolves { error: null } (happy → returns a hex nonce) or an
// error (→ 500). The route races the insert against an 8s timeout.

const state: { error: any; data: any; throw: any; hang: boolean } = {
  error: null,
  data: null,
  throw: null,
  hang: false,
}

vi.mock("@/lib/supabase", () => {
  const b: any = {
    from: () => b,
    insert: () => {
      if (state.hang) return new Promise(() => {}) // never resolves → timeout race
      if (state.throw) return Promise.reject(state.throw)
      return Promise.resolve({ error: state.error, data: state.data })
    },
  }
  return { supabaseAdmin: b }
})

import { GET } from "@/app/api/auth/fcl-nonce/route"

beforeEach(() => {
  state.error = null
  state.data = null
  state.throw = null
  state.hang = false
})

describe("GET /api/auth/fcl-nonce", () => {
  it("returns a hex nonce + appIdentifier on success", async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.appIdentifier).toBe("Rip Packs City")
    expect(body.nonce).toMatch(/^[0-9a-f]{64}$/)
  })

  it("500s on a plain insert error", async () => {
    state.error = { message: "insert failed" }
    const res = await GET()
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("insert failed")
  })

  it("returns 503 (retry) when the error message is an HTML error page, not the HTML", async () => {
    state.error = { message: "<!DOCTYPE html><html><body>Cloudflare 502</body></html>" }
    const res = await GET()
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toBe("auth_provider_unavailable")
    expect(body.retry).toBe(true)
    // the HTML must NEVER be echoed to the caller
    expect(JSON.stringify(body)).not.toContain("Cloudflare")
  })

  it("returns 503 when the data payload itself is an HTML page", async () => {
    state.data = "<html><body>oops</body></html>"
    const res = await GET()
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe("auth_provider_unavailable")
  })

  it("returns 503 (retry) when the insert throws", async () => {
    state.throw = new Error("network down")
    const res = await GET()
    expect(res.status).toBe(503)
    expect((await res.json()).retry).toBe(true)
  })

  it("returns 503 when the insert throws an HTML-bodied error", async () => {
    state.throw = new Error("<!doctype html> gateway error")
    const res = await GET()
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe("auth_provider_unavailable")
  })

  it("returns 503 when the insert hangs past the 8s upstream timeout", async () => {
    vi.useFakeTimers()
    state.hang = true
    try {
      const p = GET()
      await vi.advanceTimersByTimeAsync(8001) // trip the Promise.race timeout
      const res = await p
      expect(res.status).toBe(503)
      expect((await res.json()).error).toBe("auth_provider_unavailable")
    } finally {
      vi.useRealTimers()
    }
  })
})
