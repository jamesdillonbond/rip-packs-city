import { describe, it, expect, vi, afterEach } from "vitest"
import { fetchSavedWalletForCollection } from "@/lib/profile/saved-wallet-for-collection"

// Client-side helper resolving the signed-in user's saved wallet for a collection
// slug. Returns null for an unknown slug (no UUID mapped), a non-ok response, a
// missing/blank wallet, or any thrown error; otherwise the trimmed first wallet.

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubFetch(impl: (url: string) => any) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => impl(url)))
}

describe("fetchSavedWalletForCollection", () => {
  it("returns null (without fetching) when the slug has no UUID", async () => {
    const spy = vi.fn()
    vi.stubGlobal("fetch", spy)
    expect(await fetchSavedWalletForCollection("not-a-collection")).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it("hits the saved-wallets API with the mapped UUID and returns the first wallet, trimmed", async () => {
    let seenUrl = ""
    stubFetch((url) => {
      seenUrl = url
      return { ok: true, json: async () => ({ wallets: [{ wallet_addr: "  0xabc  " }] }) }
    })
    const addr = await fetchSavedWalletForCollection("nba-top-shot")
    expect(addr).toBe("0xabc")
    expect(seenUrl).toContain("95f28a17-224a-4025-96ad-adf8a4c63bfd")
  })

  it("returns null on a non-ok response", async () => {
    stubFetch(() => ({ ok: false, json: async () => ({}) }))
    expect(await fetchSavedWalletForCollection("nfl-all-day")).toBeNull()
  })

  it("returns null when there are no wallets or the addr is blank", async () => {
    stubFetch(() => ({ ok: true, json: async () => ({ wallets: [] }) }))
    expect(await fetchSavedWalletForCollection("nba-top-shot")).toBeNull()

    stubFetch(() => ({ ok: true, json: async () => ({ wallets: [{ wallet_addr: "   " }] }) }))
    expect(await fetchSavedWalletForCollection("nba-top-shot")).toBeNull()
  })

  it("returns null when json parsing yields null", async () => {
    stubFetch(() => ({ ok: true, json: async () => null }))
    expect(await fetchSavedWalletForCollection("nba-top-shot")).toBeNull()
  })

  it("returns null when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down") }))
    expect(await fetchSavedWalletForCollection("nba-top-shot")).toBeNull()
  })
})
