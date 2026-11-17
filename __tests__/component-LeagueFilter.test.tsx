// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"
import LeagueFilter from "@/components/filters/LeagueFilter"

// The NBA/WNBA/All league toggle for Top Shot moment surfaces. Its behavior:
// three radio options, the active one flagged aria-checked, onChange fires ONLY
// when a different option is clicked, and visible={false} renders nothing.

afterEach(() => cleanup())

describe("LeagueFilter", () => {
  it("renders All / NBA / WNBA as a radiogroup with the active option checked", () => {
    const { getByRole, getByText } = render(<LeagueFilter value="NBA" onChange={() => {}} />)
    expect(getByRole("radiogroup")).toBeTruthy()
    for (const label of ["All", "NBA", "WNBA"]) expect(getByText(label)).toBeTruthy()
    // NBA is the checked radio.
    const nba = getByText("NBA").closest("button")!
    expect(nba.getAttribute("aria-checked")).toBe("true")
  })

  it("fires onChange with the clicked league when it differs from the current value", () => {
    const onChange = vi.fn()
    const { getByText } = render(<LeagueFilter value="all" onChange={onChange} />)
    fireEvent.click(getByText("WNBA"))
    expect(onChange).toHaveBeenCalledWith("WNBA")
  })

  it("does NOT fire onChange when the already-active option is clicked", () => {
    const onChange = vi.fn()
    const { getByText } = render(<LeagueFilter value="NBA" onChange={onChange} />)
    fireEvent.click(getByText("NBA"))
    expect(onChange).not.toHaveBeenCalled()
  })

  it("renders nothing when visible is false", () => {
    const { container } = render(<LeagueFilter value="all" onChange={() => {}} visible={false} />)
    expect(container.firstChild).toBeNull()
  })
})
