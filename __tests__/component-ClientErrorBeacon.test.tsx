// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"
import { renderToString } from "react-dom/server"
import ClientErrorBeacon, { clientErrorPayload, dedupeKey, isNoiseError } from "@/components/telemetry/ClientErrorBeacon"

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
})
