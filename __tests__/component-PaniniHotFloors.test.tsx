// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"

/**
 * Panini Hot Floors (2026-10-25). Absence of the false claims: a failed read never says "no sweep"; an
 * empty ok read says none is ON RECORD (never that none happened); the sales lag is always stated; buyers
 * are never named; no FMV tier.
 */

vi.mock("next/link", () => ({ default: ({ children, href, ...rest }: any) => <a href={href} {...rest}>{children}</a> }))
vi.mock("@/components/MomentMedia", () => ({ default: ({ thumbnailUrl }: any) => <span data-thumb={thumbnailUrl} /> }))

import PaniniHotFloors from "@/components/collection/PaniniHotFloors"
import type { PaniniHotEdition } from "@/lib/hot-floors/panini"

afterEach(cleanup)

const E: PaniniHotEdition = {
  external_id: "packcard-1579_289869_7231775_137", player_name: "Tom Brady", set_name: "BC 2021 Mosaic- Base",
  parallel: "BC 2021 Mosaic- Base", mint_cap: 1999, tier: "COMMON", thumbnail_url: "pack/183/thumbnail/x.png",
  sweep_buyers: 2, swept_sales: 16, swept_spend: 327, last_swept_at: "2026-10-20T01:45:01Z", floor_ask: 24, fmv_usd: 20,
}

describe("PaniniHotFloors", () => {
  it("a failed read says couldn't load — never 'no sweep'", () => {
    const c = render(<PaniniHotFloors collection="panini-blockchain" editions={[]} ok={false} days={7} newestSaleAt={null} />).container
    expect(c.querySelector('[data-testid="panini-hot-floors-failed"]')).not.toBeNull()
    expect(c.textContent).not.toMatch(/No sweep/)
  })
  it("an empty ok read says none is on record, and the lag is stated", () => {
    const c = render(<PaniniHotFloors collection="panini-blockchain" editions={[]} ok days={7} newestSaleAt="2026-10-26T01:29:01Z" />).container
    expect(c.querySelector('[data-testid="panini-hot-floors-empty"]')?.textContent).toContain("on record for the last 7 days")
    expect(c.querySelector('[data-testid="panini-hot-floors-lag"]')?.textContent).toContain("not complete")
  })
  it("rows link the edition, show the average paid, and name no buyer", () => {
    const c = render(<PaniniHotFloors collection="panini-blockchain" editions={[E, { ...E, external_id: "x", swept_spend: null, floor_ask: null, last_swept_at: null, thumbnail_url: null, mint_cap: null, parallel: null, set_name: null, player_name: null }]} ok days={7} newestSaleAt={null} />).container
    expect(c.querySelector(`a[href="/panini-blockchain/edition/${E.external_id}"]`)).not.toBeNull()
    expect(c.textContent).toContain("$20.44")
    expect(c.textContent).toContain("not listed")
    expect(c.textContent).toContain("never named")
    expect(c.textContent).not.toMatch(/\b(HIGH|MEDIUM|LOW|ASK_ONLY)\b/)
  })
})
