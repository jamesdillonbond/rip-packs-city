// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent, screen } from "@testing-library/react"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import React from "react"

// 2026-10-11 — app/error.tsx, the ROOT route boundary.
//
// Before it existed, a render error on any page outside /[collection]/** fell
// through to app/global-error.tsx, which replaces the root layout (no header,
// no mobile nav, no concierge). And no boundary RECORDED anything except
// global-error: React does not re-raise a boundary-caught error to
// window.onerror, so ClientErrorBeacon never saw those crashes.

import RootRouteError from "@/app/error"
import CollectionSegmentError from "@/app/(collections)/[collection]/error"

vi.mock("next/navigation", () => ({ useParams: () => ({ collection: "nba-top-shot" }) }))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function telemetryBodies(fetchSpy: ReturnType<typeof vi.fn>) {
  return fetchSpy.mock.calls
    .filter((c) => String(c[0]) === "/api/telemetry")
    .map((c) => JSON.parse(String((c[1] as RequestInit).body)) as { feature: string; metadata: { message: unknown; source: unknown } })
}

const ERR = () => Object.assign(new Error("boom"), { digest: "d1gest" })

describe("app/error.tsx — root route boundary", () => {
  it("exists at the root segment, so every non-collection route inherits it", () => {
    expect(existsSync(join(process.cwd(), "app", "error.tsx"))).toBe(true)
  })

  it("records the crash through the beacon, carrying the digest", () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetchSpy)
    render(<RootRouteError error={ERR()} reset={() => {}} />)
    const bodies = telemetryBodies(fetchSpy)
    expect(bodies).toHaveLength(1)
    expect(bodies[0].feature).toBe("client_error")
    expect(bodies[0].metadata).toMatchObject({ message: "boom", source: "root-route-error:d1gest" })
  })

  it("reports OUR failure, offers a retry, and makes no claim about the data or a notified human", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })))
    const reset = vi.fn()
    render(<RootRouteError error={ERR()} reset={reset} />)
    const text = document.body.textContent ?? ""
    expect(text).toContain("Couldn’t render this page")
    expect(text).not.toMatch(/no (data|results|moments)|nothing (here|found)/i)
    expect(text).not.toMatch(/been notified/i)
    fireEvent.click(screen.getByText("Reload"))
    expect(reset).toHaveBeenCalledTimes(1)
  })

  it("uses theme tokens, not hardcoded white", () => {
    const src = readFileSync(join(process.cwd(), "app", "error.tsx"), "utf8")
    expect(src).not.toMatch(/rgba\(255,\s*255,\s*255|"#fff"/)
  })
})

describe("collection segment boundary — now RECORDS what it shows", () => {
  it("posts a client_error tagged collection-segment-error", () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetchSpy)
    vi.spyOn(console, "log").mockImplementation(() => {})
    render(<CollectionSegmentError error={ERR()} reset={() => {}} />)
    expect(telemetryBodies(fetchSpy)[0]?.metadata).toMatchObject({ message: "boom", source: "collection-segment-error:d1gest" })
  })
})
