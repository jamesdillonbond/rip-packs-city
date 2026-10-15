import { describe, it, expect, vi, afterEach } from "vitest"
import { fetchSavedWalletForCollection } from "@/lib/profile/saved-wallet-for-collection"

// Client-side helper resolving the signed-in user's saved wallet for a collection
// slug. Returns null for an unknown slug (no UUID mapped), a non-ok response, a
// missing/blank wallet, or any thrown error; otherwise the trimmed first wallet.

afterEach(() => {
  vi.unstubAllGlobals()
})

// Signed in by default: /api/profile/me answers with a user, and every other
// URL goes to `impl` (the saved-wallets call under test).
function stubFetch(impl: (url: string) => any, me: () => any = () => ({ ok: true, json: async () => ({ user: { id: "u1" } }) })) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.startsWith("/api/profile/me") ? me() : impl(url))))
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

  // 2026-10-14: an anonymous reader must not hit the session-gated route at
  // all — it 401s and logs a console error on every anonymous visit.
  it("signed out: returns null WITHOUT calling the gated saved-wallets route", async () => {
    const seen: string[] = []
    stubFetch(
      (url) => { seen.push(url); return { ok: true, json: async () => ({ wallets: [{ wallet_addr: "0xabc" }] }) } },
      () => ({ ok: true, json: async () => ({ user: null }) }),
    )
    expect(await fetchSavedWalletForCollection("nba-top-shot")).toBeNull()
    expect(seen.filter((u) => u.includes("saved-wallets"))).toEqual([])
  })

  it("a FAILED identity read is unknown, not signed out: it still asks for the wallet", async () => {
    stubFetch(
      () => ({ ok: true, json: async () => ({ wallets: [{ wallet_addr: "0xdef" }] }) }),
      () => ({ ok: false, json: async () => ({}) }),
    )
    expect(await fetchSavedWalletForCollection("nba-top-shot")).toBe("0xdef")
  })

  it("returns null when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down") }))
    expect(await fetchSavedWalletForCollection("nba-top-shot")).toBeNull()
  })
})
