// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"

// TelemetryPageView — the root-layout beacon that fires a `page-view` on route
// change, skipping static/asset/api prefixes so the usage_events stream stays
// signal. Headless (renders null).

let pathname: string | null = "/nba-top-shot/sniper"
vi.mock("next/navigation", () => ({ usePathname: () => pathname }))

const track = vi.hoisted(() => vi.fn())
vi.mock("@/lib/telemetry/track", () => ({ track }))
const ctx = vi.hoisted(() => ({
  value: { sessionId: null as string | null, referrer: null as string | null, visitorId: null as string | null },
}))
vi.mock("@/lib/track-funnel", () => ({ getFunnelContext: () => ctx.value }))

import TelemetryPageView from "@/components/TelemetryPageView"

beforeEach(() => {
  pathname = "/nba-top-shot/sniper"
  ctx.value = { sessionId: null, referrer: null, visitorId: null }
  track.mockClear()
})
afterEach(() => cleanup())

describe("TelemetryPageView", () => {
  it("carries the returning-visitor id when one exists (absent under GPC/DNT)", () => {
    ctx.value = { sessionId: "sess-1", referrer: null, visitorId: "vid-abcdef12" }
    render(<TelemetryPageView />)
    expect(track).toHaveBeenCalledWith("page-view", { path: "/nba-top-shot/sniper", sid: "sess-1", vid: "vid-abcdef12" })
  })

  it("fires a page-view beacon with the pathname and renders nothing", () => {
    const { container } = render(<TelemetryPageView />)
    expect(container.firstChild).toBeNull()
    expect(track).toHaveBeenCalledWith("page-view", { path: "/nba-top-shot/sniper" })
  })

  it("joins the beacon to the visit: carries the funnel session id and landing attribution", () => {
    ctx.value = { sessionId: "sess-123", referrer: "utm_source=chatgpt.com", visitorId: null }
    render(<TelemetryPageView />)
    expect(track).toHaveBeenCalledWith("page-view", {
      path: "/nba-top-shot/sniper",
      sid: "sess-123",
      ref: "utm_source=chatgpt.com",
    })
  })

  it("omits sid/ref rather than sending nulls when storage is unavailable", () => {
    render(<TelemetryPageView />)
    const meta = track.mock.calls[0][1] as Record<string, unknown>
    expect(meta).toEqual({ path: "/nba-top-shot/sniper" })
    expect("sid" in meta).toBe(false)
    expect("ref" in meta).toBe(false)
  })

  it("skips asset/api prefixes", () => {
    for (const p of ["/_next/static/x.js", "/api/fmv", "/favicon.ico", "/robots.txt", "/sitemap.xml", "/icons/x.png"]) {
      pathname = p
      cleanup()
      track.mockClear()
      render(<TelemetryPageView />)
      expect(track, `should skip ${p}`).not.toHaveBeenCalled()
    }
  })
})
