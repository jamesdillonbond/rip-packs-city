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
})
