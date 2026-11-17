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

// The visit join keys are stamped onto every beacon; null here so the payload
// assertions below pin the coalescing/transport contract on its own. The
// stamping itself is pinned in its own describe at the end.
const visit = vi.hoisted(() => ({ ids: { sessionId: null as string | null, visitorId: null as string | null } }))
vi.mock("@/lib/track-funnel", () => ({ getVisitIds: () => visit.ids }))

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
// jsdom's navigator has no `webdriver`; define it per test and remove it after.
function setWebdriver(v: boolean) {
  Object.defineProperty(navigator, "webdriver", { value: v, configurable: true })
}
afterEach(() => {
  delete (navigator as unknown as { webdriver?: boolean }).webdriver
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

  it("marks a beacon from an automation-driven page (navigator.webdriver) so the server can tag it", async () => {
    setWebdriver(true)
    track("page-view", { path: "/insights" })
    vi.advanceTimersByTime(350)
    const [, blob] = sendBeaconMock.mock.calls[0]
    expect(JSON.parse(await blobText(blob)).metadata).toEqual({ path: "/insights", webdriver: true })
  })

  it("adds no webdriver key for an ordinary page", async () => {
    setWebdriver(false)
    track("page-view", { path: "/" })
    vi.advanceTimersByTime(350)
    const [, blob] = sendBeaconMock.mock.calls[0]
    expect(JSON.parse(await blobText(blob)).metadata).toEqual({ path: "/" })
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

describe("track — visit join keys (2026-10-03)", () => {
  afterEach(() => { visit.ids = { sessionId: null, visitorId: null } })

  it("stamps sid + vid onto every beacon so usage_events joins the visit", async () => {
    visit.ids = { sessionId: "sess-1", visitorId: "vid-1" }
    track("deal-watch-shown", { surface: "share" })
    vi.advanceTimersByTime(400)
    const [, blob] = sendBeaconMock.mock.calls[0]
    expect(JSON.parse(await blobText(blob)).metadata).toEqual({ surface: "share", sid: "sess-1", vid: "vid-1" })
  })

  it("a caller's own sid wins, and missing ids are omitted rather than sent as null", async () => {
    visit.ids = { sessionId: "sess-1", visitorId: null }
    track("x", { sid: "explicit" })
    vi.advanceTimersByTime(400)
    const [, blob] = sendBeaconMock.mock.calls[0]
    expect(JSON.parse(await blobText(blob)).metadata).toEqual({ sid: "explicit" })
  })
})
