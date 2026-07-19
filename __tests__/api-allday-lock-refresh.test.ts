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
