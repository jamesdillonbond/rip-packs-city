// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"
import CollectionSortBar from "@/components/collection/CollectionSortBar"

// Drives the wallet-collection sort/toggle row (pure): sort buttons call
// toggleSort(key) + show the active ↑/↓, the quick-filter toggles dispatch SET
// with the negated flag, and the CSV / debug buttons appear only when gated on.

afterEach(() => cleanup())

const view = {
  sortKey: "fmv",
  sortDirection: "desc",
  filterBadges: false,
  filterHasOffer: false,
  filterListed: false,
  filterLoanDefaultsOnly: false,
} as any

function renderBar(over: Partial<React.ComponentProps<typeof CollectionSortBar>> = {}) {
  const toggleSort = vi.fn()
  const dispatchView = vi.fn()
  const onExportCsv = vi.fn()
  const onToggleShowDebug = vi.fn()
  const onCopySeeds = vi.fn()
  const utils = render(
    <CollectionSortBar
      view={view}
      dispatchView={dispatchView}
      toggleSort={toggleSort}
      showLoanDefaultsToggle={false}
      showCsvButtons={false}
      onExportCsv={onExportCsv}
      fullCsvHref="/csv"
      debugMode={false}
      showDebug={false}
      onToggleShowDebug={onToggleShowDebug}
      onCopySeeds={onCopySeeds}
      {...over}
    />,
  )
  return { ...utils, toggleSort, dispatchView, onExportCsv }
}

describe("CollectionSortBar", () => {
  it("marks the active sort key with a direction arrow", () => {
    const { getByText } = renderBar()
    // fmv is active/desc → its button carries the ↓
    expect(getByText("FMV").textContent).toContain("↓")
  })

  it("a sort button calls toggleSort with its key", () => {
    const { getByText, toggleSort } = renderBar()
    fireEvent.click(getByText("Player"))
    expect(toggleSort).toHaveBeenCalledWith("player")
  })

  it("a quick-filter toggle dispatches SET with the negated flag", () => {
    const { getByText, dispatchView } = renderBar()
    fireEvent.click(getByText("🏷 BADGES"))
    expect(dispatchView).toHaveBeenCalledWith({ type: "SET", field: "filterBadges", value: true })
    fireEvent.click(getByText("💰 HAS OFFER"))
    expect(dispatchView).toHaveBeenCalledWith({ type: "SET", field: "filterHasOffer", value: true })
  })

  it("hides CSV + loan-defaults + debug controls unless gated on", () => {
    const { queryByText } = renderBar()
    expect(queryByText("Export CSV")).toBeNull()
    expect(queryByText("⚖ LOAN DEFAULTS")).toBeNull()
    expect(queryByText("Debug")).toBeNull()
  })

  it("shows CSV export and debug controls when enabled, and Export CSV fires its callback", () => {
    const { getByText, onExportCsv } = renderBar({ showCsvButtons: true, debugMode: true, showLoanDefaultsToggle: true })
    expect(getByText("⚖ LOAN DEFAULTS")).toBeTruthy()
    expect(getByText("Debug")).toBeTruthy()
    fireEvent.click(getByText("Export CSV"))
    expect(onExportCsv).toHaveBeenCalled()
  })
})
