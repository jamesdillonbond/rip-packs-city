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

vi.mock("@/lib/badges/useBadgeTaxonomy", () => ({
  useBadgeTaxonomy: () => ({}),
  lookupBadge: () => null,
}))
vi.mock("next/link", () => ({ default: ({ children, ...p }: any) => <a {...p}>{children}</a> }))
vi.mock("@/lib/ipfs-media", () => ({ proxyIpfsUrl: (u: string) => u }))

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

  it("public mode has no remove control", () => {
    const onRemove = vi.fn()
    const { queryByLabelText } = render(
      <TrophySlab slab={base} slot={3} mode="public" onRemove={onRemove} />,
    )
    expect(queryByLabelText("Remove slab 3")).toBeNull()
  })
})
