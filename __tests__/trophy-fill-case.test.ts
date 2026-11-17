import { describe, it, expect } from "vitest"
import { provablyHeld, rankFillCandidates, topShotThumbnail, type FillCandidateRow } from "@/lib/trophy/fill-case"

// "Fill my case" (2026-11-08 weekend review). The ORDER must match the at-close
// fill (fill_partial_challenge_cases): new editions first, then highest FMV, then
// lowest serial — and a piece must be PROVABLY held, never merely present in an
// old walk of the wallet.

const NOW = Date.parse("2026-11-09T07:00:00Z")
const W = "0xabc"
const newest = new Map([[W, Date.parse("2026-11-09T04:00:00Z")]])

function row(over: Partial<FillCandidateRow>): FillCandidateRow {
  return {
    wallet_address: W,
    moment_id: "1",
    edition_key: "e1",
    fmv_usd: 1,
    serial_number: 100,
    last_seen_at: "2026-11-09T04:00:00Z",
    is_locked: false,
    lock_checked_at: null,
    ...over,
  }
}

describe("provablyHeld", () => {
  it("accepts a row seen in the wallet's latest walk (within a day of its newest row)", () => {
    expect(provablyHeld(row({ last_seen_at: "2026-11-08T05:00:00Z" }), newest, NOW)).toBe(true)
  })

  it("REJECTS a row the latest walk did not re-see (may be sold) when it is not locked", () => {
    expect(provablyHeld(row({ last_seen_at: "2026-08-16T06:28:47Z" }), newest, NOW)).toBe(false)
  })

  it("accepts a stale row that is LOCKED with a recent lock check (a locked moment cannot leave)", () => {
    expect(
      provablyHeld(row({ last_seen_at: "2026-08-16T06:28:47Z", is_locked: true, lock_checked_at: "2026-11-02T20:08:58Z" }), newest, NOW)
    ).toBe(true)
  })

  it("rejects a locked row whose lock check is older than 14 days", () => {
    expect(
      provablyHeld(row({ last_seen_at: "2026-08-16T06:28:47Z", is_locked: true, lock_checked_at: "2026-10-01T00:00:00Z" }), newest, NOW)
    ).toBe(false)
  })

  it("an unknown wallet newest (a failed read) leaves ONLY the locked branch — stricter, never looser", () => {
    expect(provablyHeld(row({}), new Map(), NOW)).toBe(false)
    expect(provablyHeld(row({ is_locked: true, lock_checked_at: "2026-11-08T00:00:00Z" }), new Map(), NOW)).toBe(true)
  })
})

describe("rankFillCandidates", () => {
  const opts = { pinnedMomentIds: new Set<string>(), pinnedEditions: new Set<string>(), walletNewestMs: newest, nowMs: NOW }

  it("orders by highest FMV, unpriced last", () => {
    const out = rankFillCandidates(
      [row({ moment_id: "a", fmv_usd: 0.5, edition_key: "ea" }), row({ moment_id: "b", fmv_usd: null, edition_key: "eb" }), row({ moment_id: "c", fmv_usd: "21.0000", edition_key: "ec" })],
      opts
    )
    expect(out.map((r) => r.moment_id)).toEqual(["c", "a", "b"])
  })

  it("puts an edition ALREADY in the case after every new edition, even a pricier one", () => {
    const out = rankFillCandidates(
      [row({ moment_id: "dup", edition_key: "e1", fmv_usd: 50 }), row({ moment_id: "new", edition_key: "e2", fmv_usd: 2 })],
      { ...opts, pinnedEditions: new Set(["e1"]) }
    )
    expect(out.map((r) => r.moment_id)).toEqual(["new", "dup"])
  })

  it("breaks an FMV tie on the lower serial", () => {
    const out = rankFillCandidates(
      [row({ moment_id: "hi", edition_key: "x", fmv_usd: 5, serial_number: 900 }), row({ moment_id: "lo", edition_key: "y", fmv_usd: 5, serial_number: 7 })],
      opts
    )
    expect(out.map((r) => r.moment_id)).toEqual(["lo", "hi"])
  })

  it("never re-offers a moment already in the case, and de-duplicates a moment seen under two rows", () => {
    const out = rankFillCandidates(
      [row({ moment_id: "in" }), row({ moment_id: "twice", edition_key: "t" }), row({ moment_id: "twice", edition_key: "t" })],
      { ...opts, pinnedMomentIds: new Set(["in"]) }
    )
    expect(out.map((r) => r.moment_id)).toEqual(["twice"])
  })

  it("drops a row that is not provably held", () => {
    const out = rankFillCandidates([row({ moment_id: "gone", last_seen_at: "2026-06-09T21:17:20Z" })], opts)
    expect(out).toEqual([])
  })
})

it("the Top Shot media URL matches the pins already stored", () => {
  expect(topShotThumbnail("42420298")).toBe("https://assets.nbatopshot.com/media/42420298/image?width=512")
})
