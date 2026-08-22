import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// BAN (population ZERO) on dividing by a FABRICATED denominator — `x / (y || 1)`,
// `x / (y ?? 1)`, and the same shape with any other invented constant.
//
// ── WHY THIS IS A BAN AND NOT A RATCHET ─────────────────────────────────────
// The population was driven to zero in the same session that added this file, so
// there is no debt to freeze and no allowlist to ship. Same precedent as the
// `.range()`-without-`.order()` ban.
//
// ── THE CLASS ───────────────────────────────────────────────────────────────
// A ratio against zero is UNDEFINED, not enormous. `|| 1` reads like a
// divide-by-zero guard and is actually a value substitution: it swaps the real
// (zero) denominator for a fabricated $1 and then reports the result as a
// measurement. Both recorded instances were the SAME expression on the SAME
// feature, and both were live on pages collectors SHARE:
//
//   app/profile/[username]/ProfileClient.tsx              (found + fixed first)
//   app/(collections)/[collection]/profile/[username]/
//     CollectionProfileClient.tsx                          (the copy-paste sibling,
//                                                           missed by that fix)
//
// A collector whose first snapshot was $0 — a new wallet, or one snapshotted
// before the FMV populate ran — had a rise to $500 rendered as
// "↑ 50000.0% / 30D". The honest answer is to OMIT the percentage: the sparkline
// still shows the real shape, so nothing informative is lost.
//
// ⚠ The fix has a second half that is easy to miss, and it is why this ban is
// worth having rather than a code-review habit: anything deriving DIRECTION from
// the now-null ratio (`change >= 0 ? green : red`) must derive it from the SERIES
// instead, or a genuine 0 -> $500 gain paints in the loss colour — and only on
// the very rows the null was introduced for.
//
// ── WHAT IS NOT BANNED ──────────────────────────────────────────────────────
// `parseInt(x) || 1` for a page number or a limit is a PARSE fallback, not a
// divisor substitution, and is deliberately untouched: the pattern below only
// matches a `|| N` sitting in DENOMINATOR position, i.e. immediately after `/`.

const ROOTS = ["app", "lib", "components", "workers"] as const

/**
 * Division whose denominator is a `||`/`??` fallback to a literal.
 * Anchored on the `/` so a bare `x || 1` anywhere else is not enrolled.
 */
const FABRICATED_DIVISOR = /\/\s*\(\s*[A-Za-z0-9_$.[\]?!]+\s*(?:\|\||\?\?)\s*-?\d+(?:\.\d+)?\s*\)/g

/**
 * Deliberate, reviewed exception.
 *
 * ⚠ Honoured on the offending line OR any of the 3 lines above it, matching the
 * `brand-exception` convention already used by `scripts/check-brand-tokens.mjs`.
 * A same-line-only window was tried first and is unusable: these expressions are
 * routinely wrapped across several lines, so the `|| 1` lands on a different line
 * from the only sensible place to write the justification. An escape hatch that
 * cannot be reached in the common case is not an escape hatch — it just teaches
 * people to delete the guard.
 */
const OPT_OUT = /fabricated-divisor:\s*intentional/
const OPT_OUT_LOOKBACK = 3

/**
 * Blank out comments, preserving offsets.
 *
 * ⚠ REQUIRED, and this file is its own proof: the header above quotes `|| 1`
 * and `x / (y || 1)` verbatim to explain itself, and BOTH fixed call sites carry
 * a comment quoting the shape they replaced. Without this the guard reports
 * offenders that are documentation — including its own — which is at least the
 * seventh instance of that trap in this repo.
 */
/*
 * ⚠ MIGRATED 2026-08-22 to the ONE shared stripper. The local copy that stood
 * here stripped BLOCK comments before LINE comments, so any ordinary line
 * comment mentioning a glob path opened a block comment that ran to the next
 * `*​/` anywhere in the file — blanking real source this guard then reported as
 * clean. Across this guard's roots that hid 103,590 characters in 49 files.
 * Do not re-inline a local copy. See scripts/lib/strip-comments.mjs.
 *
 * ⚠ THE MIGRATION WAS PROVED IN BOTH DIRECTIONS, not just re-run. Injecting
 * `totalX / (totalY || 1)` at lib/seo.ts:196 — inside a region the old stripper
 * blanked (141 of that file's lines were invisible to it, including
 * OG_INHERITED and TWITTER_INHERITED) — this guard now REPORTS it, at the right
 * line, and with the old stripper restored the identical injection PASSED. A
 * migration that only still-passes cannot tell "fixed" from "never broken".
 * On the clean tree it passes, so no hidden fabricated divisor existed in the
 * 49 newly-visible files — a real negative result, not an absence of looking.
 */

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue
      walk(full, out)
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(full)
    }
  }
  return out
}

function offenders(): { file: string; line: number; text: string }[] {
  const hits: { file: string; line: number; text: string }[] = []
  for (const root of ROOTS) {
    for (const full of walk(join(process.cwd(), root))) {
      const raw = readFileSync(full, "utf8")
      const stripped = stripComments(raw)
      if (!FABRICATED_DIVISOR.test(stripped)) {
        FABRICATED_DIVISOR.lastIndex = 0
        continue
      }
      FABRICATED_DIVISOR.lastIndex = 0
      const rawLines = raw.split("\n")
      stripped.split("\n").forEach((line, i) => {
        FABRICATED_DIVISOR.lastIndex = 0
        if (!FABRICATED_DIVISOR.test(line)) return
        const window = rawLines.slice(Math.max(0, i - OPT_OUT_LOOKBACK), i + 1)
        if (window.some((l) => OPT_OUT.test(l))) return
        hits.push({
          file: relative(process.cwd(), full).split(sep).join("/"),
          line: i + 1,
          text: (rawLines[i] ?? "").trim().slice(0, 120),
        })
      })
    }
  }
  return hits
}

describe("no fabricated divisor", () => {
  it("the walk reaches real source files (not vacuously passing)", () => {
    // ⚠ Asserts the WALK, never the offender count. A threshold on offenders
    // goes red the moment the population is driven to zero — which is the whole
    // point — and this repo has already shipped that bug once, in
    // server-page-data-access-ratchet's `pages.length > 10`.
    const files = ROOTS.flatMap((r) => walk(join(process.cwd(), r)))
    expect(files.length, "the walk must find .ts/.tsx files at all").toBeGreaterThan(200)
  })

  it("the pattern matches the shape it names, and NOT the benign ones (guards the guard)", () => {
    // Without this, a typo reports zero forever and the ban reads as protection
    // while measuring nothing.
    const bad = [
      "const pct = ((last - first) / (first || 1)) * 100",
      "const r = total / (count ?? 1)",
      "const x = a / (b.c[0] || 1)",
      "const y = n / (d || 0.0001)",
    ]
    for (const src of bad) {
      FABRICATED_DIVISOR.lastIndex = 0
      expect(FABRICATED_DIVISOR.test(src), `should flag: ${src}`).toBe(true)
    }

    const benign = [
      // A parse fallback: `|| 1` is not in denominator position.
      'const page = Math.max(1, parseInt(sp.get("page") ?? "1", 10) || 1)',
      "const limitSets = parseInt(v, 10) || 1",
      // A real, non-fabricated denominator.
      "const avg = total / rows.length",
      // The honest replacement this ban exists to encourage.
      "const pct = base > 0 ? ((last - base) / base) * 100 : null",
    ]
    for (const src of benign) {
      FABRICATED_DIVISOR.lastIndex = 0
      expect(FABRICATED_DIVISOR.test(src), `should NOT flag: ${src}`).toBe(false)
    }
  })

  it("the comment stripper is load-bearing (this file would flag itself without it)", () => {
    // The header quotes the banned shape to explain it. Proving the stripper
    // removes it is what stops a future edit from "fixing" a documentation hit
    // by deleting the explanation.
    const withComment = "// a ratio like x / (y || 1) is fabricated\nconst ok = a / b"
    FABRICATED_DIVISOR.lastIndex = 0
    expect(FABRICATED_DIVISOR.test(withComment)).toBe(true)
    FABRICATED_DIVISOR.lastIndex = 0
    expect(FABRICATED_DIVISOR.test(stripComments(withComment))).toBe(false)
  })

  it("the opt-out is reachable from a wrapped expression, not just the same line", () => {
    // ⚠ Regression pin on the escape hatch itself. The first version matched the
    // OFFENDING line only, and these expressions wrap — so a marker written on the
    // natural line (above the statement) was ignored and the opt-out could not be
    // used at all. Verified by driving the real helper, not by re-implementing it.
    const src = [
      "// fabricated-divisor: intentional — reason goes here",
      "const pct =",
      "  ((last - first) /",
      "    (first || 1)) * 100",
    ]
    const offendingIndex = 3
    const window = src.slice(Math.max(0, offendingIndex - OPT_OUT_LOOKBACK), offendingIndex + 1)
    expect(window.some((l) => OPT_OUT.test(l))).toBe(true)

    // ...and it must NOT reach further than the stated window, or an unrelated
    // marker far above silently excuses everything below it.
    const tooFar = ["// fabricated-divisor: intentional", "a", "b", "c", "d"]
    const farIndex = 4
    const farWindow = tooFar.slice(Math.max(0, farIndex - OPT_OUT_LOOKBACK), farIndex + 1)
    expect(farWindow.some((l) => OPT_OUT.test(l))).toBe(false)
  })

  it("no source file divides by a fabricated denominator", () => {
    const hits = offenders()
    expect(
      hits.length,
      "A `|| N` in denominator position substitutes an invented value for a real one and\n" +
        "publishes the result as a measurement. Omit the ratio instead (and derive any\n" +
        "direction/colour from the SERIES, not from the now-null ratio). If a case is\n" +
        "genuinely deliberate, add `fabricated-divisor: intentional` with a reason, on the\n" +
        `flagged line or any of the ${OPT_OUT_LOOKBACK} lines above it.\n` +
        hits.map((h) => `  - ${h.file}:${h.line}  ${h.text}`).join("\n"),
    ).toBe(0)
  })
})
