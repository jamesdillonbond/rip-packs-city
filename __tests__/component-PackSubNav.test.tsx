// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"

const replace = vi.fn()
let currentParams = new URLSearchParams("")
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => currentParams,
}))

import { PackSubNav, subSectionFromParams } from "@/components/collection/PackSubNav"

beforeEach(() => {
  replace.mockClear()
  currentParams = new URLSearchParams("")
})
afterEach(() => cleanup())

describe("subSectionFromParams", () => {
  it("'packs' when ?section=packs, else 'moments' (default)", () => {
    expect(subSectionFromParams(new URLSearchParams("section=packs"))).toBe("packs")
    expect(subSectionFromParams(new URLSearchParams("section=moments"))).toBe("moments")
    expect(subSectionFromParams(new URLSearchParams(""))).toBe("moments")
    expect(subSectionFromParams(new URLSearchParams("view=table"))).toBe("moments")
  })
})

describe("PackSubNav", () => {
  it("renders the two labels (custom labels honored, e.g. Pins for Pinnacle)", () => {
    const { container } = render(<PackSubNav accent="#E03A2F" active="moments" momentsLabel="Pins" />)
    expect(container.textContent).toContain("Pins")
    expect(container.textContent).toContain("Packs")
  })

  it("clicking Packs navigates to ?section=packs", () => {
    const { getByText } = render(<PackSubNav accent="#E03A2F" active="moments" />)
    fireEvent.click(getByText("Packs"))
    expect(replace).toHaveBeenCalledWith("?section=packs", { scroll: false })
  })

  it("clicking Moments DELETES the section param (back to default), preserving other params", () => {
    currentParams = new URLSearchParams("view=table&section=packs")
    const { getByText } = render(<PackSubNav accent="#E03A2F" active="packs" />)
    fireEvent.click(getByText("Moments"))
    // section removed, view=table kept
    expect(replace).toHaveBeenCalledWith("?view=table", { scroll: false })
  })
})
