// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"
import TrophySlab, { type TrophySlabData } from "@/components/TrophySlab"

// Drives the trophy-case slab: the loading/empty/filled state machine, the
// owner-vs-public empty affordance (owner = clickable "PIN A MOMENT", public =
// inert "EMPTY SLAB"), the filled slab's financial footer (FMV, the serial-FMV
// #1/perfect premium estimate, ACQUIRED / PACK PULL / MINTED), and the owner-only
// remove control. Prop-driven, so no fetch — the badge-taxonomy hook is stubbed
// to keep it that way; the slab-style helpers are unit-tested separately.

// Controllable badge-art map: default (empty) keeps every badge a plain dot
// (the pre-existing behavior every earlier test relied on); a test can register
// an icon_url to drive the art-backed <img> branch + the art-first sort.
const badgeState = vi.hoisted(() => ({ icons: {} as Record<string, string> }))
vi.mock("@/lib/badges/useBadgeTaxonomy", () => ({
  useBadgeTaxonomy: () => ({}),
  lookupBadge: (_tax: unknown, b: string) => {
    const url = badgeState.icons[b]
    return url ? { icon_url: url, title: b.toUpperCase() } : null
  },
}))
vi.mock("next/link", () => ({ default: ({ children, ...p }: any) => <a {...p}>{children}</a> }))
vi.mock("@/lib/ipfs-media", () => ({ proxyIpfsUrl: (u: string) => u }))

beforeEach(() => {
  badgeState.icons = {}
  // jsdom has no media element playback — the hover handlers call .play()/.pause().
  window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined)
  window.HTMLMediaElement.prototype.pause = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const base: TrophySlabData = {
  id: 1,
  slot: 3,
  moment_id: "m123",
  edition_id: "e1",
  player_name: "Damian Lillard",
  set_name: "Logo Daze",
  serial_number: 5,
  circulation_count: 100,
  tier: "LEGENDARY",
  thumbnail_url: null,
  video_url: null,
  fmv: 500,
  fmv_confidence: "HIGH",
  serial_fmv: null,
  badges: [],
  note: null,
  collection_id: "cid",
  collection_slug: "nba-top-shot",
  collection_display_name: "NBA Top Shot",
  play_description: null,
  team_name: "Portland Trail Blazers",
  series: 4,
  pinned_at: null,
  acquired_price: null,
  acquisition_method: null,
}

describe("TrophySlab", () => {
  it("loading → skeleton (neither empty nor filled markers render)", () => {
    const { queryByText } = render(<TrophySlab slab={null} slot={3} mode="owner" loading />)
    expect(queryByText("PIN A MOMENT")).toBeNull()
    expect(queryByText("Damian Lillard")).toBeNull()
  })

  it("empty owner slab: PIN A MOMENT, clickable, calls onEmptyClick(slot)", () => {
    const onEmptyClick = vi.fn()
    const { getByText, getByRole } = render(
      <TrophySlab slab={null} slot={3} mode="owner" onEmptyClick={onEmptyClick} />,
    )
    expect(getByText("PIN A MOMENT")).toBeTruthy()
    expect(getByText(/SLAB SLOT 3 · EMPTY/)).toBeTruthy()
    fireEvent.click(getByRole("button"))
    expect(onEmptyClick).toHaveBeenCalledWith(3)
  })

  it("empty public slab: EMPTY SLAB, inert (no button, no handler)", () => {
    const onEmptyClick = vi.fn()
    const { getByText, queryByRole } = render(
      <TrophySlab slab={null} slot={3} mode="public" onEmptyClick={onEmptyClick} />,
    )
    expect(getByText("EMPTY SLAB")).toBeTruthy()
    expect(queryByRole("button")).toBeNull()
    expect(onEmptyClick).not.toHaveBeenCalled()
  })

  it("filled slab renders the moment, FMV, tier and serial", () => {
    const { getByLabelText, getByText, container } = render(
      <TrophySlab slab={base} slot={3} mode="public" />,
    )
    expect(getByLabelText("View Damian Lillard")).toBeTruthy()
    expect(getByText("$500")).toBeTruthy() // fmtUsd(fmv)
    // tier label + serial "#5/100" appear in the metallic label
    expect(container.textContent).toContain("LEGENDARY")
    expect(container.textContent).toContain("#5/100")
  })

  it("renders the serial-FMV #1 premium estimate when present", () => {
    const slab = {
      ...base,
      serial_fmv: {
        estimate_usd: 1500,
        multiplier: 3,
        serial_bucket: "first" as const,
        circ_band: "≤100",
        basis: "tier_circ" as const,
        sample_size: 8,
        label: "#1 premium",
      },
    }
    const { container } = render(<TrophySlab slab={slab} slot={3} mode="owner" />)
    // "≈ $1,500 #1 est" (fmtUsd rounds >= 1000)
    expect(container.textContent).toContain("$1,500")
    expect(container.textContent).toContain("#1 est")
  })

  it("footer shows ACQUIRED price, else PACK PULL, else MINTED", () => {
    const acquired = render(<TrophySlab slab={{ ...base, acquired_price: 250 }} slot={3} mode="owner" />)
    expect(acquired.getByText("ACQUIRED")).toBeTruthy()
    expect(acquired.getByText("$250")).toBeTruthy()
    cleanup()

    const pull = render(<TrophySlab slab={{ ...base, acquisition_method: "pack_pull" }} slot={3} mode="owner" />)
    expect(pull.getByText("PACK PULL")).toBeTruthy()
    cleanup()

    const minted = render(<TrophySlab slab={{ ...base, acquisition_method: "mint" }} slot={3} mode="owner" />)
    expect(minted.getByText("MINTED")).toBeTruthy()
  })

  it("owner mode exposes a remove control that calls onRemove(slot)", () => {
    const onRemove = vi.fn()
    const { getByLabelText } = render(
      <TrophySlab slab={base} slot={3} mode="owner" onRemove={onRemove} />,
    )
    fireEvent.click(getByLabelText("Remove slab 3"))
    expect(onRemove).toHaveBeenCalledWith(3)
  })

  it("the remove control is reachable WITHOUT hover (touch has none, and the slab is a link)", () => {
    // 2026-09-02 onboarding QA #5: `display: none` until mouseenter meant a
    // phone user's first tap navigated to /moment/<id> and the ✕ never existed.
    const { getByLabelText } = render(
      <TrophySlab slab={base} slot={2} mode="owner" onRemove={vi.fn()} />,
    )
    const btn = getByLabelText("Remove slab 2") as HTMLElement
    expect(btn.style.display).not.toBe("none")
  })

  it("public mode has no remove control", () => {
    const onRemove = vi.fn()
    const { queryByLabelText } = render(
      <TrophySlab slab={base} slot={3} mode="public" onRemove={onRemove} />,
    )
    expect(queryByLabelText("Remove slab 3")).toBeNull()
  })

  // ── fmtUsd bands (footer FMV) ───────────────────────────────────────────────
  it("fmtUsd renders an em-dash for a null FMV, cents under $1, and thousands with commas", () => {
    const dash = render(<TrophySlab slab={{ ...base, fmv: null }} slot={3} mode="public" />)
    expect(dash.container.textContent).toContain("—")
    cleanup()
    const cents = render(<TrophySlab slab={{ ...base, fmv: 0.5 }} slot={3} mode="public" />)
    expect(cents.container.textContent).toContain("$0.50")
    cleanup()
    const thousands = render(<TrophySlab slab={{ ...base, fmv: 2500 }} slot={3} mode="public" />)
    expect(thousands.container.textContent).toContain("$2,500")
  })

  it("renders the 'perfect' serial-FMV bucket label", () => {
    const slab = {
      ...base,
      serial_fmv: {
        estimate_usd: 90,
        multiplier: 1.5,
        serial_bucket: "perfect" as const,
        circ_band: "≤100",
        basis: "aggregate" as const,
        sample_size: 4,
        label: "perfect-mint premium",
      },
    }
    const { container } = render(<TrophySlab slab={slab} slot={3} mode="owner" />)
    expect(container.textContent).toContain("perfect est")
  })

  // ── media screen (video / image / placeholder) + hover playback ─────────────
  it("renders a <video> for a video moment and plays/pauses on hover", () => {
    const slab = { ...base, video_url: "ipfs://clip.mp4", thumbnail_url: "ipfs://poster.png" }
    const { container } = render(<TrophySlab slab={slab} slot={3} mode="owner" onRemove={vi.fn()} />)
    const video = container.querySelector("video")
    expect(video).toBeTruthy()
    // hover in → play() + the remove control's hit area flips to visible
    const card = container.querySelector("video")!.closest("div[class]")!.parentElement!
    // enter/leave on the holo card wrapper (the element carrying the mouse handlers)
    const holo = container.querySelector("a > div")!
    fireEvent.mouseEnter(holo)
    expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalled()
    fireEvent.mouseLeave(holo)
    expect(window.HTMLMediaElement.prototype.pause).toHaveBeenCalled()
    expect(card).toBeTruthy()
  })

  it("renders an <img> for a thumbnail-only moment", () => {
    const slab = { ...base, video_url: null, thumbnail_url: "ipfs://poster.png" }
    const { container } = render(<TrophySlab slab={slab} slot={3} mode="public" />)
    const img = container.querySelector("img")
    expect(img).toBeTruthy()
    expect(img!.getAttribute("src")).toContain("poster.png")
  })

  it("renders the [ MOMENT VIDEO ] placeholder when there is no media", () => {
    const { container } = render(<TrophySlab slab={base} slot={3} mode="public" />)
    expect(container.textContent).toContain("[ MOMENT VIDEO ]")
  })

  // ── metallic label edge cases ───────────────────────────────────────────────
  it("falls back to 'Unknown' / 'COMMON' and omits the serial line when fields are null", () => {
    const slab = {
      ...base,
      player_name: null,
      team_name: null,
      tier: null,
      serial_number: null,
      series: null,
    }
    const { container } = render(<TrophySlab slab={slab} slot={3} mode="public" />)
    expect(container.textContent).toContain("Unknown")
    expect(container.textContent).toContain("COMMON") // tier ?? "COMMON"
    expect(container.textContent).not.toContain("#") // no serial line
  })

  it("prints the bare set name (no series prefix) when series is null", () => {
    const slab = { ...base, series: null, set_name: "Logo Daze" }
    const { container } = render(<TrophySlab slab={slab} slot={3} mode="public" />)
    expect(container.textContent).toContain("Logo Daze")
  })

  it("omits the series prefix for the anomalous Top Shot series=1 (unmapped)", () => {
    // TS series=1 maps to "Misc / Unmapped" → seriesPrefix is dropped, set name stands alone.
    const slab = { ...base, collection_slug: "nba_top_shot", series: 1, set_name: "Base Set" }
    const { container } = render(<TrophySlab slab={slab} slot={3} mode="public" />)
    expect(container.textContent).toContain("Base Set")
    expect(container.textContent).not.toContain("Misc / Unmapped")
  })

  it("uses the non-Top-Shot series label path for other collections", () => {
    const slab = { ...base, collection_slug: "nfl-all-day", series: 2, set_name: "Base" }
    const { container } = render(<TrophySlab slab={slab} slot={3} mode="public" />)
    expect(container.textContent).toContain("Base")
  })

  // ── badges: art-backed <img> vs dot, and the +N overflow ────────────────────
  it("renders an art-backed badge as an <img> and sorts art-backed badges first", () => {
    badgeState.icons = { finals: "https://cdn/finals.svg" }
    const slab = { ...base, badges: ["rookie", "finals"] } // 'rookie' has no art (dot), 'finals' does
    const { container } = render(<TrophySlab slab={slab} slot={3} mode="public" />)
    const badgeImg = Array.from(container.querySelectorAll("img")).find((i) =>
      (i.getAttribute("src") ?? "").includes("finals.svg"),
    )
    expect(badgeImg).toBeTruthy()
  })

  it("collapses more than 3 badges into a +N counter", () => {
    const slab = { ...base, badges: ["a", "b", "c", "d", "e"] } // 5 → show 2, "+3"
    const { container } = render(<TrophySlab slab={slab} slot={3} mode="public" />)
    expect(container.textContent).toContain("+3")
  })
})
