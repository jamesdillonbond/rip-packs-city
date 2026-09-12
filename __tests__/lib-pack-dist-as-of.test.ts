import { describe, it, expect, vi, afterEach } from "vitest"
import { asOfLabel, withAsOf } from "@/lib/pack-dist/as-of"

// ─────────────────────────────────────────────────────────────────────────────
// The property under test is an ABSENCE, not a format.
//
// The defect this module exists to prevent is a surface inventing freshness: the
// pack-dist Depletion tile rendered "live pool" over tier counts whose newest
// stamp was 15 days old, and the two supply-backed tiles rendered 73-day-old
// counters with no age at all. So the assertions below check that an UNKNOWN age
// never renders as a fresh one — asserting the absence of the false claim rather
// than the presence of a string, per CLAUDE.md's guards-and-tests rules.
// ─────────────────────────────────────────────────────────────────────────────

afterEach(() => vi.useRealTimers())

const NOW = new Date("2026-09-12T07:00:00.000Z")
function at(iso: string) {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  return iso
}

describe("asOfLabel", () => {
  it("states the age of a stamp it has", () => {
    expect(asOfLabel(at("2026-08-28T07:00:00.000Z"))).toBe("as of 15d ago")
  })

  it("uses hours inside a day and minutes inside an hour", () => {
    expect(asOfLabel(at("2026-09-12T04:00:00.000Z"))).toBe("as of 3h ago")
    expect(asOfLabel(at("2026-09-12T06:30:00.000Z"))).toBe("as of 30 min ago")
  })

  // ⚠ THE CORE CASE. A missing stamp must not become "just now" / "0m ago" /
  // an em-dash that reads as a rendered value — the caller has to be able to
  // OMIT the clause, which it can only do if null survives.
  it.each([null, undefined, "", "not-a-date"])(
    "returns null rather than a fresh-looking label for %p",
    (bad) => {
      vi.useFakeTimers()
      vi.setSystemTime(NOW)
      expect(asOfLabel(bad as string | null | undefined)).toBeNull()
    },
  )

  // A stale stamp must never round DOWN into a fresh-sounding bucket. This is
  // the 73-day topshot_pack_supply median, which is the number that motivated
  // the whole change.
  it("does not soften a 73-day-old stamp", () => {
    const label = asOfLabel(at("2026-06-28T07:00:00.000Z"))
    expect(label).toBe("as of 76d ago")
    expect(label).not.toMatch(/just now|min ago|\dh ago/)
  })

  // A clock-skewed or future stamp is clamped to "just now" by minutesSince's
  // Math.max(0, …) — pinned here so a future refactor cannot start rendering a
  // NEGATIVE age, which would read as a prediction.
  it("never renders a negative age", () => {
    expect(asOfLabel(at("2026-09-12T09:00:00.000Z"))).toBe("as of just now")
  })
})

describe("withAsOf", () => {
  it("joins the provenance noun to the age", () => {
    expect(withAsOf("pool", at("2026-08-28T07:00:00.000Z"))).toBe("pool · as of 15d ago")
  })

  // The noun says WHERE the number came from and stays true with no stamp; only
  // the WHEN is dropped. Crucially the result carries no freshness word.
  it("keeps the noun and adds nothing when the age is unknown", () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    expect(withAsOf("pool", null)).toBe("pool")
    expect(withAsOf("pool", null)).not.toMatch(/as of|live|just now/)
  })

  it("stands the age alone when there is no noun", () => {
    expect(withAsOf(null, at("2026-08-28T07:00:00.000Z"))).toBe("as of 15d ago")
    expect(withAsOf("", at("2026-08-28T07:00:00.000Z"))).toBe("as of 15d ago")
    expect(withAsOf("   ", at("2026-08-28T07:00:00.000Z"))).toBe("as of 15d ago")
  })

  // ⚠ null, not "". The callers hand this straight to a KpiCell `sub`, and an
  // empty string is a rendered (blank) sub-line rather than an absent one.
  it("returns null when it knows neither where nor when", () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    expect(withAsOf(null, null)).toBeNull()
    expect(withAsOf("", undefined)).toBeNull()
  })

  // ⚠ Pins the removal of the old label. "live pool" was rendered unconditionally
  // whenever a stamp existed, with no age check in the branch; nothing this
  // module produces may reintroduce an unearned freshness adjective.
  it("never emits an unverified freshness adjective", () => {
    for (const iso of ["2026-09-12T06:59:00.000Z", "2026-06-28T07:00:00.000Z", null]) {
      vi.useFakeTimers()
      vi.setSystemTime(NOW)
      expect(withAsOf("pool", iso)).not.toMatch(/\blive\b|\bcurrent\b|\bfresh\b/i)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The selectors. What is being pinned is PROVENANCE MATCHING: each tile shows the
// age of the read that produced the number beside it, or no age at all. A test
// that only checked "some stamp comes back" would pass for a selector that
// returned the wrong one, which is the failure mode that matters — so every case
// below uses three DISTINCT stamps and asserts WHICH one is chosen.
// ─────────────────────────────────────────────────────────────────────────────

import { depletionTileAsOf, packsRemainingTileAsOf } from "@/lib/pack-dist/as-of"

const SUPPLY = "2026-06-30T02:16:53.375Z" // allday_pack_supply.opened_updated_at
const DEPLETION = "2026-08-26T08:15:05.823Z" // pack_table_rows.depletion_as_of
const TIER = "2026-08-28T16:38:02.274Z" // metadata.tier_counts_updated_at

describe("depletionTileAsOf", () => {
  const base = {
    isAllDay: false,
    supplyAsOf: SUPPLY,
    depletionAsOf: DEPLETION,
    tierCountsUpdatedAt: TIER,
    metaTotalPackCount: 1000,
    metaTotalUnopened: 200,
  }

  it("dates the All Day tile from the supply read it actually renders", () => {
    expect(depletionTileAsOf({ ...base, isAllDay: true })).toBe(SUPPLY)
  })

  it("dates the v20 metadata path from the tier counts, not the supply read", () => {
    const got = depletionTileAsOf(base)
    expect(got).toBe(TIER)
    expect(got).not.toBe(SUPPLY)
    expect(got).not.toBe(DEPLETION)
  })

  // The v20 branch is guarded on `metaTotalPackCount > 0 && metaTotalUnopened != null`
  // in the page. Each way of failing that guard must fall through to the cached
  // figure's own stamp — a selector that returned TIER here would be dating a
  // number the page did not render.
  it.each([
    ["a zero denominator", { metaTotalPackCount: 0 }],
    ["a null denominator", { metaTotalPackCount: null }],
    ["a null numerator", { metaTotalUnopened: null }],
  ])("falls back to the cached depletion stamp on %s", (_label, over) => {
    expect(depletionTileAsOf({ ...base, ...over })).toBe(DEPLETION)
  })

  // ⚠ Golazos / Pinnacle have no supply lane at all, so the view returns null and
  // the tile must show no age rather than borrow one from a sibling field.
  it("returns null when no read in the chain has a stamp", () => {
    expect(
      depletionTileAsOf({ ...base, depletionAsOf: null, metaTotalPackCount: null }),
    ).toBeNull()
  })
})

describe("packsRemainingTileAsOf", () => {
  const base = {
    supplyAsOf: SUPPLY,
    tierCountsUpdatedAt: TIER,
    allDayUnopened: null as number | null,
    allDayTotalMinted: null as number | null,
    metaTotalUnopened: 200 as number | null,
    metaTotalPackCount: 1000 as number | null,
  }

  it("uses the supply stamp when both All Day counts came from it", () => {
    expect(
      packsRemainingTileAsOf({ ...base, allDayUnopened: 50, allDayTotalMinted: 1000 }),
    ).toBe(SUPPLY)
  })

  it("uses the tier-counts stamp when both v20 counts came from it", () => {
    expect(packsRemainingTileAsOf(base)).toBe(TIER)
  })

  // ⚠ THE CASE THE WHOLE SELECTOR EXISTS FOR. The page composes
  // `effectiveUnopened = allDayUnopened ?? liveUnopened` and
  // `effectiveTotalMinted = allDayTotalMinted ?? metaTotalPackCount`
  // INDEPENDENTLY, so the tile can render one number from each read. Dating that
  // pair with either stamp would attach an age to a number it does not describe.
  it.each([
    ["only the All Day remaining count", { allDayUnopened: 50, metaTotalUnopened: null }],
    ["only the All Day minted count", { allDayTotalMinted: 1000, metaTotalPackCount: null }],
  ])("shows no age when the pair is mixed — %s", (_label, over) => {
    expect(packsRemainingTileAsOf({ ...base, ...over })).toBeNull()
  })

  it("returns null when neither read supplied a complete pair", () => {
    expect(
      packsRemainingTileAsOf({ ...base, metaTotalUnopened: null, metaTotalPackCount: null }),
    ).toBeNull()
  })
})
