// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor, screen } from "@testing-library/react"
import TrophyPickerModal, { type PickerMoment } from "@/components/profile/TrophyPickerModal"

// Multi-pick (2026-11-08). Feedback from both outside Dame Time entrants: "it
// only let me select one at a time" — six modal opens to fill one case.

const mk = (id: string, name: string): PickerMoment => ({
  moment_id: id,
  collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
  collection_slug: "nba-top-shot",
  wallet_address: "0xbd94cade097e50ac",
  player_name: name,
  set_name: "Base Set",
  team_name: "Portland Trail Blazers",
  tier: "COMMON",
  serial_number: 1,
  mint_count: 100,
  fmv_usd: 5,
  image_url: null,
  is_locked: false,
  series_number: 4,
  edition_key: "1:" + id,
  league: "nba",
})
const ROWS = [mk("1", "Dame One"), mk("2", "Dame Two"), mk("3", "Dame Three")]

let posts: { slot: number; momentId: string }[] = []
function stub(failOn?: string) {
  posts = []
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (String(url).includes("/api/profile/top-moments")) {
        return Promise.resolve({ ok: true, json: async () => ({ moments: ROWS, hasMore: false }) } as Response)
      }
      if (String(url).includes("/api/profile/trophy") && init?.method === "POST") {
        const b = JSON.parse(String(init.body))
        if (b.momentId === failOn) {
          return Promise.resolve({ ok: false, status: 422, json: async () => ({ error: "not a Dame" }) } as Response)
        }
        posts.push({ slot: b.slot, momentId: b.momentId })
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
    }),
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const rowBtn = async (name: string) => (await screen.findByText(name)).closest("button")!

describe("TrophyPickerModal multi-pick", () => {
  it("picks several and pins them into the empty slots in order, tapped slot first, then calls onPinned once", async () => {
    stub()
    const onPinned = vi.fn()
    render(<TrophyPickerModal slot={4} ownerKey={null} onClose={() => {}} onPinned={onPinned} openSlots={[2, 4, 5]} />)
    expect(screen.getByText(/3 empty slots/)).toBeTruthy()
    fireEvent.click(await rowBtn("Dame Two"))
    fireEvent.click(await rowBtn("Dame One"))
    expect(screen.getByText(/2 of 3 picked → slots 4 and 2/)).toBeTruthy()
    fireEvent.click(screen.getByText("Pin 2"))
    await waitFor(() => expect(onPinned).toHaveBeenCalledTimes(1))
    expect(posts).toEqual([
      { slot: 4, momentId: "2" },
      { slot: 2, momentId: "1" },
    ])
  })

  it("a second tap un-picks, and the cap holds at the number of empty slots", async () => {
    stub()
    render(<TrophyPickerModal slot={1} ownerKey={null} onClose={() => {}} onPinned={() => {}} openSlots={[1, 6]} />)
    fireEvent.click(await rowBtn("Dame One"))
    fireEvent.click(await rowBtn("Dame Two"))
    fireEvent.click(await rowBtn("Dame Three")) // past the cap: ignored
    expect(screen.getByText(/2 of 2 picked/)).toBeTruthy()
    // Un-picking the first shifts the rest up: picks land in tap order.
    fireEvent.click(await rowBtn("Dame One"))
    expect(screen.getByText(/1 of 2 picked → slot 1$/)).toBeTruthy()
  })

  it("⛔ a failure part-way stops there, says how many landed and why, and keeps the rest picked", async () => {
    stub("2")
    const onPinned = vi.fn()
    const onClose = vi.fn()
    render(<TrophyPickerModal slot={1} ownerKey={null} onClose={onClose} onPinned={onPinned} openSlots={[1, 2, 3]} />)
    fireEvent.click(await rowBtn("Dame One"))
    fireEvent.click(await rowBtn("Dame Two"))
    fireEvent.click(await rowBtn("Dame Three"))
    fireEvent.click(screen.getByText("Pin 3"))
    expect(await screen.findByText(/Pinned 1 of 3\. Dame Two: not a Dame/)).toBeTruthy()
    expect(posts).toEqual([{ slot: 1, momentId: "1" }])
    expect(onPinned).not.toHaveBeenCalled()
    // Remaining slots are 2 and 3; the two unpinned picks stay selected for them.
    expect(screen.getByText(/2 of 2 picked → slots 2 and 3/)).toBeTruthy()
    // Something landed, so closing refreshes the case (onPinned), not a bare close.
    fireEvent.click(screen.getByLabelText("Close"))
    expect(onPinned).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it("⛔ an OCCUPIED slot keeps the one-at-a-time replace flow with its confirm step", async () => {
    stub()
    render(
      <TrophyPickerModal slot={2} ownerKey={null} onClose={() => {}} onPinned={() => {}} openSlots={[1, 3]} replacingName="Old Trophy" />,
    )
    expect(screen.getByText(/Pin to slot 2/)).toBeTruthy()
    expect(screen.queryByTestId("multi-pick-bar")).toBeNull()
    fireEvent.click(await rowBtn("Dame One"))
    expect(screen.getByText(/This replaces Old Trophy in slot 2/)).toBeTruthy()
  })
})

describe("challenge picker Panini hint (2026-11-08: 'How do I show off my Panini cards?')", () => {
  const stubLinked = (linked: unknown) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: true, json: async () => ({ moments: ROWS, hasMore: false, paniniUsernamesLinked: linked }) } as Response)),
    )
  it("says where the Panini username goes when the route READ that none is linked", async () => {
    stubLinked(0)
    render(<TrophyPickerModal slot={1} ownerKey={null} onClose={() => {}} onPinned={() => {}} initialQuery="Damian Lillard" />)
    await screen.findByText("Dame One")
    expect(document.querySelector("[data-rpc-picker-panini-hint]")).not.toBeNull()
  })
  it("⛔ says nothing when the count is unknown, or a username is linked", async () => {
    stubLinked(null)
    const a = render(<TrophyPickerModal slot={1} ownerKey={null} onClose={() => {}} onPinned={() => {}} initialQuery="Damian Lillard" />)
    await screen.findByText("Dame One")
    expect(document.querySelector("[data-rpc-picker-panini-hint]")).toBeNull()
    a.unmount()
    stubLinked(1)
    render(<TrophyPickerModal slot={1} ownerKey={null} onClose={() => {}} onPinned={() => {}} initialQuery="Damian Lillard" />)
    await screen.findByText("Dame One")
    expect(document.querySelector("[data-rpc-picker-panini-hint]")).toBeNull()
  })
})
