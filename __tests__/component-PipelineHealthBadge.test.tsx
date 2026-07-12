// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"
import PipelineHealthBadge from "@/components/analytics/PipelineHealthBadge"

let fetchMock: ReturnType<typeof vi.fn>

function mockResp(body: unknown, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response)
}

function pipeline(status: string) {
  return { status, cadence: "every 20m", lag_minutes: 5, expected_max_lag_min: 30 }
}

function payload(overall: string, statuses: Record<string, string>) {
  const base = { loans: "healthy", sales: "healthy", fmv: "healthy", pack_ev: "healthy", listings: "healthy", ...statuses }
  return {
    overall_status: overall,
    as_of: new Date().toISOString(),
    pipelines: {
      loans: pipeline(base.loans),
      sales: pipeline(base.sales),
      fmv: pipeline(base.fmv),
      pack_ev: pipeline(base.pack_ev),
      listings: pipeline(base.listings),
    },
  }
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("PipelineHealthBadge", () => {
  it("shows a loading caption before data arrives", () => {
    fetchMock.mockReturnValue(new Promise(() => {})) // never resolves
    const { container } = render(<PipelineHealthBadge />)
    expect(container.textContent).toContain("Loading status…")
  })

  it("summarizes a healthy platform", async () => {
    fetchMock.mockReturnValue(mockResp(payload("healthy", {})))
    const { container } = render(<PipelineHealthBadge />)
    await waitFor(() => expect(container.textContent).toContain("All systems healthy"))
  })

  it("counts stale pipelines and pluralizes the caption", async () => {
    fetchMock.mockReturnValue(mockResp(payload("stale", { fmv: "stale", sales: "stale" })))
    const { container } = render(<PipelineHealthBadge />)
    await waitFor(() => expect(container.textContent).toContain("2 pipelines stale"))
  })

  it("uses the singular form for a single degraded pipeline", async () => {
    fetchMock.mockReturnValue(mockResp(payload("degraded", { listings: "degraded" })))
    const { container } = render(<PipelineHealthBadge />)
    await waitFor(() => expect(container.textContent).toContain("1 pipeline lagging"))
  })

  it("soft-fails to the loading caption when the fetch is not ok", async () => {
    fetchMock.mockReturnValue(mockResp(null, false))
    const { container } = render(<PipelineHealthBadge />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    // No pipelines payload set -> summary stays on the loading caption.
    expect(container.textContent).toContain("Loading status…")
  })
})
