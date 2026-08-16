import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"

// BAN: a hydrated /insights board must not format a date with the RUNTIME
// timezone, or any value with the RUNTIME locale.
//
// ── THE DEFECT THIS EXISTS FOR (live, 2026-08-16) ──────────────────────────
// /insights/first-mint threw React #418 (hydration text mismatch) on every
// load where the data lined up:
//
//     Minified React error #418; args[]=text
//
// Cause: fmtDate called toLocaleDateString("en-US", { month, day }) with NO
// timeZone. These board clients are imported directly by a server page (no
// dynamic({ssr:false})), so the table is server-rendered for crawlability and
// then hydrated. toLocaleDateString with no timeZone uses the RUNTIME zone —
// UTC on Vercel, the visitor's zone in the browser — so any row whose
// timestamp sits near a UTC day boundary renders "Aug 16" server-side and
// "Aug 15" client-side. serial-premiums carried the identical bug, latent.
//
// ── WHY NO TEST COULD HAVE CAUGHT IT, WHICH IS WHY THIS IS A SOURCE GUARD ──
// The whole toolchain runs on Node in UTC, so SSR and the "client" render
// happen in the SAME zone under vitest and the mismatch cannot occur. The
// e2e-smoke Playwright monitor asserts rendered DOM but does not read the
// browser console, so it is blind too. This is structurally the same situation
// as the Safari lookbehind defect: a Node suite cannot observe a
// browser-runtime property, and only a source guard can. Do not "replace this
// with a real test" — there isn't one.
//
// ── WHY A BAN AND NOT A RATCHET ────────────────────────────────────────────
// This repo's usual answer is a ratchet, to avoid shipping an allowlist that
// is theatre. That objection does not apply here: the insights population was
// driven to ZERO in the same pass that added this guard (first-mint,
// serial-premiums, panini-squeeze), so a ban costs no allowlist at all.
//
// ⚠ SCOPE IS DELIBERATE AND NARROWER THAN THE DEFECT CLASS. Measured
// 2026-08-16, the same predicate over ALL of app/ + components/ reports 106
// sites, of which 17 are date/time. Most are bare Number.toLocaleString()
// (runtime-locale digit grouping — real, but lower stakes), and several of the
// date ones are live clocks that render only after mount, which is
// hydration-safe by construction and which a static check CANNOT distinguish.
// Banning site-wide would therefore red CI on correct code. The 17 are FILED,
// not fixed: docs/overnight/inbox/2026-08-16T1706Z-the-418-hydration-class-is-
// wider-than-insights.md. Widen this scope only with a measurement, never by
// assumption.

const ROOTS = ["app/insights", "components/insights"]

/**
 * Blank out comments, preserving offsets.
 *
 * ⚠ REQUIRED, not tidiness. This header quotes toLocaleDateString and the
 * fixed call sites carry comments naming the API they no longer misuse, so a
 * version without this reports its own documentation as the offender. This
 * repo has shipped that exact bug at least six times.
 */
function stripComments(src: string): string {
  const blanks = (s: string) => s.replace(/[^\n]/g, " ")
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blanks)
    .replace(/(^|[^:])\/\/.*$/gm, (m, p1) => p1 + " ".repeat(m.length - p1.length))
}

function isClientFile(src: string): boolean {
  return src.slice(0, 300).includes("use client")
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (full.endsWith(".tsx") || full.endsWith(".ts")) out.push(full)
  }
  return out
}

type Violation = { line: number; reason: string; snippet: string }

/**
 * Find every .toLocale{,Date,Time}String( call and read its ARGUMENT LIST by
 * scanning to the balanced close paren.
 *
 * ⚠ A plain regex over the call head is not enough: the options object nests,
 * and the property we care about (timeZone) can sit after other keys or across
 * several lines. Matching only the head would pass a call whose options say
 * nothing about the zone.
 */
export function findUnsafeLocaleCalls(src: string): Violation[] {
  const out: Violation[] = []
  const re = /\.toLocale(Date|Time|)String\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    let i = re.lastIndex
    let depth = 1
    while (i < src.length && depth > 0) {
      const c = src[i]
      if (c === "(" || c === "[" || c === "{") depth++
      else if (c === ")" || c === "]" || c === "}") depth--
      i++
    }
    const args = src.slice(re.lastIndex, i - 1)
    const kind = m[1] || "Any"
    const line = src.slice(0, m.index).split("\n").length
    const head = kind === "Any" ? "toLocaleString" : "toLocale" + kind + "String"
    const snippet = head + "(" + args.replace(/\s+/g, " ").trim().slice(0, 60) + ")"

    // Rule B — the locale must be pinned. A bare call, or an explicit
    // `undefined`, resolves to the RUNTIME locale: en-US on the server, the
    // visitor's in the browser, so a de-DE reader is served "1,234" and then
    // hydrates to "1.234". Every other board already hardcodes "en-US".
    if (args.trim() === "" || /^\s*undefined\b/.test(args)) {
      out.push({ line, reason: 'runtime locale (pass an explicit locale, e.g. "en-US")', snippet })
      continue
    }

    // Rule A — a DATE or TIME rendering must pin the zone. Deliberately only
    // the two methods that are unambiguously Date methods; plain
    // toLocaleString is usually a Number on these boards, and demanding
    // timeZone on it would red ~20 correct call sites.
    if ((kind === "Date" || kind === "Time") && !/\btimeZone\s*:/.test(args)) {
      out.push({ line, reason: 'runtime timezone (add timeZone: "UTC")', snippet })
    }
  }
  return out
}

function scan(): { file: string; violations: Violation[] }[] {
  const out: { file: string; violations: Violation[] }[] = []
  for (const root of ROOTS) {
    for (const full of walk(join(process.cwd(), root))) {
      const raw = readFileSync(full, "utf8")
      if (!isClientFile(raw)) continue
      const violations = findUnsafeLocaleCalls(stripComments(raw))
      if (violations.length) out.push({ file: relative(process.cwd(), full).split(sep).join("/"), violations })
    }
  }
  return out
}

describe("insights client date formatting is hydration-safe", () => {
  it("the enumerator still sees the insights client tree (not vacuously passing)", () => {
    // ⚠ Asserts on the WALK, never on how many sites are still dirty. A
    // threshold on the dirty count goes RED the moment the population is
    // driven to zero — which is the goal — and this repo has already shipped
    // that bug once, as server-page-data-access-ratchet's `pages.length > 10`.
    // A not-vacuous check must be satisfiable at a population of ZERO.
    const clientFiles = ROOTS.flatMap((r) => walk(join(process.cwd(), r))).filter((f) =>
      isClientFile(readFileSync(f, "utf8")),
    )
    expect(clientFiles.length).toBeGreaterThan(15)
  })

  it("no hydrated insights component formats with the runtime timezone or locale", () => {
    const bad = scan()
    const report = bad
      .flatMap((f) => f.violations.map((v) => f.file + ":" + v.line + " — " + v.reason + "\n    " + v.snippet))
      .join("\n")
    expect(report, "React #418 hydration risk:\n" + report).toBe("")
  })

  // ── guards-the-guard ──────────────────────────────────────────────────────
  // Without these, gutting the detector would leave the ban passing forever
  // while pointing at nothing.

  it("flags the exact pre-fix first-mint and serial-premiums source", () => {
    const firstMint = 'new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" })'
    const serialPrem =
      'new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })'
    expect(findUnsafeLocaleCalls(firstMint)).toHaveLength(1)
    expect(findUnsafeLocaleCalls(firstMint)[0].reason).toMatch(/timezone/)
    expect(findUnsafeLocaleCalls(serialPrem)).toHaveLength(1)
  })

  it("flags the pre-fix panini runtime-locale form", () => {
    const panini = "Number(x).toLocaleString(undefined, { maximumFractionDigits: 2 })"
    expect(findUnsafeLocaleCalls(panini)).toHaveLength(1)
    expect(findUnsafeLocaleCalls(panini)[0].reason).toMatch(/locale/)
  })

  it("accepts the fixed forms, and does not demand timeZone on a NUMBER", () => {
    // The three shipped fixes...
    expect(
      findUnsafeLocaleCalls(
        'new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })',
      ),
    ).toHaveLength(0)
    expect(findUnsafeLocaleCalls('Number(x).toLocaleString("en-US", { maximumFractionDigits: 2 })')).toHaveLength(0)
    // ...and the shape this must NOT punish: a locale-pinned number, which is
    // what most board helpers do.
    expect(findUnsafeLocaleCalls('Number(n).toLocaleString("en-US")')).toHaveLength(0)
  })

  it("reads timeZone out of a MULTI-LINE options object, not just the call head", () => {
    const multiline = [
      'd.toLocaleDateString("en-US", {',
      '  month: "short",',
      '  day: "numeric",',
      '  timeZone: "UTC",',
      "})",
    ].join("\n")
    expect(findUnsafeLocaleCalls(multiline)).toHaveLength(0)
  })

  it("strips comments, so documenting the banned form is not itself a violation", () => {
    const documented = [
      '// was: toLocaleDateString("en-US", { month: "short" })',
      "/* also banned: toLocaleString(undefined, {}) */",
      'const s = d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" })',
    ].join("\n")
    expect(findUnsafeLocaleCalls(stripComments(documented))).toHaveLength(0)
  })
})
