// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent, screen } from "@testing-library/react"
import FilterBar from "@/components/analytics/FilterBar"

afterEach(cleanup)

const COLLECTIONS = [
  { key: "topshot", label: "Top Shot" },
  { key: "allday", label: "All Day" },
]

function setup(overrides: Partial<React.ComponentProps<typeof FilterBar>> = {}) {
  const onCollectionsChange = vi.fn()
  const onWindowChange = vi.fn()
  const props = {
    title: "Loans",
    subtitle: "Marketplace lending",
    collections: COLLECTIONS,
    activeCollections: [] as string[],
    onCollectionsChange,
    window: "l30" as const,
    onWindowChange,
    ...overrides,
  }
  const utils = render(<FilterBar {...props} />)
  return { ...utils, onCollectionsChange, onWindowChange }
}

describe("FilterBar", () => {
  it("renders title, subtitle and the currently selected window label", () => {
    setup()
    expect(screen.getByText("Loans")).toBeTruthy()
    expect(screen.getByText("Marketplace lending")).toBeTruthy()
    // window="l30" maps to label "L30"
    expect(screen.getByText("L30")).toBeTruthy()
  })

  it("adds a collection key when an inactive chip is clicked", () => {
    const { onCollectionsChange } = setup({ activeCollections: [] })
    fireEvent.click(screen.getByText("All Day"))
    expect(onCollectionsChange).toHaveBeenCalledWith(["allday"])
  })

  it("removes a collection key when an active chip is toggled off", () => {
    const { onCollectionsChange } = setup({ activeCollections: ["topshot", "allday"] })
    fireEvent.click(screen.getByText("Top Shot"))
    expect(onCollectionsChange).toHaveBeenCalledWith(["allday"])
  })

  it("the All reset chip clears the active selection", () => {
    const { onCollectionsChange } = setup({ activeCollections: ["topshot"] })
    fireEvent.click(screen.getByText("All"))
    expect(onCollectionsChange).toHaveBeenCalledWith([])
  })

  it("opens the window dropdown and fires onWindowChange with the chosen value", () => {
    const { onWindowChange } = setup({ window: "l30" })
    // Dropdown options are not mounted until the trigger is opened.
    expect(screen.queryByText("All time")).toBeNull()
    fireEvent.click(screen.getByText("L30"))
    fireEvent.click(screen.getByText("All time"))
    expect(onWindowChange).toHaveBeenCalledWith("all")
  })

  it("closes the open window dropdown on Escape (keyboard dismissal)", () => {
    setup({ window: "l30" })
    fireEvent.click(screen.getByText("L30"))
    expect(screen.getByText("All time")).toBeTruthy() // open
    fireEvent.keyDown(document, { key: "Escape" })
    expect(screen.queryByText("All time")).toBeNull() // dismissed
  })

  it("closes the open window dropdown on an outside click", () => {
    setup({ window: "l30" })
    fireEvent.click(screen.getByText("L30"))
    expect(screen.getByText("All time")).toBeTruthy()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByText("All time")).toBeNull()
  })

  it("marks the window trigger's expanded state via aria-expanded", () => {
    setup({ window: "l30" })
    const trigger = screen.getByText("L30").closest("button") as HTMLButtonElement
    expect(trigger.getAttribute("aria-expanded")).toBe("false")
    fireEvent.click(trigger)
    expect(trigger.getAttribute("aria-expanded")).toBe("true")
  })
})
