// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"

vi.mock("@/components/analytics/KpiCard", () => ({ default: () => null }))

import PulseDashboard from "@/components/analytics/PulseDashboard"

// Drives PulseDashboard's initial 3-endpoint Promise.all (24h / hourly /
// activity) and its soft-fail leg. The auto-refresh setInterval won't fire within
// this sub-second test (REFRESH_MS >> test duration), and RTL unmount clears it,
// so we assert only the mount behaviour. Activity/hourly shaping is guarded with
// ?? [] in the component; the fixtures return the safe {rows:[]} shape.
function routeFetch() {
  return vi.fn(async (url: string) => {
    const u = String(url)
    const body = u.includes("/pulse/24h") ? {} : { rows: [] }
    return { ok: true, json: async () => body } as any
  })
}

let fetchMock: ReturnType<typeof routeFetch>
beforeEach(() => {
  fetchMock = routeFetch()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("PulseDashboard", () => {
  it("fires the 24h, hourly, and activity endpoints on mount", async () => {
    render(<PulseDashboard />)
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3))
    const urls = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(urls.some((u) => u.includes("/pulse/24h"))).toBe(true)
    expect(urls.some((u) => u.includes("/pulse/hourly"))).toBe(true)
    expect(urls.some((u) => u.includes("/pulse/activity"))).toBe(true)
  })

  it("the activity fetch carries a limit=100 cap", async () => {
    render(<PulseDashboard />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const activity = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes("/pulse/activity"))!
    expect(activity).toContain("limit=100")
  })

  it("renders without crashing on empty responses and soft-fails on reject", async () => {
    expect(() => render(<PulseDashboard />)).not.toThrow()
    cleanup()
    fetchMock.mockRejectedValue(new Error("network"))
    expect(() => render(<PulseDashboard />)).not.toThrow()
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  })
})
