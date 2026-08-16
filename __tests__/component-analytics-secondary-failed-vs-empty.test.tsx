// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, waitFor, screen, fireEvent } from "@testing-library/react"

import WalletsHubOverview from "@/components/analytics/WalletsHubOverview"
import ParallelPremiumsBoardClient from "@/app/insights/parallel-premiums/ParallelPremiumsBoardClient"

// Second batch of the raw-`r.json()` conversion (ratchet 17 → 15).
//
// ⚠ THE TWO ARE NOT OF EQUAL SEVERITY, and recording that is half the value of
// this file. A raw-parse count finds CANDIDATES; it does not rank them. You have
// to read what each one renders:
//
//   • ParallelPremiumsBoardClient — a PUBLIC board that published a FALSE CLAIM.
//     Its refetch wrote rows only `if (Array.isArray(j?.rows))`, and an error
//     envelope has no `rows`, so a failed filter-change left the PREVIOUS
//     filter's rows on screen under the NEW filter's label. Every row visible is
//     real; it simply answers a question the reader did not ask, which is worse
//     than an empty state and is why the fix CLEARS rather than keeps.
//
//   • WalletsHubOverview — merely rendered nothing. Its `j.totals && j.segments`
//     shape guard did keep the error envelope out of state, so the `|| 0` sums
//     never manufactured a zero. The section just vanished. Worth fixing, not
//     urgent.
//
// Every failure fixture is a non-2xx WITH a valid JSON body, because that is the
// case the defect actually produced: the body parses, the promise resolves, and
// a `.catch` never runs.

const errorEnvelope = {
  ok: false,
  status: 503,
  json: async () => ({ error: "Service temporarily unavailable", code: "unavailable", retryable: true }),
}
const success = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("WalletsHubOverview — a failed read is not an absent section", () => {
  it("says it could not load instead of rendering nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => errorEnvelope as any))
    const { container } = render(<WalletsHubOverview />)

    await waitFor(() => expect(screen.getByText(/Couldn't load the wallet overview just now/)).toBeTruthy())
    // The regression this replaces: the component returned null and the whole
    // section disappeared from the page.
    expect(container.textContent?.trim().length ?? 0).toBeGreaterThan(0)
  })

  it("renders the real overview when the read succeeds", async () => {
    // The other direction — the failure copy must not become the permanent state.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        success({
          totals: { wallets_total: 1234, borrowers: 10, lenders: 5 },
          segments: { whale: 1, active: 2, casual: 3, dust: 4 },
        }) as any,
      ),
    )
    render(<WalletsHubOverview />)

    await waitFor(() => expect(screen.getByText("Wallets hub")).toBeTruthy())
    expect(screen.queryByText(/Couldn't load the wallet overview/)).toBeNull()
  })
})

describe("ParallelPremiumsBoardClient — a failed filter must not relabel the previous rows", () => {
  const ROW = {
    external_id: "121:4255::1",
    player_name: "Damian Lillard",
    subedition_name: "Hexwave",
    premium_mult: 3.2,
  } as any

  function renderBoard() {
    return render(
      <ParallelPremiumsBoardClient initialRows={[ROW]} initialFetchedAt="2026-08-15T00:00:00Z" />,
    )
  }

  it("clears the stale rows and says so when a filter refetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => errorEnvelope as any))
    renderBoard()

    // Server-rendered initial rows are on screen before any refetch.
    // ⚠ getAllByText, not getByText: this board renders each row TWICE — once in
    // the top-3 highlight strip and once in the table — so the singular query
    // throws "Found multiple elements" and the test fails before it reaches the
    // behaviour under test.
    expect(screen.getAllByText("Damian Lillard").length).toBeGreaterThan(0)

    // Change a filter to trigger the refetch (firstRender is skipped by design).
    // ⚠ Click the CHIP, not any element whose text mentions confidence — the
    // first version of this matched the explanatory footnote at the bottom of
    // the board, so nothing was clicked, no refetch fired, and the test failed
    // against correct code. Query by role to be sure it is the control.
    fireEvent.click(screen.getByRole("button", { name: "High-confidence only" }))

    await waitFor(() =>
      expect(screen.getByText(/Couldn't load these filters just now/)).toBeTruthy(),
    )
    // THE POINT: the previous filter's row must be gone from BOTH renders, not
    // relabelled. queryAllByText covers the highlight strip as well as the table.
    expect(screen.queryAllByText("Damian Lillard")).toHaveLength(0)
    // ...and the market claim must not be made about a filter never queried.
    expect(screen.queryByText("No parallels match these filters.")).toBeNull()
  })

  it("a genuinely empty filter result STILL says no parallels match", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => success({ rows: [], meta: {} }) as any))
    renderBoard()

    // ⚠ Click the CHIP, not any element whose text mentions confidence — the
    // first version of this matched the explanatory footnote at the bottom of
    // the board, so nothing was clicked, no refetch fired, and the test failed
    // against correct code. Query by role to be sure it is the control.
    fireEvent.click(screen.getByRole("button", { name: "High-confidence only" }))

    await waitFor(() => expect(screen.getByText("No parallels match these filters.")).toBeTruthy())
    expect(screen.queryByText(/Couldn't load these filters/)).toBeNull()
  })
})
