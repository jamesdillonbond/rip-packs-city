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

  // The fake route honours `q` the way the real one does (2026-11-06): a typed
  // name filters the WHOLE pool server-side, before the cap. `seen` records
  // every q the picker sent.
  const seen: string[] = []
  function withMoments(rows: unknown[]) {
    seen.length = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: unknown) => {
        if (String(u).includes("/api/profile/top-moments")) {
          const q = new URL(String(u), "https://t").searchParams.get("q") ?? ""
          seen.push(q)
          const out = q
            ? (rows as { player_name?: string | null }[]).filter((m) =>
                String(m.player_name ?? "").toLowerCase().includes(q.toLowerCase()),
              )
            : rows
          return { ok: true, json: async () => ({ moments: out }) } as never
        }
        return { ok: true, json: async () => ({}) } as never
      }),
    )
  }

  it("says the grid is a slice when a full page comes back — and that typing searches everything", async () => {
    // ⚠ INVERTED 2026-11-06: the line used to say "Search looks inside this
    // list only", which was true and useless — a typed name now reaches the
    // route as `q`, so the cap line must say the opposite.
    const { PICKER_LIMIT } = await import("@/components/profile/TrophyPickerModal")
    withMoments(many(PICKER_LIMIT))
    const { container } = open()
    await waitFor(() => expect(screen.getByText("Player 0")).toBeTruthy())
    expect(container.textContent).toMatch(/highest-value Moments/i)
    expect(container.textContent).toMatch(/search everything you hold/i)
    expect(container.textContent).not.toMatch(/inside this list only/i)
  })

  it("sends a typed name to the route as q, and a row BEHIND the cap comes back (the Dame Time defect)", async () => {
    // 96 rows fill the page; "Damian Lillard" is the 97th by value, so he was
    // invisible to a client-side search. The fake route finds him by q.
    const { PICKER_LIMIT } = await import("@/components/profile/TrophyPickerModal")
    const pool = [...many(PICKER_LIMIT), moment("dame-97", "Damian Lillard")]
    withMoments(pool.slice(0, PICKER_LIMIT).concat()) // first page: no Dame
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: unknown) => {
        const q = new URL(String(u), "https://t").searchParams.get("q") ?? ""
        seen.push(q)
        const out = q
          ? pool.filter((m) => String(m.player_name ?? "").toLowerCase().includes(q.toLowerCase()))
          : pool.slice(0, PICKER_LIMIT)
        return { ok: true, json: async () => ({ moments: out }) } as never
      }),
    )
    const { container } = open()
    // 2026-11-08: ceilings, not properties — 96 rows + the search debounce missed the
    // 1 s / 2 s waits under the full-suite coverage load (passed alone and on CI).
    await waitFor(() => expect(screen.getByText("Player 0")).toBeTruthy(), { timeout: 8000 })
    expect(screen.queryByText("Damian Lillard")).toBeNull()
    fireEvent.change(screen.getByLabelText(/Search your moments/i), { target: { value: "Damian Lillard" } })
    await waitFor(() => expect(screen.getByText("Damian Lillard")).toBeTruthy(), { timeout: 8000 })
    expect(seen).toContain("Damian Lillard")
    expect(container.textContent).toMatch(/Searching everything you hold for “Damian Lillard”/i)
    expect(screen.queryByText("Player 0")).toBeNull()
  }, 20_000)

  it("a one-character query stays client-side (no q sent)", async () => {
    withMoments(many(5))
    open()
    await waitFor(() => expect(screen.getByText("Player 0")).toBeTruthy())
    fireEvent.change(screen.getByLabelText(/Search your moments/i), { target: { value: "P" } })
    await new Promise((r) => setTimeout(r, 400))
    expect(seen.filter(Boolean)).toEqual([])
  })

  it("stays quiet when the whole collection fits", async () => {
    // The mirror: a permanent notice on a collector who owns 12 Moments is its
    // own false claim.
    withMoments(many(12))
    const { container } = open()
    await waitFor(() => expect(screen.getByText("Player 0")).toBeTruthy())
    expect(container.textContent).not.toMatch(/highest-value Moments/i)
  })

  it("a server search that finds nothing says so about THIS name, never about the top 96", async () => {
    const { PICKER_LIMIT } = await import("@/components/profile/TrophyPickerModal")
    withMoments(many(PICKER_LIMIT))
    const { container } = open()
    await waitFor(() => expect(screen.getByText("Player 0")).toBeTruthy())
    fireEvent.change(screen.getByLabelText(/Search your moments/i), {
      target: { value: "zzzzz-no-such-player" },
    })
    await waitFor(() => expect(seen).toContain("zzzzz-no-such-player"), { timeout: 2000 })
    await waitFor(() =>
      expect(screen.getByText(/Nothing you hold matches “zzzzz-no-such-player”/i)).toBeTruthy(),
    )
    expect(container.textContent).not.toMatch(/top 96/i)
    expect(container.textContent).not.toMatch(/won't be listed here/i)
  })

  it("between keystrokes the previous list is narrowed client-side (no non-matching row is ever shown)", async () => {
    withMoments(many(3))
    const { container } = open()
    await waitFor(() => expect(screen.getByText("Player 0")).toBeTruthy())
    fireEvent.change(screen.getByLabelText(/Search your moments/i), {
      target: { value: "zzzzz-no-such-player" },
    })
    // Synchronously after the keystroke — before the 300 ms debounce fires —
    // the stale list must already be filtered down.
    expect(screen.queryByText("Player 0")).toBeNull()
    await waitFor(() =>
      expect(container.textContent).toMatch(/Nothing you hold matches/i),
    { timeout: 2000 })
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
