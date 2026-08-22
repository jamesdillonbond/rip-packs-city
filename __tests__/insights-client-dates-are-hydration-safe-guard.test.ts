import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

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
// ── SCOPE WIDENED 2026-08-17, WITH THE MEASUREMENT THE OLD NOTE DEMANDED ───
// The previous version scoped both rules to app/insights + components/insights
// and said "widen this scope only with a measurement, never by assumption."
// That measurement is now in, and it found the exact failure this repo keeps
// paying for: THE GUARD WAS GREEN ON A POPULATION IT HAD ITSELF DRIVEN TO ZERO,
// and structurally blind to every site outside its own two roots. Re-running
// its own predicate over ALL of app/ + components/ (client files only):
//
//   Rule A (date/time, runtime timezone) ...   5 sites
//   Rule B (runtime locale) ................ 79 sites (was 101; see note below)
//
// Of the 5 Rule-A sites, exactly ONE was a live defect, and it was worse than a
// hydration mismatch. PaniniOverviewClient rendered a MODULE CONSTANT's
// date-only ISO string ("2026-03-30"), which `new Date()` parses as UTC
// midnight: Vercel (UTC) served "Mar 30" and every US browser hydrated to
// "Mar 29". React #418 AND a wrong date on a public page. Fixed by pinning
// timeZone: "UTC".
//
// ⚠ THE OTHER FOUR ARE CORRECT CODE AND MUST NOT BE "FIXED". They are
// post-mount clocks — the formatted value comes from state that is null at SSR
// (useState(null) / useWarmCache, each gated on the value) — so nothing
// server-renders and there is no text to mismatch. Pinning them to UTC would
// not fix a bug; it would SHOW THE VIEWER UTC, a real regression on a "last
// updated" clock. The old note was right that a static check cannot tell these
// apart, and wrong that this forces a narrow scope: what it forces is an
// ESCAPE, and the escape must be co-located with the call, not a central list.
//
// ⚠ THE ESCAPE IS AN INLINE `hydration-safe: <reason>` MARKER, DELIBERATELY NOT
// AN ALLOWLIST. This repo's recorded rule is that a curated list drifts BOTH
// ways at once — it goes stale on renames and silently absorbs new instances —
// so the durable fix is the DERIVATION. A tree walk plus a marker that has to
// sit next to the call keeps the derivation complete: a new violation is
// visible by default, and suppressing it costs the author a written reason at
// the site, where the next reader is standing. The marker is read from the RAW
// source (before stripComments), and a bare `hydration-safe:` with no reason
// does NOT suppress.
//
// ── WHY RULE A IS A BAN AND RULE B IS A RATCHET ────────────────────────────
// Rule A's population is now ZERO unmarked site-wide, so a ban costs no
// allowlist. Rule B's is 101 across 42 files — that is a ratchet population,
// not a ban population, and this repo has already learned that a "ban" shipping
// a 40-entry allowlist is theatre. Rule B stays a BAN inside the insights roots
// (where it is genuinely at zero) and a site-wide RATCHET everywhere else.

const INSIGHTS_ROOTS = ["app/insights", "components/insights"]
const SITE_ROOTS = ["app", "components"]

// Site-wide Rule-B population, measured 2026-08-17. ⚠ This is a CEILING, not a
// target: the assertion is `<=`, so it is satisfiable at zero and does not go
// red when the population is driven down — the failure mode this repo shipped
// once as server-page-data-access-ratchet's `pages.length > 10`. Lower it when
// you drain some; never raise it to make a new violation pass.
const RULE_B_SITEWIDE_CEILING = 79

/**
 * Blank out comments, preserving offsets.
 *
 * ⚠ REQUIRED, not tidiness. This header quotes toLocaleDateString and the
 * fixed call sites carry comments naming the API they no longer misuse, so a
 * version without this reports its own documentation as the offender. This
 * repo has shipped that exact bug at least six times.
 */
/*
 * ⚠ MIGRATED 2026-08-22 to the ONE shared stripper (scripts/lib/strip-comments.mjs).
 * The local copy here stripped BLOCK comments before LINE comments, so an
 * ordinary line comment mentioning a glob path opened a block comment that ran
 * to the next close-comment anywhere in the file, blanking real source this
 * guard then reported as clean (103,590 chars across 49 product files).
 * Do not re-inline a local copy.
 */

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

/**
 * True when the RAW source carries a justified `hydration-safe:` marker for a
 * call whose head sits on 1-based `line`.
 *
 * ⚠ Read from the RAW source on purpose. Everything else here runs on
 * stripComments() output — because this file's own header quotes the banned
 * forms — but the marker IS a comment, so stripping first would erase every
 * escape and red all four correct clocks.
 *
 * ⚠ The reason is REQUIRED. A bare `hydration-safe:` suppresses nothing: an
 * escape that costs nothing to write is an allowlist with extra steps, and the
 * whole point of putting it at the call site is that the next reader finds the
 * argument rather than a token.
 *
 * The window is the call-head line and the 4 lines above it — enough for a
 * multi-line JSX comment immediately preceding the call, and too tight to
 * silently cover a neighbouring call.
 */
export function hasHydrationSafeMarker(rawSrc: string, line: number): boolean {
  const lines = rawSrc.split("\n")
  const from = Math.max(0, line - 5)
  const window = lines.slice(from, line).join("\n")
  const m = /hydration-safe:[ \t]*(\S.*)?/.exec(window)
  return Boolean(m && m[1] && m[1].trim().length > 0)
}

type Scanned = { file: string; violations: Violation[] }

function scanRoots(roots: string[], keep: (v: Violation, raw: string) => boolean): Scanned[] {
  const out: Scanned[] = []
  const seen = new Set<string>()
  for (const root of roots) {
    for (const full of walk(join(process.cwd(), root))) {
      if (seen.has(full)) continue
      seen.add(full)
      const raw = readFileSync(full, "utf8")
      if (!isClientFile(raw)) continue
      const violations = findUnsafeLocaleCalls(stripComments(raw)).filter((v) => keep(v, raw))
      if (violations.length) out.push({ file: relative(process.cwd(), full).split(sep).join("/"), violations })
    }
  }
  return out
}

const isRuleA = (v: Violation) => /timezone/.test(v.reason)

function scan(): Scanned[] {
  return scanRoots(INSIGHTS_ROOTS, () => true)
}

function report(bad: Scanned[]): string {
  return bad
    .flatMap((f) => f.violations.map((v) => f.file + ":" + v.line + " — " + v.reason + "\n    " + v.snippet))
    .join("\n")
}

describe("insights client date formatting is hydration-safe", () => {
  it("the enumerator still sees the insights client tree (not vacuously passing)", () => {
    // ⚠ Asserts on the WALK, never on how many sites are still dirty. A
    // threshold on the dirty count goes RED the moment the population is
    // driven to zero — which is the goal — and this repo has already shipped
    // that bug once, as server-page-data-access-ratchet's `pages.length > 10`.
    // A not-vacuous check must be satisfiable at a population of ZERO.
    const clientFiles = INSIGHTS_ROOTS.flatMap((r) => walk(join(process.cwd(), r))).filter((f) =>
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

// ── SITE-WIDE (widened 2026-08-17) ─────────────────────────────────────────
// The block above keeps app/insights + components/insights at zero on BOTH
// rules. This block covers the tree the old scope was blind to by construction.

describe("client date formatting is hydration-safe site-wide", () => {
  it("the site-wide enumerator still sees a client tree far larger than insights", () => {
    // ⚠ Asserts on the WALK, never on a dirty count — the assertion must stay
    // satisfiable at a population of ZERO. The `>` against the insights count
    // is the load-bearing half: if someone re-narrows SITE_ROOTS back to the
    // insights dirs, the ban below would still read green while covering
    // nothing, which is precisely the failure this widening exists to fix.
    const clientFiles = (roots: string[]) => {
      const seen = new Set<string>()
      for (const r of roots) for (const f of walk(join(process.cwd(), r))) seen.add(f)
      return [...seen].filter((f) => isClientFile(readFileSync(f, "utf8")))
    }
    const site = clientFiles(SITE_ROOTS)
    const insights = clientFiles(INSIGHTS_ROOTS)
    expect(site.length).toBeGreaterThan(insights.length)
    expect(site.length).toBeGreaterThan(60)
  })

  it("BAN: no client component anywhere renders a date/time in the runtime timezone without a justified marker", () => {
    const bad = scanRoots(SITE_ROOTS, (v, raw) => isRuleA(v) && !hasHydrationSafeMarker(raw, v.line))
    const r = report(bad)
    expect(
      r,
      "React #418 hydration risk (Rule A).\n" +
        "Fix by pinning timeZone, OR — if the value is null at SSR (post-mount\n" +
        "clock) — add an inline `hydration-safe: <reason>` comment at the call:\n" +
        r,
    ).toBe("")
  })

  it("RATCHET: the site-wide runtime-locale population does not grow", () => {
    const bad = scanRoots(SITE_ROOTS, (v) => !isRuleA(v))
    const count = bad.reduce((n, f) => n + f.violations.length, 0)
    expect(
      count,
      "Rule B (runtime locale) grew past its ceiling of " +
        RULE_B_SITEWIDE_CEILING +
        ". Pass an explicit locale, e.g. \"en-US\":\n" +
        report(bad),
    ).toBeLessThanOrEqual(RULE_B_SITEWIDE_CEILING)
  })

  // ── guards-the-guard: the MARKER ─────────────────────────────────────────
  // Without these, the escape hatch is the whole guard's soft underbelly — a
  // marker that suppressed everything, or that could be written without a
  // reason, would turn the ban back into the allowlist it exists to avoid.

  it("a justified marker suppresses the call it sits above", () => {
    const src = [
      "{/* hydration-safe: null at SSR, gated on the value */}",
      'updated {new Date(t).toLocaleTimeString([], { hour: "2-digit" })}',
    ].join("\n")
    // The detector still SEES it...
    expect(findUnsafeLocaleCalls(stripComments(src))).toHaveLength(1)
    // ...and the marker is what excuses it.
    expect(hasHydrationSafeMarker(src, 2)).toBe(true)
  })

  it("a BARE marker with no reason suppresses NOTHING", () => {
    const bare = ["// hydration-safe:", 'x.toLocaleTimeString("en-US")'].join("\n")
    expect(hasHydrationSafeMarker(bare, 2)).toBe(false)
    const spaces = ["// hydration-safe:    ", 'x.toLocaleTimeString("en-US")'].join("\n")
    expect(hasHydrationSafeMarker(spaces, 2)).toBe(false)
  })

  it("a marker does not reach a call further down the file", () => {
    const far = [
      "// hydration-safe: applies to the call right below",
      'a.toLocaleTimeString("en-US")',
      "const x = 1",
      "const y = 2",
      "const z = 3",
      "const w = 4",
      'b.toLocaleTimeString("en-US")',
    ].join("\n")
    expect(hasHydrationSafeMarker(far, 2)).toBe(true)
    expect(hasHydrationSafeMarker(far, 7)).toBe(false)
  })

  it("the marker excuses Rule A only — it can never suppress Rule B", () => {
    // Rule B is a separate failure (runtime LOCALE, not zone) and the marker's
    // stated reason is always about SSR timing, which says nothing about it.
    // The filter composes them with `isRuleA`, so this is pinned by shape.
    const v = findUnsafeLocaleCalls("x.toLocaleString(undefined, {})")
    expect(v).toHaveLength(1)
    expect(isRuleA(v[0])).toBe(false)
  })

  it("the four known post-mount clocks are marked, and the Panini date is PINNED not marked", () => {
    // The one real defect had to be FIXED, not excused. If a later edit swaps
    // the timeZone pin for a marker, this reds — an escape is not a fix.
    const panini = readFileSync(
      join(process.cwd(), "app/(collections)/panini-blockchain/overview/PaniniOverviewClient.tsx"),
      "utf8",
    )
    // Rule A only: this file also carries a bare `n.toLocaleString()` number
    // format (Rule B), which is inside the site-wide ratchet, not this ban.
    expect(findUnsafeLocaleCalls(stripComments(panini)).filter(isRuleA)).toHaveLength(0)
    expect(panini).toContain('timeZone: "UTC"')

    for (const f of [
      "components/sniper/SniperStatsBar.tsx",
      "app/admin/analytics/AdminAnalyticsClient.tsx",
      "app/dashboard/alerts/DashboardAlertsClient.tsx",
      "app/(collections)/disney-pinnacle/sniper/PinnacleSniperClient.tsx",
    ]) {
      const raw = readFileSync(join(process.cwd(), f), "utf8")
      const ruleA = findUnsafeLocaleCalls(stripComments(raw)).filter(isRuleA)
      expect(ruleA.length, f + " no longer has the Rule-A call this pin describes").toBeGreaterThan(0)
      for (const v of ruleA) expect(hasHydrationSafeMarker(raw, v.line), f + ":" + v.line).toBe(true)
    }
  })
})
