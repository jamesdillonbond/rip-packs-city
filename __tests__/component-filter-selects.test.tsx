// @vitest-environment jsdom
// The shared type-to-filter controls (components/filters/*): keyboard behaviour,
// ARIA wiring, outside-press dismissal, and FilterSelect's native/searchable split.
import { describe, it, expect, afterEach } from "vitest"
import { render, screen, fireEvent, within, cleanup } from "@testing-library/react"
import { useState } from "react"
import SearchableSelect from "@/components/filters/SearchableSelect"
import MultiSelect from "@/components/filters/MultiSelect"
import FilterSelect from "@/components/filters/FilterSelect"
import Autocomplete from "@/components/filters/Autocomplete"

afterEach(cleanup)

const TEAMS = [
  "Atlanta Hawks", "Boston Celtics", "Chicago Bulls", "Denver Nuggets", "Golden State Warriors",
  "Miami Heat", "Portland Trail Blazers", "Sacramento Kings", "Utah Jazz",
]

function Single({ initial = "all", options = TEAMS }: { initial?: string; options?: string[] }) {
  const [v, setV] = useState(initial)
  return (
    <>
      <SearchableSelect label="Team" value={v} allValue="all" allLabel="All Teams" options={options} onChange={setV} />
      <output data-testid="value">{v}</output>
      <button type="button">elsewhere</button>
    </>
  )
}

function Multi({ initial = [] as string[], options = TEAMS }: { initial?: string[]; options?: string[] }) {
  const [v, setV] = useState<string[]>(initial)
  return (
    <>
      <MultiSelect label="Team" selected={v} options={options} onChange={setV} />
      <output data-testid="value">{v.join("|")}</output>
      <button type="button">elsewhere</button>
    </>
  )
}

const value = () => screen.getByTestId("value").textContent

describe("SearchableSelect", () => {
  it("wires the combobox to its listbox and tracks the active option", () => {
    render(<Single />)
    fireEvent.click(screen.getByRole("button", { name: "Team" }))
    const box = screen.getByRole("combobox", { name: "Filter Team options" })
    const list = screen.getByRole("listbox", { name: "Team" })
    expect(box.getAttribute("aria-controls")).toBe(list.id)
    // opens on the current value ("All Teams")
    expect(document.getElementById(box.getAttribute("aria-activedescendant")!)?.textContent).toContain("All Teams")
    fireEvent.keyDown(box, { key: "ArrowDown" })
    expect(document.getElementById(box.getAttribute("aria-activedescendant")!)?.textContent).toContain("Atlanta Hawks")
  })

  it("type, arrow, Enter picks — and focus goes back to the trigger", () => {
    render(<Single />)
    const trigger = screen.getByRole("button", { name: "Team" })
    fireEvent.click(trigger)
    const box = screen.getByRole("combobox")
    fireEvent.change(box, { target: { value: "kings" } })
    fireEvent.keyDown(box, { key: "Enter" })
    expect(value()).toBe("Sacramento Kings")
    expect(screen.queryByRole("listbox")).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it("ranks prefix matches first and ignores accents", () => {
    render(<Single options={["Real Madrid", "Atlético de Madrid", "Madrid Club", ...TEAMS]} />)
    fireEvent.click(screen.getByRole("button", { name: "Team" }))
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "madrid" } })
    expect(screen.getAllByRole("option").map((o) => o.textContent?.replace("✓", ""))).toEqual(["Madrid Club", "Real Madrid", "Atlético de Madrid"])
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "atletico" } })
    expect(screen.getAllByRole("option")).toHaveLength(1)
  })

  it("the All option is offered only without a query, and picking it clears the filter", () => {
    render(<Single initial="Miami Heat" />)
    const trigger = screen.getByRole("button", { name: "Team" })
    expect(trigger.textContent).toBe("Miami Heat")
    fireEvent.click(trigger)
    expect(screen.getByRole("option", { name: "Miami Heat" }).getAttribute("aria-selected")).toBe("true")
    fireEvent.click(screen.getByRole("option", { name: "All Teams" }))
    expect(value()).toBe("all")
    fireEvent.click(trigger)
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "a" } })
    expect(screen.queryByRole("option", { name: "All Teams" })).toBeNull()
  })

  it("Escape closes without picking; a press outside closes; ArrowDown on the trigger opens", () => {
    render(<Single />)
    const trigger = screen.getByRole("button", { name: "Team" })
    fireEvent.keyDown(trigger, { key: "ArrowDown" })
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" })
    expect(screen.queryByRole("listbox")).toBeNull()
    expect(value()).toBe("all")
    fireEvent.click(trigger)
    fireEvent.mouseDown(screen.getByRole("button", { name: "elsewhere" }))
    expect(screen.queryByRole("listbox")).toBeNull()
  })

  it("a highlighted option keeps its spaces in its accessible name", () => {
    render(<Single options={[...TEAMS, "Luka Dončić"]} />)
    fireEvent.click(screen.getByRole("button", { name: "Team" }))
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "doncic" } })
    // A <span> per plain run read as "LukaDončić" (the walk trims at element edges).
    expect(screen.getByRole("option", { name: "Luka Dončić" })).toBeTruthy()
    expect(screen.getByRole("option").querySelector("mark")?.textContent).toBe("Dončić")
  })

  it("says so when nothing matches, instead of an empty box", () => {
    render(<Single />)
    fireEvent.click(screen.getByRole("button", { name: "Team" }))
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "zzz" } })
    expect(screen.getByText(/No match for “zzz”/).getAttribute("role")).toBe("status")
    expect(screen.queryAllByRole("option")).toHaveLength(0)
  })
})

// 2026-10-22: the Panini product picker (106 products, 6 sports) — a pick-one
// list with no "All" row, grouped by sport like the native <optgroup>s.
describe("SearchableSelect with groups and no All row", () => {
  const SPORT: Record<string, string> = { "WC Prizm": "Soccer", "Select WC": "Soccer", "Prizm FB": "Football", "Mosaic FB": "Football", "Prizm BK": "Basketball" }
  function Grouped() {
    const [v, setV] = useState("Prizm FB")
    return (
      <>
        <SearchableSelect label="Product" value={v} options={Object.keys(SPORT)} groupOf={(o) => SPORT[o]} onChange={setV} />
        <output data-testid="value">{v}</output>
      </>
    )
  }
  it("renders one named group per sport, in order, with no All row; opens on the current pick", () => {
    render(<Grouped />)
    fireEvent.click(screen.getByRole("button", { name: "Product" }))
    const list = screen.getByRole("listbox", { name: "Product" })
    expect(within(list).getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["Soccer", "Football", "Basketball"])
    expect(within(within(list).getByRole("group", { name: "Football" })).getAllByRole("option").map((o) => o.textContent!.replace("✓", ""))).toEqual(["Prizm FB", "Mosaic FB"])
    expect(within(list).getAllByRole("option")).toHaveLength(5)
    const box = screen.getByRole("combobox")
    expect(document.getElementById(box.getAttribute("aria-activedescendant")!)?.textContent!.replace("✓", "")).toBe("Prizm FB")
  })
  it("a query matches the sport heading too, keeps group order, and the keys walk across groups", () => {
    render(<Grouped />)
    fireEvent.click(screen.getByRole("button", { name: "Product" }))
    const box = screen.getByRole("combobox")
    fireEvent.change(box, { target: { value: "football" } })
    expect(screen.getAllByRole("option").map((o) => o.textContent!.replace("✓", ""))).toEqual(["Prizm FB", "Mosaic FB"])
    fireEvent.change(box, { target: { value: "prizm" } })
    expect(screen.getAllByRole("option").map((o) => o.textContent!.replace("✓", ""))).toEqual(["WC Prizm", "Prizm FB", "Prizm BK"])
    fireEvent.keyDown(box, { key: "ArrowDown" })
    fireEvent.keyDown(box, { key: "ArrowDown" })
    fireEvent.keyDown(box, { key: "Enter" })
    expect(value()).toBe("Prizm BK")
  })
})

describe("MultiSelect", () => {
  it("toggles with Enter and stays open; picked options are pinned first on the next open", () => {
    render(<Multi />)
    const chip = screen.getByRole("button", { name: /Team/ })
    fireEvent.click(chip)
    const box = screen.getByRole("combobox", { name: "Filter Team options" })
    expect(screen.getByRole("listbox").getAttribute("aria-multiselectable")).toBe("true")
    fireEvent.change(box, { target: { value: "utah" } })
    fireEvent.keyDown(box, { key: "Enter" })
    expect(value()).toBe("Utah Jazz")
    expect(screen.getByRole("listbox")).toBeTruthy()
    fireEvent.keyDown(box, { key: "Escape" })
    expect(document.activeElement).toBe(chip)
    fireEvent.click(chip)
    expect(screen.getAllByRole("option")[0].textContent).toContain("Utah Jazz")
    expect(screen.getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true")
  })

  it("a space inside a query is typed, not a toggle", () => {
    render(<Multi />)
    fireEvent.click(screen.getByRole("button", { name: /Team/ }))
    const box = screen.getByRole("combobox")
    fireEvent.change(box, { target: { value: "trail" } })
    fireEvent.keyDown(box, { key: " " })
    expect(value()).toBe("")
  })

  it("names the chip with its label and its current value", () => {
    render(<Multi initial={["Miami Heat"]} />)
    expect(screen.getByRole("button", { name: "Team Miami Heat ▾" })).toBeTruthy()
  })

  it("closes on a press outside — the 10-21 market chip stayed open until re-clicked", () => {
    render(<Multi />)
    fireEvent.click(screen.getByRole("button", { name: /Team/ }))
    fireEvent.mouseDown(screen.getByRole("button", { name: "elsewhere" }))
    expect(screen.queryByRole("listbox")).toBeNull()
  })

  it("a short list has no search box and takes the keys on the list itself", () => {
    render(<Multi options={["Base Set", "Metallic Gold LE"]} />)
    fireEvent.click(screen.getByRole("button", { name: /Team/ }))
    expect(screen.queryByRole("combobox")).toBeNull()
    const list = screen.getByRole("listbox")
    fireEvent.keyDown(list, { key: "ArrowDown" })
    fireEvent.keyDown(list, { key: " " })
    expect(value()).toBe("Metallic Gold LE")
  })

  it("Clear empties the selection and reports how many it clears", () => {
    render(<Multi initial={["Miami Heat", "Utah Jazz"]} />)
    fireEvent.click(screen.getByRole("button", { name: /Team/ }))
    fireEvent.click(screen.getByRole("button", { name: "Clear (2)" }))
    expect(value()).toBe("")
  })
})

describe("FilterSelect", () => {
  it("keeps the native select up to 8 options and switches to the searchable list above", () => {
    const { container, rerender } = render(<FilterSelect label="Team" value="all" allLabel="All Teams" options={TEAMS.slice(0, 8)} onChange={() => {}} />)
    expect(container.querySelector("select")).not.toBeNull()
    rerender(<FilterSelect label="Team" value="all" allLabel="All Teams" options={TEAMS} onChange={() => {}} />)
    expect(container.querySelector("select")).toBeNull()
    expect(within(container).getByRole("button", { name: "Team" })).toBeTruthy()
  })
})

function Auto({ suggestions = ["Luka Dončić", "Luka Garza", "Damian Lillard"] }: { suggestions?: string[] }) {
  const [v, setV] = useState("")
  return (
    <>
      <Autocomplete label="Search by player" value={v} onChange={setV} suggestions={suggestions} />
      <output data-testid="value">{v}</output>
    </>
  )
}

describe("Autocomplete", () => {
  it("the typed text is the filter; no list until something is typed", () => {
    render(<Auto />)
    const box = screen.getByRole("combobox", { name: "Search by player" })
    fireEvent.focus(box)
    expect(screen.queryByRole("listbox")).toBeNull()
    fireEvent.change(box, { target: { value: "luka" } })
    expect(value()).toBe("luka")
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Luka Dončić", "Luka Garza"])
  })

  it("↓ then Enter takes the suggestion; Enter with nothing active keeps the typed text", () => {
    render(<Auto />)
    const box = screen.getByRole("combobox")
    fireEvent.change(box, { target: { value: "luka" } })
    fireEvent.keyDown(box, { key: "Enter" })
    expect(value()).toBe("luka")
    fireEvent.keyDown(box, { key: "ArrowDown" })
    fireEvent.keyDown(box, { key: "ArrowDown" })
    expect(document.getElementById(box.getAttribute("aria-activedescendant")!)?.textContent).toBe("Luka Garza")
    fireEvent.keyDown(box, { key: "Enter" })
    expect(value()).toBe("Luka Garza")
    expect(screen.queryByRole("listbox")).toBeNull()
  })

  it("Escape closes the list but keeps what was typed", () => {
    render(<Auto />)
    const box = screen.getByRole("combobox")
    fireEvent.change(box, { target: { value: "dami" } })
    fireEvent.keyDown(box, { key: "Escape" })
    expect(screen.queryByRole("listbox")).toBeNull()
    expect(value()).toBe("dami")
    expect(box.getAttribute("aria-expanded")).toBe("false")
  })

  it("a suggestion identical to the text is not offered again, an accent-only difference is", () => {
    render(<Auto />)
    const box = screen.getByRole("combobox")
    fireEvent.change(box, { target: { value: "Damian Lillard" } })
    expect(screen.queryByRole("listbox")).toBeNull()
    fireEvent.change(box, { target: { value: "luka doncic" } })
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Luka Dončić"])
  })
})
