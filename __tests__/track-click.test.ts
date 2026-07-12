// @vitest-environment jsdom
//
// lib/track-click.ts — fire-and-forget outbound-click logger. trackOutboundClick
// posts {sessionId, ...payload} to /api/track-click, preferring navigator.
// sendBeacon and falling back to fetch(keepalive) only when sendBeacon is
// missing / returns false. A stable-per-tab sessionId is minted into
// sessionStorage ("rpc_sess"). All failures are swallowed. We stub sendBeacon +
// fetch and assert endpoint, payload shape, the fallback branch, and no-throw.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { trackOutboundClick } from "@/lib/track-click"

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

describe("trackOutboundClick", () => {
  it("beacons the payload (+ sessionId) to /api/track-click and does not fall back", async () => {
    trackOutboundClick({ surface: "sniper", destination: "flowty", askPrice: 12 })

    expect(sendBeaconMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()

    const [url, blob] = sendBeaconMock.mock.calls[0]
    expect(url).toBe("/api/track-click")
    const body = JSON.parse(await blobText(blob))
    expect(body).toMatchObject({ surface: "sniper", destination: "flowty", askPrice: 12 })
    expect(typeof body.sessionId).toBe("string")
    expect(body.sessionId.length).toBeGreaterThan(0)
  })

  it("reuses the same sessionId across calls (stored in sessionStorage)", async () => {
    trackOutboundClick({ surface: "a" })
    trackOutboundClick({ surface: "b" })
    const first = JSON.parse(await blobText(sendBeaconMock.mock.calls[0][1])).sessionId
    const second = JSON.parse(await blobText(sendBeaconMock.mock.calls[1][1])).sessionId
    expect(first).toBe(second)
    expect(window.sessionStorage.getItem("rpc_sess")).toBe(first)
  })

  it("falls back to fetch(keepalive) when sendBeacon returns false", async () => {
    sendBeaconMock.mockReturnValue(false)
    trackOutboundClick({ surface: "moment", momentId: 42 })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/track-click")
    expect(init).toMatchObject({ method: "POST", keepalive: true })
    const body = JSON.parse(init.body)
    expect(body).toMatchObject({ surface: "moment", momentId: 42 })
    expect(body.sessionId).toBeDefined()
  })

  it("uses fetch when sendBeacon is entirely unavailable", () => {
    ;(navigator as unknown as { sendBeacon: unknown }).sendBeacon = undefined
    trackOutboundClick({ surface: "x" })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("swallows a throwing sendBeacon (never breaks the click handler)", () => {
    sendBeaconMock.mockImplementation(() => {
      throw new Error("boom")
    })
    expect(() => trackOutboundClick({ surface: "y" })).not.toThrow()
  })

  it("swallows a rejected fallback fetch", () => {
    sendBeaconMock.mockReturnValue(false)
    fetchMock.mockReturnValue(Promise.reject(new Error("net")))
    expect(() => trackOutboundClick({ surface: "z" })).not.toThrow()
  })
})
