import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/public/wallet-packs — sealed packs one wallet holds at the lowest live ask,
// under /share/<wallet>'s Total Collection FMV (2026-11-21). Pins: strict Flow
// address; totals only; a failed read is a 503, never a $0 answer.

const state: { packs: { data: any; error: any } | null; calls: string[] } = { packs: null, calls: [] }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: (_fn: string, args: { p_wallet: string }) => {
      state.calls.push(args.p_wallet)
      return Promise.resolve(state.packs ?? { data: null, error: { message: "boom" } })
    },
  },
}))

import { NextRequest } from "next/server"
import { GET } from "@/app/api/public/wallet-packs/route"

const req = (w: string) => new NextRequest("https://x.test/api/public/wallet-packs?wallet=" + encodeURIComponent(w))

beforeEach(() => { state.packs = null; state.calls = [] })

describe("GET /api/public/wallet-packs", () => {
  it("rejects anything but a Flow address", async () => {
    expect((await GET(req("not-a-wallet"))).status).toBe(400)
    expect(state.calls).toEqual([])
  })
  it("returns the low-ask total, cached at the edge", async () => {
    state.packs = { data: { count: 28, listed_count: 28, floor_ask_usd: 922.99 }, error: null }
    const res = await GET(req("0xaf78a4360000fe85"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ held: 28, listed: 28, low_ask_usd: 922.99 })
    expect(res.headers.get("cache-control")).toContain("s-maxage=600")
  })
  it("a failed read is a 503, never $0", async () => {
    const res = await GET(req("0xaf78a4360000fe85"))
    expect(res.status).toBe(503)
    expect(res.headers.get("cache-control")).toBe("no-store")
  })
})
