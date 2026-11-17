import { describe, it, expect, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for GET /api/allday-lock-refresh.
// The route is now a thin wrapper over refreshAllDayWalletLocks (lib/allday-lock),
// which holds the on-chain-diff logic (tested separately in lib-allday-lock.test.ts).
// Here we pin the param guard (400 before any Cadence work) and the passthrough
// of the helper's result on the 200 path.

const h = vi.hoisted(() => ({
  refresh: vi.fn(async (wallet: string) => ({
    wallet,
    total_cached: 1,
    unlocked_onchain: 0,
    marked_locked: 1,
    marked_unlocked: 0,
  })),
}))

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))
vi.mock("@/lib/allday-lock", () => ({ refreshAllDayWalletLocks: h.refresh }))

import { GET } from "@/app/api/allday-lock-refresh/route"

const req = (qs = "") => new NextRequest("https://t/api/allday-lock-refresh" + qs)

describe("GET /api/allday-lock-refresh", () => {
  it("400s without a wallet param", async () => {
    const res = await GET(req())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet required")
    expect(h.refresh).not.toHaveBeenCalled()
  })

  it("200s and returns the helper's diff result", async () => {
    const res = await GET(req("?wallet=0xabc"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.wallet).toBe("0xabc")
    expect(body.total_cached).toBe(1)
    expect(body.marked_locked).toBe(1)
    expect(h.refresh).toHaveBeenCalledWith("0xabc", expect.anything())
  })
})

// --- the 0x normalization + the 500 paths ---

describe("GET /api/allday-lock-refresh — normalization + failures", () => {
  it("prefixes a bare-hex wallet with 0x before the diff walk", async () => {
    h.refresh.mockClear()
    await GET(req("?wallet=bd94cade097e50ac"))
    expect(h.refresh).toHaveBeenCalledWith("0xbd94cade097e50ac", expect.anything())
  })

  it("500s without the helper's message when the diff walk throws", async () => {
    h.refresh.mockRejectedValueOnce(new Error("computation limit exceeded"))
    const res = await GET(req("?wallet=0xabc"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain("computation limit exceeded")
  })

  it("500s with generic copy when a non-Error is thrown", async () => {
    h.refresh.mockRejectedValueOnce("boom")
    const res = await GET(req("?wallet=0xabc"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain("internal error")
  })
})
