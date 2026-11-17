// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { renderToString } from "react-dom/server"
import { render, cleanup } from "@testing-library/react"

// The /insights/top-sales board threw React #418 (a hydration TEXT mismatch) in
// production on 2026-08-16, caught by a live console read — no gate in this repo
// could see it, because vitest and the CI runner both render "server" and
// "client" in the same process at the same instant.
//
// ── THE MECHANISM ──────────────────────────────────────────────────────────
// The board read the WALL CLOCK during render, in two places:
//
//   relTime(iso)      -> `Date.now() - then`, rendered at three call sites
//   recentRows memo   -> `Date.now() - 48h` cutoff for the "just sold" rail
//
// The page is ISR (`revalidate = 900`), so the HTML the browser receives can be
// up to 15 minutes old. Anything derived from "now" therefore differs between
// the server render and hydration.
//
// ⚠ WHAT IS AND IS NOT MEASURED. #418 WAS observed live on this page on
// 2026-08-16 (via pageerror, with a positive control proving the listener
// worked), and both reads above are unsafe BY CONSTRUCTION — which is what these
// cases pin. The specific culprit was NOT isolated: a first attempt reported the
// 48h rail as "13 server-side vs 12 hydrated" and that was an ARTIFACT, counting
// a raw-HTML string (the inlined `.rpc-ts-recent-when {` CSS rule adds one)
// against a DOM element count. Real rows were 12 vs 12. Because #418 reported
// `args[]=text` — a TEXT mismatch — relTime is the likelier culprit. These tests
// pin the PROPERTY (a server render must not move with the clock), which holds
// regardless of which read was firing.
//
// ── WHAT THIS PINS, AND WHY IT IS A SERVER RENDER ──────────────────────────
// The contract React actually enforces is: the SERVER render and the client's
// FIRST render must produce identical markup. `@testing-library/react`'s
// render() flushes effects, so it shows the POST-mount output and cannot see
// this class at all — after mount the board is *supposed* to use the live clock.
// So these cases use renderToString(), which is the server render, and assert it
// does not move when the clock does.
//
// Mutation-checked: restoring `Date.now()` in either place reds the matching
// case here (the two differ by 26 hours, which crosses both the "Nh ago"/"Nd
// ago" boundary and the 48h rail cutoff).

import TopSalesBoardClient, { type Row } from "@/app/insights/top-sales/TopSalesBoardClient"

// A fixed instant, and the snapshot the server says the data was fetched at.
// Both renders below get the SAME props — only the wall clock differs.
const FETCHED_AT = "2026-08-16T12:00:00.000Z"
const T1 = Date.parse("2026-08-16T12:05:00.000Z") // 5 min after the snapshot
const T2 = Date.parse("2026-08-17T14:05:00.000Z") // 26 h later — crosses both boundaries

function row(over: Partial<Row> & { sale_id: string }): Row {
  return {
    edition_id: "e1",
    external_id: "141:5156",
    collection: "nba_top_shot",
    collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
    player_name: "Victor Wembanyama",
    set_name: "Base Set",
    team_name: "San Antonio Spurs",
    tier: "LEGENDARY",
    circulation_count: 2999,
    thumbnail_url: "https://example.com/a.png",
    nft_id: "999",
    serial_number: 1,
    price_usd: 12500,
    sold_at: "2026-08-16T09:00:00.000Z",
    buyer_address: "0xbd94cade097e50ac",
    seller_address: "0xb5053ef95e702657",
    marketplace: "topshot",
    buyer_name: "whalebuyer",
    seller_name: null,
    ...over,
  } as Row
}

// Two rows straddling the 48h rail cutoff as measured from FETCHED_AT: one
// comfortably inside, one ~47h back. Under a live clock the second falls out of
// the window as time passes, which is exactly the 13-vs-12 divergence observed
// in production.
const ROWS: Row[] = [
  row({ sale_id: "recent", sold_at: "2026-08-16T09:00:00.000Z" }),
  row({ sale_id: "edge", sold_at: "2026-08-14T13:30:00.000Z", price_usd: 5000 }),
  row({ sale_id: "old", sold_at: "2026-08-10T00:00:00.000Z", price_usd: 900 }),
]

function serverRenderAt(nowMs: number): string {
  const spy = vi.spyOn(Date, "now").mockReturnValue(nowMs)
  try {
    return renderToString(<TopSalesBoardClient initialRows={ROWS} initialFetchedAt={FETCHED_AT} />)
  } finally {
    spy.mockRestore()
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("TopSalesBoardClient — hydration safety (React #418)", () => {
  it("server render is IDENTICAL across a 26-hour clock jump (same props)", () => {
    const a = serverRenderAt(T1)
    const b = serverRenderAt(T2)
    // Identical markup is the whole contract: whatever the browser's clock says
    // when it hydrates, it must reproduce what the server sent.
    expect(a).toBe(b)
  })

  it("the relative-time cells specifically do not move with the clock", () => {
    const ago = (html: string) => (html.match(/(?:just now|\d+[mhd] ago)/g) ?? []).join(",")
    const a = ago(serverRenderAt(T1))
    const b = ago(serverRenderAt(T2))
    // Guards-the-guard: if the board ever stops rendering relative times at all,
    // this case would pass vacuously on two empty strings.
    expect(a.length, "no relative-time text rendered — assertion would be vacuous").toBeGreaterThan(0)
    expect(a).toBe(b)
  })

  it("the 48h rail row count does not move with the clock", () => {
    const rail = (html: string) => (html.match(/rpc-ts-recent-when/g) ?? []).length
    const a = rail(serverRenderAt(T1))
    const b = rail(serverRenderAt(T2))
    expect(a, "no 48h rail rendered — assertion would be vacuous").toBeGreaterThan(0)
    expect(a).toBe(b)
  })

  it("relative times are anchored to fetched_at, so they are real values not placeholders", () => {
    // The fix must not degrade into rendering an em-dash for everything — that
    // would satisfy every assertion above while removing the feature. The
    // "recent" row sold 3h before FETCHED_AT, so the server must say "3h ago".
    expect(serverRenderAt(T1)).toContain("3h ago")
  })

  it("still swaps to the LIVE clock after mount (the feature survives the fix)", () => {
    // After hydration the board is supposed to track real time — the anchor is
    // only for the first render. render() flushes effects, so this observes the
    // post-mount state. At T2 the "recent" row is ~29h old, so it reads in days.
    const spy = vi.spyOn(Date, "now").mockReturnValue(T2)
    const { container } = render(
      <TopSalesBoardClient initialRows={ROWS} initialFetchedAt={FETCHED_AT} />,
    )
    spy.mockRestore()
    expect(container.textContent).toMatch(/\dd ago/)
  })

  it("a missing fetched_at yields a deterministic render rather than a guess", () => {
    // No anchor => no clock-derived output at all, identical on both sides.
    const spy = vi.spyOn(Date, "now").mockReturnValue(T1)
    const a = renderToString(<TopSalesBoardClient initialRows={ROWS} initialFetchedAt={null} />)
    spy.mockReturnValue(T2)
    const b = renderToString(<TopSalesBoardClient initialRows={ROWS} initialFetchedAt={null} />)
    spy.mockRestore()
    expect(a).toBe(b)
    expect(a).not.toMatch(/\d+[mhd] ago/)
  })
})
