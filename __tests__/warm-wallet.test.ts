import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { warmWalletDeep } from "@/lib/profile/warm-wallet"

// Unit test for the shared deep-warm dispatcher used by BOTH wallet entry
// points (the username CTA and the paste-an-address save). The invariant that
// matters is skip_cached:false — an open-door signup's cache is page-capped at
// 50 Top Shot moments by the old shallow warm, and skip_cached:true would
// leave it that way forever.

const FLOW = "0xbd94cade097e50ac"
const SOLANA = "63p1oKqkAQ9sQD55iApNRkVL2XzYtASwKjCdSSNEGEhY"
const MULTI = "/api/wallet-backfill-multicollection"

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, status: 202 }))
  vi.stubGlobal("fetch", fetchMock)
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("warmWalletDeep", () => {
  it("POSTs the multicollection orchestrator with the bearer and skip_cached:false", async () => {
    const res = await warmWalletDeep("https://t", "tok", FLOW)
    expect(res).toEqual({ dispatched: true, status: 202, path: MULTI })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, any]
    expect(url).toBe(`https://t${MULTI}`)
    expect(init.method).toBe("POST")
    expect(init.headers.Authorization).toBe("Bearer tok")
    expect(JSON.parse(init.body)).toEqual({ wallet: FLOW, skip_cached: false })
  })

  // Candy is a DIFFERENT CHAIN with its own enricher. Handing a base58 address
  // to the Flow orchestrator would fan it out across five Cadence collections
  // that can never match it.
  it("routes a Solana address to the Candy enricher, case INTACT", async () => {
    const res = await warmWalletDeep("https://t", "tok", SOLANA)
    expect(res.path).toBe("/api/wallet-backfill-candy")
    const [url, init] = fetchMock.mock.calls[0] as [string, any]
    expect(url).toBe("https://t/api/wallet-backfill-candy")
    // base58 is case-sensitive — a lowercased address matches no wmc row.
    expect(JSON.parse(init.body).wallet).toBe(SOLANA)
  })

  it("trims the address before dispatching", async () => {
    expect((await warmWalletDeep("https://t", "tok", `  ${FLOW}  `)).dispatched).toBe(true)
    expect(JSON.parse((fetchMock.mock.calls[0] as any)[1].body).wallet).toBe(FLOW)
  })

  it("skips chains with no enricher, without burning a request", async () => {
    // EVM (Panini/Beezie) has no wallet backfill route today; garbage has none either.
    for (const addr of ["0x" + "a".repeat(40), "", "nonsense"]) {
      expect(await warmWalletDeep("https://t", "tok", addr)).toEqual({
        dispatched: false,
        reason: "unsupported_chain",
      })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("skips (rather than 401s) when the ingest token is blank", async () => {
    expect(await warmWalletDeep("https://t", "", FLOW)).toEqual({
      dispatched: false,
      reason: "no_ingest_token",
      path: MULTI,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("reports a non-ok HTTP response without throwing", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 } as never)
    expect(await warmWalletDeep("https://t", "tok", FLOW)).toEqual({
      dispatched: false,
      reason: "http_error",
      status: 503,
      path: MULTI,
    })
  })

  it("swallows a network failure — warming must never fail the caller's write", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"))
    expect(await warmWalletDeep("https://t", "tok", FLOW)).toEqual({
      dispatched: false,
      reason: "fetch_failed",
      path: MULTI,
    })
  })
})
