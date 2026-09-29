// @vitest-environment jsdom
// 2026-09-27 — the Sniper's Team / Franchise filter (Trevor: Pinnacle's Sniper
// filters by Character and Franchise, not Player and Team). ONE shared control:
// the label comes from the collection's vocabulary (lib/entity-labels), the
// options from the board itself.
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"
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
      showVerifiedOnly={false} onVerifiedChange={() => {}} ownedFilter="all" onOwnedFilterChange={() => {}} ownedCount={0}
      leagueFilter={"all" as never} onLeagueChange={() => {}} saveSearchMsg={null} onSaveSearch={() => {}}
    />,
  )
  return { text: r.container.textContent ?? "", select: r.container.querySelector("select[aria-label]") as HTMLSelectElement | null, picked }
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
  it("no dropdown when the board offers fewer than two choices", () => {
    expect(bar("disney-pinnacle", ["Star Wars"]).select).toBeNull()
  })
})

import { serialCellText } from "@/app/(collections)/[collection]/sniper/SniperClient"
describe("serialCellText — serial 0 is never printed as '#0'", () => {
  it("Top Shot floor rows say Floor; unserialised Pinnacle pins say —; real serials keep #N", () => {
    expect(serialCellText(0, false)).toBe("Floor")
    expect(serialCellText(0, true)).toBe("—")
    expect(serialCellText(12, true)).toBe("#12")
    expect(serialCellText(12, false)).toBe("#12")
  })
})
