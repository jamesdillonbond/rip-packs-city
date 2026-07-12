// @vitest-environment jsdom
//
// lib/telemetry/track.ts — debounced client beacon. track(feature, metadata)
// coalesces same-feature firings within a 350ms window, then flushes each
// beacon to /api/telemetry via navigator.sendBeacon, falling back to
// fetch(keepalive) when sendBeacon is unavailable / returns false. All
// failures are swallowed. We drive the debounce with fake timers and stub
// navigator.sendBeacon + fetch to observe the endpoint, payload, and fallback.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { track } from "@/lib/telemetry/track"

let sendBeaconMock: ReturnType<typeof vi.fn>
let fetchMock: ReturnType<typeof vi.fn>

async function blobText(arg: unknown): Promise<string> {
  return arg instanceof Blob ? await arg.text() : String(arg)
}

beforeEach(() => {
  vi.useFakeTimers()
  sendBeaconMock = vi.fn(() => true)
  ;(navigator as unknown as { sendBeacon: unknown }).sendBeacon = sendBeaconMock
  fetchMock = vi.fn(() => Promise.resolve({} as Response))
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("track", () => {
  it("beacons {feature,metadata} to /api/telemetry after the debounce window", async () => {
    track("open_cart", { count: 2 })
    expect(sendBeaconMock).not.toHaveBeenCalled() // still debouncing

    vi.advanceTimersByTime(350)
    expect(sendBeaconMock).toHaveBeenCalledTimes(1)

    const [url, blob] = sendBeaconMock.mock.calls[0]
    expect(url).toBe("/api/telemetry")
    expect(JSON.parse(await blobText(blob))).toEqual({
      feature: "open_cart",
      metadata: { count: 2 },
    })
  })

  it("coalesces repeated firings of the same feature into one beacon (latest metadata wins)", async () => {
    track("plus", { v: 1 })
    track("plus", { v: 2 })
    track("plus", { v: 3 })

    vi.advanceTimersByTime(350)
    expect(sendBeaconMock).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(await blobText(sendBeaconMock.mock.calls[0][1]))
    expect(parsed.metadata).toEqual({ v: 3 })
  })

  it("sends distinct features as separate beacons in one flush", () => {
    track("a")
    track("b")
    vi.advanceTimersByTime(350)
    expect(sendBeaconMock).toHaveBeenCalledTimes(2)
  })

  it("falls back to fetch(keepalive) when sendBeacon returns false", async () => {
    sendBeaconMock.mockReturnValue(false)
    track("fallback_feature", { x: 1 })
    vi.advanceTimersByTime(350)

    expect(sendBeaconMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/telemetry")
    expect(init).toMatchObject({
      method: "POST",
      keepalive: true,
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    })
    expect(JSON.parse(init.body)).toEqual({ feature: "fallback_feature", metadata: { x: 1 } })
  })

  it("swallows a throwing sendBeacon (no throw, no unhandled rejection)", () => {
    sendBeaconMock.mockImplementation(() => {
      throw new Error("boom")
    })
    track("explodes")
    expect(() => vi.advanceTimersByTime(350)).not.toThrow()
  })

  it("swallows a fetch rejection on the fallback path", () => {
    sendBeaconMock.mockReturnValue(false)
    fetchMock.mockReturnValue(Promise.reject(new Error("net")))
    track("fetch_rejects")
    expect(() => vi.advanceTimersByTime(350)).not.toThrow()
  })

  it("ignores an empty feature name (no beacon scheduled)", () => {
    track("")
    vi.advanceTimersByTime(350)
    expect(sendBeaconMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("resets the debounce so nothing fires early on the trailing edge only", () => {
    track("late")
    vi.advanceTimersByTime(200)
    track("late", { updated: true }) // re-schedules, clears prior timer
    vi.advanceTimersByTime(200) // 400ms total, but only 200 since last schedule
    expect(sendBeaconMock).not.toHaveBeenCalled()
    vi.advanceTimersByTime(150)
    expect(sendBeaconMock).toHaveBeenCalledTimes(1)
  })
})
