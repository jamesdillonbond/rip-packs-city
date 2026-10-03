import { describe, it, expect, vi } from "vitest"
import { discoverAccounts } from "@/lib/giveaways/linked-accounts"
import { LINKED_ACCOUNTS_SCRIPT } from "@/lib/giveaways/deliver-cadence"
import type { CdcValue } from "@/lib/giveaways/flow-script"

// The accounts a connected Flow Wallet can draw a pool from. Measured on mainnet
// 2026-10-03 for Trevor's Flow Wallet: itself (0 moments), his Dapper account
// (15,547) and a second linked account with no Top Shot collection (-1).

const dict = (entries: [string, number][]): CdcValue => ({
  type: "Dictionary",
  value: entries.map(([k, v]) => ({ key: { type: "Address", value: k }, value: { type: "Int", value: String(v) } })),
})

describe("giveaways/linked-accounts — discoverAccounts", () => {
  it("returns the wallet first, then its linked accounts; -1 means no Top Shot collection", async () => {
    const run = vi.fn(async () => dict([["0xe48652ecda3b296d", -1], ["0xbd94cade097e50ac", 15547], ["0x3d0b274c80263484", 0]]))
    const r = await discoverAccounts("0x3d0b274c80263484", run)
    expect(run).toHaveBeenCalledWith(LINKED_ACCOUNTS_SCRIPT, [{ type: "Address", value: "0x3d0b274c80263484" }])
    expect(r).toEqual([
      { address: "0x3d0b274c80263484", role: "flow_wallet", topshot_count: 0 },
      { address: "0xbd94cade097e50ac", role: "linked", topshot_count: 15547 },
      { address: "0xe48652ecda3b296d", role: "linked", topshot_count: null },
    ])
  })

  it("refuses a shape it can't read, and an answer that omits the wallet itself", async () => {
    await expect(discoverAccounts("0x3d0b274c80263484", vi.fn(async () => ({ type: "Array", value: [] })))).rejects.toMatchObject({ code: "flow_shape" })
    await expect(discoverAccounts("0x3d0b274c80263484", vi.fn(async () => dict([["nope", 1]])))).rejects.toMatchObject({ code: "flow_shape" })
    await expect(discoverAccounts("0x3d0b274c80263484", vi.fn(async () => dict([["0xbd94cade097e50ac", 1]])))).rejects.toMatchObject({ code: "flow_shape" })
  })

  it("a failed chain read propagates (never an empty account list)", async () => {
    await expect(discoverAccounts("0x3d0b274c80263484", vi.fn(async () => Promise.reject(new Error("Flow script HTTP 503"))))).rejects.toThrow(/503/)
  })
})
