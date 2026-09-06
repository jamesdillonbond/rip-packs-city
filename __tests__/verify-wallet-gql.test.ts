import { describe, it, expect, beforeEach, vi } from "vitest"

const adminRpc = vi.fn()
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: (...args: unknown[]) => adminRpc(...args) },
  supabase: { rpc: (...args: unknown[]) => adminRpc(...args) },
}))

import { fetchMomentListingState, priceMatchesCents, topShotMomentUrl } from "@/lib/verify-wallet-gql"

// lib/verify-wallet-gql.ts — live listing-state helper backing the wallet
// listing-challenge. Pure helpers (priceMatchesCents / topShotMomentUrl) are
// pinned statically; fetchMomentListingState is exercised over a stubbed Atlas
// DB handle (the two-phase RPCs, 2026-09-06 — the GQL host it replaced is dead):
// the seller+price-matched answer, the "listed by someone else" answer, the
// no-wallet call, the default service-role handle, and the throw on a failed
// read (a failed read must surface as "couldn't check", never as a verdict).

// ── pure helpers ───────────────────────────────────────────────────────────
describe("priceMatchesCents", () => {
  it("matches to the cent", () => {
    expect(priceMatchesCents(10.0, 10.0)).toBe(true)
    expect(priceMatchesCents(10.01, 10.01)).toBe(true)
    expect(priceMatchesCents(10.005 + 0.005, 10.01)).toBe(true)
  })

  it("rejects a mismatch by a cent or more", () => {
    expect(priceMatchesCents(10.0, 10.01)).toBe(false)
    expect(priceMatchesCents(9.99, 10.0)).toBe(false)
  })

  it("rejects null / non-finite price", () => {
    expect(priceMatchesCents(null, 10)).toBe(false)
    expect(priceMatchesCents(Infinity, 10)).toBe(false)
    expect(priceMatchesCents(NaN, 10)).toBe(false)
  })
})

describe("topShotMomentUrl", () => {
  it("builds the native moment page url, encoding the id", () => {
    expect(topShotMomentUrl("999")).toBe("https://nbatopshot.com/moment/999")
    expect(topShotMomentUrl("a b")).toBe("https://nbatopshot.com/moment/a%20b")
  })
})

// ── fetchMomentListingState (stubbed Atlas handle) ─────────────────────────
function atlasHandle(collect: unknown, beginId: number | { error: string } = 91) {
  const rpc = vi.fn<(name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message?: string } | null }>>(async (name) => {
    if (name === "atlas_verify_listing_begin") {
      return typeof beginId === "number" ? { data: beginId, error: null } : { data: null, error: { message: beginId.error } }
    }
    if (name === "atlas_verify_listing_collect") return { data: collect, error: null }
    return { data: null, error: null }
  })
  return { db: { rpc }, rpc }
}

beforeEach(() => {
  adminRpc.mockReset()
})

describe("fetchMomentListingState", () => {
  it("asks Atlas about THIS nft, THIS seller and THIS price, and reports the seller-matched open listing", async () => {
    const { db, rpc } = atlasHandle({
      ok: true, matched: true, open_listings: 1, listed_at: "2026-09-06T20:00:00Z",
      price_cents: 1250, serial_number: 42, listing_resource_id: "r-1",
    })
    const out = await fetchMomentListingState("123456", { wallet: "0xabc", priceCents: 1250, db })
    expect(out).toEqual({
      momentId: "123456",
      found: true,
      forSale: true,
      price: 12.5,
      isLocked: false,
      matchedForWallet: true,
      openListings: 1,
    })
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(["atlas_verify_listing_begin", "atlas_verify_listing_collect"])
    expect(rpc.mock.calls[0][1]).toEqual({ p_nft_id: "123456" })
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_request_id: 91, p_wallet: "0xabc", p_price_cents: 1250 })
  })

  it("a listing by SOMEONE ELSE is forSale but NOT matchedForWallet — the verdict the check route keys on", async () => {
    const { db } = atlasHandle({ ok: true, matched: false, open_listings: 2, price_cents: null })
    const out = await fetchMomentListingState("5", { wallet: "0xabc", priceCents: 1250, db })
    expect(out.forSale).toBe(true)
    expect(out.matchedForWallet).toBe(false)
    expect(out.price).toBeNull()
  })

  it("with no wallet asked about, matchedForWallet is null and forSale reflects the open-listing count", async () => {
    const { db, rpc } = atlasHandle({ ok: true, matched: false, open_listings: 0 })
    const out = await fetchMomentListingState("5", { db })
    expect(out).toMatchObject({ found: true, forSale: false, matchedForWallet: null, openListings: 0, isLocked: false })
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_wallet: "", p_price_cents: null })
  })

  it("uses the service-role client when no db is injected", async () => {
    adminRpc.mockImplementation(async (name: string) =>
      name === "atlas_verify_listing_begin" ? { data: 7, error: null } : { data: { ok: true, matched: false, open_listings: 0 }, error: null },
    )
    const out = await fetchMomentListingState("9")
    expect(out.found).toBe(true)
    expect(adminRpc).toHaveBeenCalledTimes(2)
  })

  it("THROWS on a failed read — an Atlas timeout is not 'not listed'", async () => {
    const { db } = atlasHandle({ ok: false, error: "atlas_timeout", status: null })
    await expect(fetchMomentListingState("5", { wallet: "0xabc", priceCents: 100, db })).rejects.toThrow(/Atlas listing read failed: atlas_timeout/)
  })

  it("THROWS on an HTTP-level failure, embedding the status (a Cloudflare 403 challenge is not a verdict)", async () => {
    const { db } = atlasHandle({ ok: false, error: "<!DOCTYPE html>…Just a moment", status: 403 })
    await expect(fetchMomentListingState("5", { db })).rejects.toThrow(/HTTP 403/)
  })

  it("THROWS when the begin RPC itself errors", async () => {
    const { db } = atlasHandle({ ok: true, matched: false, open_listings: 0 }, { error: "permission denied" })
    await expect(fetchMomentListingState("5", { db })).rejects.toThrow(/permission denied/)
  })

  it("THROWS on a malformed nft id before any RPC fires", async () => {
    const { db, rpc } = atlasHandle({ ok: true, matched: false, open_listings: 0 })
    await expect(fetchMomentListingState("not-an-id", { db })).rejects.toThrow(/bad_nft_id/)
    expect(rpc).not.toHaveBeenCalled()
  })
})
