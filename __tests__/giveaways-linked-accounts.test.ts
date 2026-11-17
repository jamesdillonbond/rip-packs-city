import { describe, it, expect, vi } from "vitest"
import { discoverAccounts } from "@/lib/giveaways/linked-accounts"
import { LINKED_ACCOUNTS_SCRIPT } from "@/lib/giveaways/deliver-cadence"
import type { CdcValue } from "@/lib/giveaways/flow-script"

// The accounts a connected Flow Wallet can draw a pool from. Measured on mainnet
// 2026-10-03 for Trevor's Flow Wallet: itself (0 moments), his Dapper account
// (15,547) and a second linked account with no Top Shot collection (-1).

// The script answers [count, on-chain name, "dapper" | ""] per account (mainnet, 2026-10-03:
// Flow Wallet ["0","",""], 0xe486… ["-1","Creator Hub",""], 0xbd94… ["15549","Dapper Wallet","dapper"]).
const dict = (entries: [string, number, string?, string?][]): CdcValue => ({
  type: "Dictionary",
  value: entries.map(([k, n, name = "", dapper = ""]) => ({
    key: { type: "Address", value: k },
    value: { type: "Array", value: [String(n), name, dapper].map((v) => ({ type: "String", value: v })) },
  })),
})

describe("giveaways/linked-accounts — discoverAccounts", () => {
  it("returns the wallet first, then its linked accounts; -1 means no Top Shot collection", async () => {
    const run = vi.fn(async () =>
      dict([["0xe48652ecda3b296d", -1, "Creator Hub"], ["0xbd94cade097e50ac", 15547, "Dapper Wallet", "dapper"], ["0x3d0b274c80263484", 0]]),
    )
    const r = await discoverAccounts("0x3d0b274c80263484", run)
    expect(run).toHaveBeenCalledWith(LINKED_ACCOUNTS_SCRIPT, [{ type: "Address", value: "0x3d0b274c80263484" }])
    expect(r).toEqual([
      { address: "0x3d0b274c80263484", role: "flow_wallet", topshot_count: 0, name: null, dapper: false },
      { address: "0xbd94cade097e50ac", role: "linked", topshot_count: 15547, name: "Dapper Wallet", dapper: true },
      { address: "0xe48652ecda3b296d", role: "linked", topshot_count: null, name: "Creator Hub", dapper: false },
    ])
  })

  it("an on-chain name is anyone's text: collapsed to one line and capped", async () => {
    const run = vi.fn(async () => dict([["0x3d0b274c80263484", 0], ["0xbd94cade097e50ac", 1, "  My\n  " + "x".repeat(80), "dapper"]]))
    const [, linked] = await discoverAccounts("0x3d0b274c80263484", run)
    expect(linked.name).toBe(("My " + "x".repeat(80)).slice(0, 40))
  })

  it("Dapper comes from the on-chain flag only — a link merely NAMED 'Dapper Wallet' is not one", async () => {
    const run = vi.fn(async () => dict([["0x3d0b274c80263484", 0], ["0xbd94cade097e50ac", 5, "Dapper Wallet", ""], ["0xe48652ecda3b296d", 5, "", "dapper"]]))
    const r = await discoverAccounts("0x3d0b274c80263484", run)
    expect(r.find((a) => a.address === "0xbd94cade097e50ac")?.dapper).toBe(false)
    expect(r.find((a) => a.address === "0xe48652ecda3b296d")?.dapper).toBe(true)
  })

  it("the old count-only answer is a shape error, not an account list", async () => {
    const old: CdcValue = {
      type: "Dictionary",
      value: [{ key: { type: "Address", value: "0x3d0b274c80263484" }, value: { type: "Int", value: "0" } }],
    }
    await expect(discoverAccounts("0x3d0b274c80263484", vi.fn(async () => old))).rejects.toMatchObject({ code: "flow_shape" })
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
