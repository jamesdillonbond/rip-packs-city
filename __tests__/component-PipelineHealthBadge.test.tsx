// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react"
import PipelineHealthBadge from "@/components/analytics/PipelineHealthBadge"

let fetchMock: ReturnType<typeof vi.fn>

function mockResp(body: unknown, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response)
}

function pipeline(status: string, lag = 5, expected = 30) {
  return { status, cadence: "every 20m", lag_minutes: lag, expected_max_lag_min: expected }
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

  it("stays on the loading caption when the fetch rejects (soft-fail catch)", async () => {
    fetchMock.mockReturnValue(Promise.reject(new Error("boom")))
    const { container } = render(<PipelineHealthBadge />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(container.textContent).toContain("Loading status…")
  })
})

describe("PipelineHealthBadge — expandable dropdown", () => {
  it("opens on click and lists every pipeline row with its label + status", async () => {
    fetchMock.mockReturnValue(mockResp(payload("degraded", { listings: "degraded", fmv: "stale" })))
    const { container, getByRole } = render(<PipelineHealthBadge />)
    await waitFor(() => expect(container.textContent).toContain("1 pipeline lagging"))
    // Dropdown not rendered until the button is clicked.
    expect(container.textContent).not.toContain("Pipeline status")
    fireEvent.click(getByRole("button", { name: "Pipeline health" }))
    const txt = container.textContent!
    expect(txt).toContain("Pipeline status")
    // all five labels
    expect(txt).toContain("Loans")
    expect(txt).toContain("Sales")
    expect(txt).toContain("FMV")
    expect(txt).toContain("Pack EV")
    expect(txt).toContain("Listings")
    // per-row status pills (statusBadgeClass branches: healthy/degraded/stale)
    expect(txt).toContain("degraded")
    expect(txt).toContain("stale")
    expect(txt).toContain("healthy")
  })

  it("formats lag across all fmtLag bands (<1m, m, h, d, and — for non-finite)", async () => {
    const body = {
      overall_status: "degraded",
      as_of: "2026-07-01T12:00:00Z",
      pipelines: {
        loans: pipeline("healthy", 0.5, 30), // <1m -> "<1m"
        sales: pipeline("healthy", 42, 30), // -> "42m"
        fmv: pipeline("degraded", 90, 120), // 1.5h -> "1.5h"
        pack_ev: pipeline("healthy", 2880, 4320), // 48h -> "2.0d"
        listings: pipeline("healthy", Number.NaN, 30), // non-finite -> "—"
      },
    }
    fetchMock.mockReturnValue(mockResp(body))
    const { container, getByRole } = render(<PipelineHealthBadge />)
    await waitFor(() => expect(container.textContent).toContain("pipeline"))
    fireEvent.click(getByRole("button", { name: "Pipeline health" }))
    const txt = container.textContent!
    expect(txt).toContain("<1m")
    expect(txt).toContain("42m")
    expect(txt).toContain("1.5h")
    expect(txt).toContain("2.0d")
    expect(txt).toContain("—")
    // as_of timestamp is rendered in the header
    expect(txt).toMatch(/\d{1,2}:\d{2}/)
  })

  it("closes the dropdown on a click outside the wrapper", async () => {
    fetchMock.mockReturnValue(mockResp(payload("healthy", {})))
    const { container, getByRole } = render(<PipelineHealthBadge />)
    await waitFor(() => expect(container.textContent).toContain("All systems healthy"))
    fireEvent.click(getByRole("button", { name: "Pipeline health" }))
    expect(container.textContent).toContain("Pipeline status")
    fireEvent.mouseDown(document.body)
    await waitFor(() => expect(container.textContent).not.toContain("Pipeline status"))
  })

  it("renders the 'stale' plural caption and the ping animation on a non-healthy dot", async () => {
    fetchMock.mockReturnValue(mockResp(payload("stale", { fmv: "stale", sales: "stale", listings: "stale" })))
    const { container } = render(<PipelineHealthBadge />)
    await waitFor(() => expect(container.textContent).toContain("3 pipelines stale"))
    // non-healthy → the animate-ping overlay span is present
    expect(container.querySelector(".animate-ping")).not.toBeNull()
  })
})
