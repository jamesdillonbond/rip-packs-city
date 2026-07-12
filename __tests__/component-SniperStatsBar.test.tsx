// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import SniperStatsBar from "@/components/sniper/SniperStatsBar"

// SniperStatsBar shows a deal-summary row. The interesting behavior is the
// collection-conditional visibility: badge count is hidden for Pinnacle/AllDay
// (and when zero); special-serial count is hidden for AllDay (and when zero);
// owned-editions caption hidden for AllDay (and when zero); the updated-at
// stamp only renders when lastRefreshed is set.

afterEach(cleanup)

function stats(overrides: Partial<{ total: number; hot: number; badge: number; special: number; avgDiscount: number }> = {}) {
  return { total: 10, hot: 3, badge: 4, special: 2, avgDiscount: 22.5, ...overrides }
}

describe("SniperStatsBar", () => {
  it("shows deals, hot, badged, special and avg-off for a Top Shot bar", () => {
    const { container } = render(
      <SniperStatsBar stats={stats()} isPinnacle={false} isAllDay={false} ownedCount={7} lastRefreshed={null} />
    )
    const txt = container.textContent!
    expect(txt).toContain("10")
    expect(txt).toContain("deals")
    expect(txt).toContain("hot (40%+)")
    expect(txt).toContain("badged")
    expect(txt).toContain("special serials")
    expect(txt).toContain("22.5%")
    expect(txt).toContain("7 owned editions tracked")
  })

  it("hides badged + special-serial + owned for an AllDay bar", () => {
    const { container } = render(
      <SniperStatsBar stats={stats()} isPinnacle={false} isAllDay={true} ownedCount={7} lastRefreshed={null} />
    )
    const txt = container.textContent!
    expect(txt).not.toContain("badged")
    expect(txt).not.toContain("special serials")
    expect(txt).not.toContain("owned editions tracked")
  })

  it("hides only the badged stat for Pinnacle (special serials still shown)", () => {
    const { container } = render(
      <SniperStatsBar stats={stats()} isPinnacle={true} isAllDay={false} ownedCount={0} lastRefreshed={null} />
    )
    const txt = container.textContent!
    expect(txt).not.toContain("badged")
    expect(txt).toContain("special serials")
  })

  it("suppresses zero-valued badge/special counts even on Top Shot", () => {
    const { container } = render(
      <SniperStatsBar stats={stats({ badge: 0, special: 0 })} isPinnacle={false} isAllDay={false} ownedCount={0} lastRefreshed={null} />
    )
    const txt = container.textContent!
    expect(txt).not.toContain("badged")
    expect(txt).not.toContain("special serials")
  })

  it("renders the updated-at stamp only when lastRefreshed is present", () => {
    const off = render(
      <SniperStatsBar stats={stats()} isPinnacle={false} isAllDay={false} ownedCount={0} lastRefreshed={null} />
    )
    expect(off.container.textContent).not.toContain("updated")
    cleanup()
    const on = render(
      <SniperStatsBar stats={stats()} isPinnacle={false} isAllDay={false} ownedCount={0} lastRefreshed={"2026-07-12T10:00:00Z"} />
    )
    expect(on.container.textContent).toContain("updated")
  })
})
