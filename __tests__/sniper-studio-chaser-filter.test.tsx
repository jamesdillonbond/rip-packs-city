// @vitest-environment jsdom
// 2026-09-27 — the Sniper's Studio dropdown and Chasers-only toggle (Disney
// Pinnacle deals carry `studio` and `isChaser`). Data-driven: the controls show
// only when the board has something to choose between, so a sports board never
// renders them — no per-collection branch.
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"
import SniperFilterBar from "@/components/sniper/SniperFilterBar"
import { filterSniperDeals, sniperStudioOptions, sniperHasChasers, countHiddenByVerifiedGate } from "@/lib/sniper/helpers"
import type { SniperDeal } from "@/lib/sniper/types"

afterEach(() => cleanup())

const deal = (over: Partial<SniperDeal> = {}) =>
  ({ playerName: "x", setName: "s", teamName: "t", discount: 10, ...over }) as SniperDeal

describe("sniperStudioOptions / sniperHasChasers / filterSniperDeals({ studio, chaserOnly })", () => {
  it("options are the board's distinct studios, sorted, without Unknown; a sports board has none", () => {
    expect(sniperStudioOptions([deal({ studio: "Pixar Animation Studios" }), deal({ studio: "Disney" }), deal({ studio: "Disney" }), deal({ studio: "Unknown" }), deal()]))
      .toEqual(["Disney", "Pixar Animation Studios"])
    expect(sniperStudioOptions([deal(), deal()])).toEqual([])
  })
  it("a selected studio that left the board stays listed", () => {
    expect(sniperStudioOptions([deal({ studio: "Disney" })], "Lucasfilm Ltd.")).toEqual(["Disney", "Lucasfilm Ltd."])
  })
  it("studio is an exact case-insensitive match; 'all' is a no-op", () => {
    const deals = [deal({ studio: "Disney" }), deal({ studio: "Walt Disney Animation Studios" }), deal({ studio: "Pixar Animation Studios" })]
    expect(filterSniperDeals(deals, { studio: "disney" }).map((d) => d.studio)).toEqual(["Disney"])
    expect(filterSniperDeals(deals, { studio: "all" })).toHaveLength(3)
  })
  it("chaserOnly keeps only isChaser === true (undefined is NOT a chaser)", () => {
    const deals = [deal({ isChaser: true }), deal({ isChaser: false }), deal()]
    expect(filterSniperDeals(deals, { chaserOnly: true })).toHaveLength(1)
    expect(filterSniperDeals(deals, { chaserOnly: false })).toHaveLength(3)
    expect(sniperHasChasers(deals)).toBe(true)
    expect(sniperHasChasers([deal(), deal({ isChaser: false })])).toBe(false)
  })
  it("the Verified-gate hidden count honours the board filters (it counted other studios' rows before)", () => {
    // Unverified (LOW confidence) rows in two studios; filtering to one studio
    // must not report the other studio's rows as hidden by the gate.
    const low = (studio: string) => deal({ studio, confidence: "low" } as Partial<SniperDeal>)
    const deals = [low("Disney"), low("Disney"), low("Pixar Animation Studios")]
    const all = countHiddenByVerifiedGate(deals, { showVerifiedOnly: true })
    const one = countHiddenByVerifiedGate(deals, { showVerifiedOnly: true, studio: "Disney" })
    expect(one).toBeLessThan(all)
  })
})

function bar(opts: { studioOptions: string[]; showChaserToggle: boolean }) {
  const studios: string[] = []
  const chasers: boolean[] = []
  const r = render(
    <SniperFilterBar
      isMobile={false} isPinnacle isAllDay={false} isGolazos={false} accent="#A855F7" collectionSlug="disney-pinnacle"
      showFilters onToggleFilters={() => {}} playerInput="" onPlayerChange={() => {}}
      studioOptions={opts.studioOptions} studioFilter="all" onStudioChange={(v) => studios.push(v)}
      showChaserToggle={opts.showChaserToggle} chaserOnly={false} onChaserOnlyChange={(v) => chasers.push(v)}
      tierTab="all" tabs={["all"]} onTierChange={() => {}} minDiscount={0} onMinDiscountChange={() => {}}
      maxPrice={0} onMaxPriceChange={() => {}} search="" onSearchChange={() => {}} serialFilter="" onSerialChange={() => {}}
      sortBy={"discount" as never} sortOptions={[]} onSortChange={() => {}} badgeOnly={false} onBadgeOnlyChange={() => {}}
      showVerifiedOnly={false} onVerifiedChange={() => {}} afterFeesOnly={false} onAfterFeesChange={() => {}} ownedFilter="all" onOwnedFilterChange={() => {}} ownedCount={0}
      leagueFilter={"all" as never} onLeagueChange={() => {}} copyLinkMsg={null} onCopyLink={() => {}}
    />,
  )
  return {
    text: r.container.textContent ?? "",
    select: r.container.querySelector('select[aria-label="Studio"]') as HTMLSelectElement | null,
    box: Array.from(r.container.querySelectorAll("label")).find((l) => /CHASERS ONLY/.test(l.textContent ?? ""))?.querySelector("input") ?? null,
    studios, chasers,
  }
}

describe("SniperFilterBar — Studio + Chasers only", () => {
  it("renders both when the board has 2+ studios and a chaser, and reports changes", () => {
    const b = bar({ studioOptions: ["Disney", "Pixar Animation Studios"], showChaserToggle: true })
    expect(b.text).toMatch(/STUDIO/)
    expect(b.text).toMatch(/All Studios/)
    fireEvent.change(b.select!, { target: { value: "Disney" } })
    expect(b.studios).toEqual(["Disney"])
    fireEvent.click(b.box!)
    expect(b.chasers).toEqual([true])
  })
  it("CONTROL: hidden with fewer than 2 studios and no chasers (a sports board)", () => {
    const b = bar({ studioOptions: ["Disney"], showChaserToggle: false })
    expect(b.select).toBeNull()
    expect(b.box).toBeNull()
    expect(b.text).not.toMatch(/STUDIO|CHASERS ONLY/)
  })
})
