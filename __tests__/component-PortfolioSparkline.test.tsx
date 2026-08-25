// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"
import PortfolioSparkline from "@/components/profile/PortfolioSparkline"

// Drives the 30d portfolio sparkline: the /api/profile/portfolio-history fetch,
// the points build (historical snapshots + a live "today" point from currentFmv,
// dropping non-positive), the empty state (< 2 points), the 30D-change readout +
// the onChange(pct) callback, and that a real SVG path renders with data.

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

describe("PortfolioSparkline", () => {
  it("shows the empty state and reports null change when there is < 2 points", async () => {
    fetchMock.mockReturnValueOnce(okJson({ snapshots: [] }))
    const onChange = vi.fn()
    const { getByText } = render(
      <PortfolioSparkline ownerKey="0xowner" currentFmv={1000} onChange={onChange} />,
    )
    await waitFor(() => expect(getByText(/Sparkline builds as you load wallets/)).toBeTruthy())
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(null))
  })

  it("renders the 30D change and calls onChange(pct) with one historical point + today", async () => {
    fetchMock.mockReturnValueOnce(
      okJson({ snapshots: [{ snapshot_date: "2026-04-01", total_fmv: 800, moment_count: 5, wallet_count: 1 }] }),
    )
    const onChange = vi.fn()
    const { container } = render(
      <PortfolioSparkline ownerKey="0xowner" currentFmv={1000} onChange={onChange} />,
    )
    // change = 1000 - 800 = +200 (+25.0%)
    await waitFor(() => expect(container.textContent).toContain("+25.0%"))
    expect(container.querySelector("path")).toBeTruthy() // the sparkline line renders
    // onChange fires from a useEffect keyed on [changePct, points.length]. Under CI
    // timing the "+25.0%" text can paint in the same commit where that effect is
    // scheduled-but-not-yet-flushed, so assert it via waitFor (not synchronously) —
    // this was an intermittent CI-only red while passing in isolation locally.
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(25))
  })

  it("does not fetch when ownerKey is empty", () => {
    render(<PortfolioSparkline ownerKey="" currentFmv={1000} />)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// HONESTY CANON — the ACTIONABLE sub-class. A failed read left `snapshots`
// empty, so `points` held only the synthetic live-today entry, `isEmpty` went
// true, and the card told a collector "Load any saved wallet to record today's
// data point" — work they may already have done, because OUR read failed.
//
// ⚠ The first case in this file is the genuine-empty POSITIVE CONTROL: a
// successful read with zero snapshots must STILL show that prompt. Without it,
// deleting the empty state would satisfy everything below.
//
// ⚠ Found only because `client-failure-collapses-to-empty-ratchet` was widened
// the same day: it matched the ARROW spelling of
// `.then((r) => (r.ok ? r.json() : null))` and this file used the FUNCTION
// spelling, so the site was invisible to the guard written to count it.
describe("PortfolioSparkline — a failed read is not an unloaded wallet", () => {
  it("does not tell the reader to load a wallet when the fetch 5xx'd", async () => {
    fetchMock.mockReturnValueOnce(
      Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) } as Response),
    )
    const { container } = render(<PortfolioSparkline ownerKey="0xowner" currentFmv={1000} />)
    await waitFor(() =>
      expect(container.textContent).toMatch(/Couldn.{1,8}t load your portfolio history/),
    )
    // Assert the ABSENCE of the false instruction, not just the presence of ours.
    expect(container.textContent).not.toMatch(/Load any saved wallet/)
  })

  it("does not tell the reader to load a wallet when the fetch rejected", async () => {
    fetchMock.mockReturnValueOnce(Promise.reject(new Error("network down")))
    const { container } = render(<PortfolioSparkline ownerKey="0xowner" currentFmv={1000} />)
    await waitFor(() =>
      expect(container.textContent).toMatch(/Couldn.{1,8}t load your portfolio history/),
    )
    expect(container.textContent).not.toMatch(/Load any saved wallet/)
  })

  it("still reports a null 30D change on a failed read — withholding, not zero", async () => {
    // ⚠ A FORWARD PIN, NOT A REGRESSION TEST — it passes against the pre-fix
    // component too, because `onChange(null)` was already correct on an empty
    // points list. Labelled because counting it among the two cases that
    // actually went red would overstate this suite by 50%.
    //
    // What it guards is the tempting NEXT change: the parent hero renders this
    // as its "↑ x% / 30D" badge, and routing a failed read to 0% there would be
    // the fabricated-number shape.
    fetchMock.mockReturnValueOnce(
      Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) } as Response),
    )
    const onChange = vi.fn()
    render(<PortfolioSparkline ownerKey="0xowner" currentFmv={1000} onChange={onChange} />)
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(null))
    expect(onChange).not.toHaveBeenCalledWith(0)
  })
})
