// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"

// ─────────────────────────────────────────────────────────────────────────────
// The shareable trophy-case page.
//
// This URL is meant to be pasted into a Discord or a DM, so the failure mode
// that matters is the one this repo keeps paying for: a transient read failure
// rendering as a claim about the collector. Here that claim would be "this
// person has no trophies" on the page they just shared to show off their
// trophies.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("next/link", () => ({ default: ({ children, ...p }: any) => <a {...p}>{children}</a> }))
vi.mock("@/components/RpcLogo", () => ({ default: () => <div /> }))
vi.mock("@/components/profile/ShareProfileButtons", () => ({
  default: ({ trophyCount, surface }: { trophyCount?: number; surface?: string }) => (
    <div data-testid="share-buttons" data-count={String(trophyCount)} data-surface={String(surface)} />
  ),
}))
vi.mock("@/components/TrophySlab", () => ({
  default: ({ slab }: any) => <div data-testid="slab">{slab?.player_name ?? "slab"}</div>,
}))

import TrophyCaseShareClient from "@/app/profile/[username]/trophy-case/TrophyCaseShareClient"

const trophy = (id: string, player: string) => ({ moment_id: id, player_name: player })

const base = {
  username: "trevor",
  displayName: "Trevor",
  accentColor: null,
  trophies: [] as Array<Record<string, unknown>>,
  readFailed: false,
}

afterEach(cleanup)

describe("TrophyCaseShareClient", () => {
  it("renders the pinned Moments", () => {
    render(
      <TrophyCaseShareClient
        {...base}
        trophies={[trophy("m1", "Damian Lillard"), trophy("m2", "Anfernee Simons")]}
      />,
    )
    expect(screen.getAllByTestId("slab")).toHaveLength(2)
    expect(screen.getByText("Damian Lillard")).toBeTruthy()
  })

  it("says WE could not load it when the read failed", () => {
    const { container } = render(<TrophyCaseShareClient {...base} readFailed />)
    expect(container.textContent).toMatch(/Couldn’t load this trophy case/i)
    expect(container.textContent).not.toMatch(/No trophies pinned yet/i)
  })

  it("still says NO TROPHIES for a genuinely empty case", () => {
    // The mirror. Over-correcting would make every new collector's page look
    // broken instead of new.
    const { container } = render(<TrophyCaseShareClient {...base} />)
    expect(container.textContent).toMatch(/No trophies pinned yet/i)
    expect(container.textContent).not.toMatch(/Couldn’t load/i)
  })

  it("caps at six slots even if handed more", () => {
    render(
      <TrophyCaseShareClient
        {...base}
        trophies={Array.from({ length: 9 }, (_, i) => trophy(`m${i}`, `P${i}`))}
      />,
    )
    expect(screen.getAllByTestId("slab")).toHaveLength(6)
  })

  it("drops rows with no moment_id rather than rendering an empty slab", () => {
    render(<TrophyCaseShareClient {...base} trophies={[trophy("m1", "Dame"), { slot: 2 }]} />)
    expect(screen.getAllByTestId("slab")).toHaveLength(1)
  })

  it("tells the share buttons how many trophies are up", () => {
    // So the tweet can claim a full case only when it is one.
    render(<TrophyCaseShareClient {...base} trophies={[trophy("m1", "A"), trophy("m2", "B")]} />)
    expect(screen.getByTestId("share-buttons").getAttribute("data-count")).toBe("2")
  })

  it("shares ITSELF — the trophy-case surface, not the profile (2026-09-02 QA #3)", () => {
    render(<TrophyCaseShareClient {...base} trophies={[trophy("m1", "A")]} />)
    expect(screen.getByTestId("share-buttons").getAttribute("data-surface")).toBe("trophy-case")
  })

  it("does not claim a trophy count when the read failed", () => {
    render(<TrophyCaseShareClient {...base} readFailed />)
    expect(screen.getByTestId("share-buttons").getAttribute("data-count")).toBe("0")
    // and nothing on the page states a number
    expect(screen.queryByText(/\b0 trophy/i)).toBeNull()
  })

  it("links back to the full profile", () => {
    const { container } = render(<TrophyCaseShareClient {...base} />)
    const hrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"))
    expect(hrefs).toContain("/profile/trevor")
  })

  it("URL-encodes the handle in its links", () => {
    const { container } = render(<TrophyCaseShareClient {...base} username="a b" />)
    const hrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"))
    expect(hrefs.some((h) => h?.includes("a%20b"))).toBe(true)
  })
})
