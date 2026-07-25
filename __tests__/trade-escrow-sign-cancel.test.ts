import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Pins lib/trade-escrow/sign-cancel.ts — the client-side cancel "signature"
// stub (mirror of sign-deposit.ts). It logs the template, waits ~1.5s
// (fakeWalletSign), mints a 0xstub_cancel_ tx id, then POSTs to
// /api/trade-chain/cancel-callback. Covers all three result branches: success,
// server failure (!res.ok or body.error), and fetch throwing. Fake timers drive
// past the wait; global fetch is stubbed per-test so no real request is made.

import { signAndSubmitCancel, type SignCancelArgs } from "@/lib/trade-escrow/sign-cancel"

const fetchMock = vi.fn()

const baseArgs: SignCancelArgs = {
  trade_match_id: "match-1",
  chain_trade_id: 42,
  side: "A",
  canceller_address: "0xaaaa",
  reason: "changed my mind",
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

// Drives the pending promise past the 1.5s fakeWalletSign wait, flushing timers
// and microtasks so the fetch call and its .json() resolve.
async function drive<T>(p: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(1500)
  return p
}

describe("signAndSubmitCancel — success", () => {
  it("returns ok:true with the callback state and a 0xstub_cancel_ tx id", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, state: { status: "cancelled" } }),
    })
    const res = await drive(signAndSubmitCancel(baseArgs))
    expect(res.ok).toBe(true)
    expect(res.tx_id).toMatch(/^0xstub_cancel_/)
    expect(res.state).toEqual({ status: "cancelled" })
    expect(res.error).toBeUndefined()
  })

  it("POSTs the cancel-callback with the expected payload and logs the template", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) })
    await drive(signAndSubmitCancel(baseArgs))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/trade-chain/cancel-callback")
    expect(init.method).toBe("POST")
    expect(init.credentials).toBe("include")
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({
      trade_match_id: "match-1",
      cancelled_by: "0xaaaa",
      reason: "changed my mind",
    })
    expect(body.cancel_tx_id).toMatch(/^0xstub_cancel_/)
    const logged = JSON.stringify(logSpy.mock.calls)
    expect(logged).toContain("cancel_trade.cdc")
  })
})

describe("signAndSubmitCancel — server failure branch", () => {
  it("body carries an error → ok:false with that error, tx id still returned", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: false, error: "not a party" }),
    })
    const res = await drive(signAndSubmitCancel(baseArgs))
    expect(res.ok).toBe(false)
    expect(res.error).toBe("not a party")
    expect(res.tx_id).toMatch(/^0xstub_cancel_/)
  })

  it("non-ok HTTP with no error body → ok:false with HTTP <status>", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) })
    const res = await drive(signAndSubmitCancel(baseArgs))
    expect(res.ok).toBe(false)
    expect(res.error).toBe("HTTP 503")
  })
})

describe("signAndSubmitCancel — thrown/network error branch", () => {
  it("fetch rejecting → ok:false with the Error message", async () => {
    fetchMock.mockRejectedValue(new Error("network down"))
    const res = await drive(signAndSubmitCancel(baseArgs))
    expect(res.ok).toBe(false)
    expect(res.error).toBe("network down")
    expect(res.tx_id).toMatch(/^0xstub_cancel_/)
  })

  it("a non-Error rejection is stringified", async () => {
    fetchMock.mockRejectedValue("boom")
    const res = await drive(signAndSubmitCancel(baseArgs))
    expect(res.ok).toBe(false)
    expect(res.error).toBe("boom")
  })
})
