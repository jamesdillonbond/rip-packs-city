import { describe, it, expect, vi } from "vitest"
import { atlasResolveUsername, atlasVerifyListing } from "@/lib/chains/flow/atlas"

// lib/chains/flow/atlas.ts — the two-phase Atlas reads (2026-09-06). pg_net
// only sends after the enqueuing transaction commits, so every read is
// `*_begin` (returns a request id) then `*_collect` (polls in the next
// transaction). Pins the call shape, the envelope parsing, and — the part the
// honesty canon cares about — that every failure is a FAILED READ envelope
// (ok:false) distinct from a clean "not found", and that the helpers never throw.

type Env = { data: unknown; error: { message?: string } | null }
function handle(script: Record<string, unknown | (() => unknown)>) {
  const rpc = vi.fn<(name: string, args: Record<string, unknown>) => Promise<Env>>(async (name) => {
    const v = script[name]
    if (v === undefined) return { data: null, error: null }
    const out = typeof v === "function" ? (v as () => unknown)() : v
    if (out instanceof Error) throw out
    return out as Env
  })
  return { db: { rpc }, rpc }
}

describe("atlasResolveUsername", () => {
  it("begin → collect, forwarding the trimmed @-stripped username and the request id, then normalizes the address", async () => {
    const { db, rpc } = handle({
      atlas_resolve_username_begin: { data: 84233, error: null },
      atlas_resolve_username_collect: {
        data: { ok: true, found: true, flow_address: "BD94CADE097E50AC", username: "Jamesdillonbond", profile_image_url: "https://i/x.png", created_at: "2021-03-01T06:30:10Z" },
        error: null,
      },
    })
    const out = await atlasResolveUsername(db, "  @Jamesdillonbond ")
    expect(out).toEqual({
      ok: true,
      found: true,
      flowAddress: "0xbd94cade097e50ac",
      username: "Jamesdillonbond",
      profileImageUrl: "https://i/x.png",
      createdAt: "2021-03-01T06:30:10Z",
    })
    expect(rpc.mock.calls[0]).toEqual(["atlas_resolve_username_begin", { p_username: "Jamesdillonbond" }])
    expect(rpc.mock.calls[1]).toEqual(["atlas_resolve_username_collect", { p_request_id: 84233, p_max_ms: 8000 }])
  })

  it("a clean 'no such user' is ok:true / found:false with a null address", async () => {
    const { db } = handle({
      atlas_resolve_username_begin: { data: 1, error: null },
      atlas_resolve_username_collect: { data: { ok: true, found: false, flow_address: null, username: null }, error: null },
    })
    expect(await atlasResolveUsername(db, "ghost")).toMatchObject({ ok: true, found: false, flowAddress: null })
  })

  it("accepts a string request id (PostgREST serializes bigint as text)", async () => {
    const { db, rpc } = handle({
      atlas_resolve_username_begin: { data: "84233", error: null },
      atlas_resolve_username_collect: { data: { ok: true, found: false }, error: null },
    })
    expect((await atlasResolveUsername(db, "x")).ok).toBe(true)
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_request_id: 84233 })
  })

  it("a collect envelope with ok:false is a FAILED READ carrying the upstream error and status", async () => {
    const { db } = handle({
      atlas_resolve_username_begin: { data: 1, error: null },
      atlas_resolve_username_collect: { data: { ok: false, error: "<!DOCTYPE html>Just a moment", status: 403 }, error: null },
    })
    expect(await atlasResolveUsername(db, "x")).toEqual({ ok: false, error: "<!DOCTYPE html>Just a moment", status: 403 })
  })

  it("a begin that returns no request id is a failed read (never a not-found), and collect is not called", async () => {
    const { db, rpc } = handle({ atlas_resolve_username_begin: { data: null, error: null } })
    const out = await atlasResolveUsername(db, "x")
    expect(out).toMatchObject({ ok: false })
    expect((out as { error: string }).error).toMatch(/no request id/)
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it("an RPC error / a thrown transport error / a non-object envelope are all ok:false — the helper never throws", async () => {
    const a = handle({ atlas_resolve_username_begin: { data: null, error: { message: "permission denied for function" } } })
    expect(await atlasResolveUsername(a.db, "x")).toMatchObject({ ok: false, error: "permission denied for function" })

    const b = handle({ atlas_resolve_username_begin: () => new Error("fetch failed") })
    expect(await atlasResolveUsername(b.db, "x")).toMatchObject({ ok: false, error: "fetch failed" })

    const c = handle({ atlas_resolve_username_begin: { data: 1, error: null }, atlas_resolve_username_collect: { data: "nope", error: null } })
    expect(await atlasResolveUsername(c.db, "x")).toMatchObject({ ok: false })
  })

  it("rejects a blank or over-long username before any RPC", async () => {
    const { db, rpc } = handle({})
    expect(await atlasResolveUsername(db, "@@ ")).toMatchObject({ ok: false, error: "bad_username" })
    expect(await atlasResolveUsername(db, "x".repeat(65))).toMatchObject({ ok: false, error: "bad_username" })
    expect(rpc).not.toHaveBeenCalled()
  })

  it("found:true with an unparseable address yields a null flowAddress (the caller treats it as not resolvable)", async () => {
    const { db } = handle({
      atlas_resolve_username_begin: { data: 1, error: null },
      atlas_resolve_username_collect: { data: { ok: true, found: true, flow_address: "0xzz" }, error: null },
    })
    expect(await atlasResolveUsername(db, "x")).toMatchObject({ ok: true, found: true, flowAddress: null })
  })
})

describe("atlasVerifyListing", () => {
  it("forwards nft id, seller, rounded price and max_ms; parses counts and the matched listing", async () => {
    const { db, rpc } = handle({
      atlas_verify_listing_begin: { data: 5, error: null },
      atlas_verify_listing_collect: {
        data: { ok: true, matched: true, open_listings: "1", listed_at: "t", price_cents: "1250", serial_number: 42, listing_resource_id: "r" },
        error: null,
      },
    })
    const out = await atlasVerifyListing(db, " 123 ", "0xABC", 1249.6, 5000)
    expect(out).toEqual({ ok: true, matched: true, openListings: 1, listedAt: "t", priceCents: 1250, serialNumber: 42, listingResourceId: "r" })
    expect(rpc.mock.calls[0]).toEqual(["atlas_verify_listing_begin", { p_nft_id: "123" }])
    expect(rpc.mock.calls[1]).toEqual(["atlas_verify_listing_collect", { p_request_id: 5, p_wallet: "0xABC", p_price_cents: 1250, p_max_ms: 5000 }])
  })

  it("no wallet / no price → empty seller filter and null price", async () => {
    const { db, rpc } = handle({
      atlas_verify_listing_begin: { data: 5, error: null },
      atlas_verify_listing_collect: { data: { ok: true, matched: false, open_listings: 0 }, error: null },
    })
    expect(await atlasVerifyListing(db, "1", null, null)).toMatchObject({ ok: true, matched: false, openListings: 0, priceCents: null })
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_wallet: "", p_price_cents: null })
  })

  it("an ok envelope WITHOUT an open_listings count is a failed read, not zero listings", async () => {
    const { db } = handle({
      atlas_verify_listing_begin: { data: 5, error: null },
      atlas_verify_listing_collect: { data: { ok: true, matched: false }, error: null },
    })
    const out = await atlasVerifyListing(db, "1", null, null)
    expect(out.ok).toBe(false)
    expect((out as { error: string }).error).toMatch(/open_listings/)
  })

  it("rejects a non-numeric nft id before any RPC", async () => {
    const { db, rpc } = handle({})
    expect(await atlasVerifyListing(db, "abc", null, null)).toMatchObject({ ok: false, error: "bad_nft_id" })
    expect(rpc).not.toHaveBeenCalled()
  })
})
