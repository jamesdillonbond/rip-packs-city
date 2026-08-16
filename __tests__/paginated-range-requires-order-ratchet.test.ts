import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

// RATCHET: a PostgREST `.range()` read whose query chain carries no `.order()`.
//
// ── WHY THIS EXISTS, AND WHY A COMMENT WAS NOT ENOUGH ───────────────────────
// lib/supabase-paginate.ts has stated the rule in plain words since it was
// written:
//
//     "The query MUST carry a deterministic .order(). Postgres gives no stable
//      row order without ORDER BY, so paging an unordered query can silently
//      duplicate rows on one page and drop them from another."
//
// That is exactly right, and it is exactly what happened — in the one place
// that hand-rolled its own paging loop instead of calling fetchAllPaged.
// `snapshot-institutional-wallets` paged wallet_moments_cache with .range() and
// no .order(). Measured 2026-08-16 on 0x4d2c9216f1dca098:
//
//     wallet_moments_cache   52,120 rows / 52,120 DISTINCT
//     the snapshot it wrote  52,123 entries / 45,059 DISTINCT
//
// The source cannot contain duplicates — UNIQUE(wallet_address, collection_id,
// moment_id) forbids it — so the reader manufactured ~7,064 duplicate reads and
// missed ~7,061 rows entirely. ⚠ The two roughly CANCEL, so `moment_count` came
// out within 3 of the truth and every count-based check passed. It read the
// right NUMBER of rows and the wrong SET.
//
// Downstream, compute_institutional_wallet_diff treated each day's missing ~7k
// as departures and the next day's different ~7k as arrivals, producing 161,366
// fabricated "buyback acquisitions" over three months — of which 41,301 of
// 41,307 distinct moments had been in the wallet since the very first snapshot.
//
// ⚠ THE SAME BUG IS HARMLESS OR CATASTROPHIC DEPENDING ON THE CONSUMER, which
// is why this is a ratchet and not a ban. The two sites in
// lib/chains/flow/wallet-backfill-helpers.ts had the identical defect on the
// identical table, and cost only redundant idempotent re-upserts, because their
// Set decides what to SKIP — absence means "do more work", not "an event
// happened". Judge a flagged site by what reads its output.
//
// ⚠ Not every entry below is a bug. A single `.range(0, N)` used as a "first N"
// limit does not duplicate or drop across pages; it is merely nondeterministic
// about WHICH N. Those are legitimately lower priority. What must not happen is
// a NEW hand-rolled paging LOOP without an order.
//
// Passing means the population did not GROW. It does not mean the 11 remaining
// sites are correct.

const ROOTS = ["app", "lib", "supabase/functions", "workers"]

/**
 * The ceiling. Lower it when you add an `.order()`; NEVER raise it.
 *
 * 13 when first measured (2026-08-16), immediately reduced to 11 by ordering the
 * two wallet_moments_cache paging loops in wallet-backfill-helpers.ts. The
 * snapshot-institutional-wallets site — the one that caused the incident — was
 * fixed in the same pass and is not counted here.
 */
const BUDGET = 11

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const e of entries) {
    if (e === "node_modules" || e.startsWith(".")) continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e) && !p.includes("__tests__")) out.push(p)
  }
  return out
}

/**
 * Blank comments AND string/template literals, preserving offsets.
 *
 * ⚠ Both passes are load-bearing and were added because the guard lied without
 * them. Comments: this very file, and the fixed call sites, quote `.range(` and
 * `.order(` in prose. Strings: snapshot-institutional-wallets builds a retry
 * LABEL containing the text "wmc.range(", which is not a query and was
 * reported as an offender AFTER the real defect there had been fixed.
 */
export function blankNonCode(src: string): string {
  let s = src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + " ".repeat(m.length - p.length))
  s = s
    .replace(/`(?:\\.|[^`\\])*`/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/'(?:\\.|[^'\\\n])*'/g, (m) => " ".repeat(m.length))
    .replace(/"(?:\\.|[^"\\\n])*"/g, (m) => " ".repeat(m.length))
  return s
}

/** Every `.range(` whose chain back to the nearest `.from(` has no `.order(`. */
export function findUnorderedRangeSites(roots: string[] = ROOTS): string[] {
  const hits: string[] = []
  for (const root of roots) {
    for (const file of walk(root)) {
      const src = blankNonCode(readFileSync(file, "utf8"))
      const re = /\.range\s*\(/g
      let m: RegExpExecArray | null
      while ((m = re.exec(src))) {
        const before = src.slice(0, m.index)
        const fromIdx = before.lastIndexOf(".from(")
        if (fromIdx === -1) continue
        if (!src.slice(fromIdx, m.index).includes(".order(")) {
          hits.push(`${file}:${before.split("\n").length}`)
        }
      }
    }
  }
  return hits
}

describe("paginated .range() must carry a deterministic .order()", () => {
  const sites = findUnorderedRangeSites()

  it("does not grow the unordered-pagination population", () => {
    expect(sites.length).toBeLessThanOrEqual(BUDGET)
  })

  // No-slack: the frozen number must EQUAL the live count. A ratchet with
  // headroom silently licenses the next N additions.
  it("BUDGET matches the live count exactly — lower it when you fix a site", () => {
    expect(sites.length).toBe(BUDGET)
  })

  it("the walk finds files at all (not vacuous)", () => {
    // Satisfiable at a population of ZERO — a threshold on `sites` would punish
    // its own success, which is the failure the server-page ratchet hit.
    expect(walk("lib").length).toBeGreaterThan(50)
  })

  it("the site that caused the 2026-08-16 incident is fixed and stays fixed", () => {
    const snap = sites.filter((s) => s.includes("snapshot-institutional-wallets"))
    expect(snap).toEqual([])
  })

  it("the wallet_moments_cache paging loops in wallet-backfill-helpers stay ordered", () => {
    const wb = sites.filter((s) => s.includes("wallet-backfill-helpers"))
    expect(wb).toEqual([])
  })

  // Guards the guard: without the string/comment blanking the scanner reports
  // prose and retry labels as offenders, which is how it would drift back to
  // being ignored.
  it("blankNonCode removes .range( inside comments and string literals", () => {
    const src = [
      'const label = `wmc.range(${w},${from})`',
      "// a comment mentioning .range( and .order(",
      'const q = sb.from("t").select("*").range(0, 9)',
    ].join("\n")
    const blanked = blankNonCode(src)
    // The literal and the comment are gone...
    expect(blanked).not.toContain("wmc.range(")
    expect(blanked).not.toContain("a comment mentioning")
    // ...but the real call survives, so the scanner can still see it.
    expect(blanked).toContain(".range(0, 9)")
  })

  it("blankNonCode preserves line offsets so reported line numbers are true", () => {
    const src = 'const a = 1\n/* block\ncomment */\nconst b = 2\n'
    expect(blankNonCode(src).split("\n").length).toBe(src.split("\n").length)
  })
})
