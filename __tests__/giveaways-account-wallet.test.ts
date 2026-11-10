import { describe, it, expect } from "vitest"
import { accountTopShotWallet } from "@/lib/giveaways/account-wallet"

function db(result: { data: unknown; error: { message: string } | null }) {
  const calls: unknown[][] = []
  const api = {
    from: (t: string) => {
      calls.push(["from", t])
      return {
        select: (c: string) => {
          calls.push(["select", c])
          return {
            eq: (a: string, v: string) => {
              calls.push(["eq", a, v])
              return {
                eq: (b: string, w: string) => {
                  calls.push(["eq", b, w])
                  return Promise.resolve(result)
                },
              }
            },
          }
        },
      }
    },
  }
  return { api: api as never, calls }
}

describe("accountTopShotWallet", () => {
  it("one saved Flow wallet for the collection: that wallet, lower-cased, with its username; scoped by user AND collection", async () => {
    const { api, calls } = db({ data: [{ wallet_addr: "0x00000000000000AB", username: "Alice" }], error: null })
    expect(await accountTopShotWallet(api, "u1", "col")).toEqual({ wallet: { address: "0x00000000000000ab", username: "Alice" } })
    expect(calls).toContainEqual(["eq", "user_id", "u1"])
    expect(calls).toContainEqual(["eq", "collection_id", "col"])
  })

  it("the same wallet saved twice is one wallet; a non-Flow address (a Solana key) is not a Top Shot wallet", async () => {
    const { api } = db({
      data: [
        { wallet_addr: "0x00000000000000ab", username: null },
        { wallet_addr: "0x00000000000000AB", username: "Alice" },
        { wallet_addr: "GRWXtk2EYMvxN1P4NSorymJkPnEcHK63y95Ae6YqDymk", username: null },
      ],
      error: null,
    })
    expect(await accountTopShotWallet(api, "u1", "col")).toEqual({ wallet: { address: "0x00000000000000ab", username: "Alice" } })
  })

  it("no wallet → none; two different wallets → ambiguous (never a guess)", async () => {
    expect(await accountTopShotWallet(db({ data: [], error: null }).api, "u1", "col")).toEqual({ wallet: null, reason: "none" })
    const two = db({ data: [{ wallet_addr: "0x00000000000000ab" }, { wallet_addr: "0x00000000000000cd" }], error: null })
    expect(await accountTopShotWallet(two.api, "u1", "col")).toEqual({ wallet: null, reason: "ambiguous" })
  })

  it("a failed read THROWS — it is never reported as 'no wallet'", async () => {
    await expect(accountTopShotWallet(db({ data: null, error: { message: "timeout" } }).api, "u1", "col")).rejects.toThrow(/timeout/)
  })
})
