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

import TelemetryPageView from "@/components/TelemetryPageView"

beforeEach(() => {
  pathname = "/nba-top-shot/sniper"
  track.mockClear()
})
afterEach(() => cleanup())

describe("TelemetryPageView", () => {
  it("fires a page-view beacon with the pathname and renders nothing", () => {
    const { container } = render(<TelemetryPageView />)
    expect(container.firstChild).toBeNull()
    expect(track).toHaveBeenCalledWith("page-view", { path: "/nba-top-shot/sniper" })
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
