// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"
import { renderToString } from "react-dom/server"
import ClientErrorBeacon, { clientErrorPayload, dedupeKey, isNoiseError, pageSessionId } from "@/components/telemetry/ClientErrorBeacon"

// The client-error beacon (known-issues #34, go-live bar M7). The property under
// test is not "it renders" — it renders nothing — but that a thrown error in the
// page becomes exactly ONE bounded POST to /api/telemetry, that a loop of the
// same error stays ONE row, and that nothing secret-shaped (query strings) can
// ride along. Prove the watcher can see a failure: dispatch one, read the body.

afterEach(cleanup)

describe("ClientErrorBeacon", () => {
  let posts: Array<{ url: string; body: string }>
  beforeEach(() => {
    posts = []
    // jsdom has no sendBeacon → the keepalive fetch path is the one exercised.
    ;(navigator as any).sendBeacon = undefined
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      posts.push({ url: String(url), body: String(init?.body) })
      return new Response(null, { status: 204 })
    }))
  })
  afterEach(() => vi.unstubAllGlobals())

  it("renders nothing on the server (no markup, no window access)", () => {
    expect(renderToString(<ClientErrorBeacon />)).toBe("")
  })

  it("a window error becomes ONE bounded client_error beacon carrying the path, never the href", () => {
    window.history.replaceState({}, "", "/nba-top-shot/collection?wallet=SECRET-LOOKING")
    render(<ClientErrorBeacon />)
    window.dispatchEvent(new ErrorEvent("error", { message: "boom", filename: "https://x/app.js", lineno: 12, colno: 3, error: new Error("boom") }))
    expect(posts).toHaveLength(1)
    expect(posts[0].url).toBe("/api/telemetry")
    const body = JSON.parse(posts[0].body)
    expect(body.feature).toBe("client_error")
    expect(body.metadata.kind).toBe("error")
    expect(body.metadata.message).toBe("boom")
    expect(body.metadata.path).toBe("/nba-top-shot/collection")
    expect(posts[0].body).not.toContain("SECRET-LOOKING")
    expect(typeof body.metadata.width).toBe("number")
  })

  it("the SAME error thrown repeatedly is ONE row, and the per-load cap holds for distinct ones", () => {
    render(<ClientErrorBeacon />)
    for (let i = 0; i < 50; i++) {
      window.dispatchEvent(new ErrorEvent("error", { message: "loop", filename: "a.js", lineno: 1 }))
    }
    expect(posts).toHaveLength(1)
    for (let i = 0; i < 50; i++) {
      window.dispatchEvent(new ErrorEvent("error", { message: `distinct-${i}`, filename: "a.js", lineno: i }))
    }
    expect(posts.length).toBeLessThanOrEqual(6)
  })

  it("an unhandled rejection is reported with its message and kind", () => {
    render(<ClientErrorBeacon />)
    const ev = new Event("unhandledrejection") as PromiseRejectionEvent
    Object.defineProperty(ev, "reason", { value: new Error("rejected!") })
    window.dispatchEvent(ev)
    expect(posts).toHaveLength(1)
    const body = JSON.parse(posts[0].body)
    expect(body.metadata.kind).toBe("unhandledrejection")
    expect(body.metadata.message).toBe("rejected!")
  })

  it("skips the noise classes and bounds every field", () => {
    expect(isNoiseError("Script error.", undefined)).toBe(true)
    expect(isNoiseError("ResizeObserver loop completed with undelivered notifications.", "x.js")).toBe(true)
    expect(isNoiseError("TypeError: x is not a function", "x.js")).toBe(false)
    const p = clientErrorPayload({ kind: "error", message: "m".repeat(5000), stack: "s".repeat(5000), path: "/p", width: 390, ua: "u".repeat(500) })
    expect((p.metadata.message as string).length).toBe(300)
    expect((p.metadata.stack as string).length).toBe(1200)
    expect((p.metadata.ua as string).length).toBe(120)
    expect(dedupeKey("a", "b", 1)).toBe(dedupeKey("a", "b", 1))
    expect(dedupeKey("a", "b", 1)).not.toBe(dedupeKey("a", "b", 2))
  })

  it("a beacon that cannot be sent never throws into the page", () => {
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("offline") }))
    render(<ClientErrorBeacon />)
    expect(() => window.dispatchEvent(new ErrorEvent("error", { message: "x", filename: "a.js", lineno: 1 }))).not.toThrow()
  })

  // ── `sid`, the per-tab discriminator (#69) ────────────────────────────────
  // The defect this fixes was NOT a missing field — it was that a row COUNT read
  // like an INCIDENCE, because every row carried the same `'anon'` and
  // `count(distinct …)` was 1. So the property under test is that two different
  // tabs are DISTINGUISHABLE and one tab is STABLE. Asserting merely that `sid`
  // exists would pass against a hardcoded constant, which is the bug.

  it("every beacon carries a sid, and it is STABLE within a tab", () => {
    render(<ClientErrorBeacon />)
    window.dispatchEvent(new ErrorEvent("error", { message: "one", filename: "a.js", lineno: 1 }))
    window.dispatchEvent(new ErrorEvent("error", { message: "two", filename: "a.js", lineno: 2 }))
    expect(posts).toHaveLength(2)
    const sids = posts.map((p) => JSON.parse(p.body).metadata.sid)
    expect(sids[0]).toBeTruthy()
    expect(sids[0]).toBe(sids[1])
  })

  it("a DIFFERENT tab gets a DIFFERENT sid ON THE WIRE — the property that makes a count an incidence", () => {
    // Deliberately asserted on the POSTED body, not on pageSessionId()'s return:
    // a mutation that hardcodes `sid` in the payload leaves the helper correct and
    // must still fail HERE, or this test's title is a promise its assertion breaks.
    render(<ClientErrorBeacon />)
    window.dispatchEvent(new ErrorEvent("error", { message: "tab-a", filename: "a.js", lineno: 1 }))
    cleanup()
    sessionStorage.clear() // a new tab starts with empty sessionStorage
    render(<ClientErrorBeacon />)
    window.dispatchEvent(new ErrorEvent("error", { message: "tab-b", filename: "a.js", lineno: 2 }))
    expect(posts).toHaveLength(2)
    const [a, b] = posts.map((p) => JSON.parse(p.body).metadata.sid)
    expect(a).toBeTruthy()
    expect(b).toBeTruthy()
    expect(b).not.toBe(a)
  })

  it("sid survives blocked storage — it never throws, and still discriminates in-memory", () => {
    const proto = Object.getPrototypeOf(sessionStorage)
    const getSpy = vi.spyOn(proto, "getItem").mockImplementation(() => { throw new Error("blocked") })
    const setSpy = vi.spyOn(proto, "setItem").mockImplementation(() => { throw new Error("blocked") })
    try {
      expect(() => pageSessionId()).not.toThrow()
      const a = pageSessionId()
      expect(a).toBeTruthy()
      expect(pageSessionId()).toBe(a) // the in-memory fallback is stable, not a fresh id per call
      render(<ClientErrorBeacon />)
      expect(() => window.dispatchEvent(new ErrorEvent("error", { message: "blocked-storage", filename: "a.js", lineno: 9 }))).not.toThrow()
      expect(posts).toHaveLength(1)
      expect(JSON.parse(posts[0].body).metadata.sid).toBe(a)
    } finally {
      getSpy.mockRestore()
      setSpy.mockRestore()
    }
  })

  it("sid is per-TAB, never a cross-session visitor id — nothing is written to localStorage or cookies", () => {
    const before = document.cookie
    localStorage.clear()
    render(<ClientErrorBeacon />)
    window.dispatchEvent(new ErrorEvent("error", { message: "scope", filename: "a.js", lineno: 1 }))
    expect(posts).toHaveLength(1)
    expect(localStorage.length).toBe(0)
    expect(document.cookie).toBe(before)
  })
})
