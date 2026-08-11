// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent, within } from "@testing-library/react"

// PackTable — the pack boards' sortable table. Pins the Pack-audit B6 contract:
// tier sorts by RARITY RANK (common < fandom < rare < legendary < ultimate,
// with UFC tiers mapped by equivalence), never alphabetically — plus the
// null-always-last sort rule and the header-click direction toggle.

const routerState = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerState.push, prefetch: () => {} }),
}))
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}))

import PackTable, { type PackRow } from "@/components/packs/PackTable"

afterEach(() => {
  cleanup()
  routerState.push.mockReset()
})

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

describe("PackTable — follows a changed sort prop (dropdown sync)", () => {
  it("re-sorts when defaultSort/defaultDir change after mount, not just on mount", () => {
    const rows = [
      row({ title: "Ultimate Pack", tier: "ULTIMATE", evMarginPct: 0.9 }),
      row({ title: "Common Pack", tier: "COMMON", evMarginPct: 0.1 }),
    ]
    const { container, rerender } = render(
      <PackTable rows={rows} defaultSort="tier" defaultDir="asc" />,
    )
    // tier asc → Common (lowest rarity) first.
    expect(renderedTitles(container)[0]).toContain("Common")
    // Parent's Sort dropdown changes → new defaultSort/defaultDir props. Before
    // the useEffect sync this stayed tier-asc (the dropdown did nothing).
    rerender(<PackTable rows={rows} defaultSort="evMarginPct" defaultDir="desc" />)
    expect(renderedTitles(container)[0]).toContain("Ultimate") // 0.9 EV first
  })
})

// ── Availability badge (2026-08-04) ────────────────────────────────────────
// The badge previously rendered "Retired" -- copy that asserts "this pack is not
// on sale and has no live secondary listing" -- for rows where availability was
// never measured. Measured live that day: the pack_ev_latest cross-tab has NO
// (false,false) cell, so 100% of the 3,883 Retired badges were unbacked.
//
// The regression this pins is subtle: AvailabilityBadge used to branch on
// `status === 'retired'`, so introducing the 'unknown' state would silently have
// dropped the marker on exactly those 3,883 rows. It now branches on
// `historical`, and the assertions below are behavioural (rendered text), not
// source greps.
describe("PackTable — availability badge never claims a check it did not run", () => {
  it("renders 'Availability unknown', not 'Retired', when both flags are null", () => {
    const { container } = render(
      <PackTable
        rows={[row({ title: "Common Pack", primaryAvailable: null, secondaryAvailable: null })]}
        defaultSort="tier"
        defaultDir="asc"
      />,
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Availability unknown")
    expect(text).not.toContain("Retired")
  })

  it("still SHOWS a badge on an unmeasured row — it must not silently vanish", () => {
    const { container } = render(
      <PackTable
        rows={[row({ title: "Common Pack", primaryAvailable: null, secondaryAvailable: null })]}
        defaultSort="tier"
        defaultDir="asc"
      />,
    )
    // the tooltip carries the honest long form
    const badge = container.querySelector('[title*="no record"]')
    expect(badge).not.toBeNull()
  })

  it("keeps 'Retired' for a row actually measured as not buyable", () => {
    const { container } = render(
      <PackTable
        rows={[row({ title: "Common Pack", primaryAvailable: false, secondaryAvailable: false })]}
        defaultSort="tier"
        defaultDir="asc"
      />,
    )
    expect(container.textContent ?? "").toContain("Retired")
  })

  it("renders no badge for a live primary pack, and 'Secondary only' for a secondary one", () => {
    const { container: primary } = render(
      <PackTable
        rows={[row({ title: "Common Pack", primaryAvailable: true, secondaryAvailable: true })]}
        defaultSort="tier"
        defaultDir="asc"
      />,
    )
    const pText = primary.textContent ?? ""
    expect(pText).not.toContain("Availability unknown")
    expect(pText).not.toContain("Retired")

    cleanup()
    const { container: secondary } = render(
      <PackTable
        rows={[row({ title: "Common Pack", primaryAvailable: false, secondaryAvailable: true })]}
        defaultSort="tier"
        defaultDir="asc"
      />,
    )
    expect(secondary.textContent ?? "").toContain("Secondary only")
  })
})

// ── Row badges + EV cells (the dark interior columns) ───────────────────────
// The sort/null/availability suites above never populate the EV-cell chips, the
// Typical-Pull column, the coverage/depletion states, or the Action column, so
// those branches were entirely dark. Both the desktop table and the mobile card
// render in jsdom, so assertions read the whole container text (badges appear in
// both layouts) unless a layout-specific query is needed.
describe("PackTable — EV-cell badges", () => {
  it("renders the reality-adjusted badge when calibrationApplied is set", () => {
    const { container } = render(
      <PackTable rows={[row({ title: "Cal Pack", calibrationApplied: true })]} />,
    )
    expect(container.textContent).toContain("reality-adjusted")
  })

  it("renders the thin-FMV caveat when lowConfidenceEv is set", () => {
    const { container } = render(
      <PackTable rows={[row({ title: "Thin Pack", lowConfidenceEv: true })]} />,
    )
    expect(container.textContent).toContain("thin FMV")
  })

  it("renders the single-rare-edition badge when isRareSinglePack is set", () => {
    const { container } = render(
      <PackTable rows={[row({ title: "Grail Pack", isRareSinglePack: true })]} />,
    )
    expect(container.textContent).toContain("Single rare edition")
  })

  it("renders the pool-depletion chip and mutes the margin when the pool is ≥70% drained", () => {
    const { container } = render(
      <PackTable
        rows={[row({ title: "Drained Pack", evMarginPct: 12, poolDepletionPct: 0.95, editionCount: 100 })]}
      />,
    )
    // depletionChip: surviving = round(100 * (1 - 0.95)) = 5.
    expect(container.textContent).toContain("5/100 remain")
    // marginClass mutes a positive margin under heavy depletion -> not emerald.
    const marginCell = container.querySelector("tbody td.font-semibold")
    expect(marginCell?.className).not.toContain("emerald")
  })

  it("shows the Typical Pull value and the lottery grail-premium chip when the gap is large", () => {
    const { container } = render(
      <PackTable
        rows={[row({ title: "Lottery Pack", grossEV: 100, typicalEv: 20, grailPremium: 80 })]}
      />,
    )
    // grailPremium 80 >= 0.5 AND >= 0.15*100 -> lottery chip renders with the value.
    expect(container.textContent).toContain("🎰 +$80.00")
    expect(container.textContent).toContain("$20.00") // typical pull
  })

  it("renders an em-dash in the Typical Pull column when typicalEv is null", () => {
    const { container } = render(
      <PackTable rows={[row({ title: "No Typical Pack", typicalEv: null })]} />,
    )
    // The Typical Pull column is the 6th cell in the desktop row.
    const cells = container.querySelectorAll("tbody tr td")
    expect((cells[5].textContent ?? "").trim()).toContain("—")
  })

  it("renders an em-dash coverage chip when fmvCoverage is null", () => {
    const { container } = render(
      <PackTable rows={[row({ title: "No Cov Pack", fmvCoverage: null as never })]} />,
    )
    // FMV Coverage is the 8th desktop cell — the chip shows an em-dash, not 0%.
    const cells = container.querySelectorAll("tbody tr td")
    expect((cells[7].textContent ?? "")).toContain("—")
  })

  it("uses the pack-type label for the Slots cell when slots is null/0", () => {
    const { container } = render(
      <PackTable rows={[row({ title: "Bundle Pack", slots: null as never, packType: "bundle" })]} />,
    )
    expect(container.textContent).toContain("Bundle")
  })
})

describe("PackTable — Action column", () => {
  it("renders an Analyze button and fires onAction when clicked", () => {
    const onAction = vi.fn()
    const { getAllByText } = render(
      <PackTable rows={[row({ title: "Act Pack", onAction, actionLabel: "Inspect" })]} />,
    )
    const btns = getAllByText("Inspect")
    fireEvent.click(btns[0])
    expect(onAction).toHaveBeenCalled()
  })

  it("renders a Buy link when a buyUrl is present (and no onAction)", () => {
    const { container } = render(
      <PackTable rows={[row({ title: "Buy Pack", buyUrl: "https://market/buy" })]} />,
    )
    const buy = Array.from(container.querySelectorAll("a")).find(
      (a) => a.getAttribute("href") === "https://market/buy",
    )
    expect(buy).toBeTruthy()
    expect(buy?.textContent).toContain("Buy")
  })

  it("renders a Simulate link when only simulatorHref is present", () => {
    const { container } = render(
      <PackTable rows={[row({ title: "Sim Pack", simulatorHref: "/nba-top-shot/packs/simulator/1" })]} />,
    )
    const sim = Array.from(container.querySelectorAll("a")).find(
      (a) => a.getAttribute("href") === "/nba-top-shot/packs/simulator/1",
    )
    expect(sim).toBeTruthy()
    expect(sim?.textContent).toContain("Simulate")
  })

  it("renders an em-dash Action cell when there is no action, buy, or simulator target", () => {
    const { container } = render(<PackTable rows={[row({ title: "Inert Pack" })]} />)
    const cells = container.querySelectorAll("tbody tr td")
    // Action is the last (10th) desktop cell.
    expect((cells[9].textContent ?? "").trim()).toBe("—")
  })
})

describe("PackTable — row navigation + header sort", () => {
  it("navigates to detailHref on a row click away from a link/button", () => {
    const { container } = render(
      <PackTable rows={[row({ title: "Nav Pack", detailHref: "/nba-top-shot/pack/dist/1" })]} />,
    )
    // Click the Slots cell (3rd cell) — not inside an <a> or <button>.
    const cells = container.querySelectorAll("tbody tr td")
    fireEvent.click(cells[2])
    expect(routerState.push).toHaveBeenCalledWith("/nba-top-shot/pack/dist/1")
  })

  it("does NOT navigate when the click lands on a link inside the row", () => {
    const { container } = render(
      <PackTable rows={[row({ title: "Guard Pack", detailHref: "/nba-top-shot/pack/dist/2" })]} />,
    )
    const titleLink = container.querySelector("tbody a") as HTMLElement
    fireEvent.click(titleLink)
    expect(routerState.push).not.toHaveBeenCalled()
  })

  it("switching to a NEW sort column sets that column's default direction", () => {
    const rows = [
      row({ title: "Low", tier: "COMMON", grossEV: 5 }),
      row({ title: "High", tier: "ULTIMATE", grossEV: 500 }),
    ]
    const { container } = render(
      <PackTable rows={rows} defaultSort="tier" defaultDir="asc" />,
    )
    // Click the (inactive) "Actual EV" table header -> sorts grossEV desc.
    // Scope to <th> — the mobile card also renders an "Actual EV" label.
    const evHeader = Array.from(container.querySelectorAll("th")).find((th) =>
      (th.textContent ?? "").includes("Actual EV"),
    ) as HTMLElement
    fireEvent.click(evHeader)
    const firstTitleCell = container.querySelector("tbody tr td")?.textContent ?? ""
    expect(firstTitleCell).toContain("High") // 500 EV first
  })
})
