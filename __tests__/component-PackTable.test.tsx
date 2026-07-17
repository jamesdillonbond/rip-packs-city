// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent, within } from "@testing-library/react"

// PackTable — the pack boards' sortable table. Pins the Pack-audit B6 contract:
// tier sorts by RARITY RANK (common < fandom < rare < legendary < ultimate,
// with UFC tiers mapped by equivalence), never alphabetically — plus the
// null-always-last sort rule and the header-click direction toggle.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, prefetch: () => {} }),
}))
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}))

import PackTable, { type PackRow } from "@/components/packs/PackTable"

afterEach(cleanup)

let nextId = 0
function row(o: Partial<PackRow>): PackRow {
  nextId++
  return {
    id: `pack-${nextId}`,
    title: "Pack",
    thumbnailUrl: null,
    tier: "COMMON",
    slots: 5,
    price: 10,
    grossEV: 12,
    evMarginPct: 0.2,
    fmvCoverage: 0.9,
    depletionPct: 0.5,
    ...o,
  } as PackRow
}

function renderedTitles(container: HTMLElement): string[] {
  // The title cell also carries the PackThumb's fallback INITIAL for null
  // thumbnails, so match the known pack-name word rather than raw text.
  return Array.from(container.querySelectorAll("tbody tr")).map(
    (tr) =>
      (within(tr as HTMLElement).getAllByRole("cell")[0].textContent ?? "").match(
        /(Common|Fandom|Rare|Legendary|Ultimate|Challenger|Contender|No EV|Low EV|High EV)/,
      )?.[0] ?? "",
  )
}

describe("PackTable — tier sort is rarity-ranked (audit B6)", () => {
  const rows = [
    row({ title: "Ultimate Pack", tier: "ULTIMATE" }),
    row({ title: "Fandom Pack", tier: "FANDOM" }),
    row({ title: "Legendary Pack", tier: "LEGENDARY" }),
    row({ title: "Common Pack", tier: "COMMON" }),
    row({ title: "Rare Pack", tier: "RARE" }),
  ]

  it("sorts tier asc by rarity, not alphabetically", () => {
    const { container, getByText } = render(
      <PackTable rows={rows} defaultSort="tier" defaultDir="asc" />,
    )
    void getByText
    // Alphabetical would put Common < Fandom < Legendary < Rare < Ultimate —
    // rarity rank instead puts RARE between FANDOM and LEGENDARY.
    expect(renderedTitles(container)).toEqual([
      "Common",
      "Fandom",
      "Rare",
      "Legendary",
      "Ultimate",
    ])
  })

  it("maps UFC tiers by rarity equivalence into the same ordering", () => {
    const ufcRows = [
      row({ title: "Challenger Pack", tier: "CHALLENGER" }),
      row({ title: "Contender Pack", tier: "CONTENDER" }),
      row({ title: "Fandom Pack", tier: "FANDOM" }),
    ]
    const { container } = render(<PackTable rows={ufcRows} defaultSort="tier" defaultDir="asc" />)
    // FANDOM(2) < CONTENDER(3) < CHALLENGER(5).
    expect(renderedTitles(container)).toEqual(["Fandom", "Contender", "Challenger"])
  })

  it("clicking the active sort header toggles direction", () => {
    const { container, getByText } = render(
      <PackTable rows={rows} defaultSort="tier" defaultDir="asc" />,
    )
    // Header cells are clickable <th> elements, not buttons.
    fireEvent.click(getByText("Tier"))
    expect(renderedTitles(container)[0]).toContain("Ultimate")
  })
})

describe("PackTable — null handling + empty state", () => {
  it("null sort values sink to the end regardless of direction", () => {
    const rows = [
      row({ title: "No EV Pack", grossEV: null as never, evMarginPct: null as never }),
      row({ title: "Low EV Pack", evMarginPct: 0.05 }),
      row({ title: "High EV Pack", evMarginPct: 0.4 }),
    ]
    const desc = render(<PackTable rows={rows} defaultSort="evMarginPct" defaultDir="desc" />)
    expect(renderedTitles(desc.container).at(-1)).toContain("No EV")
    cleanup()
    const asc = render(<PackTable rows={rows} defaultSort="evMarginPct" defaultDir="asc" />)
    // The asc view must NOT crowd null-EV packs to the top (the old bug).
    expect(renderedTitles(asc.container)[0]).toContain("Low EV")
    expect(renderedTitles(asc.container).at(-1)).toContain("No EV")
  })

  it("renders the empty message when there are no rows", () => {
    const { getByText } = render(<PackTable rows={[]} emptyMessage="No packs indexed yet." />)
    expect(getByText("No packs indexed yet.")).toBeTruthy()
  })
})
