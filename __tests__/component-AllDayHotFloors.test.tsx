// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"

/**
 * All Day Hot Floors (2026-10-26). Absence of the false claims: a failed read never says "no sweeps";
 * collectors are never named; no FMV tier; the floor ask carries its last on-chain CHECK (never a
 * "listed" or "changed" claim), a stale check is flagged, and an edition with no open ask says "not listed".
 */

vi.mock("next/link", () => ({ default: ({ children, href, ...rest }: any) => <a href={href} {...rest}>{children}</a> }))
vi.mock("@/components/MomentMedia", () => ({ default: ({ thumbnailUrl }: any) => <span data-thumb={thumbnailUrl} /> }))

import AllDayHotFloors from "@/components/collection/AllDayHotFloors"
import type { AllDayHotEdition } from "@/lib/hot-floors/allday"

afterEach(cleanup)

const NOW = Date.parse("2026-10-27T01:00:00Z")
const E: AllDayHotEdition = {
  external_id: "3201", player_name: "Anthony Richardson", set_name: "Base", tier: "COMMON", circulation_count: 7500,
  thumbnail_url: "https://media.nflallday.com/editions/3201/media/image", sweep_buyers: 2, swept_sales: 22, swept_spend: 2.7,
  last_swept_at: "2026-10-25T00:08:04Z", floor_ask: 0.18, floor_ask_verified_at: "2026-10-26T23:15:01Z", fmv_usd: 0.1,
}

describe("AllDayHotFloors", () => {
  it("a failed read says couldn't load — never 'no sweeps'", () => {
    const c = render(<AllDayHotFloors collection="nfl-all-day" editions={[]} ok={false} days={7} newestSaleAt={null} now={NOW} />).container
    expect(c.querySelector('[data-testid="allday-hot-floors-failed"]')).not.toBeNull()
    expect(c.textContent).not.toMatch(/No sweeps/)
  })
  it("an empty ok read says no sweeps in the window", () => {
    const c = render(<AllDayHotFloors collection="nfl-all-day" editions={[]} ok days={7} newestSaleAt="2026-10-27T00:51:49Z" now={NOW} />).container
    expect(c.querySelector('[data-testid="allday-hot-floors-empty"]')?.textContent).toContain("last 7 days")
    expect(c.querySelector('[data-testid="allday-hot-floors-newest"]')).not.toBeNull()
  })
  it("rows link the edition, show average paid and the ask's last check, and name no collector or tier", () => {
    const stale = { ...E, external_id: "9", floor_ask_verified_at: "2026-10-20T00:00:00Z" }
    const bare = { ...E, external_id: "x", swept_spend: null, floor_ask: null, floor_ask_verified_at: null, last_swept_at: null, thumbnail_url: null, circulation_count: null, set_name: null, tier: null, player_name: null }
    const c = render(<AllDayHotFloors collection="nfl-all-day" editions={[E, stale, bare]} ok days={7} newestSaleAt={null} now={NOW} />).container
    expect(c.querySelector('a[href="/nfl-all-day/edition/3201"]')).not.toBeNull()
    expect(c.textContent).toContain("Base · Common · /7,500")
    const ages = c.querySelectorAll('[data-testid="allday-hot-floors-ask-age"]')
    expect(ages).toHaveLength(2)
    expect(ages[0].textContent).toBe("2h old")
    expect(ages[0].getAttribute("title")).toMatch(/last checked/)
    expect(ages[1].textContent).toMatch(/^⚠ /)
    expect(c.textContent).toContain("not listed")
    expect(c.textContent).toContain("never named")
    expect(c.textContent).not.toMatch(/\b(HIGH|MEDIUM|LOW|ASK_ONLY)\b/)
  })
})
