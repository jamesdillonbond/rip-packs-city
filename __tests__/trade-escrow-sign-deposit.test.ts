import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Pins lib/trade-escrow/sign-deposit.ts — the client-side deposit "signature"
// stub. It logs the resolved template/paths, waits ~2s (fakeWalletSign), mints a
// 0xstub_deposit_ tx id, then POSTs to /api/trade-chain/deposit-callback. Covers
// all three result branches: success (res.ok + no error → {ok:true,state}),
// server failure (!res.ok or body.error → {ok:false,error}), and fetch throwing
// (network error → catch → {ok:false,error}). Fake timers drive past the 2s wait;
// global fetch is stubbed per-test so no real request is made.

import { signAndSubmitDeposit, type SignDepositArgs } from "@/lib/trade-escrow/sign-deposit"

const fetchMock = vi.fn()

const baseArgs: SignDepositArgs = {
  trade_match_id: "match-1",
  chain_trade_id: 42,
  side: "A",
  depositor_address: "0xaaaa",
  collection: "topshot",
  incoming_collection: "allday",
  nft_ids: ["1", "2"],
}

let logSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.useFakeTimers()
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  logSpy.mockRestore()
})

// Drives the pending promise past the 2s fakeWalletSign wait, flushing timers
// and microtasks so the fetch call and its .json() resolve.
async function drive<T>(p: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(2000)
  return p
}

describe("signAndSubmitDeposit — success", () => {
  it("returns ok:true with the callback state and a 0xstub_deposit_ tx id", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, state: { status: "partial_a" } }),
    })
    const res = await drive(signAndSubmitDeposit(baseArgs))
    expect(res.ok).toBe(true)
    expect(res.tx_id).toMatch(/^0xstub_deposit_/)
    expect(res.state).toEqual({ status: "partial_a" })
    expect(res.error).toBeUndefined()
  })

  it("POSTs the deposit-callback with the expected payload and logs the template", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) })
    await drive(signAndSubmitDeposit(baseArgs))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/trade-chain/deposit-callback")
    expect(init.method).toBe("POST")
    expect(init.credentials).toBe("include")
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({
      trade_match_id: "match-1",
      depositor_address: "0xaaaa",
      side: "A",
    })
    expect(body.deposit_tx_id).toMatch(/^0xstub_deposit_/)
    // stub logs the chosen per-collection template
    const logged = JSON.stringify(logSpy.mock.calls)
    expect(logged).toContain("deposit_to_trade_topshot.cdc")
  })
})

describe("signAndSubmitDeposit — server failure branch", () => {
  it("body carries an error → ok:false with that error, tx id still returned", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: false, error: "trade not found" }),
    })
    const res = await drive(signAndSubmitDeposit(baseArgs))
    expect(res.ok).toBe(false)
    expect(res.error).toBe("trade not found")
    expect(res.tx_id).toMatch(/^0xstub_deposit_/)
  })

  it("non-ok HTTP with no error body → ok:false with HTTP <status>", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    })
    const res = await drive(signAndSubmitDeposit(baseArgs))
    expect(res.ok).toBe(false)
    expect(res.error).toBe("HTTP 503")
  })
})

describe("signAndSubmitDeposit — thrown/network error branch", () => {
  it("fetch rejecting → ok:false with the Error message", async () => {
    fetchMock.mockRejectedValue(new Error("network down"))
    const res = await drive(signAndSubmitDeposit(baseArgs))
    expect(res.ok).toBe(false)
    expect(res.error).toBe("network down")
    expect(res.tx_id).toMatch(/^0xstub_deposit_/)
  })

  it("a non-Error rejection is stringified", async () => {
    fetchMock.mockRejectedValue("boom")
    const res = await drive(signAndSubmitDeposit(baseArgs))
    expect(res.ok).toBe(false)
    expect(res.error).toBe("boom")
  })
})
