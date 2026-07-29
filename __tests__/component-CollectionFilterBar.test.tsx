// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"
import CollectionFilterBar from "@/components/collection/CollectionFilterBar"

// Drives the wallet-collection filter bar (pure, dispatch-driven): each control
// dispatches SET with the right field/value, the "all" option relabelling, and
// the league filter's Top-Shot-only visibility.

vi.mock("@/components/filters/LeagueFilter", () => ({
  default: ({ visible }: { visible: boolean }) =>
    visible ? <div data-testid="league-filter" /> : null,
}))

afterEach(() => cleanup())

const view = {
  playerFilter: "all",
  setFilter: "all",
  seriesFilter: "all",
  rarityFilter: "all",
  lockedFilter: "all",
  searchWithin: "",
  leagueFilter: "all",
} as any

function renderBar(collectionSlug = "nba-top-shot") {
  const dispatchView = vi.fn()
  const utils = render(
    <CollectionFilterBar
      view={view}
      dispatchView={dispatchView}
      availablePlayers={["all", "Damian Lillard"]}
      availableSets={["all", "Base Set"]}
      availableSeries={["all", "Series 4"]}
      availableRarities={["all", "LEGENDARY"]}
      collectionSlug={collectionSlug}
    />,
  )
  return { ...utils, dispatchView }
}

describe("CollectionFilterBar", () => {
  it("relabels the 'all' option per control and lists the real options", () => {
    const { getByText } = renderBar()
    expect(getByText("All Players")).toBeTruthy()
    expect(getByText("All Sets")).toBeTruthy()
    expect(getByText("All Series")).toBeTruthy()
    expect(getByText("All Rarities")).toBeTruthy()
    expect(getByText("Damian Lillard")).toBeTruthy()
  })

  it("each select dispatches SET with its own field", () => {
    const { getByDisplayValue, dispatchView, getByText } = renderBar()
    // player select currently shows "All Players" (value "all")
    fireEvent.change(getByText("All Players").closest("select")!, { target: { value: "Damian Lillard" } })
    expect(dispatchView).toHaveBeenCalledWith({ type: "SET", field: "playerFilter", value: "Damian Lillard" })

    fireEvent.change(getByText("Locked").closest("select")!, { target: { value: "locked" } })
    expect(dispatchView).toHaveBeenCalledWith({ type: "SET", field: "lockedFilter", value: "locked" })
  })

  it("the search input dispatches searchWithin", () => {
    const { getByPlaceholderText, dispatchView } = renderBar()
    fireEvent.change(getByPlaceholderText("Filter moments…"), { target: { value: "lebron" } })
    expect(dispatchView).toHaveBeenCalledWith({ type: "SET", field: "searchWithin", value: "lebron" })
  })

  it("shows the league filter only for Top Shot", () => {
    expect(renderBar("nba-top-shot").queryByTestId("league-filter")).toBeTruthy()
    cleanup()
    expect(renderBar("nfl-all-day").queryByTestId("league-filter")).toBeNull()
  })
})
