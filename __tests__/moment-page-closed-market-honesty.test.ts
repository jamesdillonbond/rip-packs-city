import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import path from "path"

// ARCHITECTURE GUARD — the moment page + OG card must not publish a current-tense
// FMV / sales-count claim it cannot stand behind.
//
// WHY THIS EXISTS
//   The 2026-08-04 closure work (20cef621) caps fmv_snapshots.confidence to STALE
//   for closed markets, but the carry-forward still re-stamps fmv_usd and
//   sales_count_30d forward daily. So a UFC moment page rendered "Current FMV
//   $313.43 / 7 sales / 30d" beside a "Flow trading frozen since May 2026" banner
//   with a last sale 524 days ago — the page disagreed with itself.
//
//   Two rules close it, and this guard pins both against a silent regression:
//     1. Hero FMV: suppressed for a CLOSED market (isMarketClosed) — a value that
//        can never be current again must not render as "Current FMV". Gated on
//        closure (not STALE) on purpose: 577 live Top Shot editions are
//        STALE-but-recently-traded and must keep their price.
//     2. "N sales / 30d": suppressed whenever the last sale is older than 30 days
//        (days_since_sale > 30) — a self-contradiction, systemic on the closed
//        market and a small self-correcting tail elsewhere. Mirrors the
//        fmv_snapshots_zero_stale_sales_count DB trigger.
//
//   These live inline in a DB-driven server component, so this is a source guard
//   (same convention as invariants-closed-market-disclosure.test.ts).

const REPO = process.cwd()
const read = (rel: string) => readFileSync(path.join(REPO, rel), "utf8")

const MOMENT_PAGE = "app/moment/[id]/page.tsx"
const OG_ROUTE = "app/api/og/moment/[id]/route.tsx"

describe("invariant: moment page suppresses dead current-FMV claims on closed markets", () => {
  it("moment page imports isMarketClosed", () => {
    expect(read(MOMENT_PAGE)).toMatch(/from\s+["']@\/lib\/market-closed["']/)
  })

  it("hero FMV is gated on market closure, not shown unconditionally", () => {
    const src = read(MOMENT_PAGE)
    // The closure boolean is derived and the hero value/color read a gate, not a
    // bare `f.fmv_usd != null`.
    expect(src, "marketClosed must be derived via isMarketClosed").toMatch(
      /const\s+marketClosed\s*=\s*isMarketClosed\(/,
    )
    expect(src, "showHeroFmv gate must exist and exclude closed markets").toMatch(
      /const\s+showHeroFmv\s*=\s*[^\n]*!marketClosed/,
    )
    expect(src, "the hero number must render via showHeroFmv").toMatch(
      /\{\s*showHeroFmv\s*\?\s*fmtUsd/,
    )
  })

  it("the '/ 30d' sales-count subtitle is gated on days_since_sale <= 30", () => {
    const src = read(MOMENT_PAGE)
    expect(src, "showSalesCount must gate on days_since_sale").toMatch(
      /const\s+showSalesCount\s*=\s*\(f\?\.days_since_sale\s*\?\?\s*0\)\s*<=\s*30/,
    )
    expect(src, "the sales-count block must consume showSalesCount").toMatch(
      /\{\s*showSalesCount\s*&&\s*\(f\?\.sales_count_30d/,
    )
  })

  it("SEO description suppresses the sales claim when the last sale is >30d old", () => {
    // sales30 (used in the meta description) must not carry a raw count once the
    // last sale is older than 30 days.
    expect(read(MOMENT_PAGE)).toMatch(
      /days_since_sale\s*\?\?\s*0\)\s*>\s*30\s*\?\s*0\s*:/,
    )
  })

  it("OG card suppresses Current FMV on a closed market", () => {
    const src = read(OG_ROUTE)
    expect(src).toMatch(/from\s+["']@\/lib\/market-closed["']/)
    expect(src, "fmv must be nulled when the market is closed").toMatch(
      /marketClosed\s*\?\s*null\s*:/,
    )
  })
})
