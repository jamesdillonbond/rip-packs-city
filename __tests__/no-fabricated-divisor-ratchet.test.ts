import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import { isMarkerSuppressed } from "../scripts/lib/marker-suppression.mjs"

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

// ── ROOTS: WIDENED 2026-09-07, and the widening is the point ────────────────
//
// The first four roots were a curated list, and CLAUDE.md's standing rule is to
// prefer a TREE WALK over one. `scripts` and `supabase/functions` were outside
// it, and their exclusion rested on nothing — the edge fns are outside the
// coverage gates entirely, so no other instrument was looking. Enrolling them
// on the widened patterns below surfaced three real sites; each is now either
// fixed or carries a written suppression on the line.
const ROOTS = ["app", "lib", "components", "workers", "scripts", "supabase/functions"] as const

/**
 * Division whose denominator is a `||`/`??` fallback to a literal.
 * Anchored on the `/` so a bare `x || 1` anywhere else is not enrolled.
 */
const FABRICATED_DIVISOR = /\/\s*\(\s*[A-Za-z0-9_$.[\]?!]+\s*(?:\|\||\?\?)\s*-?\d+(?:\.\d+)?\s*\)/g

/**
 * The CLAMP spelling of the same substitution: `x / Math.max(y, 1)`. It reads as
 * a divide-by-zero guard and is the identical value substitution — a ratio
 * against zero is undefined, and clamping the denominator to 1 reports a
 * fabricated finite number instead. Population was already zero when this was
 * added, so it is a pure ban with no debt.
 */
const CLAMPED_DIVISOR = /\/\s*Math\.max\(\s*[A-Za-z0-9_$.[\]?!()]+\s*,\s*-?\d+(?:\.\d+)?\s*\)/g

/**
 * ── THE HOISTED SPELLING, and why this guard needed it ──────────────────────
 *
 * Both patterns above anchor on the `/`, so they only see the substitution when
 * it is written INSIDE the division. Name it first and the guard goes blind:
 *
 *     const total = stats?.total_principal_usd || 1     // <- invisible
 *     const pct = (part / total) * 100
 *
 * That is not hypothetical. `components/analytics/WalletProfile.tsx` carried
 * exactly it — inside this guard's OWN roots, under a green CI, for as long as
 * the guard has existed — and published a measured "0%" collection-mix share
 * for every wallet whose funded loans all carry a NULL principal_usd (2 of 16
 * borrower wallets on 2026-09-07). The two `Sparkline` copies carried the same
 * shape as `max - min || 1`, drawing a FLAT series along the bottom of the box
 * as though it sat at the low of its window.
 *
 * A declaration is enrolled only when BOTH hold:
 *   1. its initialiser falls back to a NON-ZERO numeric literal — `?? 0` is not
 *      this class, because dividing by an explicit 0 yields Infinity/NaN, which
 *      is loud, not a plausible-looking measurement; and
 *   2. the identifier is actually used in denominator position in the same file.
 *
 * ⚠ (2) is deliberately strict about what counts as a `/`. A first cut matched
 * any `/` before the name and reported `?? 1`/`?? 148.0` constants whose names
 * merely appeared inside URL PATHS ("/api/fmv/demo", "/serial-premiums") — two
 * false positives out of seven. The divisor must be preceded by a value-ish
 * character and not followed by another path segment.
 */
const HOISTED_DECL =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*?(?:\|\||\?\?)\s*-?(?!0(?:\.0+)?\b)\d+(?:\.\d+)?\s*(?:[;\n)]|$)/gm

function usedAsDivisor(src: string, id: string): boolean {
  return new RegExp(`[\\w$)\\]]\\s*\\/\\s*\\(?\\s*${id.replace(/\$/g, "\\$")}(?![\\w$/-])`).test(src)
}

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

/**
 * ⚠ WIDENED 2026-09-07, in the one direction that cannot leak. The fixed 3-line
 * lookback is kept verbatim (it exists because these expressions WRAP, so the
 * flagged line's neighbours are often code, not prose) and is now UNIONed with
 * the contiguous comment block immediately above the line.
 *
 * Reason: a suppression worth honouring states WHY, and a real justification
 * does not fit in three lines. BOTH suppressions written the day this widened
 * were silently ignored by the 3-line rule — an escape hatch that quietly does
 * nothing is worse than none, because the author believes it took.
 *
 * The block walk stops at the FIRST non-comment line, so unlike a bigger fixed
 * number it can never reach across code to excuse something below it.
 */
/*
 * ⚠ MIGRATED 2026-09-09 to the ONE shared reader, `scripts/lib/marker-suppression.mjs`,
 * for the same reason `stripComments` was: a second guard now needs these exact
 * window semantics, and a copy would have to re-earn all three properties above.
 * The signature here is unchanged, so every control below still drives the real
 * implementation. Do not re-inline a local copy.
 */
export function isSuppressed(rawLines: string[], i: number): boolean {
  return isMarkerSuppressed(rawLines, i, OPT_OUT, OPT_OUT_LOOKBACK)
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue
      walk(full, out)
    } else if (/\.(ts|tsx|mjs|js)$/.test(entry) && !entry.includes(".test.")) {
      // ⚠ .mjs/.js added with the `scripts` root: the repo's analysis scripts are
      // .mjs, and one of them (classify-ts-livetoken) carried the class. A walk
      // that reaches a directory but not its file extension is not a walk.
      out.push(full)
    }
  }
  return out
}

type Hit = { file: string; line: number; text: string; kind: string }

/** Line index (0-based) of a character offset, for the hoisted matches. */
function lineOf(src: string, index: number): number {
  let n = 0
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === "\n") n++
  return n
}

function offenders(): Hit[] {
  const hits: Hit[] = []
  for (const root of ROOTS) {
    for (const full of walk(join(process.cwd(), root))) {
      const raw = readFileSync(full, "utf8")
      const stripped = stripComments(raw)
      const rawLines = raw.split("\n")
      const file = relative(process.cwd(), full).split(sep).join("/")

      // The opt-out is honoured identically for every kind: on the flagged line
      // or any of the OPT_OUT_LOOKBACK lines above it.
      const suppressed = (i: number) => isSuppressed(rawLines, i)
      const push = (i: number, kind: string) => {
        if (suppressed(i)) return
        hits.push({ file, line: i + 1, text: (rawLines[i] ?? "").trim().slice(0, 120), kind })
      }

      // ── inline spellings, line by line ──
      for (const [kind, re] of [
        ["inline", FABRICATED_DIVISOR],
        ["clamp", CLAMPED_DIVISOR],
      ] as const) {
        re.lastIndex = 0
        if (!re.test(stripped)) {
          re.lastIndex = 0
          continue
        }
        re.lastIndex = 0
        stripped.split("\n").forEach((line, i) => {
          re.lastIndex = 0
          if (re.test(line)) push(i, kind)
        })
        re.lastIndex = 0
      }

      // ── hoisted spelling: whole-file, because the declaration and the
      //    division are on different lines by construction ──
      HOISTED_DECL.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = HOISTED_DECL.exec(stripped)) !== null) {
        if (!usedAsDivisor(stripped, m[1])) continue
        push(lineOf(stripped, m.index), "hoisted")
      }
      HOISTED_DECL.lastIndex = 0
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
    expect(files.length, "the walk must find source files at all").toBeGreaterThan(200)
  })

  it("EVERY root contributes files — a root added but not reached is a silent hole", () => {
    // ⚠ The rule this pins: an exclusion (or an inclusion that reaches nothing)
    // is a CLAIM. `scripts` and `supabase/functions` were added on 2026-09-07;
    // asserting only the total would let either of them contribute ZERO — a
    // typo'd path, a moved directory — while the aggregate stayed comfortably
    // above 200 on the four original roots alone.
    for (const r of ROOTS) {
      expect(walk(join(process.cwd(), r)).length, `root "${r}" reached no files`).toBeGreaterThan(0)
    }
  })

  it("the walk reaches .mjs, not only .ts/.tsx", () => {
    // The `scripts` root is mostly .mjs. Enrolling the directory without the
    // extension would have read as coverage while measuring nothing there.
    const scripts = walk(join(process.cwd(), "scripts"))
    expect(scripts.some((f) => f.endsWith(".mjs")), "no .mjs reached under scripts/").toBe(true)
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

    // The CLAMP spelling.
    for (const src of [
      "const r = x / Math.max(y, 1)",
      "const r = x / Math.max(counts.length, 1)",
    ]) {
      CLAMPED_DIVISOR.lastIndex = 0
      expect(CLAMPED_DIVISOR.test(src), `should flag: ${src}`).toBe(true)
    }
    CLAMPED_DIVISOR.lastIndex = 0
    expect(CLAMPED_DIVISOR.test("const r = x / Math.max(y, z)")).toBe(false)

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

  it("the HOISTED detector fires on the real shapes and not on the two it over-matched", () => {
    // ⚠ POSITIVE CONTROL FIRST, and it is not decoration: an earlier revision of
    // this detector used `\\bactive\\b`-style over-narrow anchoring in a sibling
    // guard and passed when it should have failed. Both fixtures below are the
    // VERBATIM shapes found in the tree on 2026-09-07.
    const hoistedFires = (src: string) => {
      HOISTED_DECL.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = HOISTED_DECL.exec(src)) !== null) if (usedAsDivisor(src, m[1])) return true
      return false
    }

    expect(
      hoistedFires("const total = stats?.total_principal_usd || 1\nconst pct = ((v ?? 0) / total) * 100"),
      "the WalletProfile shape must be caught",
    ).toBe(true)
    expect(
      hoistedFires("const range = max - min || 1;\nconst y = height - ((v - min) / range) * h;"),
      "the Sparkline shape must be caught",
    ).toBe(true)
    expect(
      hoistedFires("const totalCount = xs.reduce((s, c) => s + c, 0) || 1\nconst w = count / totalCount"),
      "the pack-supply shape must be caught",
    ).toBe(true)

    // NOT the class: `?? 0` divides by an explicit zero, which is loud
    // (Infinity/NaN), not a plausible-looking finite measurement.
    expect(hoistedFires("const total = s?.count ?? 0\nconst pct = (v / total) * 100")).toBe(false)

    // NOT the class: the name only appears inside a URL PATH. Both of these
    // were real false positives before `usedAsDivisor` was tightened.
    expect(
      hoistedFires('const fmv = sample?.fmv ?? 148.0\nconst r = await fetch("/api/fmv/demo")'),
      "a name inside a URL path is not a divisor",
    ).toBe(false)
    expect(
      hoistedFires('const serial = r.headline_serial ?? 1\nconst href = "/serial-premiums"'),
      "a name inside a URL path is not a divisor",
    ).toBe(false)

    // NOT the class: declared with a fallback but never divided by.
    expect(hoistedFires("const limit = parseInt(x, 10) || 50\nconst rows = all.slice(0, limit)")).toBe(false)
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

  it("the opt-out reaches through a MULTI-LINE justification block, and stops at code", () => {
    // ⚠ Drives the real `isSuppressed`, not a re-implementation — the same
    // discipline the 3-line test above already applies.
    //
    // Positive: a 6-line justification whose marker is on the FIRST line. Under
    // the old fixed window this returned false, and both suppressions shipped
    // that day were ignored without any signal.
    const block = [
      "// fabricated-divisor: intentional — a stated reason,",
      "// which runs on for several lines because it names the",
      "// measured population, why the fix is not here, and the",
      "// exit condition that would let the marker be deleted.",
      "// Three lines is not enough room for any of that.",
      "const totalCount = xs.reduce((s, c) => s + c, 0) || 1",
    ]
    expect(isSuppressed(block, 5), "a marker at the top of an adjacent comment block must count").toBe(true)

    // Negative: the block is broken by a line of CODE, so the marker above it
    // must NOT excuse the offender below. This is the property a bigger fixed
    // lookback would have lost.
    const broken = [
      "// fabricated-divisor: intentional — belongs to the line below it",
      "const somethingElse = compute()",
      "",
      "",
      "",
      "const totalCount = xs.reduce((s, c) => s + c, 0) || 1",
    ]
    expect(isSuppressed(broken, 5), "a marker separated by code must not reach").toBe(false)

    // And an unmarked block stays unsuppressed however long it is.
    expect(isSuppressed(["// just a comment", "// and another", "const x = a / (b || 1)"], 2)).toBe(false)
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
        hits.map((h) => `  - [${h.kind}] ${h.file}:${h.line}  ${h.text}`).join("\n"),
    ).toBe(0)
  })
})
