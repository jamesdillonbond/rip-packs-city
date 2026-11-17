// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
}))

import ParallelTierSwitcher from "@/components/entity/ParallelTierSwitcher"

afterEach(cleanup)

interface Sib {
  external_id: string
  subedition_id: number | null
  subedition_name: string | null
  circulation_count: number | null
  thumbnail_url: string | null
  fmv_usd: number | null
  confidence: string | null
  is_self: boolean
}
function sib(o: Partial<Sib> = {}): Sib {
  return {
    external_id: "e1", subedition_id: null, subedition_name: null,
    circulation_count: null, thumbnail_url: null, fmv_usd: null,
    confidence: null, is_self: false, ...o,
  }
}

describe("ParallelTierSwitcher", () => {
  it("renders nothing for a single-printing edition (< 2 siblings)", () => {
    const { container } = render(<ParallelTierSwitcher collection="nba-top-shot" siblings={[sib()]} />)
    expect(container.firstChild).toBeNull()
  })

  it("renders the Standard printing as a non-navigating active pill and links the others", () => {
    const siblings = [
      sib({ external_id: "std", subedition_name: null, is_self: true, circulation_count: 15000 }),
      sib({ external_id: "hex", subedition_name: "Hexwave", is_self: false, circulation_count: 500 }),
    ]
    const { container } = render(<ParallelTierSwitcher collection="nba-top-shot" siblings={siblings} />)
    // Active (self) pill is not a link; the sibling is a prefetched Link.
    const active = container.querySelector('[aria-current="true"]')!
    expect(active.textContent).toContain("Standard")
    const links = container.querySelectorAll("a")
    expect(links).toHaveLength(1)
    expect(links[0].getAttribute("href")).toContain("/nba-top-shot/edition/hex")
    expect(links[0].textContent).toContain("Hexwave")
  })

  it("shows a premium multiplier chip only for printings >= 1.3x Standard FMV", () => {
    const siblings = [
      sib({ external_id: "std", subedition_name: null, fmv_usd: 100, is_self: true }),
      sib({ external_id: "big", subedition_name: "Hexwave", fmv_usd: 250, is_self: false }),   // 2.5x → chip
      sib({ external_id: "small", subedition_name: "Jukebox", fmv_usd: 110, is_self: false }), // 1.1x → no chip
    ]
    const { container } = render(<ParallelTierSwitcher collection="nba-top-shot" siblings={siblings} />)
    const txt = container.textContent!
    expect(txt).toContain("2.5×")
    expect(txt).not.toContain("1.1×")
    // Because at least one premium >= 1.3, the compare-all footer link appears.
    expect(txt).toContain("compare all parallel premiums")
  })

  it("omits the compare-premiums footer when no printing crosses the 1.3x threshold", () => {
    const siblings = [
      sib({ external_id: "std", subedition_name: null, fmv_usd: 100, is_self: true }),
      sib({ external_id: "near", subedition_name: "Jukebox", fmv_usd: 105, is_self: false }),
    ]
    const { container } = render(<ParallelTierSwitcher collection="nba-top-shot" siblings={siblings} />)
    expect(container.textContent).not.toContain("compare all parallel premiums")
  })

  it("rounds a large multiplier to a whole number with a thousands separator", () => {
    const siblings = [
      sib({ external_id: "std", subedition_name: null, fmv_usd: 1, is_self: true }),
      sib({ external_id: "huge", subedition_name: "Hexwave", fmv_usd: 1200, is_self: false }),
    ]
    const { container } = render(<ParallelTierSwitcher collection="nba-top-shot" siblings={siblings} />)
    expect(container.textContent).toContain("1,200×")
  })
})
