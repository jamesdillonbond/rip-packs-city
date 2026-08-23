import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

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
// Passing now means the population is EMPTY. Any new unordered `.range()` fails
// CI outright — which is affordable precisely because the debt was cleared rather
// than frozen.
//
// ⚠ Choose the order column from a UNIQUE key, not merely a selected one. A
// non-unique order leaves ties between pages and reintroduces the defect:
// `moment_acquisitions.nft_id` looks like the natural key and is not (the unique
// constraint is (nft_id, wallet, transaction_hash)), so those sites order by the
// PK `id` instead.

// ⚠ TWO WIDENINGS, 2026-08-23 (deep-audit R26). Both were BLIND SPOTS OF THIS
// FILE'S OWN DERIVATION, which is the shape this repo keeps paying for: a
// guard's declared scope is itself a claim, and coverage is only real against
// what the guard READS.
//
//   1. `scripts` was not a root. Ten unordered paging loops lived there, and
//      the rule applies HARDER to a script than to a route: the sharpest one,
//      `scripts/backfill-livetoken-fmv.mjs`, paged `fmv_snapshots` unordered to
//      build the `existingIds` SKIP SET that `--force` exists to honour, and
//      then ran `.delete()` + `.insert()` on `fmv_snapshots`. A row missed by
//      pagination there is an FMV row overwritten without being asked for.
//
//   2. 🚨 The walk matched `/\.(ts|tsx)$/`, so it could not see `.mjs` or `.js`
//      AT ALL — in ANY root, including the four it already declared. Six of
//      those ten scripts are `.mjs`, so adding `scripts` alone would have
//      "cleared" the debt while leaving most of it invisible. Widened to
//      `/\.(ts|tsx|mjs|js)$/`.
//
// ⚠ Measured before widening, so the ban was not being loosened to fit: with
// the widened extensions the four ORIGINAL roots still report **0** — the
// existing ban was honest about the files it could see, it just could not see
// `.mjs`. `scripts` reported 10, all now fixed, so the population is 0 again.
const ROOTS = ["app", "lib", "supabase/functions", "workers", "scripts"]

/**
 * ZERO. This is now a BAN, not a ratchet — the population was driven to 0 in the
 * same session that found the defect.
 *
 * 13 when first measured (2026-08-16) → 11 (the two wallet_moments_cache loops in
 * wallet-backfill-helpers.ts) → 0 (the remaining 11 route-level loops).
 *
 * ⚠ AN EARLIER VERSION OF THIS FILE SAID a single `.range(0, N)` used as a
 * "first N" limit is a lower-priority member of this population. That was a
 * reasonable expectation and it was WRONG about the actual population: triaged
 * one by one, **all 11 remaining sites were genuine multi-page paging loops**
 * (`while (true)` / `for (…; offset += PAGE)`), every one able to duplicate and
 * drop rows. The distinction is still real in principle; it just described none
 * of the code. Do not assume a flagged site is benign — open it.
 */
const BUDGET = 0

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
    else if (/.(ts|tsx|mjs|js)$/.test(e) && !p.includes("__tests__")) out.push(p)
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
  // Comments first (shared stripper), then strings — order matters.
  let s = stripComments(src)
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

  it("no query offset-pages with .range() without a deterministic .order()", () => {
    expect(sites).toEqual([])
  })

  // Kept as a separate assertion so a future re-introduction that also edits
  // BUDGET upward still trips something.
  it("BUDGET stays at zero — this is a ban now, not a ratchet", () => {
    expect(BUDGET).toBe(0)
    expect(sites.length).toBe(BUDGET)
  })

  it("the walk finds files at all (not vacuous)", () => {
    // Satisfiable at a population of ZERO — a threshold on `sites` would punish
    // its own success, which is the failure the server-page ratchet hit.
    expect(walk("lib").length).toBeGreaterThan(50)
  })

  it("the walk actually reaches `scripts` AND sees .mjs — the two 2026-08-23 widenings", () => {
    // ⚠ Pins the SCOPE, not the population. Both widenings are invisible in the
    // headline assertion once the debt is cleared: a walk that silently stopped
    // matching `.mjs`, or a ROOTS edit that dropped `scripts`, would keep
    // reporting 0 and read as coverage. That is exactly how this guard was blind
    // to six `.mjs` paging loops while passing every run.
    const scriptFiles = walk("scripts")
    expect(scriptFiles.length, "scripts must be walked").toBeGreaterThan(20)
    expect(
      scriptFiles.filter((f) => f.endsWith(".mjs")).length,
      "the extension filter must still admit .mjs",
    ).toBeGreaterThan(10)
    expect(ROOTS).toContain("scripts")
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
