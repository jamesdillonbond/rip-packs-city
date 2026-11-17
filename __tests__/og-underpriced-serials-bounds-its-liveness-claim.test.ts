import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { installOgCapture, resetOgCapture, ogText, type OgCapture } from "./helpers/og-capture"
import { boardMaxAgeHours, boardLivenessLabel } from "@/lib/og/board-freshness"

// The Underpriced #1s OG card must not print "Live deals" over a FROZEN board.
//
// ── THE DEFECT ──────────────────────────────────────────────────────────────
// `topshot_underpriced_serials_board` gates on `l.active`. `active` is cleared
// ONLY by `deactivate_stale_topshot_active_listings`, which runs ONLY ON A
// SUCCESSFUL INGEST — so a failing ingest FREEZES the flag and sold or delisted
// moments stay on the board with a reassuringly non-zero count.
//
// ⚠ This is NOT the fabricated-number shape. The count is real `active` rows.
// It is an UNBOUNDED LIVENESS CLAIM, on the widest-reach surface the platform
// has (Twitter / iMessage / Slack unfurls) and edge-cached on top of that.
//
// The PAGE has bounded this since 2026-08-16 ("Listings last refreshed {N}h ago"
// at >= 4h). Its own social card did not — the documented "fix per PANEL, not
// per page" shape, filed as the residual on known-issues #30.
//
// ── WHAT THESE TESTS ASSERT, AND WHY IN THIS DIRECTION ──────────────────────
// The ABSENCE of the false claim, never the presence of a message. A test that
// only asserted "renders 22h ago" would still pass if the card printed BOTH the
// age and "Live deals" — which is the same overclaim with a caveat glued on.
// So the stale case asserts `not.toMatch(/Live deals/)`.
//
// ⚠ And the fresh case asserts the claim IS present. Without it, deleting the
// liveness line entirely would satisfy every other test in this file — a guard
// that can be passed by removing the feature is not a guard.

const capture: { c: OgCapture | null } = { c: null }

/** A board row as the public API actually returns it (field names verified live 2026-08-24). */
function row(lastSeenAt: string | null) {
  return {
    player_name: "Test Player",
    set_name: "Test Set",
    tier: "MOMENT_TIER_RARE",
    serial_number: 1,
    circulation_count: 500,
    kind: "first",
    ask_usd: 50,
    serial_fmv_usd: 100,
    discount_pct: 50,
    estimate_quality: "tight",
    last_seen_at: lastSeenAt,
  }
}

/**
 * Drive the route with a board whose spine is `ageHours` old.
 * `null` => rows carry no timestamp at all, i.e. the age is UNKNOWABLE.
 */
function mockBoard(ageHours: number | null) {
  const stamp =
    ageHours == null ? null : new Date(Date.now() - ageHours * 3_600_000).toISOString()
  globalThis.fetch = vi.fn(async () => {
    const rows = [row(stamp), row(stamp)]
    return new Response(
      JSON.stringify({ rows, meta: { returned_rows: rows.length, truncated: false } }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }) as unknown as typeof globalThis.fetch
}

async function renderCard(): Promise<string> {
  const mod = await import("@/app/api/og/insights/underpriced-serials/route")
  await mod.GET(new NextRequest("https://www.rippackscity.com/api/og/insights/underpriced-serials"))
  return ogText(capture.c!.element())
}

beforeEach(() => {
  resetOgCapture()
  capture.c = installOgCapture()
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
  resetOgCapture()
})

describe("boardMaxAgeHours", () => {
  const NOW = Date.parse("2026-08-24T12:00:00.000Z")
  const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString()

  it("takes the NEWEST timestamp, not the oldest", () => {
    // ⚠ Direction matters. Every row's last_seen_at is a LOWER bound on when the
    // ingest last ran, so the newest is the tightest bound available. Taking the
    // min would report a board as stale on the strength of one laggard row.
    const age = boardMaxAgeHours([row(iso(30)), row(iso(2)), row(iso(19))], "last_seen_at", NOW)
    expect(age).toBeCloseTo(2, 5)
  })

  it("returns null — NOT zero — when nothing carries a usable timestamp", () => {
    // A zero here would be the `?? 0` fabricated-number shape wearing a
    // different hat: it would report an unreadable spine as freshly refreshed.
    expect(boardMaxAgeHours([], "last_seen_at", NOW)).toBeNull()
    expect(boardMaxAgeHours([row(null), row(null)], "last_seen_at", NOW)).toBeNull()
    expect(boardMaxAgeHours([row("not a date")], "last_seen_at", NOW)).toBeNull()
    expect(boardMaxAgeHours([{ other_field: iso(1) }], "last_seen_at", NOW)).toBeNull()
  })

  it("clamps a future timestamp to 0 rather than reporting a negative age", () => {
    expect(boardMaxAgeHours([row(iso(-5))], "last_seen_at", NOW)).toBe(0)
  })
})

describe("boardLivenessLabel has three states, not two", () => {
  it("under the threshold, makes the live claim", () => {
    expect(boardLivenessLabel(1.5, "Live deals")).toBe("Live deals")
  })

  it("at or over the threshold, replaces the claim with the measured age", () => {
    expect(boardLivenessLabel(4, "Live deals")).toBe("Listings last refreshed 4h ago")
    expect(boardLivenessLabel(22.4, "Live deals")).toBe("Listings last refreshed 22h ago")
  })

  it("makes NO claim at all when the age is unknown", () => {
    // Not "live", and not a fabricated age either. The caller renders its
    // remaining copy without a liveness claim.
    expect(boardLivenessLabel(null, "Live deals")).toBeNull()
  })

  it("uses the PAGE's 4h threshold by default", () => {
    // The number is copied from UnderpricedSerialsBoardClient.tsx on purpose.
    // The page and its own social card disagreeing about whether the board is
    // live is the defect this file exists to prevent. If someone retunes the
    // page, this pins that the card was considered.
    expect(boardLivenessLabel(3.99, "Live deals")).toBe("Live deals")
    expect(boardLivenessLabel(4.0, "Live deals")).not.toBe("Live deals")
  })
})

describe("the Underpriced #1s OG card bounds its liveness claim", () => {
  it("does NOT print 'Live deals' when the spine is 22h old", async () => {
    // The p90 of the measured ingest-gap distribution. The card used to print
    // "Live deals · buy on Dapper" here with no age signal anywhere on it.
    mockBoard(22)
    const text = await renderCard()
    expect(text).not.toMatch(/Live deals/)
    expect(text).toMatch(/last refreshed 22h ago/)
  })

  it("DOES print 'Live deals' when the spine is fresh", async () => {
    // The other direction, so the guard cannot be satisfied by deleting the
    // feature it guards.
    mockBoard(1)
    const text = await renderCard()
    expect(text).toMatch(/Live deals/)
    expect(text).not.toMatch(/last refreshed/)
  })

  it("makes NO liveness claim when the rows carry no timestamp", async () => {
    // Third state. Neither "Live deals" nor an invented age — but the card
    // still has to be a card, so the call to action survives.
    mockBoard(null)
    const text = await renderCard()
    expect(text).not.toMatch(/Live deals/)
    expect(text).not.toMatch(/last refreshed/)
    expect(text).toMatch(/buy on Dapper/)
  })

  it("keeps the headline count, which was never the defective part", async () => {
    // The count is real `active` rows. This fix must not have "helpfully"
    // suppressed it — an honest number removed is a regression, not a fix.
    mockBoard(22)
    const text = await renderCard()
    expect(text).toMatch(/2 live deals/)
  })
})
