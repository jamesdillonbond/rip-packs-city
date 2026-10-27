// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"

/**
 * Disney Pinnacle Hot Floors (2026-10-26). Absence of the false claims: a failed read never says "no sweeps";
 * collectors are never named; no FMV tier; rows link the PIN page (render_id), never a shared edition page;
 * the floor ask carries its last sweep CHECK, a stale check is flagged, and a pin with no open ask says "not listed".
 */

vi.mock("next/link", () => ({ default: ({ children, href, ...rest }: any) => <a href={href} {...rest}>{children}</a> }))

import PinnacleHotFloors from "@/components/collection/PinnacleHotFloors"
import type { PinnacleHotPin } from "@/lib/hot-floors/pinnacle"

afterEach(cleanup)

const NOW = Date.parse("2026-10-27T04:00:00Z")
const E: PinnacleHotPin = {
  external_id: "OEV2-ALIN-CRIM-S3", player_name: "Crimson Coil", set_name: "20th Century Studios • Alien Vol.2", tier: "Silver Sparkle",
  circulation_count: 204, thumbnail_url: "/api/public/pinnacle-image/OEV2-ALIN-CRIM-S3", sweep_buyers: 4, swept_sales: 26, swept_spend: 26,
  last_swept_at: "2026-10-27T00:05:20Z", floor_ask: 2, floor_ask_verified_at: "2026-10-27T02:00:00Z", fmv_usd: 1,
}

describe("PinnacleHotFloors", () => {
  it("a failed read says couldn't load — never 'no sweeps'", () => {
    const c = render(<PinnacleHotFloors editions={[]} ok={false} days={7} newestSaleAt={null} now={NOW} />).container
    expect(c.querySelector('[data-testid="pinnacle-hot-floors-failed"]')).not.toBeNull()
    expect(c.textContent).not.toMatch(/No sweeps/)
  })
  it("an empty ok read says no sweeps in the window", () => {
    const c = render(<PinnacleHotFloors editions={[]} ok days={7} newestSaleAt="2026-10-27T03:43:24Z" now={NOW} />).container
    expect(c.querySelector('[data-testid="pinnacle-hot-floors-empty"]')?.textContent).toContain("last 7 days")
    expect(c.querySelector('[data-testid="pinnacle-hot-floors-newest"]')).not.toBeNull()
  })
  it("rows link the pin page, show average paid and the ask's last check, and name no collector or tier", () => {
    const stale = { ...E, external_id: "OEV1-X", floor_ask_verified_at: "2026-10-20T00:00:00Z" }
    const bare = { ...E, external_id: "OEV1-Y", swept_spend: null, floor_ask: null, floor_ask_verified_at: null, last_swept_at: null, thumbnail_url: null, circulation_count: null, set_name: null, tier: null, player_name: null }
    const c = render(<PinnacleHotFloors editions={[E, stale, bare]} ok days={7} newestSaleAt={null} now={NOW} />).container
    expect(c.querySelector('a[href="/pinnacle/moment/OEV2-ALIN-CRIM-S3"]')).not.toBeNull()
    expect(c.querySelector('a[href*="/edition/"]')).toBeNull()
    // Art comes from the pin's same-origin image route, keyed by render_id.
    expect(c.querySelector('img[src="/api/public/pinnacle-image/OEV2-ALIN-CRIM-S3"]')).not.toBeNull()
    expect(c.textContent).toContain("20th Century Studios • Alien Vol.2 · Silver Sparkle · /204")
    const ages = c.querySelectorAll('[data-testid="pinnacle-hot-floors-ask-age"]')
    expect(ages).toHaveLength(2)
    expect(ages[0].textContent).toBe("2h old")
    expect(ages[0].getAttribute("title")).toMatch(/last checked/)
    expect(ages[1].textContent).toMatch(/^⚠ /)
    expect(c.textContent).toContain("not listed")
    expect(c.textContent).toContain("never named")
    expect(c.textContent).not.toMatch(/\b(HIGH|MEDIUM|LOW|ASK_ONLY)\b/)
    expect(c.textContent).not.toMatch(/Quick Buy/)
  })
})
