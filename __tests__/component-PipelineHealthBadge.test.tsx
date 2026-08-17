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

  // ⚠ THE TWO CASES BELOW WERE INVERTED, NOT DELETED. They asserted that a failed
  // read "stays on the loading caption", which was a fair description of the code
  // and a defect in the product: the summary hardcoded `status: "healthy"` when
  // `data` was null, so a live ops badge that had just FAILED to read pipeline
  // status rendered a GREEN dot under a caption claiming it was still loading —
  // on /analytics, where the badge exists precisely to say when something broke.
  // "Soft-fail" is right about the render (never throw, never vanish) and wrong
  // about the claim. What survives from the originals is that the component keeps
  // rendering; what changed is what it says while it does.
  it("says the status is UNAVAILABLE — not loading, not healthy — when the fetch is not ok", async () => {
    fetchMock.mockReturnValue(mockResp(null, false))
    const { container } = render(<PipelineHealthBadge />)
    await waitFor(() => expect(container.textContent).toContain("Status unavailable"))
    expect(container.textContent).not.toContain("Loading status…")
    expect(container.textContent).not.toContain("All systems healthy")
  })

  it("says the status is UNAVAILABLE when the fetch rejects (soft-fail catch)", async () => {
    fetchMock.mockReturnValue(Promise.reject(new Error("boom")))
    const { container } = render(<PipelineHealthBadge />)
    await waitFor(() => expect(container.textContent).toContain("Status unavailable"))
    expect(container.textContent).not.toContain("Loading status…")
  })

  it("does NOT paint the dot green when it has no answer", async () => {
    // The colour is the part a reader actually takes in at a glance, and green
    // is the one thing an unmeasured status must never be. Emerald is the
    // healthy palette; asserting its absence is what makes this load-bearing.
    fetchMock.mockReturnValue(mockResp(null, false))
    const { container } = render(<PipelineHealthBadge />)
    await waitFor(() => expect(container.textContent).toContain("Status unavailable"))
    expect(container.innerHTML).not.toContain("bg-emerald-400")
    // ...and it must not pulse like an alert either — we do not know of trouble.
    expect(container.innerHTML).not.toContain("animate-ping")
  })

  it("still paints green, and never pulses, when the platform really is healthy", async () => {
    // The other direction: the fix must not turn a genuine all-clear into a
    // muted "unknown", or it cries wolf on a healthy platform.
    fetchMock.mockReturnValue(mockResp(payload("healthy", {})))
    const { container } = render(<PipelineHealthBadge />)
    await waitFor(() => expect(container.textContent).toContain("All systems healthy"))
    expect(container.innerHTML).toContain("bg-emerald-400")
    expect(container.innerHTML).not.toContain("animate-ping")
  })

  it("still pulses for real trouble", async () => {
    fetchMock.mockReturnValue(mockResp(payload("stale", { fmv: "stale" })))
    const { container } = render(<PipelineHealthBadge />)
    await waitFor(() => expect(container.textContent).toContain("1 pipeline stale"))
    expect(container.innerHTML).toContain("animate-ping")
  })

  it("the open panel distinguishes a failed read from a pending one", async () => {
    fetchMock.mockReturnValue(mockResp(null, false))
    const { container, getByRole } = render(<PipelineHealthBadge />)
    await waitFor(() => expect(container.textContent).toContain("Status unavailable"))
    fireEvent.click(getByRole("button", { name: /pipeline health/i }))
    expect(container.textContent).toContain("says nothing about the pipelines")
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
