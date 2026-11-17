import { describe, it, expect, vi } from "vitest"

// Route integration test for POST /api/user-resolve. Resolves a wallet-or-username
// to a canonical address. Empty input → 400; a wallet-shaped input short-circuits
// to inputType "wallet" (no network); an unresolvable username → 404. Mocks
// @/lib/topshot-username-resolve.

const state: { resolved: any } = { resolved: null }
vi.mock("@/lib/chains/flow/topshot-username-resolve", () => ({
  isWalletAddress: (v: string) => /^0x[a-fA-F0-9]{16}$/.test(v.trim()),
  resolveTopShotUsername: async () => state.resolved,
}))

import { POST } from "@/app/api/user-resolve/route"

const req = (body: any) => ({ json: async () => body }) as any

describe("POST /api/user-resolve", () => {
  it("400s on empty input", async () => {
    expect((await POST(req({ input: "  " }))).status).toBe(400)
  })

  it("resolves a wallet-shaped input without a lookup", async () => {
    const res = await POST(req({ input: "0xbd94cade097e50ac" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.inputType).toBe("wallet")
    expect(body.walletAddress).toBe("0xbd94cade097e50ac")
  })

  it("404s when the username cannot be resolved", async () => {
    state.resolved = null
    const res = await POST(req({ input: "ghost-user" }))
    expect(res.status).toBe(404)
  })

  it("returns the resolved identity for a known username", async () => {
    state.resolved = { walletAddress: "0xabc", username: "curry", dapperId: "d1" }
    const res = await POST(req({ input: "curry" }))
    expect(res.status).toBe(200)
    expect((await res.json()).inputType).toBe("username")
  })
})
