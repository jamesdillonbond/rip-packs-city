// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
}))

import TeamSqueeze, { SqueezeRow } from "@/components/entity/TeamSqueeze"

afterEach(cleanup)

function row(o: Partial<SqueezeRow> = {}): SqueezeRow {
  return {
    route_slug: "8:1234", player_name: "Damian Lillard", set_name: "Base Set",
    team_name: null, play_type: null, tier: "COMMON",
    squeeze_pct: 42, lock_pct: 20, burn_pct: 5,
    effectively_buyable: 300, circulation: 1000, low_ask: 25, fmv_usd: 30,
    thumbnail_url: null, ...o,
  }
}

describe("TeamSqueeze", () => {
  it("renders nothing when there are no rows (self-hides for non-Top-Shot)", () => {
    expect(render(<TeamSqueeze collectionUrlSlug="nba-top-shot" rows={[]} />).container.firstChild).toBeNull()
  })

  it("renders one linked row per squeeze entry with rounded squeeze %", () => {
    const { container } = render(
      <TeamSqueeze collectionUrlSlug="nba-top-shot" rows={[row({ squeeze_pct: 42.7 })]} />
    )
    const link = container.querySelector("a")!
    expect(link.getAttribute("href")).toContain("/nba-top-shot/edition/8%3A1234")
    const txt = container.textContent!
    expect(txt).toContain("43%") // toFixed(0)
    expect(txt).toContain("Damian Lillard")
    expect(txt).toContain("300")
    expect(txt).toContain("1,000")
  })

  it("uses the team+play subject for team moments (null player_name)", () => {
    const { container } = render(
      <TeamSqueeze collectionUrlSlug="nba-top-shot" rows={[
        row({ player_name: null, team_name: "Chicago Bulls", play_type: "Reel" }),
      ]} />
    )
    expect(container.textContent).toContain("Chicago Bulls Reel")
  })

  it("shows an em-dash ask when low_ask is null or zero", () => {
    const { container } = render(
      <TeamSqueeze collectionUrlSlug="nba-top-shot" rows={[row({ low_ask: 0 })]} />
    )
    // "ask —" appears when low_ask is not a positive number.
    expect(container.textContent).toContain("ask —")
  })
})
