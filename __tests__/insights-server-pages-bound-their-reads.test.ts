import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

// Every PRERENDERED `/insights` server page must bound its data read.
//
// ── THE INCIDENT ───────────────────────────────────────────────────────────
// Two production deploys ERRORed on 2026-08-15 within ten minutes —
// `/insights/market` and `/insights/market-pulse`, a DIFFERENT page each time,
// neither touched by the commit that failed (one was tests-only) — both on
// "Timed out acquiring connection from connection pool" ending in "Export
// encountered an error … exiting the build".
//
// Next gives each prerendered page 60s to export, retries 3×, then kills the
// whole build. So an unbounded board read is not a slow page, it is a coin flip
// on every deploy, resolved by whichever board the saturation happens to land
// on. Measured at the time: only 5 of 30 pages bounded anything.
//
// ── WHY A BAN AND NOT A RATCHET ────────────────────────────────────────────
// The repo's usual answer to a large pre-existing population is a ratchet,
// because a ban would ship a 30-entry allowlist. Here the population was driven
// to ZERO in the same pass, so a ban carries no allowlist and no exceptions —
// it is enforceable rather than theatre. If a page ever needs a genuine
// exemption, that is a deliberate decision to argue for, not a default.
//
// ── THIS IS THE THIRD INSTANCE OF ONE CLASS ────────────────────────────────
// `BOARD_LIVE_TIMEOUT_MS` was created for it on first-mint; `SET_DETAIL_TIMEOUT_MS`
// fixed it on `/analytics/sets`. Both prior fixes were applied to the ONE page
// that failed rather than to the shape, which is exactly why it came back twice.
// This test is the shape-level fix.

const INSIGHTS_DIR = join(process.cwd(), "app", "insights")
const USE_CLIENT = /^\s*["']use client["']/

/** Any of the sanctioned bounded paths.
 *
 * ⚠ The `(?:<[^>]*>)?` is load-bearing, not defensive: most call sites supply an
 * explicit type argument (`fetchBoardForPage<MarketPulseRow[]>(...)`), so a
 * plain `name\s*\(` matched NONE of the eight pages that route through the
 * shared fetcher. The first version of this guard did exactly that and reported
 * nine correctly-bounded pages as offenders. */
const BOUNDED = [
  // The board snapshot ladder — bounds internally via BOARD_LIVE_TIMEOUT_MS.
  /readBoardOrLive\s*(?:<[^>]*>)?\s*\(/,
  // The shared page fetcher — bounds internally.
  /fetchBoardForPage\s*(?:<[^>]*>)?\s*\(/,
  // The two explicit primitives, for pages with their own fetch shape.
  /withBoardBudget\s*(?:<[^>]*>)?\s*\(/,
  /withPagedBoardBudget\s*(?:<[^>]*>)?\s*\(/,
]

/** Async server pages under app/insights — the ones Next prerenders with a read. */
function asyncServerPages(): string[] {
  const out: string[] = []
  for (const entry of readdirSync(INSIGHTS_DIR)) {
    const dir = join(INSIGHTS_DIR, entry)
    if (!statSync(dir).isDirectory()) continue
    const file = join(dir, "page.tsx")
    let src: string
    try {
      src = readFileSync(file, "utf8")
    } catch {
      continue
    }
    // Client pages do their reads in the browser — no export budget to blow.
    if (USE_CLIENT.test(src.split("\n").slice(0, 3).join("\n"))) continue
    // A synchronous server page is a static shell with no read to bound
    // (`account-value` is one). `export default async function` is the tell.
    if (!/export default async function/.test(src)) continue
    out.push(entry)
  }
  return out.sort()
}

describe("/insights server pages bound their reads", () => {
  const pages = asyncServerPages()

  it("is not vacuous: it found the prerendered board pages", () => {
    expect(pages.length).toBeGreaterThanOrEqual(20)
    // The two that actually broke production builds, named so a rename cannot
    // silently drop either out of the checked set.
    expect(pages).toContain("market")
    expect(pages).toContain("market-pulse")
  })

  it("excludes client pages and static shells rather than exempting them", () => {
    // These are OUT of scope for a real reason, not allowlisted: a client page
    // reads in the browser, and a synchronous server page has no read at all.
    // Asserted so the exclusion stays a property rather than becoming a place to
    // hide an unbounded page by adding "use client" to the top.
    for (const clientPage of ["squeeze-check", "tc-report", "pack-reality"]) {
      const src = readFileSync(join(INSIGHTS_DIR, clientPage, "page.tsx"), "utf8")
      expect(USE_CLIENT.test(src.split("\n").slice(0, 3).join("\n"))).toBe(true)
    }
    const shell = readFileSync(join(INSIGHTS_DIR, "account-value", "page.tsx"), "utf8")
    expect(shell).not.toMatch(/export default async function/)
    expect(shell).not.toMatch(/supabaseAdmin/)
  })

  it.each(asyncServerPages())("/insights/%s bounds its read", (page) => {
    const src = readFileSync(join(INSIGHTS_DIR, page, "page.tsx"), "utf8")
    const bounded = BOUNDED.some((re) => re.test(src))
    expect(
      bounded,
      `/insights/${page} reads the DB during a PRERENDER without a budget.\n` +
        `Next kills the whole build if any page exceeds 60s, so this is a build-\n` +
        `integrity defect, not a slow page. Use one of:\n` +
        `  readBoardOrLive(...)        — the cached-board ladder\n` +
        `  fetchBoardForPage(...)      — the shared page fetcher\n` +
        `  withBoardBudget(p, label)   — rejects; for a page with a try/catch\n` +
        `  withPagedBoardBudget(p, l)  — resolves { rows, error }; for fetchAllPaged`,
    ).toBe(true)
  })

  it("no page is left unbounded — the count is zero, so there is no allowlist", () => {
    const unbounded = pages.filter((page) => {
      const src = readFileSync(join(INSIGHTS_DIR, page, "page.tsx"), "utf8")
      return !BOUNDED.some((re) => re.test(src))
    })
    expect(unbounded, `unbounded: ${unbounded.join(", ")}`).toEqual([])
  })
})
