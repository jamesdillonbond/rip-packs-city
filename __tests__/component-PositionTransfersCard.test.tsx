// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react"
import PositionTransfersCard from "@/components/analytics/PositionTransfersCard"

// Drives the collapsible Position-transfers analytics card: collapsed by
// default, it fetches /api/analytics/loans/position-transfers on first open,
// shows a loading line, then renders the KPI row (fmtUsd/fmtNumber/fmtPct) +
// the origin/recipient wallet tables, or a "could not load" fallback. Untested
// before; the money/number formatting on a public analytics surface is the
// regression risk.

vi.mock("@/lib/analytics/username-resolver", async (orig) => {
  const real = (await orig()) as any
  return { ...real, useResolveUsernames: () => ({ "0xaaaaaaaaaaaaaaaa": "whale" }) }
})
vi.mock("next/link", () => ({ default: ({ children, ...p }: any) => <a {...p}>{children}</a> }))

let fetchMock: ReturnType<typeof vi.fn>
const okJson = (b: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(b) } as Response)

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const summary = {
  as_of: "2026-07-20T00:00:00Z",
  totals: {
    total_transfers: 1234,
    total_principal_usd: 2_500_000,
    unique_origin_lenders: 40,
    unique_recipient_lenders: 55,
    pct_of_full_loans: 12.5,
  },
  top_origins: [{ addr: "0xaaaaaaaaaaaaaaaa", transfer_count: 10, principal_usd: 100000 }],
  top_recipients: [{ addr: "0xbbbbbbbbbbbbbbbb", transfer_count: 8, principal_usd: 90000 }],
  recent: [{ origin_addr: "0xaaaaaaaaaaaaaaaa", recipient_addr: "0xbbbbbbbbbbbbbbbb", principal_usd: 500, settled_at: "2026-07-19T00:00:00Z", status: "settled" }],
}

const toggle = (container: HTMLElement) => fireEvent.click(container.querySelector("button")!)

describe("PositionTransfersCard", () => {
  it("is collapsed by default and does not fetch until opened", () => {
    const { container } = render(<PositionTransfersCard />)
    expect(container.textContent).toContain("Position transfers")
    // panel body absent, no fetch yet
    expect(container.textContent).not.toContain("Total transfers")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("fetches on open and renders the KPI row with formatted money/numbers", async () => {
    fetchMock.mockReturnValue(okJson(summary))
    const { container } = render(<PositionTransfersCard />)
    toggle(container)
    await waitFor(() => expect(container.textContent).toContain("Total transfers"))
    expect(fetchMock).toHaveBeenCalledWith("/api/analytics/loans/position-transfers")
    // $2.50M principal, 12.50% of full loans, the resolved handle in a table
    expect(container.textContent).toContain("$2.50M")
    expect(container.textContent).toContain("12.50%")
    // the origin wallet's address resolved to a handle via the mocked resolver
    expect(container.textContent).toContain("whale")
  })

  it("caches — a second open does not re-fetch", async () => {
    fetchMock.mockReturnValue(okJson(summary))
    const { container } = render(<PositionTransfersCard />)
    toggle(container) // open + fetch
    await waitFor(() => expect(container.textContent).toContain("Total transfers"))
    toggle(container) // close
    toggle(container) // re-open
    await waitFor(() => expect(container.textContent).toContain("Total transfers"))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("shows the could-not-load fallback on a non-ok response", async () => {
    fetchMock.mockReturnValue(Promise.resolve({ ok: false, json: () => Promise.resolve(null) } as Response))
    const { container } = render(<PositionTransfersCard />)
    toggle(container)
    await waitFor(() => expect(container.textContent).toContain("Could not load position transfer data"))
  })

  it("shows the could-not-load fallback when the fetch rejects", async () => {
    fetchMock.mockReturnValue(Promise.reject(new Error("network")))
    const { container } = render(<PositionTransfersCard />)
    toggle(container)
    await waitFor(() => expect(container.textContent).toContain("Could not load position transfer data"))
  })
})
