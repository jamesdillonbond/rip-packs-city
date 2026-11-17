// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, fireEvent, screen, waitFor } from "@testing-library/react"
import TrophyPickerModal from "@/components/profile/TrophyPickerModal"

// ─────────────────────────────────────────────────────────────────────────────
// The grid tab pins through a CONFIRM step, and the confirm step says what the
// pin will destroy.
//
// ⚠ Two things made the old one-tap flow worse than it looked. Pinning is an
// OVERWRITE — the upsert conflicts on `(user_id, slot)` — and there is no undo,
// so a mis-tap on a 72px row in a dense scrolling list silently replaced a
// trophy the collector had chosen, and the only feedback was a "Trophy pinned"
// toast that reads as success. The manual-ID tab had shown a preview since it
// was written; the grid, which is how everybody actually pins, had none.
//
// The replacement notice is the half that could not exist before: it needs the
// CURRENT occupant of the slot, which the picker was never told.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("@/lib/badges/useBadgeTaxonomy", () => ({
  useBadgeTaxonomy: () => ({}),
  lookupBadge: () => null,
}))
vi.mock("@/lib/telemetry/track", () => ({ track: vi.fn() }))
vi.mock("next/link", () => ({ default: ({ children, ...p }: any) => <a {...p}>{children}</a> }))

const MOMENTS = [
  {
    moment_id: "m-1",
    collection_id: "c1",
    collection_slug: "nba_top_shot",
    player_name: "Damian Lillard",
    set_name: "Base Set",
    serial_number: 5,
    mint_count: 100,
    tier: "RARE",
    fmv_usd: 1200,
    image_url: null,
    is_locked: false,
    series_number: 4,
    edition_key: "1:2",
  },
]

let trophyPosts: number

beforeEach(() => {
  trophyPosts = 0
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: unknown) => {
      const url = String(u)
      if (url.includes("/api/profile/top-moments"))
        return { ok: true, json: async () => ({ moments: MOMENTS }) } as never
      if (url.includes("/api/profile/trophy")) {
        trophyPosts += 1
        return { ok: true, json: async () => ({}) } as never
      }
      return { ok: true, json: async () => ({}) } as never
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function open(props: Partial<React.ComponentProps<typeof TrophyPickerModal>> = {}) {
  return render(
    <TrophyPickerModal
      slot={3}
      ownerKey="trevor"
      onClose={() => {}}
      onPinned={() => {}}
      {...props}
    />,
  )
}

describe("TrophyPickerModal — the grid confirms before it overwrites", () => {
  it("selects on tap and writes nothing until the confirm button", async () => {
    open()
    fireEvent.click(await screen.findByText("Damian Lillard"))

    // Selected, not written.
    expect(trophyPosts).toBe(0)
    expect(screen.getByText("Pin trophy")).toBeTruthy()

    fireEvent.click(screen.getByText("Pin trophy"))
    await waitFor(() => expect(trophyPosts).toBe(1))
  })

  it("names the Moment it is about to replace", async () => {
    open({ replacingName: "Anfernee Simons" })
    fireEvent.click(await screen.findByText("Damian Lillard"))
    expect(screen.getByText(/This replaces Anfernee Simons in slot 3/)).toBeTruthy()
  })

  it("says the slot is empty when nothing is being replaced", async () => {
    // ⚠ The mirror case matters as much as the warning. If the notice only ever
    // appeared for a replacement, its ABSENCE would be the signal, and an
    // un-wired caller (the prop is optional) would look identical to an empty
    // slot. Stating both means the confirm step is never silent about the slot.
    open()
    fireEvent.click(await screen.findByText("Damian Lillard"))
    expect(screen.getByText(/Slot 3 is empty/)).toBeTruthy()
    expect(screen.queryByText(/This replaces/)).toBeNull()
  })

  it("backing out writes nothing and returns to the list", async () => {
    open({ replacingName: "Anfernee Simons" })
    fireEvent.click(await screen.findByText("Damian Lillard"))
    fireEvent.click(screen.getByText(/Back to your Moments/))

    expect(trophyPosts).toBe(0)
    expect(screen.queryByText(/^(Pin|Replace) trophy$/)).toBeNull()
    // The filters and the loaded page survive the round trip — re-fetching or
    // resetting them would punish the collector for looking twice.
    expect(screen.getByLabelText("Search your moments")).toBeTruthy()
    expect(screen.getByText("Damian Lillard")).toBeTruthy()
  })

  it("shows the picked Moment's own details on the confirm step", async () => {
    // Confirming against a card that does not identify the Moment is not a
    // confirmation. Serial and FMV are what distinguish two copies of the same
    // player in a list sorted by value.
    open()
    fireEvent.click(await screen.findByText("Damian Lillard"))
    const panel = screen.getByText("Pin trophy").closest("div")?.parentElement
    expect(panel?.textContent).toContain("Damian Lillard")
    expect(panel?.textContent).toContain("#5")
    expect(panel?.textContent).toContain("$1,200")
  })
})
