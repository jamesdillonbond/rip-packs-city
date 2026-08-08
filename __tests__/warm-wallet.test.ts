import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { warmWalletDeep } from "@/lib/profile/warm-wallet"

// Unit test for the shared deep-warm dispatcher used by BOTH wallet entry
// points (the username CTA and the paste-an-address save). The invariant that
// matters is skip_cached:false — an open-door signup's cache is page-capped at
// 50 Top Shot moments by the old shallow warm, and skip_cached:true would
// leave it that way forever.

const FLOW = "0xbd94cade097e50ac"

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
    expect(res).toEqual({ dispatched: true, status: 202 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, any]
    expect(url).toBe("https://t/api/wallet-backfill-multicollection")
    expect(init.method).toBe("POST")
    expect(init.headers.Authorization).toBe("Bearer tok")
    expect(JSON.parse(init.body)).toEqual({ wallet: FLOW, skip_cached: false })
  })

  it("trims the address before dispatching", async () => {
    expect((await warmWalletDeep("https://t", "tok", `  ${FLOW}  `)).dispatched).toBe(true)
    expect(JSON.parse((fetchMock.mock.calls[0] as any)[1].body).wallet).toBe(FLOW)
  })

  it("skips non-Flow addresses without a fetch", async () => {
    for (const addr of ["0x" + "a".repeat(40), "63p1oKqkAQ9sQD55iApNRkVL2XzYtASwKjCdSSNEGEhY", "", "nonsense"]) {
      expect(await warmWalletDeep("https://t", "tok", addr)).toEqual({
        dispatched: false,
        reason: "not_flow_address",
      })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("skips (rather than 401s) when the ingest token is blank", async () => {
    expect(await warmWalletDeep("https://t", "", FLOW)).toEqual({
      dispatched: false,
      reason: "no_ingest_token",
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("reports a non-ok HTTP response without throwing", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 } as never)
    expect(await warmWalletDeep("https://t", "tok", FLOW)).toEqual({
      dispatched: false,
      reason: "http_error",
      status: 503,
    })
  })

  it("swallows a network failure — warming must never fail the caller's write", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"))
    expect(await warmWalletDeep("https://t", "tok", FLOW)).toEqual({
      dispatched: false,
      reason: "fetch_failed",
    })
  })
})
