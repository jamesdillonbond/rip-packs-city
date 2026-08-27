// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { renderToString } from "react-dom/server"
import { render, cleanup, waitFor } from "@testing-library/react"
import type { UnderpricedRow } from "@/lib/underpriced-serials-board"

// /insights/underpriced-serials threw React #418 in PRODUCTION on 2026-08-26,
// caught by the scheduled `E2E DOM Smoke` monitor at 13:37Z and 21:09Z — both
// runs, all three retries, 1 failed / 95 passed — while three earlier runs the
// same day were green.
//
// ── THE MECHANISM ──────────────────────────────────────────────────────────
// The board computed `listingsAgeHours` from `Date.now()` inside a useMemo, i.e.
// DURING RENDER, and fed it to a caption that is unsafe in TWO ways at once:
//
//   {age >= 4 ? <span>Listings last refreshed {Math.round(age)}h ago</span> : null}
//
//   - STRUCTURAL: the element exists on one side of the 4-hour threshold and
//     not on the other.
//   - TEXTUAL: `Math.round(age)` changes every hour.
//
// ⚠ AND THE SERVER/CLIENT CLOCK GAP IS NOT THE 900 s `revalidate` WINDOW — it is
// unbounded. Next serves the stale cached page while it regenerates, so on a
// near-zero-traffic site the HTML can be hours old: measured 2026-08-27 02:40Z,
// the served page's own server stamp read 00:12:06Z, 2.5 h earlier. That is why
// the observed error was `args[]=HTML` (a STRUCTURAL mismatch) rather than
// `args[]=text` — the sibling defect on /insights/top-sales (2026-08-16) was the
// text flavour of the same class.
//
// ── WHY THESE ARE SERVER RENDERS ───────────────────────────────────────────
// The contract React enforces is that the SERVER render and the client's FIRST
// render must match. `@testing-library/react`'s render() flushes effects, so it
// shows the POST-mount output — where the live clock is CORRECT — and is
// structurally blind to this class. So the cases below use renderToString() and
// assert it does not move when the clock does.
//
// Mutation-checked 2026-08-26, and the exact count is recorded because "some of
// them red" is not a check: restoring `Date.now()` in the memo reds FOUR of the
// six cases — the whole-render identity, the caption's TEXT, the caption's
// PRESENCE, and the no-anchor case. The two that stay green are the two that
// should: the anchored-value case (at T1, five minutes after bake, a live clock
// happens to agree) and the post-mount case (where the live clock is the point).
// A test that went red on all six would be pinning the clock, not the contract.

import UnderpricedSerialsBoardClient from "@/app/insights/underpriced-serials/UnderpricedSerialsBoardClient"

const row = (o: Partial<UnderpricedRow> = {}): UnderpricedRow =>
  ({
    edition_id: "ed-1", external_id: "3:45", edition_key: "3:45", player_name: "Damian Lillard",
    set_name: "Base Set", tier: "LEGENDARY", circulation_count: 499, thumbnail_url: null, nft_id: "111",
    serial_number: 1, kind: "first", ask_usd: 80, serial_fmv_usd: 200, edition_fmv_usd: 150,
    confidence: "HIGH", discount_pct: 60, discount_usd: 120, estimate_quality: "tight",
    listing_url: "https://x", listed_at: "2026-08-26T05:00:00.000Z",
    last_seen_at: "2026-08-26T05:22:00.000Z",
    ...o,
  }) as UnderpricedRow

// Real timings from the incident: the Atlas listings ingest last SUCCEEDED at
// 05:22Z (it then egress-blocked for hours), and the monitor failed at 21:09Z.
const STALE_ROWS: UnderpricedRow[] = [row()]
const FRESH_ROWS: UnderpricedRow[] = [row({ last_seen_at: "2026-08-26T19:13:00.000Z" })]

const BAKED_AT_STALE = "2026-08-26T15:30:00.000Z" // spine 10.1 h old at bake
const BAKED_AT_FRESH = "2026-08-26T21:09:00.000Z" // spine 1.9 h old at bake

const T1 = Date.parse("2026-08-26T15:35:00.000Z")
const T2 = Date.parse("2026-08-26T21:09:00.000Z") // ~6 h later — crosses the rounding boundary
const T3 = Date.parse("2026-08-27T00:00:00.000Z") // crosses the 4-hour THRESHOLD for FRESH_ROWS

function serverRenderAt(nowMs: number, rows: UnderpricedRow[], fetchedAt: string | null): string {
  const spy = vi.spyOn(Date, "now").mockReturnValue(nowMs)
  try {
    return renderToString(
      <UnderpricedSerialsBoardClient initialRows={rows} initialFetchedAt={fetchedAt} />,
    )
  } finally {
    spy.mockRestore()
  }
}

// ⚠ React's SSR output separates adjacent text nodes with `<!-- -->` markers, so
// the caption reaches this file as "Listings last refreshed <!-- -->10<!-- -->h
// ago". Strip them before matching — matching the raw HTML instead silently
// finds nothing, which would make every assertion below vacuous rather than red.
const stripMarkers = (html: string) => html.replace(/<!-- -->/g, "")
const captions = (html: string) =>
  (stripMarkers(html).match(/Listings last refreshed \d+h ago/g) ?? []).join(",")

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ user: null }) })),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("UnderpricedSerialsBoardClient — hydration safety (React #418)", () => {
  it("server render is IDENTICAL across a ~6-hour clock jump (same props)", () => {
    expect(serverRenderAt(T1, STALE_ROWS, BAKED_AT_STALE)).toBe(
      serverRenderAt(T2, STALE_ROWS, BAKED_AT_STALE),
    )
  })

  it("the stale-listings caption specifically does not move with the clock", () => {
    const a = captions(serverRenderAt(T1, STALE_ROWS, BAKED_AT_STALE))
    const b = captions(serverRenderAt(T2, STALE_ROWS, BAKED_AT_STALE))
    // Guards-the-guard: if the caption ever stops rendering, the comparison
    // above would pass vacuously on two empty strings — which is precisely how
    // a "fix" that just deletes the feature would sail through.
    expect(a.length, "no caption rendered — the assertion would be vacuous").toBeGreaterThan(0)
    expect(a).toBe(b)
  })

  it("the caption's PRESENCE does not move with the clock either (the structural half)", () => {
    // The observed production error was args[]=HTML, not args[]=text: with a
    // fresh spine at bake time the element is absent, and a later client clock
    // would have made it appear. Both server renders must agree.
    const a = serverRenderAt(T2, FRESH_ROWS, BAKED_AT_FRESH)
    const b = serverRenderAt(T3, FRESH_ROWS, BAKED_AT_FRESH)
    expect(a).toBe(b)
    expect(captions(a), "spine was fresh at bake time, so no caption belongs here").toBe("")
  })

  it("the caption is anchored to the SERVER's stamp, so it is a real value not a placeholder", () => {
    // 05:22Z spine, 15:30Z bake => 10.1 h. The fix must not degrade into
    // rendering nothing, which would satisfy every identity assertion above
    // while removing an honesty surface from the served HTML.
    expect(stripMarkers(serverRenderAt(T1, STALE_ROWS, BAKED_AT_STALE))).toContain(
      "Listings last refreshed 10h ago",
    )
  })

  it("still swaps to the LIVE clock after mount (the feature survives the fix)", async () => {
    // After hydration the board is supposed to track real time — the anchor is
    // only for the first render. render() flushes effects, so this observes the
    // post-mount state: at T2 the 05:22Z spine is 15.8 h old.
    const spy = vi.spyOn(Date, "now").mockReturnValue(T2)
    const { container } = render(
      <UnderpricedSerialsBoardClient initialRows={STALE_ROWS} initialFetchedAt={BAKED_AT_STALE} />,
    )
    await waitFor(() => expect(container.textContent).toContain("Listings last refreshed 16h ago"))
    spy.mockRestore()
  })

  it("a missing fetched_at yields a deterministic render rather than a guess", () => {
    // A failed seed carries no stamp. With no anchor there is no clock-derived
    // output at all — identical on both sides, and no invented staleness claim.
    const a = serverRenderAt(T1, STALE_ROWS, null)
    const b = serverRenderAt(T2, STALE_ROWS, null)
    expect(a).toBe(b)
    expect(captions(a)).toBe("")
  })
})
