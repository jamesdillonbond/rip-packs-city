import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import { computeWalletStatRow } from "../lib/portfolio-summary-compute"

// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// The SECOND instance of register #112, on a different function feeding a
// different surface. `get_wallet_summary` backs the COLLECTION TAB's headline
// "Unlocked FMV" tile and computed it as `SUM(CASE WHEN NOT is_locked …)`.
// `NOT is_locked` is TRUE for the column DEFAULT, and 1,160,468 of 1,767,936
// Top Shot rows were never checked — so the tile told collectors they could sell
// things nobody had verified. Measured on a real 17-moment wallet: $4.55 claimed
// unlocked where only $1.16 was verified, a ~3x overstatement.
//
// ⭐ Fixing get_wallet_moments_with_fmv did NOT fix this. #112's filing named
// three surfaces and missed this fourth, which is why the guard below pins the
// COMPUTE layer rather than one route: the next such function will feed a fifth.
//
// ── AND THE MIRROR DEFECT, REMOVED IN THE SAME CHANGE ────────────────────────
// `computeWalletStatRow` suppressed All Day lock state entirely
// (`lockUntracked = collectionSlug === "nfl-all-day"` → null → "not tracked") on
// a comment saying its flags were "frozen at a past manual run". Re-derived
// 2026-09-13: All Day is 99.6% checked within 7 days, nothing older than 3 days,
// `allday-lock-refresh` writing 326,787 rows/day — the FRESHEST lock data of any
// collection. The suppression hid 140,084 genuinely locked moments. An `unknown`
// that is actually KNOWN is the same defect as a `false` that was never read.
//
// ⛔ The replacement is NOT another hardcoded list. Provenance decides per row.
// A per-collection allowlist is the guard-that-names-its-instances shape: right
// when written, wrong within weeks, and silent when it went wrong.

const COMPUTE = "lib/portfolio-summary-compute.ts"
const STATROW = "components/wallet-stat-row.tsx"
const read = (p: string) => stripComments(readFileSync(join(process.cwd(), p), "utf8"))

const summary = (over: Record<string, unknown> = {}) =>
  ({
    total_moments: 17,
    wallet_fmv: 5.48,
    unlocked_fmv: 1.16,
    unlocked_count: 4,
    locked_fmv: 0.93,
    locked_count: 3,
    stale_fmv: 0,
    stale_count: 0,
    lock_unknown_fmv: 3.39,
    lock_unknown_count: 10,
    ...over,
  }) as never

const totals = {
  totalFmv: 0,
  totalCount: 0,
  unlockedFmv: 0,
  unlockedCount: 0,
  lockedFmv: 0,
  lockedCount: 0,
  totalBestOffer: 0,
} as never

const call = (collectionSlug: string, walletSummary: unknown = summary()) =>
  computeWalletStatRow({
    walletSummary: walletSummary as never,
    walletTotalFmv: null,
    totals,
    paginatedTotal: 0,
    collectionSlug,
  })

describe("the unchecked bucket reaches the collection tab", () => {
  it("⭐ carries lockUnknown through instead of folding it into unlocked", () => {
    const r = call("nba-top-shot")
    expect(r.lockUnknownFmv).toBe(3.39)
    expect(r.lockUnknownCount).toBe(10)
    // ⛔ And the unlocked figure is the VERIFIED one, not verified+unknown.
    expect(r.unlockedFmv).toBe(1.16)
    expect(r.unlockedFmv).not.toBe(1.16 + 3.39)
  })

  it("an older summary without the keys reports null, not a confident zero", () => {
    const r = call("nba-top-shot", summary({ lock_unknown_fmv: undefined, lock_unknown_count: undefined }))
    expect(r.lockUnknownFmv).toBeNull()
    expect(r.lockUnknownCount).toBeNull()
  })

  it("with no authoritative summary it is null — the client-side totals have no provenance", () => {
    const r = computeWalletStatRow({
      walletSummary: null as never,
      walletTotalFmv: null,
      totals: { ...(totals as object), totalCount: 5, unlockedFmv: 9, unlockedCount: 5 } as never,
      paginatedTotal: 0,
      collectionSlug: "nba-top-shot",
    })
    expect(r.lockUnknownFmv).toBeNull()
    expect(r.lockUnknownCount).toBeNull()
  })
})

describe("⛔ All Day lock state is no longer suppressed by collection slug", () => {
  it("All Day reports its locked figures like every other collection", () => {
    const r = call("nfl-all-day")
    expect(r.lockedFmv).toBe(0.93)
    expect(r.lockedCount).toBe(3)
  })

  it("and it is identical to another collection given identical input", () => {
    // The property is that the SLUG no longer changes the answer. If someone
    // reintroduces a per-collection rule this diverges, whatever it is named.
    const a = call("nfl-all-day")
    const b = call("nba-top-shot")
    expect(a.lockedFmv).toBe(b.lockedFmv)
    expect(a.lockedCount).toBe(b.lockedCount)
    expect(a.lockUnknownCount).toBe(b.lockUnknownCount)
  })

  it("no collection-slug allowlist decides lock state in the source", () => {
    const src = read(COMPUTE)
    expect(src).not.toMatch(/lockUntracked/)
    // Belt: no slug comparison anywhere near a lock field.
    expect(src).not.toMatch(/collectionSlug\s*===\s*"nfl-all-day"/)
  })
})

describe("the tile DISCLOSES the bucket", () => {
  const src = read(STATROW)

  it("renders the unchecked count — a split nobody sees is not a split", () => {
    expect(src).toMatch(/lockUnknownCount/)
    expect(src).toMatch(/not checked/)
  })

  it("⛔ and never adds it into the unlocked figure", () => {
    expect(src).not.toMatch(/unlockedFmv\s*\+\s*[^)\n]*lockUnknownFmv/)
    expect(src).not.toMatch(/lockUnknownFmv\s*\+\s*[^)\n]*unlockedFmv/)
  })

  it("the guards above read real files", () => {
    expect(read(COMPUTE).length).toBeGreaterThan(1500)
    expect(src.length).toBeGreaterThan(1500)
  })
})
