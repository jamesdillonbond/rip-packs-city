// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, fireEvent, screen, waitFor } from "@testing-library/react"
import TrophySlab, { type TrophySlabData } from "@/components/TrophySlab"
import TrophyNoteEditor from "@/components/profile/TrophyNoteEditor"

// ─────────────────────────────────────────────────────────────────────────────
// The trophy CAPTION — display (TrophySlab) and authoring (TrophyNoteEditor).
//
// `trophy_moments.note` was writable, stored, RPC-returned, typed and rendered
// in the trophy-case PDF, with no UI to write one and no surface to read one.
// These are the two halves that close it, so both are asserted here together:
// a caption that saves but never renders, or renders but never saves, is the
// same non-feature it was before.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("@/lib/badges/useBadgeTaxonomy", () => ({
  useBadgeTaxonomy: () => ({}),
  lookupBadge: () => null,
}))
vi.mock("next/link", () => ({ default: ({ children, ...p }: any) => <a {...p}>{children}</a> }))
vi.mock("@/lib/ipfs-media", () => ({ proxyIpfsUrl: (u: string) => u }))

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

beforeEach(() => {
  window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined)
  window.HTMLMediaElement.prototype.pause = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("TrophySlab — caption display", () => {
  it("renders the collector's caption when there is one", () => {
    const { container } = render(
      <TrophySlab slab={{ ...base, note: "First Moment I ever pulled" }} slot={3} mode="public" />,
    )
    expect(container.textContent).toContain("First Moment I ever pulled")
  })

  it("shows it to VISITORS, not just the owner", () => {
    // The whole point of a caption is that other people read it. If this only
    // rendered in owner mode the feature would be a private note.
    for (const mode of ["owner", "public"] as const) {
      cleanup()
      const { container } = render(
        <TrophySlab slab={{ ...base, note: "Game 5, 2019" }} slot={3} mode={mode} />,
      )
      expect(container.textContent).toContain("Game 5, 2019")
    }
  })

  it("renders nothing extra when there is no caption", () => {
    // The mirror assertion: an always-on caption row would put an empty quoted
    // line under every uncaptioned trophy, which is most of them.
    const { container } = render(<TrophySlab slab={base} slot={3} mode="public" />)
    expect(container.textContent).not.toContain("“")
  })

  it("does not render an empty-string caption as a blank line", () => {
    const { container } = render(
      <TrophySlab slab={{ ...base, note: "" }} slot={3} mode="public" />,
    )
    expect(container.textContent).not.toContain("“")
  })
})

describe("TrophyNoteEditor", () => {
  const fetchMock = (res: Partial<Response> & { status: number }) =>
    vi.fn().mockResolvedValue({ ok: res.status < 400, status: res.status, json: async () => ({}) })

  it("offers to ADD when there is no caption and EDIT when there is", () => {
    const { container, rerender } = render(<TrophyNoteEditor slot={2} note={null} />)
    expect(container.textContent).toContain("ADD A CAPTION")
    rerender(<TrophyNoteEditor slot={2} note="hi" />)
    expect(container.textContent).toContain("EDIT CAPTION")
  })

  it("PATCHes the caption for its own slot", async () => {
    const f = fetchMock({ status: 200 })
    vi.stubGlobal("fetch", f)
    render(<TrophyNoteEditor slot={4} note={null} />)
    fireEvent.click(screen.getByRole("button", { name: /ADD A CAPTION/i }))
    fireEvent.change(screen.getByLabelText(/Caption for trophy slot 4/i), {
      target: { value: "  my   first pull " },
    })
    fireEvent.click(screen.getByRole("button", { name: /^SAVE$/i }))

    await waitFor(() => expect(f).toHaveBeenCalled())
    const [url, init] = f.mock.calls[0]
    expect(url).toBe("/api/profile/trophy")
    // PATCH, never POST — POST upserts the whole row and would blank the
    // trophy's player/tier/art/FMV.
    expect(init.method).toBe("PATCH")
    expect(JSON.parse(init.body)).toEqual({ slot: 4, note: "my first pull" })
  })

  it("sends null when the caption is cleared, so it round-trips to NULL", async () => {
    const f = fetchMock({ status: 200 })
    vi.stubGlobal("fetch", f)
    render(<TrophyNoteEditor slot={1} note="old" />)
    fireEvent.click(screen.getByRole("button", { name: /EDIT CAPTION/i }))
    fireEvent.change(screen.getByLabelText(/Caption for trophy slot 1/i), {
      target: { value: "   " },
    })
    fireEvent.click(screen.getByRole("button", { name: /^SAVE$/i }))
    await waitFor(() => expect(f).toHaveBeenCalled())
    expect(JSON.parse(f.mock.calls[0][1].body).note).toBeNull()
  })

  it("tells the parent only after the write succeeded", async () => {
    const onSaved = vi.fn()
    vi.stubGlobal("fetch", fetchMock({ status: 200 }))
    render(<TrophyNoteEditor slot={2} note={null} onSaved={onSaved} />)
    fireEvent.click(screen.getByRole("button", { name: /ADD A CAPTION/i }))
    fireEvent.change(screen.getByLabelText(/Caption for trophy slot 2/i), {
      target: { value: "wow" },
    })
    fireEvent.click(screen.getByRole("button", { name: /^SAVE$/i }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(2, "wow"))
  })

  it("does NOT tell the parent when the write failed", async () => {
    // Otherwise the caption appears on screen, survives until reload, and is
    // gone the next time the collector opens their dashboard.
    const onSaved = vi.fn()
    vi.stubGlobal("fetch", fetchMock({ status: 500 }))
    render(<TrophyNoteEditor slot={2} note={null} onSaved={onSaved} />)
    fireEvent.click(screen.getByRole("button", { name: /ADD A CAPTION/i }))
    fireEvent.change(screen.getByLabelText(/Caption for trophy slot 2/i), {
      target: { value: "wow" },
    })
    fireEvent.click(screen.getByRole("button", { name: /^SAVE$/i }))
    await waitFor(() => expect(screen.getByText(/Couldn't save/i)).toBeTruthy())
    expect(onSaved).not.toHaveBeenCalled()
  })

  it("distinguishes an empty slot from a failed save", async () => {
    // A 404 means "nothing is pinned here", which is a different problem with a
    // different fix than "the save failed" — reporting both the same way sends
    // the collector to retry something that can never work.
    vi.stubGlobal("fetch", fetchMock({ status: 404 }))
    render(<TrophyNoteEditor slot={5} note={null} />)
    fireEvent.click(screen.getByRole("button", { name: /ADD A CAPTION/i }))
    fireEvent.click(screen.getByRole("button", { name: /^SAVE$/i }))
    await waitFor(() => expect(screen.getByText(/slot is empty/i)).toBeTruthy())
  })

  it("distinguishes a signed-out session too", async () => {
    vi.stubGlobal("fetch", fetchMock({ status: 401 }))
    render(<TrophyNoteEditor slot={5} note={null} />)
    fireEvent.click(screen.getByRole("button", { name: /ADD A CAPTION/i }))
    fireEvent.click(screen.getByRole("button", { name: /^SAVE$/i }))
    await waitFor(() => expect(screen.getByText(/Sign in/i)).toBeTruthy())
  })

  it("reports a network failure rather than silently doing nothing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")))
    render(<TrophyNoteEditor slot={5} note={null} />)
    fireEvent.click(screen.getByRole("button", { name: /ADD A CAPTION/i }))
    fireEvent.click(screen.getByRole("button", { name: /^SAVE$/i }))
    await waitFor(() => expect(screen.getByText(/Couldn't reach the server/i)).toBeTruthy())
  })

  it("cancels back to the stored caption, discarding the draft", async () => {
    const f = fetchMock({ status: 200 })
    vi.stubGlobal("fetch", f)
    render(<TrophyNoteEditor slot={1} note="original" />)
    fireEvent.click(screen.getByRole("button", { name: /EDIT CAPTION/i }))
    fireEvent.change(screen.getByLabelText(/Caption for trophy slot 1/i), {
      target: { value: "throwaway" },
    })
    fireEvent.click(screen.getByRole("button", { name: /CANCEL/i }))
    expect(f).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: /EDIT CAPTION/i }))
    expect(
      (screen.getByLabelText(/Caption for trophy slot 1/i) as HTMLInputElement).value,
    ).toBe("original")
  })

  it("saves on Enter and cancels on Escape", async () => {
    const f = fetchMock({ status: 200 })
    vi.stubGlobal("fetch", f)
    render(<TrophyNoteEditor slot={1} note={null} />)
    fireEvent.click(screen.getByRole("button", { name: /ADD A CAPTION/i }))
    const input = screen.getByLabelText(/Caption for trophy slot 1/i)
    fireEvent.change(input, { target: { value: "typed" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole("button", { name: /ADD A CAPTION|EDIT CAPTION/i }))
    fireEvent.keyDown(screen.getByLabelText(/Caption for trophy slot 1/i), { key: "Escape" })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it("re-syncs when the parent swaps the trophy in this slot", () => {
    // Reorder and repin both change which Moment a slot holds. Without the
    // effect, the editor would keep offering the PREVIOUS trophy's caption.
    const { container, rerender } = render(<TrophyNoteEditor slot={1} note="first" />)
    rerender(<TrophyNoteEditor slot={1} note="second" />)
    fireEvent.click(screen.getByRole("button", { name: /EDIT CAPTION/i }))
    expect(
      (screen.getByLabelText(/Caption for trophy slot 1/i) as HTMLInputElement).value,
    ).toBe("second")
    expect(container).toBeTruthy()
  })
})
