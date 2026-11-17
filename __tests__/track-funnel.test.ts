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
import { trackFunnelEvent, getVisitorId, getFunnelContext } from "@/lib/track-funnel"

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

// ── Campaign attribution (2026-07-25) ──────────────────────────────────────
// trackFunnelEvent stamps the SESSION's resolved attribution (our own utm_*
// params + the initial EXTERNAL referrer, reduced to origin+path) onto the
// referrer column of every event, so a promoted arrival is attributable and
// STAYS attributable after the visitor navigates internally.
function setReferrer(value: string) {
  Object.defineProperty(document, "referrer", { value, configurable: true })
}

async function lastBody(): Promise<Record<string, unknown>> {
  const calls = sendBeaconMock.mock.calls
  return JSON.parse(await blobText(calls[calls.length - 1][1]))
}

describe("trackFunnelEvent campaign attribution", () => {
  it("captures utm_* params and the external referrer origin+path", async () => {
    window.history.replaceState({}, "", "/insights?utm_source=twitter&utm_medium=social&utm_campaign=squeeze")
    setReferrer("https://t.co/abc123?secret=nope#frag")

    trackFunnelEvent({ eventType: "insights_view", surface: "insights_hub" })

    const body = await lastBody()
    expect(body.referrer).toBe(
      "utm_source=twitter&utm_medium=social&utm_campaign=squeeze&ref=https://t.co/abc123"
    )
    // The referring URL's own query string is never persisted.
    expect(String(body.referrer)).not.toContain("secret")
  })

  it("reuses the landing attribution after internal navigation", async () => {
    window.history.replaceState({}, "", "/?utm_source=reddit")
    setReferrer("https://www.reddit.com/r/nbatopshot/comments/x")
    trackFunnelEvent({ eventType: "home_view", surface: "home" })

    // Visitor clicks through: the URL loses the utm and document.referrer
    // becomes our own origin. The session attribution must not degrade.
    window.history.replaceState({}, "", "/nba-top-shot/overview")
    setReferrer(`${window.location.origin}/`)
    trackFunnelEvent({
      eventType: "wallet_paste",
      surface: "collection_overview",
      walletAddress: "0xbd94cade097e50ac",
    })

    const body = await lastBody()
    expect(body.surface).toBe("collection_overview")
    expect(body.referrer).toBe("utm_source=reddit&ref=https://www.reddit.com/r/nbatopshot/comments/x")
  })

  it("drops a same-origin referrer and sends none when there is nothing to attribute", async () => {
    window.history.replaceState({}, "", "/insights")
    setReferrer(`${window.location.origin}/some/page`)

    trackFunnelEvent({ eventType: "insights_view" })

    const body = await lastBody()
    expect(body.referrer ?? null).toBeNull()
  })

  it("strips unexpected characters out of utm values", async () => {
    window.history.replaceState({}, "", "/?utm_campaign=%3Cscript%3Ealert(1)%3C/script%3E")
    setReferrer("")

    trackFunnelEvent({ eventType: "home_view" })

    const body = await lastBody()
    expect(body.referrer).toBe("utm_campaign=scriptalert1script")
  })

  it("lets an explicit caller-supplied referrer win", async () => {
    window.history.replaceState({}, "", "/?utm_source=twitter")
    setReferrer("https://t.co/abc")

    trackFunnelEvent({ eventType: "home_view", referrer: "reddit" })

    const body = await lastBody()
    expect(body.referrer).toBe("reddit")
  })
})

// ── Returning-visitor id (2026-10-03) ───────────────────────────────────────
describe("rpc_vid returning-visitor id", () => {
  beforeEach(() => {
    window.localStorage.clear()
    Object.defineProperty(navigator, "globalPrivacyControl", { value: undefined, configurable: true })
    Object.defineProperty(navigator, "doNotTrack", { value: null, configurable: true })
  })

  it("outlives the tab session: a new rpc_sess keeps the same visitorId", async () => {
    trackFunnelEvent({ eventType: "home_view" })
    const first = JSON.parse(await blobText(sendBeaconMock.mock.calls[0][1]))
    window.sessionStorage.clear() // tab closed, new visit
    trackFunnelEvent({ eventType: "home_view" })
    const second = JSON.parse(await blobText(sendBeaconMock.mock.calls[1][1]))
    expect(typeof first.visitorId).toBe("string")
    expect(second.visitorId).toBe(first.visitorId)
    expect(second.sessionId).not.toBe(first.sessionId)
  })

  it("honours Global Privacy Control: sends no visitorId and drops a stored one", async () => {
    window.localStorage.setItem("rpc_vid", "11111111-2222-3333-4444-555555555555")
    Object.defineProperty(navigator, "globalPrivacyControl", { value: true, configurable: true })
    trackFunnelEvent({ eventType: "home_view" })
    const body = JSON.parse(await blobText(sendBeaconMock.mock.calls[0][1]))
    expect(body.visitorId).toBeUndefined()
    expect(window.localStorage.getItem("rpc_vid")).toBeNull()
    expect(getVisitorId()).toBeNull()
  })

  it("honours Do Not Track the same way", () => {
    Object.defineProperty(navigator, "doNotTrack", { value: "1", configurable: true })
    expect(getVisitorId()).toBeNull()
    expect(window.localStorage.getItem("rpc_vid")).toBeNull()
  })

  it("getFunnelContext carries it for server-side writers", () => {
    const ctx = getFunnelContext()
    expect(ctx.visitorId).toBe(window.localStorage.getItem("rpc_vid"))
  })
})
