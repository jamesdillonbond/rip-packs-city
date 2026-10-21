// @vitest-environment jsdom
// 2026-09-27 — the Sniper's Team / Franchise filter (Trevor: Pinnacle's Sniper
// filters by Character and Franchise, not Player and Team). ONE shared control:
// the label comes from the collection's vocabulary (lib/entity-labels), the
// options from the board itself.
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup, fireEvent, screen, within } from "@testing-library/react"
import SniperFilterBar from "@/components/sniper/SniperFilterBar"
import { filterSniperDeals, sniperClientTeamFilter, sniperTeamOptions } from "@/lib/sniper/helpers"
import type { SniperDeal } from "@/lib/sniper/types"

afterEach(() => cleanup())

const deal = (teamName: string, over: Partial<SniperDeal> = {}) =>
  ({ playerName: "x", setName: "s", teamName, discount: 10, ...over }) as SniperDeal

describe("sniperTeamOptions / filterSniperDeals({ team })", () => {
  it("options are the board's distinct teams, sorted, without the Unknown placeholder", () => {
    expect(sniperTeamOptions([deal("Star Wars"), deal("Pocahontas"), deal("Star Wars"), deal("Unknown"), deal("")])).toEqual(["Pocahontas", "Star Wars"])
  })
  it("known teams (the feed's teamOptions) are offered even with no listing on the board", () => {
    expect(sniperTeamOptions([deal("Boston Celtics")], "all", ["Portland Trail Blazers", "Boston Celtics"])).toEqual(["Boston Celtics", "Portland Trail Blazers"])
  })
  it("does not re-filter a franchise-wide server pick on its exact label; filters a stale board", () => {
    const board = [deal("LA Clippers"), deal("Los Angeles Clippers"), deal("Boston Celtics")]
    // The feed applied "LA Clippers" franchise-wide: both Clippers labels stay.
    const applied = filterSniperDeals(board.slice(0, 2), { team: sniperClientTeamFilter("LA Clippers", "LA Clippers") })
    expect(applied.map((d) => d.teamName)).toEqual(["LA Clippers", "Los Angeles Clippers"])
    // The board on screen was fetched for another pick (or none): filter it here.
    expect(sniperClientTeamFilter("LA Clippers", null)).toBe("LA Clippers")
    expect(sniperClientTeamFilter("LA Clippers", "Boston Celtics")).toBe("LA Clippers")
    expect(filterSniperDeals(board, { team: sniperClientTeamFilter("Boston Celtics", "LA Clippers") }).map((d) => d.teamName)).toEqual(["Boston Celtics"])
  })
  it("a selected team that left the board stays listed", () => {
    expect(sniperTeamOptions([deal("Pocahontas")], "Toy Story")).toEqual(["Pocahontas", "Toy Story"])
  })
  it("filters on an exact (case-insensitive) team match; 'all' is a no-op", () => {
    const deals = [deal("Star Wars"), deal("Star Wars Rebels"), deal("Pocahontas")]
    expect(filterSniperDeals(deals, { team: "star wars" }).map((d) => d.teamName)).toEqual(["Star Wars"])
    expect(filterSniperDeals(deals, { team: "all" })).toHaveLength(3)
  })
})

function bar(slug: string, teamOptions: string[]) {
  const picked: string[] = []
  const r = render(
    <SniperFilterBar
      isMobile={false} isPinnacle={slug === "disney-pinnacle"} isAllDay={false} isGolazos={false} accent="#A855F7" collectionSlug={slug}
      showFilters onToggleFilters={() => {}} playerInput="" onPlayerChange={() => {}}
      teamOptions={teamOptions} teamFilter="all" onTeamChange={(v) => picked.push(v)}
      tierTab="all" tabs={["all"]} onTierChange={() => {}} minDiscount={0} onMinDiscountChange={() => {}}
      maxPrice={0} onMaxPriceChange={() => {}} search="" onSearchChange={() => {}} serialFilter="" onSerialChange={() => {}}
      sortBy={"discount" as never} sortOptions={[]} onSortChange={() => {}} badgeOnly={false} onBadgeOnlyChange={() => {}}
      showVerifiedOnly={false} onVerifiedChange={() => {}} afterFeesOnly={false} onAfterFeesChange={() => {}} ownedFilter="all" onOwnedFilterChange={() => {}} ownedCount={0}
      leagueFilter={"all" as never} onLeagueChange={() => {}} copyLinkMsg={null} onCopyLink={() => {}}
    />,
  )
  return { text: r.container.textContent ?? "", // The team/franchise select is the labelled one that is NOT sort or ownership: every
    // <select> gained an accessible name on 2026-10-18 (axe select-name), so "the only
    // labelled select" stopped being a way to find it.
    select: r.container.querySelector('select[aria-label]:not([aria-label="Sort deals"]):not([aria-label="Filter by ownership"])') as HTMLSelectElement | null, picked }
}

describe("SniperFilterBar — Character / Franchise on Pinnacle, Player / Team elsewhere", () => {
  it("Pinnacle: CHARACTER input and a FRANCHISE dropdown", () => {
    const { text, select, picked } = bar("disney-pinnacle", ["Pocahontas", "Star Wars"])
    expect(text).toMatch(/CHARACTER/)
    expect(text).toMatch(/FRANCHISE/)
    expect(text).toMatch(/All Franchises/)
    expect(text).not.toMatch(/PLAYER|TEAM\b/)
    fireEvent.change(select!, { target: { value: "Star Wars" } })
    expect(picked).toEqual(["Star Wars"])
  })
  it("CONTROL: Top Shot keeps PLAYER and gets a TEAM dropdown", () => {
    const { text } = bar("nba-top-shot", ["Lakers", "Trail Blazers"])
    expect(text).toMatch(/PLAYER/)
    expect(text).toMatch(/TEAM/)
    expect(text).toMatch(/All Teams/)
  })
  // 2026-10-21 (Trevor): a long Team list needs a place to type — a native <select>
  // opens a scroll wheel on a phone. Above 8 options it becomes a searchable list.
  it("a long team list gets a type-to-filter box; picking a match sends it", () => {
    const teams = ["Atlanta Hawks", "Boston Celtics", "Chicago Bulls", "Denver Nuggets", "Golden State Warriors", "Miami Heat", "Portland Trail Blazers", "Seattle Storm", "Utah Jazz"]
    const { select, picked } = bar("nba-top-shot", teams)
    expect(select).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Team" }))
    const box = screen.getByRole("listbox", { name: "Team" })
    expect(within(box).getByRole("option", { name: "All Teams" })).toBeTruthy()
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter Team options" }), { target: { value: "port" } })
    expect(within(box).getAllByRole("option").map((o) => o.textContent)).toEqual(["Portland Trail Blazers"])
    fireEvent.click(within(box).getByRole("option", { name: "Portland Trail Blazers" }))
    expect(picked).toEqual(["Portland Trail Blazers"])
    expect(screen.queryByRole("listbox")).toBeNull()
  })
  it("a short list keeps the native dropdown", () => {
    expect(bar("nba-top-shot", ["Lakers", "Trail Blazers"]).select).not.toBeNull()
    expect(screen.queryByRole("searchbox")).toBeNull()
  })
  it("no dropdown when the board offers fewer than two choices", () => {
    expect(bar("disney-pinnacle", ["Star Wars"]).select).toBeNull()
  })
})

import { serialCellText } from "@/app/(collections)/[collection]/sniper/SniperClient"
describe("serialCellText — serial 0 is never printed as '#0'", () => {
  it("Top Shot floor rows say Floor; unserialised Pinnacle pins say —; real serials keep #N", () => {
    expect(serialCellText(0, "nba-top-shot")).toBe("Floor")
    expect(serialCellText(0, "disney-pinnacle")).toBe("—")
    expect(serialCellText(12, "disney-pinnacle")).toBe("#12")
    expect(serialCellText(12, "nba-top-shot")).toBe("#12")
    // 2026-10-10: an All Day listing with an unknown serial is NOT the floor
    expect(serialCellText(0, "nfl-all-day")).toBe("—")
    expect(serialCellText(0, "laliga-golazos")).toBe("—")
  })
})
