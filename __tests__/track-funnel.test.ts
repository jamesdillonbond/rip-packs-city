// @vitest-environment jsdom
//
// lib/track-funnel.ts — fire-and-forget top-of-funnel logger. trackFunnelEvent
// posts {sessionId, ...payload} to /api/track-funnel, preferring navigator.
// sendBeacon and falling back to fetch(keepalive). It DELIBERATELY reuses the
// same "rpc_sess" sessionStorage key as track-click so a visitor's funnel
// events + outbound clicks reconcile to one session. All failures are
// swallowed. We stub sendBeacon + fetch and assert endpoint, payload, and
// no-throw across the fallback + failure branches.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { trackFunnelEvent } from "@/lib/track-funnel"

let sendBeaconMock: ReturnType<typeof vi.fn>
let fetchMock: ReturnType<typeof vi.fn>

async function blobText(arg: unknown): Promise<string> {
  return arg instanceof Blob ? await arg.text() : String(arg)
}

beforeEach(() => {
  window.sessionStorage.clear()
  sendBeaconMock = vi.fn(() => true)
  ;(navigator as unknown as { sendBeacon: unknown }).sendBeacon = sendBeaconMock
  fetchMock = vi.fn(() => Promise.resolve({} as Response))
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("trackFunnelEvent", () => {
  it("beacons the event (+ sessionId) to /api/track-funnel", async () => {
    trackFunnelEvent({ eventType: "home_view", surface: "home", referrer: "reddit" })

    expect(sendBeaconMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()

    const [url, blob] = sendBeaconMock.mock.calls[0]
    expect(url).toBe("/api/track-funnel")
    const body = JSON.parse(await blobText(blob))
    expect(body).toMatchObject({
      eventType: "home_view",
      surface: "home",
      referrer: "reddit",
    })
    expect(typeof body.sessionId).toBe("string")
  })

  it("shares the rpc_sess session id with track-click", async () => {
    trackFunnelEvent({ eventType: "wallet_paste", walletAddress: "0xbd94cade097e50ac" })
    const sid = JSON.parse(await blobText(sendBeaconMock.mock.calls[0][1])).sessionId
    expect(window.sessionStorage.getItem("rpc_sess")).toBe(sid)
  })

  it("falls back to fetch(keepalive) when sendBeacon returns false", async () => {
    sendBeaconMock.mockReturnValue(false)
    trackFunnelEvent({ eventType: "share_view", surface: "share" })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/track-funnel")
    expect(init).toMatchObject({ method: "POST", keepalive: true })
    expect(JSON.parse(init.body)).toMatchObject({ eventType: "share_view", surface: "share" })
  })

  it("uses fetch when sendBeacon is unavailable", () => {
    ;(navigator as unknown as { sendBeacon: unknown }).sendBeacon = undefined
    trackFunnelEvent({ eventType: "insights_view" })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("swallows a throwing sendBeacon (never breaks render)", () => {
    sendBeaconMock.mockImplementation(() => {
      throw new Error("boom")
    })
    expect(() => trackFunnelEvent({ eventType: "insights_card_click" })).not.toThrow()
  })

  it("swallows a rejected fallback fetch", () => {
    sendBeaconMock.mockReturnValue(false)
    fetchMock.mockReturnValue(Promise.reject(new Error("net")))
    expect(() => trackFunnelEvent({ eventType: "share_cta_click" })).not.toThrow()
  })
})
