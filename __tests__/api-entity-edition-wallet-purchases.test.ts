import { describe, it, expect, beforeEach, vi } from "vitest"

// The `part=wallet-purchases` arm of /api/entity/edition — the viewer's OWN buys
// of this edition, for the chart's "my buys" overlay (beta feedback 10263,
// 2026-10-03). Pins: the wallet is parsed for the collection's chain the way the
// team checklist parses it (Flow folded to lowercase, Solana verbatim); a key of
// the wrong chain is a 400, never a silent "no buys"; days=0 is all-time; the
// response is never edge-cached (it is per wallet).

const calls: Array<{ fn: string; args: any }> = []
const rpc: { data: any; error: any } = { data: [], error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (fn: string, args: any) => {
      calls.push({ fn, args })
      return { data: rpc.data, error: rpc.error }
    },
  },
  supabase: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))

import { GET } from "@/app/api/entity/edition/route"

const req = (qs: string) => new Request("https://t/api/entity/edition?" + qs)
const BASE = "collection=nba-top-shot&slug=272%3A9030&part=wallet-purchases"

beforeEach(() => {
  calls.length = 0
  rpc.data = []
  rpc.error = null
})

describe("GET /api/entity/edition?part=wallet-purchases", () => {
  it("calls get_edition_wallet_purchases with the Flow wallet folded to lowercase and days=0 by default", async () => {
    rpc.data = [{ sold_at: "2026-09-27T20:22:19.529+00:00", price_usd: 82, serial_number: 22, marketplace: "topshot" }]
    const res = await GET(req(BASE + "&wallet=0x17FA19EC950ACE75"))
    expect(res.status).toBe(200)
    expect(calls[0].fn).toBe("get_edition_wallet_purchases")
    expect(calls[0].args).toMatchObject({ p_route_slug: "272:9030", p_wallet: "0x17fa19ec950ace75", p_days: 0 })
    expect(await res.json()).toHaveLength(1)
    expect(res.headers.get("Cache-Control")).toContain("no-store")
  })

  it("bounds the window when days is given, and clamps it", async () => {
    await GET(req(BASE + "&wallet=0x17fa19ec950ace75&days=90"))
    expect(calls[0].args.p_days).toBe(90)
    await GET(req(BASE + "&wallet=0x17fa19ec950ace75&days=999999"))
    expect(calls[1].args.p_days).toBe(4000)
  })

  it("400s without a wallet, and on a key that is not an address of the collection's chain — never a silent empty", async () => {
    expect((await GET(req(BASE))).status).toBe(400)
    expect((await GET(req(BASE + "&wallet=not-an-address"))).status).toBe(400)
    expect(calls).toHaveLength(0)
    // Candy MLB is Solana: a Flow key is refused (and a Solana key is NEVER folded)
    const res = await GET(req("collection=candy-mlb&slug=x&part=wallet-purchases&wallet=0x17fa19ec950ace75"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/Solana/)
    await GET(req("collection=candy-mlb&slug=x&part=wallet-purchases&wallet=7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCTqQe"))
    expect(calls.at(-1)?.args.p_wallet).toBe("7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCTqQe")
  })

  it("a failed read is a classified error, not an empty list", async () => {
    rpc.error = { message: "canceling statement due to statement timeout" }
    const res = await GET(req(BASE + "&wallet=0x17fa19ec950ace75"))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(JSON.stringify(await res.json())).not.toContain("canceling")
  })
})
