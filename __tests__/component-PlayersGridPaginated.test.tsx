// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react"

// ─────────────────────────────────────────────────────────────────────────────
// PlayersGridPaginated — the entity-page player grid (a team/collection's
// players with Load-more paging). It had NO test importing its module (36% br).
// The branches that matter to a visitor on a `/[collection]/team|player` page:
//   · the Current/All-Time roster toggle (Current filters to is_active — but
//     only when the loaded rows actually carry active-roster data, else it would
//     hide everyone, e.g. Pinnacle where is_active is always null),
//   · the FMV/Editions/A→Z client sort,
//   · Load-more append → exhaust-on-short-page, and exhaust-on-fetch-error,
//   · the headshot → portrait fallback → "No image", and the rookie badge.
// A regression here shows an empty roster, a wrong sort, or a broken pager.
// ─────────────────────────────────────────────────────────────────────────────

import PlayersGridPaginated, { type PlayerTile } from "@/components/entity/PlayersGridPaginated"

function tile(o: Partial<PlayerTile>): PlayerTile {
  return {
    name: "Player", player_slug: "player", headshot_url: null, jersey_number: null,
    position: null, edition_count: 1, total_circulation: 100, fmv_total_usd: 10,
    portrait_thumbnail: null, is_active: null, is_rookie: null, ...o,
  }
}

const base = { collectionUrlSlug: "nba-top-shot", fetchUrl: "/api/entity/players", isFranchise: true }

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("PlayersGridPaginated", () => {
  it("shows the empty state with no rows", () => {
    const { getByText } = render(
      <PlayersGridPaginated {...base} initial={[]} pageSize={12} />
    )
    expect(getByText("No entries yet.")).toBeTruthy()
  })

  it("defaults to Current and filters to active players when active data exists", () => {
    const rows = [
      tile({ name: "Active One", player_slug: "active-one", is_active: true }),
      tile({ name: "Retired Two", player_slug: "retired-two", is_active: false }),
    ]
    const { container, getByText } = render(
      <PlayersGridPaginated {...base} initial={rows} pageSize={12} />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Active One")
    expect(text).not.toContain("Retired Two") // Current view hides inactive
    // Toggle to All-Time → inactive reappears.
    fireEvent.click(getByText("All-Time"))
    expect((container.textContent ?? "")).toContain("Retired Two")
  })

  it("does NOT hide everyone when no row carries active-roster data", () => {
    const rows = [
      tile({ name: "Pinn One", player_slug: "p1", is_active: null }),
      tile({ name: "Pinn Two", player_slug: "p2", is_active: null }),
    ]
    const { container } = render(
      <PlayersGridPaginated {...base} initial={rows} pageSize={12} />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Pinn One")
    expect(text).toContain("Pinn Two")
  })

  it("re-sorts by editions and alphabetically", () => {
    const rows = [
      tile({ name: "Bravo", player_slug: "bravo", fmv_total_usd: 5, edition_count: 9 }),
      tile({ name: "Alpha", player_slug: "alpha", fmv_total_usd: 50, edition_count: 1 }),
    ]
    const { container, getByText } = render(
      <PlayersGridPaginated {...base} initial={rows} pageSize={12} />
    )
    // default FMV desc → Alpha (50) leads
    expect((container.textContent ?? "").indexOf("Alpha")).toBeLessThan((container.textContent ?? "").indexOf("Bravo"))
    fireEvent.click(getByText("Editions ↓")) // Bravo (9) leads
    let t = container.textContent ?? ""
    expect(t.indexOf("Bravo")).toBeLessThan(t.indexOf("Alpha"))
    fireEvent.click(getByText("A → Z")) // Alpha leads
    t = container.textContent ?? ""
    expect(t.indexOf("Alpha")).toBeLessThan(t.indexOf("Bravo"))
  })

  it("appends a page on Load more and exhausts on a short page", async () => {
    const rows = [tile({ name: "P1", player_slug: "p1" }), tile({ name: "P2", player_slug: "p2" })]
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => [tile({ name: "P3", player_slug: "p3" })] } as Response))
    )
    const { getByText, container, queryByText } = render(
      <PlayersGridPaginated {...base} initial={rows} pageSize={2} />
    )
    // initial.length === pageSize → Load more offered
    fireEvent.click(getByText("Load 2 more"))
    await waitFor(() => expect((container.textContent ?? "")).toContain("P3"))
    // returned 1 < pageSize 2 → exhausted, button gone
    await waitFor(() => expect(queryByText("Load 2 more")).toBeNull())
  })

  // ⚠⚠ INVERTED 2026-08-26. This test was named "exhausts (no crash) when Load
  // more errors" and asserted the Load-more button DISAPPEARS on a failed page.
  // That IS the defect: `catch { setExhausted(true) }` conflated "the upstream
  // said there are no more" with "we could not ask", so a TRUNCATED roster
  // rendered as a complete one with no way to retry — the same class as the
  // sitemap read that served 24,000 of 27,246 editions under a 200.
  //
  // ⚠ It is also a lesson in why the old assertion was worthless in BOTH
  // directions: after the fix the button reads "Try again", so
  // `queryByText("Load 2 more")` is still null and the original assertion
  // passes against the defect AND the fix, for opposite reasons.
  it("does NOT present a truncated list as complete when Load more errors", async () => {
    const rows = [tile({ name: "P1", player_slug: "p1" }), tile({ name: "P2", player_slug: "p2" })]
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 } as Response)))
    const { getByText, queryByText } = render(
      <PlayersGridPaginated {...base} initial={rows} pageSize={2} />
    )
    fireEvent.click(getByText("Load 2 more"))
    // The incompleteness must be DISCLOSED, and the list must stay expandable.
    await waitFor(() => expect(getByText(/this list may be incomplete/i)).toBeTruthy())
    expect(getByText("Try again")).toBeTruthy()
    expect(queryByText("P1")).toBeTruthy()
  })

  it("NO-CHANGE CONTROL — a genuinely short page still exhausts and offers nothing more", async () => {
    // Without this, never exhausting would satisfy the test above while leaving
    // a Load-more button on a list that really has ended.
    const rows = [tile({ name: "P1", player_slug: "p1" }), tile({ name: "P2", player_slug: "p2" })]
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => [tile({ name: "P3", player_slug: "p3" })] } as unknown as Response)))
    const { getByText, queryByText } = render(
      <PlayersGridPaginated {...base} initial={rows} pageSize={2} />
    )
    fireEvent.click(getByText("Load 2 more"))
    await waitFor(() => expect(queryByText("Load 2 more")).toBeNull())
    expect(queryByText(/this list may be incomplete/i)).toBeNull()
    expect(queryByText("Try again")).toBeNull()
  })

  it("does not offer Load more when the first page is already short", () => {
    const rows = [tile({ name: "Solo", player_slug: "solo" })]
    const { queryByText } = render(
      <PlayersGridPaginated {...base} initial={rows} pageSize={12} />
    )
    expect(queryByText("Load 12 more")).toBeNull()
  })

  it("renders the rookie badge and the no-image fallback", () => {
    const rows = [
      tile({ name: "Rookie", player_slug: "rook", is_rookie: true, headshot_url: null, portrait_thumbnail: null, jersey_number: 23, position: "SG" }),
    ]
    const { container } = render(
      <PlayersGridPaginated {...base} initial={rows} pageSize={12} />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("No image") // both image sources null
    expect(text).toContain("#23") // jersey + position line
  })
})
