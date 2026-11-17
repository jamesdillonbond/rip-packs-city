// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import TrophySlab, { type TrophySlabData } from "@/components/TrophySlab"

// Collector report 2026-09-29 (support_conversations #10153): on the trophy
// case, edition badges (Debut, Rookie Year) drew but the special-serial ones
// (#1 / perfect mint / jersey match) were "missing entirely — the number does
// not have a different colour". The slab never computed them. These pin that a
// special serial is MARKED (gold serial + one labelled mark per reason) and —
// the half that keeps it honest — that an ordinary serial is NOT, and that a
// jersey match is never claimed without a jersey number.

vi.mock("@/lib/badges/useBadgeTaxonomy", () => ({
  useBadgeTaxonomy: () => ({}),
  lookupBadge: () => null,
}))
vi.mock("next/link", () => ({ default: ({ children, ...p }: any) => <a {...p}>{children}</a> }))
vi.mock("@/lib/ipfs-media", () => ({ proxyIpfsUrl: (u: string) => u }))

afterEach(() => cleanup())

const base: TrophySlabData = {
  id: 1, slot: 1, moment_id: "m1", edition_id: "e1",
  player_name: "Ausar Thompson", set_name: "Metallic Gold LE",
  serial_number: 5, circulation_count: 10, tier: "RARE",
  thumbnail_url: null, video_url: null, fmv: 45, fmv_confidence: "STALE",
  serial_fmv: null, badges: ["Rookie Year"], note: null,
  collection_id: "cid", collection_slug: "nba_top_shot", collection_display_name: "NBA Top Shot",
  play_description: null, team_name: "Detroit Pistons", series: 6,
  pinned_at: null, acquired_price: null, acquisition_method: null,
  jersey_number: 9,
}

const marks = (c: HTMLElement) =>
  Array.from(c.querySelectorAll("[data-special]")).map((e) => e.getAttribute("aria-label"))
const serialEl = (c: HTMLElement) => c.querySelector(".rpc-slab-label-serialnum") as HTMLElement

describe("TrophySlab special-serial marks", () => {
  it("#1 of a /10 gets a First Mint mark and a highlighted serial", () => {
    const { container } = render(<TrophySlab slab={{ ...base, serial_number: 1 }} slot={1} mode="public" />)
    expect(marks(container)).toEqual(["First Mint"])
    expect(serialEl(container).getAttribute("data-special-serial")).toBe("first")
    expect(serialEl(container).textContent).toBe("#1/10")
  })

  it("perfect mint (serial == circulation) is marked", () => {
    const { container } = render(<TrophySlab slab={{ ...base, serial_number: 10 }} slot={1} mode="public" />)
    expect(marks(container)).toEqual(["Perfect Mint"])
  })

  it("jersey match is marked from jersey_number", () => {
    const { container } = render(<TrophySlab slab={{ ...base, serial_number: 9 }} slot={1} mode="public" />)
    expect(marks(container)).toEqual(["Jersey Match"])
  })

  it("an ordinary serial carries NO mark and NO highlight", () => {
    const { container } = render(<TrophySlab slab={base} slot={1} mode="public" />)
    expect(marks(container)).toEqual([])
    expect(serialEl(container).getAttribute("data-special-serial")).toBeNull()
  })

  it("never claims a jersey match without a jersey number (null or absent)", () => {
    const noKey: TrophySlabData = { ...base }
    delete noKey.jersey_number
    for (const slab of [{ ...base, serial_number: 9, jersey_number: null }, { ...noKey, serial_number: 9 }]) {
      const { container, unmount } = render(<TrophySlab slab={slab} slot={1} mode="public" />)
      expect(marks(container)).toEqual([])
      unmount()
    }
  })

  it("edition badges still render beside the special marks", () => {
    const { container } = render(<TrophySlab slab={{ ...base, serial_number: 1 }} slot={1} mode="public" />)
    expect(container.querySelector('[title="Rookie Year"]')).not.toBeNull()
  })
})

// 2026-09-30 — Trevor: a special serial wears "its native color" (webz_80:
// "i do prefer the special serial badge being blue like it is on TS"). Values
// were sampled live from nbatopshot.com / nflallday.com; see
// specialSerialStyle in lib/badges/official-art.ts.
describe("TrophySlab special-serial colour is the platform's native one", () => {
  const bgOf = (el: Element | null) => (el as HTMLElement | null)?.style.background ?? ""
  const rgb = (hex: string) => {
    const n = parseInt(hex.slice(1), 16)
    return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
  }

  it("Top Shot: blue chip and blue marks, never gold", () => {
    const { container } = render(<TrophySlab slab={{ ...base, serial_number: 1 }} slot={1} mode="public" />)
    expect(bgOf(serialEl(container))).toBe(rgb("#2752ED"))
    expect(bgOf(container.querySelector("[data-special]"))).toBe(rgb("#2752ED"))
    expect(container.innerHTML).not.toContain(rgb("#F59E0B"))
  })

  it("All Day: dark pill with its purple ring, never gold", () => {
    const slab = { ...base, serial_number: 1, collection_slug: "nfl_all_day", collection_display_name: "NFL All Day" }
    const { container } = render(<TrophySlab slab={slab} slot={1} mode="public" />)
    const mark = container.querySelector("[data-special]") as HTMLElement
    expect(bgOf(mark)).toBe(rgb("#212127"))
    expect(mark.style.boxShadow.toUpperCase()).toContain("#7A4DE1")
    expect(container.innerHTML).not.toContain(rgb("#F59E0B"))
  })

  it("a collection with no platform special-serial badge keeps RPC gold", () => {
    const slab = { ...base, serial_number: 1, collection_slug: "laliga_golazos", collection_display_name: "LaLiga Golazos" }
    const { container } = render(<TrophySlab slab={slab} slot={1} mode="public" />)
    expect(bgOf(serialEl(container))).toBe(rgb("#F59E0B"))
  })
})
