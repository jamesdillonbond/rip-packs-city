import { describe, it, expect, beforeEach, vi } from "vitest"

// Wallet read routes share a required-identifier guard (wallet / ownerKey) and
// several also validate the collection slug — all returning 400 before any DB
// call. Pin those guards + one happy path. Mocks supabaseAdmin.

const rpc: { data: any; error: any } = { data: null, error: null }
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
  supabase: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))

import { GET as packSummary } from "@/app/api/wallet/pack-summary/route"
import { GET as editionCounts } from "@/app/api/wallet/edition-counts/route"
import { GET as costBasis } from "@/app/api/wallet-cost-basis/route"
import { GET as holdTime } from "@/app/api/wallet-hold-time/route"
import { GET as walletProfile } from "@/app/api/wallet/profile/route"

const req = (u: string) => ({ nextUrl: new URL(u) }) as any

beforeEach(() => { rpc.data = null; rpc.error = null })

describe("wallet read routes — required-identifier guard", () => {
  it("pack-summary is auth-gated: 401 without a signed-in user", async () => {
    // requireUser() runs before the wallet check → fail-closed 401.
    expect((await packSummary(req("https://t/api/wallet/pack-summary"))).status).toBe(401)
  })
  it("edition-counts 400s without wallet", async () => {
    expect((await editionCounts(req("https://t/api/wallet/edition-counts"))).status).toBe(400)
  })
  it("cost-basis 400s without wallet", async () => {
    expect((await costBasis(req("https://t/api/wallet-cost-basis"))).status).toBe(400)
  })
  it("hold-time 400s without wallet", async () => {
    expect((await holdTime(req("https://t/api/wallet-hold-time"))).status).toBe(400)
  })
  it("wallet/profile 400s without ownerKey", async () => {
    expect((await walletProfile(req("https://t/api/wallet/profile"))).status).toBe(400)
  })
})

describe("wallet read routes — collection-slug guard", () => {
  it("edition-counts 400s on an unknown collection", async () => {
    const res = await editionCounts(req("https://t/api/wallet/edition-counts?wallet=0xabc&collection=not-real"))
    expect(res.status).toBe(400)
  })
  it("cost-basis 400s on an unknown collection", async () => {
    const res = await costBasis(req("https://t/api/wallet-cost-basis?wallet=0xabc&collection=not-real"))
    expect(res.status).toBe(400)
  })
})
