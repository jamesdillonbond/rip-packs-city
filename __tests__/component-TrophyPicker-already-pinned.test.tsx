// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, fireEvent, screen, waitFor } from "@testing-library/react"
import TrophyPickerModal from "@/components/profile/TrophyPickerModal"

// ─────────────────────────────────────────────────────────────────────────────
// The picker must show which Moments are already in the case.
//
// ⚠ Nothing rejected a duplicate. The trophy upsert conflicts on
// `(user_id, slot)`, NOT `(user_id, moment_id)`, so pinning the same Moment
// into two slots succeeded end to end — and no row in the grid was marked, so
// every Moment looked equally pinnable. A collector could put the same Moment
// on their public profile twice and only find out by looking at it.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("@/lib/badges/useBadgeTaxonomy", () => ({
  useBadgeTaxonomy: () => ({}),
  lookupBadge: () => null,
}))
vi.mock("@/lib/telemetry/track", () => ({ track: vi.fn() }))
vi.mock("next/link", () => ({ default: ({ children, ...p }: any) => <a {...p}>{children}</a> }))

const moment = (id: string, player: string) => ({
  moment_id: id,
  collection_id: "c1",
  collection_slug: "nba_top_shot",
  player_name: player,
  set_name: "Base Set",
  serial_number: 5,
  mint_count: 100,
  tier: "RARE",
  fmv_usd: 50,
  image_url: null,
  is_locked: false,
  series_number: 4,
  edition_key: "1:2",
})

const MOMENTS = [moment("m-1", "Damian Lillard"), moment("m-2", "Anfernee Simons")]

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: unknown) => {
      if (String(u).includes("/api/profile/top-moments"))
        return { ok: true, json: async () => ({ moments: MOMENTS }) } as never
      return { ok: true, json: async () => ({}) } as never
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const open = (pinnedMomentIds?: string[]) =>
  render(
    <TrophyPickerModal
      slot={2}
      ownerKey="trevor"
      onClose={() => {}}
      onPinned={() => {}}
      pinnedMomentIds={pinnedMomentIds}
    />,
  )

/** The clickable row for a player, i.e. the button wrapping their name. */
function rowFor(player: string): HTMLButtonElement {
  const el = screen.getByText(player).closest("button")
  if (!el) throw new Error(`no row for ${player}`)
  return el as HTMLButtonElement
}

describe("TrophyPickerModal — already-pinned Moments", () => {
  it("marks a Moment that is already in the case", async () => {
    open(["m-1"])
    await waitFor(() => expect(screen.getByText("Damian Lillard")).toBeTruthy())
    expect(rowFor("Damian Lillard").textContent).toContain("PINNED")
  })

  it("leaves un-pinned Moments unmarked", async () => {
    // The mirror. A marker that fires on everything is the same as none.
    open(["m-1"])
    await waitFor(() => expect(screen.getByText("Anfernee Simons")).toBeTruthy())
    expect(rowFor("Anfernee Simons").textContent).not.toContain("PINNED")
  })

  it("refuses the click, so the duplicate cannot be created", async () => {
    open(["m-1"])
    await waitFor(() => expect(screen.getByText("Damian Lillard")).toBeTruthy())
    const before = (globalThis.fetch as any).mock.calls.length
    fireEvent.click(rowFor("Damian Lillard"))
    expect(rowFor("Damian Lillard").disabled).toBe(true)
    expect((globalThis.fetch as any).mock.calls.length).toBe(before)
  })

  it("still pins a Moment that is NOT already up", async () => {
    open(["m-1"])
    await waitFor(() => expect(screen.getByText("Anfernee Simons")).toBeTruthy())
    fireEvent.click(rowFor("Anfernee Simons"))
    fireEvent.click(await screen.findByText("Pin trophy"))
    await waitFor(() =>
      expect(
        (globalThis.fetch as any).mock.calls.some(
          (c: any[]) => String(c[0]).includes("/api/profile/trophy") && c[1]?.method === "POST",
        ),
      ).toBe(true),
    )
  })

  it("works when the prop is absent (nothing marked, everything pinnable)", async () => {
    // The prop is optional, so an un-wired caller must degrade to the previous
    // behaviour rather than marking everything or nothing clickable.
    open(undefined)
    await waitFor(() => expect(screen.getByText("Damian Lillard")).toBeTruthy())
    expect(rowFor("Damian Lillard").textContent).not.toContain("PINNED")
    expect(rowFor("Damian Lillard").disabled).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The picker loads a CAPPED page of Moments and searches client-side over it.
//
// So a collector with more Moments than the cap who searches for one outside
// their top N was told "No moments match the current filter" — a claim about
// THEIR COLLECTION manufactured from our page limit, on the screen where they
// choose what their public profile shows off.
// ─────────────────────────────────────────────────────────────────────────────

describe("TrophyPickerModal — the page cap is disclosed, not silent", () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => moment(`m-${i}`, `Player ${i}`))

  function withMoments(rows: unknown[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: unknown) => {
        if (String(u).includes("/api/profile/top-moments"))
          return { ok: true, json: async () => ({ moments: rows }) } as never
        return { ok: true, json: async () => ({}) } as never
      }),
    )
  }

  it("says the grid is a slice when a full page comes back", async () => {
    const { PICKER_LIMIT } = await import("@/components/profile/TrophyPickerModal")
    withMoments(many(PICKER_LIMIT))
    const { container } = open()
    await waitFor(() => expect(screen.getByText("Player 0")).toBeTruthy())
    expect(container.textContent).toMatch(/highest-value Moments/i)
    expect(container.textContent).toMatch(/inside this list only/i)
  })

  it("stays quiet when the whole collection fits", async () => {
    // The mirror: a permanent notice on a collector who owns 12 Moments is its
    // own false claim.
    withMoments(many(12))
    const { container } = open()
    await waitFor(() => expect(screen.getByText("Player 0")).toBeTruthy())
    expect(container.textContent).not.toMatch(/highest-value Moments/i)
  })

  it("does not blame the collection when a capped search finds nothing", async () => {
    const { PICKER_LIMIT } = await import("@/components/profile/TrophyPickerModal")
    withMoments(many(PICKER_LIMIT))
    open()
    await waitFor(() => expect(screen.getByText("Player 0")).toBeTruthy())
    fireEvent.change(screen.getByLabelText(/Search your moments/i), {
      target: { value: "zzzzz-no-such-player" },
    })
    await waitFor(() =>
      expect(screen.getByText(/won't be listed here/i)).toBeTruthy(),
    )
  })

  it("keeps the plain no-match copy when the list is NOT capped", async () => {
    withMoments(many(3))
    const { container } = open()
    await waitFor(() => expect(screen.getByText("Player 0")).toBeTruthy())
    fireEvent.change(screen.getByLabelText(/Search your moments/i), {
      target: { value: "zzzzz-no-such-player" },
    })
    await waitFor(() =>
      expect(container.textContent).toMatch(/No moments match the current filter/i),
    )
    expect(container.textContent).not.toMatch(/won't be listed here/i)
  })

  it("requests exactly the cap it later reasons about", async () => {
    // The fetch used to hardcode "96" while nothing else knew the number, so
    // the disclosure and the request could drift apart silently.
    const { PICKER_LIMIT } = await import("@/components/profile/TrophyPickerModal")
    withMoments(many(5))
    open()
    await waitFor(() => expect(screen.getByText("Player 0")).toBeTruthy())
    const url = String((globalThis.fetch as any).mock.calls[0][0])
    expect(url).toContain(`limit=${PICKER_LIMIT}`)
  })
})
