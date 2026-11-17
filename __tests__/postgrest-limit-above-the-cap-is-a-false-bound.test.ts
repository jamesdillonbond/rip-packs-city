import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import { isMarkerSuppressed } from "../scripts/lib/marker-suppression.mjs"

// BAN (population ZERO after 2026-09-09) on a PostgREST `.limit(N)` / `.range()`
// span ABOVE the project's row cap.
//
// ── THE CLASS ───────────────────────────────────────────────────────────────
// PostgREST on this project caps every read at 1,000 rows AND silently CLAMPS a
// larger explicit bound down to it. `.limit(20000)` returns 1,000 rows with no
// error, no warning, and nothing in the response that distinguishes a complete
// result from a truncated one. So the number is not a bound at all — it is a
// CLAIM ABOUT THE POPULATION ("this table is smaller than 20,000") written in
// the one syntax that looks like an enforced limit.
//
// That makes it a documentation defect with teeth. Every subsequent reader —
// including the next author of the file — reads `.limit(20000)` as "we asked
// for everything", and any total, map or `rows.length` built underneath it is
// then computed on an undisclosed truncation. This is the same failure the
// honesty canon names elsewhere: a partial read that no caller can tell from a
// complete one.
//
// The class is already recorded as having produced live wrong numbers at least
// five separate times (lock-roi, market, sets-db, market-pulse's 4x undercount,
// the Panini squeeze board) — see the header of `lib/supabase-paginate.ts`,
// which exists because of them.
//
// ── WHY A NEW GUARD, WHEN `invariants-postgrest-cap` ALREADY EXISTS ─────────
// ⚠ That file is a CURATED LIST: it names six routes that were fixed and
// asserts each still reads `fmv_current` / pages with `.range()`. It is a good
// regression pin and it is structurally SILENT about the seventh site, which is
// exactly the shape CLAUDE.md warns about — "prefer a tree walk over a curated
// list and a ban at zero over an allowlist; make SUPPRESSION the curated list".
//
// The walk this file does found 21 sites carrying the shape, none of them in
// that curated list, and TWO of them over their population when measured on
// 2026-09-09:
//   - app/api/pack-listings/historical-pulls/route.ts  `.limit(20000)` over
//     838,392 rows — 0.12% of the population, unordered, published as a `total`.
//   - app/api/cron/pinnacle-metadata-backfill/route.ts `.limit(5000)`/`.limit(8000)`
//     over a >=9,000-row pool — an unordered head-of-table read.
// Neither was reachable by grepping for a *fixed* site, because there is no copy
// to grep: the tell is a NUMBER, and every instance spells it differently.
//
// ── WHY THE NUMBERS WERE NOT SIMPLY REWRITTEN TO 1000 ───────────────────────
// ⛔ Deliberate, and it is a measurement point, not caution. Rewriting
// `.limit(20000)` to `.limit(1000)` is behaviour-preserving ONLY IF the server
// cap really is 1,000 — if it were higher, the rewrite would introduce the very
// truncation this guard is about. That cap is a PostgREST server setting; it is
// not readable from Postgres, and this sandbox has no egress to the REST
// endpoint (verified 2026-09-09: the agent proxy rejects CONNECT to the project
// host). So the value is documented-but-unverified here, and a behaviour change
// resting on an unverified premise is not one to ship. What IS verifiable from
// source — that the number is an unstated claim about a population — is what
// this guard enforces.
//
// ── WHAT THIS IS STRUCTURALLY SILENT ABOUT, stated rather than implied ──────
//  1. ~~A NON-LITERAL bound. Only literals can be judged statically.~~
//     ⛔ CORRECTED 2026-09-11, and it had a LIVE INSTANCE. A same-file
//     `const NAME = <number>` IS statically judgeable, and hiding the number
//     behind a name is precisely how this class survives a guard anchored on the
//     literal — CLAUDE.md names that shape ("a guard anchored on an OPERATOR is
//     blind to its class HOISTED into a name") and the divisor ban had the same
//     hole. Found by resolving every `.limit(<name>)` in the tree against its
//     own file: 74 named sites, 31 resolvable, ONE over the cap —
//     `app/api/cron/pinnacle-wmc-render-id/route.ts` `.limit(CAP)` with
//     `const CAP = 2000`, which the 2026-09-09 walk could not see. Now covered
//     by LIMIT_NAMED below.
//     ⚠ STILL SILENT, deliberately: a bound that is a function PARAMETER
//     (`.limit(pageSize)`), an IMPORTED constant, or any computed expression —
//     none is decidable from one file, and guessing would put noise on every
//     correct pager. `.range(from, from + PAGE - 1)` likewise; the paging helpers
//     are the right answer there and `range-needs-order` covers the ordering half.
//     ⚠ AND ONLY WHEN THE NAME HAS EXACTLY ONE NUMERIC DEFINITION in the file —
//     a reassigned or shadowed name is skipped rather than guessed, because a
//     false positive on a ban-at-zero guard is a red CI run for everyone.
//  2. A `.limit(<=1000)` over a LARGER population. That is a truncation too, and
//     it is invisible to any source-shape check — it needs a row count, which
//     is a live read, not a lint.
//  3. Test files, excluded by the walk. A fixture cannot truncate production.
//  4. Whether a suppression's stated reason is TRUE. The marker forces the claim
//     to be written down where the next reader meets it; it cannot verify it.
//     Every marker in the tree therefore carries a measured number and a DATE,
//     because a population is a dated sample and not a constant.

/** PostgREST's row cap on this project. See lib/supabase-paginate.ts. */
const CAP = 1000

const ROOTS = ["app", "components", "lib", "workers", "supabase/functions", "scripts"]

/** `.limit(<literal>)` — the whole class in one spelling. */
const LIMIT_LITERAL = /\.limit\(\s*(\d[\d_]*)\s*\)/g

/** `.range(<literal>, <literal>)` — the same lie, spelled as a span. */
const RANGE_LITERAL = /\.range\(\s*(\d[\d_]*)\s*,\s*(\d[\d_]*)\s*\)/g

/** `.limit(<bare identifier>)` — the same lie with the number hoisted into a name. */
const LIMIT_NAMED = /\.limit\(\s*([A-Za-z_$][\w$]*)\s*\)/g

/**
 * Same-file numeric constant definitions, as `name -> value`.
 *
 * ⚠ CONSERVATIVE ON PURPOSE. The value must be a bare numeric literal that ENDS
 * the assignment (`= 2000;` or `= 2000` at end of line) — so `= 2000 * 3` and
 * `= Number(x) || 2000` are not read as 2000. And a name defined more than once
 * in the file is DROPPED rather than resolved to either value: a reassigned or
 * shadowed name is not statically known, and on a ban-at-zero guard a false
 * positive is a red run for everybody. Under-reaching here is the safe direction;
 * the walk still catches every literal.
 */
function numericConsts(strippedLines: string[]): Map<string, number> {
  const seen = new Map<string, number[]>()
  const DECL = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+?)?=\s*(\d[\d_]*)\s*;?$/
  // ⚠ A BARE REASSIGNMENT COUNTS AS A DEFINITION, and leaving it out was a real
  // bug in the first draft of this resolver — `let CAP = 2000; CAP = 10;` was
  // read as a single definition of 2000 and fired. Caught by the reassignment
  // case in the test below, which is why that case is written as an assertion
  // rather than a comment.
  const REASSIGN = /^([A-Za-z_$][\w$]*)\s*=\s*(\d[\d_]*)\s*;?$/
  // Any OTHER assignment to the name (a computed value, a call, a ternary) also
  // makes it unknowable — record a sentinel so the name is dropped.
  const ASSIGN_ANY = /^(?:(?:export\s+)?(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+?)?=(?![=>])/
  for (const raw of strippedLines) {
    const line = raw.trim()
    const m = DECL.exec(line) ?? REASSIGN.exec(line)
    if (m) {
      const list = seen.get(m[1]) ?? []
      list.push(Number(m[2].replace(/_/g, "")))
      seen.set(m[1], list)
      continue
    }
    const a = ASSIGN_ANY.exec(line)
    if (a) {
      const list = seen.get(a[1]) ?? []
      list.push(Number.NaN)
      seen.set(a[1], list)
    }
  }
  const out = new Map<string, number>()
  for (const [name, vals] of seen) {
    if (vals.length === 1 && Number.isFinite(vals[0])) out.set(name, vals[0])
  }
  return out
}

/**
 * Deliberate, reviewed exception. Honoured on the flagged line, any of the 3
 * lines above it, or anywhere in the contiguous comment block above — the same
 * window as `fabricated-divisor: intentional`, via the same shared reader.
 */
const OPT_OUT = /postgrest-cap:\s*intentional/
const OPT_OUT_LOOKBACK = 3

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue
      walk(full, out)
    } else if (/\.(ts|tsx|mjs|js)$/.test(entry) && !entry.includes(".test.")) {
      out.push(full)
    }
  }
  return out
}

type Hit = { file: string; line: number; text: string; kind: string; value: number }

/** Every unsuppressed over-cap literal bound in the tree. */
function offenders(): Hit[] {
  const hits: Hit[] = []
  for (const root of ROOTS) {
    for (const full of walk(join(process.cwd(), root))) {
      const raw = readFileSync(full, "utf8")
      // ⚠ Load-bearing: this file's own header quotes `.limit(20000)` to explain
      // itself, and several annotated call sites quote the number in the comment
      // that justifies it. Without stripping, the guard reports documentation.
      const strippedLines = stripComments(raw).split("\n")
      const rawLines = raw.split("\n")
      const file = relative(process.cwd(), full).split(sep).join("/")
      const consts = numericConsts(strippedLines)

      strippedLines.forEach((line, i) => {
        const push = (kind: string, value: number) => {
          if (isMarkerSuppressed(rawLines, i, OPT_OUT, OPT_OUT_LOOKBACK)) return
          hits.push({ file, line: i + 1, text: (rawLines[i] ?? "").trim().slice(0, 120), kind, value })
        }

        LIMIT_LITERAL.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = LIMIT_LITERAL.exec(line)) !== null) {
          const n = Number(m[1].replace(/_/g, ""))
          if (n > CAP) push("limit", n)
        }

        RANGE_LITERAL.lastIndex = 0
        while ((m = RANGE_LITERAL.exec(line)) !== null) {
          const span = Number(m[2].replace(/_/g, "")) - Number(m[1].replace(/_/g, "")) + 1
          if (span > CAP) push("range", span)
        }

        LIMIT_NAMED.lastIndex = 0
        while ((m = LIMIT_NAMED.exec(line)) !== null) {
          const n = consts.get(m[1])
          if (n !== undefined && n > CAP) push(`limit via ${m[1]} =`, n)
        }
      })
    }
  }
  return hits
}

/** Drive the real matcher over a source string, the way the walk does. */
function fires(src: string): boolean {
  const stripped = stripComments(src).split("\n")
  const rawLines = src.split("\n")
  return stripped.some((line, i) => {
    if (isMarkerSuppressed(rawLines, i, OPT_OUT, OPT_OUT_LOOKBACK)) return false
    LIMIT_LITERAL.lastIndex = 0
    RANGE_LITERAL.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = LIMIT_LITERAL.exec(line)) !== null) {
      if (Number(m[1].replace(/_/g, "")) > CAP) return true
    }
    while ((m = RANGE_LITERAL.exec(line)) !== null) {
      if (Number(m[2].replace(/_/g, "")) - Number(m[1].replace(/_/g, "")) + 1 > CAP) return true
    }
    return false
  })
}

/**
 * Drive the NAMED-constant path over a whole file, the way the walk does.
 * `fires()` above is line-scoped and structurally cannot see a const declared
 * elsewhere in the file — which is exactly why the class hid from it.
 */
function firesFile(src: string): boolean {
  const stripped = stripComments(src).split("\n")
  const rawLines = src.split("\n")
  const consts = numericConsts(stripped)
  return stripped.some((line, i) => {
    if (isMarkerSuppressed(rawLines, i, OPT_OUT, OPT_OUT_LOOKBACK)) return false
    LIMIT_NAMED.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = LIMIT_NAMED.exec(line)) !== null) {
      const n = consts.get(m[1])
      if (n !== undefined && n > CAP) return true
    }
    return false
  })
}

describe("a PostgREST bound above the row cap is a false bound", () => {
  it("the walk reaches real source files (not vacuously passing)", () => {
    // ⚠ Asserts the WALK, never the offender count — a threshold on offenders
    // goes red the moment the population reaches zero, which is the point.
    const files = ROOTS.flatMap((r) => walk(join(process.cwd(), r)))
    expect(files.length, "the walk must find source files at all").toBeGreaterThan(200)
  })

  it("EVERY root contributes files — a root added but not reached is a silent hole", () => {
    for (const r of ROOTS) {
      expect(walk(join(process.cwd(), r)).length, `root "${r}" reached no files`).toBeGreaterThan(0)
    }
  })

  it("the walk reaches .mjs, not only .ts/.tsx", () => {
    // `scripts` is mostly .mjs and carried five instances of this class. A walk
    // that reaches a directory but not its file extension is not a walk.
    const scripts = walk(join(process.cwd(), "scripts"))
    expect(scripts.some((f) => f.endsWith(".mjs")), "no .mjs reached under scripts/").toBe(true)
  })

  it("the matcher fires on the shape it names, and NOT on the benign ones", () => {
    expect(fires('sb.from("t").select("*").limit(2000)'), "an over-cap .limit must fire").toBe(true)
    expect(fires("  .limit(20_000)"), "a numeric separator must not hide it").toBe(true)
    expect(fires("  .range(0, 4999)"), "an over-cap .range span must fire").toBe(true)

    // NOT the class: at or under the cap, so the bound is real.
    expect(fires('sb.from("t").select("*").limit(1000)')).toBe(false)
    expect(fires("  .range(0, 999)")).toBe(false)
    expect(fires("  .range(5000, 5999)"), "a high OFFSET with a legal span is fine").toBe(false)

    // NOT the class: a non-literal bound cannot be judged statically, and
    // pretending otherwise would produce noise on every correct pager.
    expect(fires("  .limit(pageSize)")).toBe(false)
    expect(fires("  .range(from, from + PAGE - 1)")).toBe(false)
  })

  it("catches the number HOISTED INTO A NAME — the shape that hid from the literal walk", () => {
    // The live instance: app/api/cron/pinnacle-wmc-render-id/route.ts carried
    // `const CAP = 2000` and `.limit(CAP)` on a plain PostgREST select, and the
    // literal-only walk on 2026-09-09 reported zero offenders across the tree.
    expect(firesFile("const CAP = 2000;\nawait sb.from('t').select('*').limit(CAP);")).toBe(true)
    expect(firesFile("const CAP = 20_000\n  .limit(CAP)"), "separators must not hide it").toBe(true)
    expect(firesFile("const CAP: number = 5000;\n  .limit(CAP)"), "a type annotation must not hide it").toBe(true)

    // At or under the cap, the bound is real.
    expect(firesFile("const CAP = 1000;\n  .limit(CAP)")).toBe(false)

    // ⚠ THE CONSERVATISM, asserted rather than described. Each of these is a
    // name the guard must DECLINE to judge, because guessing wrong reds CI for
    // everyone on a ban-at-zero check.
    expect(firesFile("let CAP = 2000;\nCAP = 10;\n  .limit(CAP)"), "a name defined twice is not statically known").toBe(
      false,
    )
    expect(firesFile("const CAP = 2000 * 3;\n  .limit(CAP)"), "a computed value is not a bare literal").toBe(false)
    expect(firesFile("const CAP = Number(x) || 2000;\n  .limit(CAP)"), "a fallback expression is not a bare literal").toBe(
      false,
    )
    expect(firesFile("function f(pageSize: number) {\n  return q.limit(pageSize)\n}"), "a parameter is unknowable").toBe(
      false,
    )
    expect(firesFile("  .limit(opts.pageSize)"), "a dotted access is not a bare identifier").toBe(false)

    // The opt-out reaches this path too, via the same shared reader.
    expect(
      firesFile("const CAP = 2000;\n// postgrest-cap: intentional — 5 rows measured 2026-09-11\n  .limit(CAP)"),
      "the marker must suppress a named hit as well as a literal one",
    ).toBe(false)
  })

  it("the comment stripper is load-bearing (this file would flag itself without it)", () => {
    // This guard's own header quotes `.limit(20000)`. Proving the stripper
    // removes it is what stops a future edit from "fixing" a documentation hit
    // by deleting the explanation.
    const doc = "// a read written as .limit(20000) is clamped to 1000\nconst ok = 1"
    expect(/\.limit\(\s*20000\s*\)/.test(doc)).toBe(true)
    expect(/\.limit\(\s*20000\s*\)/.test(stripComments(doc))).toBe(false)
    expect(fires(doc), "a quoted example in a comment must not be an offender").toBe(false)
  })

  it("the opt-out works, and cannot reach across code", () => {
    // ⚠ Drives the real shared reader, not a re-implementation.
    expect(fires("// postgrest-cap: intentional — 265 rows measured 2026-09-09\n  .limit(10000)")).toBe(false)

    const brokenByCode = [
      "// postgrest-cap: intentional — belongs to the line below it",
      "const somethingElse = compute()",
      "",
      "",
      "",
      "  .limit(10000)",
    ]
    expect(isMarkerSuppressed(brokenByCode, 5, OPT_OUT, OPT_OUT_LOOKBACK), "a marker separated by code must not reach").toBe(
      false,
    )

    const block = [
      "// postgrest-cap: intentional — a justification long enough to name",
      "// the measured population, the date it was measured, and the exit",
      "// condition that would let this marker be deleted. Three lines is",
      "// not enough room for any of that.",
      "  .limit(10000)",
    ]
    expect(isMarkerSuppressed(block, 4, OPT_OUT, OPT_OUT_LOOKBACK), "a marker at the top of an adjacent block must count").toBe(
      true,
    )
  })

  it("no source file states a PostgREST bound the server will silently clamp", () => {
    const hits = offenders()
    expect(
      hits.length,
      `PostgREST caps reads at ${CAP} rows and CLAMPS a larger explicit bound to it, silently.\n` +
        "So a bigger number is not a limit — it is an unstated claim that the population is\n" +
        "smaller than it, and anything computed underneath it is built on a truncation no\n" +
        "caller can see. Page with .range() (lib/supabase-paginate.ts's fetchAllPaged), read a\n" +
        "head:true count for a total, or lower the bound to a real one. If the read genuinely\n" +
        "cannot exceed the cap, say so: add `postgrest-cap: intentional` WITH THE MEASURED ROW\n" +
        "COUNT AND THE DATE, on the flagged line, the " +
        `${OPT_OUT_LOOKBACK} lines above it, or the comment block above it.\n` +
        hits.map((h) => `  - [${h.kind} ${h.value}] ${h.file}:${h.line}  ${h.text}`).join("\n"),
    ).toBe(0)
  })
})
