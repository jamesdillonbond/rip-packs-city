import { describe, it, expect } from "vitest"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
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

/**
 * The order keys on a `.range()` chain, in source order.
 *
 * ⚠ Reads the RAW (comment-stripped but string-INTACT) source, because the key
 * IS a string literal — `blankNonCode` erases exactly what we need here. Offsets
 * are preserved by both passes, so the two views index identically.
 */
function orderKeysFor(rawStripped: string, fromIdx: number, rangeIdx: number): string[] {
  return [...rawStripped.slice(fromIdx, rangeIdx).matchAll(/\.order\s*\(\s*["'`]([^"'`]+)["'`]/g)].map(
    (m) => m[1],
  )
}

/**
 * A column name that CANNOT be a unique key in this schema. Timestamps are the
 * whole population in practice and the one that actually bit.
 */
const TIMESTAMPISH = /^(.*_at|.*_time|.*timestamp|day|date|created|updated)$/i

/**
 * Every `.range()` whose ONLY `.order()` key is timestamp-shaped.
 *
 * ⚠ THIS IS THE HALF THE CHECK ABOVE CANNOT SEE, and R47 is the proof: that
 * check was GREEN on `/sitemap/3.xml`, which paged `editions` ordered by
 * `updated_at`. It asserts `.order()` PRESENCE — the spelling — while the rule
 * the file's own header states is that the key must be UNIQUE. **A guard whose
 * assertion is weaker than the rule it cites reads as coverage for the rule.**
 *
 * Re-measured live 2026-08-23 over the four published collections:
 * `editions.updated_at` has **8,927 distinct values across 27,121 rows — 68.4%
 * of rows in a tied group, largest group 1,084**. ⚠ That is WIDER THAN THE
 * 1,000-ROW PAGE, which is the case where loss is not merely possible but
 * forced.
 *
 * ⚠ Uniqueness is not decidable from source, so this does not try. It bans the
 * shape that is never unique and requires a SECOND `.order()` alongside it —
 * which is what makes a wrong tiebreaker a code-review question rather than an
 * invisible one. (Choosing that tiebreaker still needs checking against
 * `pg_indexes`: `wallet_moments_cache.moment_id` looked natural here and is
 * NOT unique — the constraint is (wallet_address, collection_id, moment_id).)
 */
export function findTimestampOnlyOrderSites(roots: string[] = ROOTS): string[] {
  const hits: string[] = []
  for (const root of roots) {
    for (const file of walk(root)) {
      const raw = readFileSync(file, "utf8")
      const code = blankNonCode(raw)
      const rawStripped = stripComments(raw)
      const re = /\.range\s*\(/g
      let m: RegExpExecArray | null
      while ((m = re.exec(code))) {
        const fromIdx = code.slice(0, m.index).lastIndexOf(".from(")
        if (fromIdx === -1) continue
        // ⚠ COUNT from the blanked view, KEY from the string-intact one. A second
        // `.order()` is what clears a site, so the count is the primary signal.
        const orderCount = (code.slice(fromIdx, m.index).match(/\.order\s*\(/g) ?? []).length
        if (orderCount !== 1) continue
        const keys = orderKeysFor(rawStripped, fromIdx, m.index)
        const line = code.slice(0, m.index).split("\n").length
        // 🚨 A NON-LITERAL SOLE ORDER KEY COUNTS. Mutation caught this: the very
        // site R47 found — `lib/sitemap-data.ts::fetchAllByCollection` — takes its
        // order column as a PARAMETER, so a literal-only detector could not see
        // it, and the guard written FOR that defect did not cover it. The same
        // hole hid `/api/badges`, where the sort column comes from the QUERY
        // STRING and every allowed value is non-unique. When the key is unknown,
        // a single `.order()` cannot be shown to be deterministic, so a second
        // one is required — which is exactly the fix in both places.
        if (keys.length === 0) {
          hits.push(`${file}:${line} order=<non-literal>`)
        } else if (TIMESTAMPISH.test(keys[0])) {
          hits.push(`${file}:${line} order=${keys[0]}`)
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

describe("a paged .range() must not order by a TIMESTAMP alone", () => {
  // ⚠ BAN AT ZERO, and the population was measured BEFORE the assertion was
  // written rather than after — 5 sites (the sitemap's `editions.updated_at`
  // plus four backfills), all fixed in the same commit, so there is nothing to
  // grandfather. A ban at zero is what this file already chose for the sibling
  // check, for the same reason.
  const sites = findTimestampOnlyOrderSites()

  it("no paged read is ordered by a timestamp with no unique tiebreaker", () => {
    expect(sites).toEqual([])
  })

  it("POSITIVE CONTROL: a sole order key that is a VARIABLE is flagged", () => {
    // 🚨 The mutation that caught the first draft. `fetchAllByCollection` and
    // `/api/badges` both order by a value the source does not name, and a
    // literal-only detector reported ZERO on both — a guard silently blind to
    // the defect it was written for.
    const dir = mkdtempSync(join(tmpdir(), "range-order-var-"))
    try {
      writeFileSync(
        join(dir, "param.ts"),
        `const r = await sb.from("editions").select("id").order(sortCol, { ascending: true }).range(from, from + 999)`,
      )
      expect(findTimestampOnlyOrderSites([dir]).length).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("NO-CHANGE CONTROL: a VARIABLE key with a second .order() is accepted", () => {
    const dir = mkdtempSync(join(tmpdir(), "range-order-var-ok-"))
    try {
      writeFileSync(
        join(dir, "param-ok.ts"),
        `const r = await sb.from("editions").select("id").order(sortCol, { ascending: true }).order("id", { ascending: true }).range(from, from + 999)`,
      )
      expect(findTimestampOnlyOrderSites([dir])).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("POSITIVE CONTROL: the detector fires on the exact shape R47 found", () => {
    // Without this, a detector that silently matches NOTHING passes forever and
    // reads as coverage. Drives the real function over a temp tree rather than
    // asserting on a regex, so a broken walk fails here too.
    const dir = mkdtempSync(join(tmpdir(), "range-order-"))
    try {
      writeFileSync(
        join(dir, "offender.ts"),
        `const r = await sb.from("editions").select("id").order("updated_at", { ascending: false }).range(0, 999)`,
      )
      expect(findTimestampOnlyOrderSites([dir]).length).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("NO-CHANGE CONTROL: a timestamp WITH a unique tiebreaker is accepted", () => {
    // The mirror-image defect would be to ban timestamp ordering outright, which
    // would push callers toward a worse key rather than a second one.
    const dir = mkdtempSync(join(tmpdir(), "range-order-ok-"))
    try {
      writeFileSync(
        join(dir, "fine.ts"),
        `const r = await sb.from("editions").select("id").order("updated_at", { ascending: false }).order("id", { ascending: true }).range(0, 999)`,
      )
      expect(findTimestampOnlyOrderSites([dir])).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("NO-CHANGE CONTROL: a non-timestamp single order key is accepted", () => {
    const dir = mkdtempSync(join(tmpdir(), "range-order-uniq-"))
    try {
      writeFileSync(
        join(dir, "fine2.ts"),
        `const r = await sb.from("profile_bio").select("username").order("username", { ascending: true }).range(0, 999)`,
      )
      expect(findTimestampOnlyOrderSites([dir])).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("the order key is read from the SOURCE, not from a blanked view", () => {
    // blankNonCode() erases string literals, and the order key IS a string
    // literal — reading the blanked view would make every key the empty string
    // and the detector would match nothing. Pins the reason for the two views.
    expect(blankNonCode(`x.order("updated_at")`)).not.toContain("updated_at")
  })
})
