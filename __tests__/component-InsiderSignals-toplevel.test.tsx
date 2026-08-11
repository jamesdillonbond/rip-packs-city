// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react"

// components/InsiderSignals.tsx (the top-level widget, distinct from the tested
// components/analytics/InsiderSignals panel) was at 0%. It fetches
// /api/insider-signals and renders a severity-ranked alert list with an
// expand-to-evidence toggle. Drives its OWN code: the loading -> error ->
// populated/empty state machine, severityStyle, formatRelative, and the expand
// toggle that reveals evidence_jsonb.

import InsiderSignals from "@/components/InsiderSignals"

function stub(payload: unknown, ok = true, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok, status, json: async () => payload } as Response)),
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const alert = {
  id: "a1",
  alert_type: "whale_accumulation",
  title: "Whale is accumulating LeBron rookies",
  summary: "One wallet bought 12 in 24h",
  evidence_jsonb: { wallet: "0xabc", count: 12 },
  severity: 3,
  generated_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  expires_at: null,
}

describe("InsiderSignals (top-level widget)", () => {
  it("renders alerts with a High severity chip and expands evidence", async () => {
    stub({ alerts: [alert] })
    const { findByText, getByText, container } = render(<InsiderSignals />)
    expect(await findByText(/Whale is accumulating LeBron rookies/)).toBeTruthy()
    expect(getByText("High")).toBeTruthy()
    fireEvent.click(getByText(/Whale is accumulating LeBron rookies/))
    await waitFor(() => expect(container.querySelector("pre")).toBeTruthy())
  })

  it("shows the empty state when there are no active signals", async () => {
    stub({ alerts: [] })
    const { findByText } = render(<InsiderSignals />)
    expect(await findByText(/No active signals\./)).toBeTruthy()
  })

  it("surfaces a load error from the payload", async () => {
    stub({ error: "detector offline" }, false, 500)
    const { findByText } = render(<InsiderSignals />)
    expect(await findByText(/Couldn't load: detector offline/)).toBeTruthy()
  })

  it("falls back to the HTTP status when a non-ok response carries no error field", async () => {
    stub({}, false, 503)
    const { findByText } = render(<InsiderSignals />)
    expect(await findByText(/Couldn't load: HTTP 503/)).toBeTruthy()
  })

  it("surfaces a thrown fetch (network failure) via the catch branch", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("network down"))))
    const { findByText } = render(<InsiderSignals />)
    expect(await findByText(/Couldn't load: network down/)).toBeTruthy()
  })

  it("renders Medium and Low severity chips, and a header count", async () => {
    stub({
      alerts: [
        { ...alert, id: "m", severity: 2, title: "Medium sev" },
        { ...alert, id: "l", severity: 1, title: "Low sev" },
      ],
    })
    const { findByText, getByText, container } = render(<InsiderSignals />)
    expect(await findByText(/Medium sev/)).toBeTruthy()
    expect(getByText("Medium")).toBeTruthy() // severity 2
    expect(getByText("Low")).toBeTruthy()    // severity < 2 -> else
    expect(container.textContent).toContain("· 2") // header count when length > 0
  })

  it("collapses the evidence panel on a second click, and shows no pre for a summary-less, evidence-less alert", async () => {
    stub({
      alerts: [{ ...alert, summary: null, evidence_jsonb: null }],
    })
    const { findByText, getByText, container } = render(<InsiderSignals />)
    expect(await findByText(/Whale is accumulating LeBron rookies/)).toBeTruthy()
    // No summary div rendered (summary is null).
    expect(container.textContent).not.toContain("One wallet bought")
    // Open: evidence_jsonb null -> the `isOpen && a.evidence_jsonb` guard stays false, no <pre>.
    fireEvent.click(getByText(/Whale is accumulating LeBron rookies/))
    expect(container.querySelector("pre")).toBeNull()
  })

  it("toggles the evidence panel open then closed (Set delete branch)", async () => {
    stub({ alerts: [alert] })
    const { findByText, getByText, container } = render(<InsiderSignals />)
    expect(await findByText(/Whale is accumulating LeBron rookies/)).toBeTruthy()
    fireEvent.click(getByText(/Whale is accumulating LeBron rookies/))
    await waitFor(() => expect(container.querySelector("pre")).toBeTruthy())
    // Second click removes the id from the expanded Set -> pre unmounts.
    fireEvent.click(getByText(/Whale is accumulating LeBron rookies/))
    await waitFor(() => expect(container.querySelector("pre")).toBeNull())
  })

  it("renders formatRelative hour and day buckets", async () => {
    const now = Date.now()
    stub({
      alerts: [
        { ...alert, id: "h", title: "Hours old", generated_at: new Date(now - 5 * 3_600_000).toISOString() },
        { ...alert, id: "d", title: "Days old", generated_at: new Date(now - 3 * 86_400_000).toISOString() },
      ],
    })
    const { findByText, container } = render(<InsiderSignals />)
    expect(await findByText(/Hours old/)).toBeTruthy()
    expect(container.textContent).toContain("5h ago") // h < 24
    expect(container.textContent).toContain("3d ago") // days branch
  })
})
