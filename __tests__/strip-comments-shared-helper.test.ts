// Contract tests for the ONE shared comment stripper (scripts/lib/strip-comments.mjs).
//
// WHY THIS FILE EXISTS. 37 files had grown their own `stripComments`, and two
// separate implementations were measured BLIND on 2026-08-22 — each hiding real
// source from every guard built on it. A stripper that blanks too much is the
// worst class of guard bug, because the guard still passes and still reports a
// population; it is simply reading a blanked file.
//
// So every test below is written as a PAIR: the new stripper must keep the
// code, AND the implementation it replaces must be shown to lose it. A test
// that only asserts the new behaviour cannot tell "fixed" from "never broken",
// and would let a future rewrite silently reintroduce either defect.

import { describe, it, expect } from "vitest"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// ── The two implementations this replaces, kept verbatim as NEGATIVE CONTROLS ──

/** The 20-copy regex stripper. Strips block comments BEFORE line comments. */
function legacyRegexStripper(src: string): string {
  const blanks = (s: string) => s.replace(/[^\n]/g, " ")
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blanks)
    .replace(/(^|[^:])\/\/.*$/gm, (m, p1) => p1 + " ".repeat(m.length - p1.length))
}

/** The proposed state-machine replacement, which had no regex-literal state. */
function stateMachineWithoutRegexState(src: string): string {
  let out = ""
  let i = 0
  let state: "code" | "line" | "block" | "sq" | "dq" | "tpl" = "code"
  const BS = String.fromCharCode(92)
  while (i < src.length) {
    const c = src[i]
    const d = src[i + 1]
    if (state === "code") {
      if (c === "/" && d === "/") { state = "line"; out += "  "; i += 2; continue }
      if (c === "/" && d === "*") { state = "block"; out += "  "; i += 2; continue }
      if (c === "'") state = "sq"
      else if (c === '"') state = "dq"
      else if (c === "`") state = "tpl"
      out += c; i++; continue
    }
    if (state === "line") {
      if (c === "\n") { state = "code"; out += c } else out += " "
      i++; continue
    }
    if (state === "block") {
      if (c === "*" && d === "/") { state = "code"; out += "  "; i += 2; continue }
      out += c === "\n" ? c : " "; i++; continue
    }
    if (c === BS) { out += src.slice(i, i + 2); i += 2; continue }
    if ((state === "sq" && c === "'") || (state === "dq" && c === '"') || (state === "tpl" && c === "`")) state = "code"
    out += c; i++
  }
  return out
}

describe("stripComments — DEFECT 1: a line comment containing /* must not open a block comment", () => {
  // This is the exact shape that hid ~19.6k chars of CollectionAnalyticsClient.tsx,
  // including the branch publishing a 99-day-old row as market depth.
  const sample = [
    "// short form used by /api/* endpoints. Distinct from SLUG_TO_DB_SLUG",
    "const orderbook = data?.topshot_orderbook",
    "/* a genuine block comment */",
    "const after = 1",
  ].join("\n")

  it("keeps the code the legacy stripper blanked", () => {
    expect(stripComments(sample)).toContain("data?.topshot_orderbook")
    expect(stripComments(sample)).toContain("const after = 1")
  })

  it("NEGATIVE CONTROL — the legacy regex stripper loses it", () => {
    // If this ever stops failing, the negative control has gone vacuous and
    // the test above no longer proves anything.
    expect(legacyRegexStripper(sample)).not.toContain("data?.topshot_orderbook")
  })
})

describe("stripComments — DEFECT 2: a regex ending in an escaped slash is not a comment", () => {
  // Raw characters are `\` `/` `/` — the escaped slash and the regex's closing
  // slash are adjacent. Measured in 66 files, including the guards' own
  // `.replace(/\/\*[\s\S]*?\*\//g, ...)` bodies.
  const sample = [
    "function isAbsolute(url) {",
    "  if (!/^https?:\\/\\//i.test(url)) { return KEEP_ME }",
    "  return OTHER_TOKEN",
    "}",
  ].join("\n")

  it("keeps code after the regex literal", () => {
    const out = stripComments(sample)
    expect(out).toContain("KEEP_ME")
    expect(out).toContain("OTHER_TOKEN")
  })

  it("NEGATIVE CONTROL — the regex-state-less machine loses it", () => {
    expect(stateMachineWithoutRegexState(sample)).not.toContain("KEEP_ME")
  })

  it("handles a regex character class containing a slash", () => {
    const s = 'const m = str.match(/[/?#]/) ; const KEEP = 2'
    expect(stripComments(s)).toContain("KEEP")
  })
})

describe("stripComments — it must still actually strip comments", () => {
  it("strips line comments", () => {
    expect(stripComments("const a = 1 // SECRET_TOKEN\n")).not.toContain("SECRET_TOKEN")
  })

  it("strips block comments, including multi-line", () => {
    const s = "const a = 1\n/* SECRET_TOKEN\n still hidden */\nconst b = 2"
    const out = stripComments(s)
    expect(out).not.toContain("SECRET_TOKEN")
    expect(out).not.toContain("still hidden")
    expect(out).toContain("const b = 2")
  })

  it("does NOT treat // inside a string as a comment", () => {
    const s = 'const u = "https://example.com/KEEP_ME"\nconst v = 1'
    expect(stripComments(s)).toContain("KEEP_ME")
  })

  it("does not mistake division for a regex", () => {
    const s = "const ratio = total / count // HIDE_ME\nconst KEEP = 1"
    const out = stripComments(s)
    expect(out).not.toContain("HIDE_ME")
    expect(out).toContain("KEEP")
    expect(out).toContain("total / count")
  })

  it("preserves length and line numbers so callers can report positions", () => {
    const s = "const a = 1 // comment\nconst b = 2\n/* x */\nconst c = 3"
    const out = stripComments(s)
    expect(out).toHaveLength(s.length)
    expect(out.split("\n")).toHaveLength(s.split("\n").length)
  })
})

/**
 * DEFECT 3's negative control: the stripper as it stood before 2026-08-27.
 * Identical to the shipped one EXCEPT that it has no template-interpolation
 * stack, so `${...}` is copied verbatim — which is what breaks.
 */
function stripperWithoutInterpolationStack(src: string): string {
  const KEYWORDS = new Set([
    "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
    "throw", "case", "do", "else", "yield", "await",
  ])
  let out = ""
  let i = 0
  let state: "code" | "line" | "block" | "sq" | "dq" | "tpl" | "regex" | "class" = "code"
  const BS = String.fromCharCode(92)
  let lastSig = ""
  let word = ""
  const regexCanFollow = () => {
    if (word && !KEYWORDS.has(word)) return false
    if (word) return true
    if (lastSig === "") return true
    return !/[A-Za-z0-9_$)\]]/.test(lastSig)
  }
  while (i < src.length) {
    const c = src[i]
    const d = src[i + 1]
    if (state === "code") {
      if (c === "/" && d === "/") { state = "line"; out += "  "; i += 2; continue }
      if (c === "/" && d === "*") { state = "block"; out += "  "; i += 2; continue }
      if (c === "/" && regexCanFollow()) { state = "regex"; out += c; i++; lastSig = c; word = ""; continue }
      if (c === "'") state = "sq"
      else if (c === '"') state = "dq"
      else if (c === "`") state = "tpl"
      if (/[A-Za-z0-9_$]/.test(c)) word += c
      else if (!/\s/.test(c)) word = ""
      if (!/\s/.test(c)) lastSig = c
      out += c; i++; continue
    }
    if (state === "line") {
      if (c === "\n") { state = "code"; out += c; word = "" } else out += " "
      i++; continue
    }
    if (state === "block") {
      if (c === "*" && d === "/") { state = "code"; out += "  "; i += 2; word = ""; continue }
      out += c === "\n" ? c : " "; i++; continue
    }
    if (state === "regex") {
      if (c === BS) { out += src.slice(i, i + 2); i += 2; continue }
      if (c === "[") state = "class"
      else if (c === "/") { state = "code"; lastSig = "/"; word = "" }
      else if (c === "\n") { state = "code"; word = "" }
      out += c; i++; continue
    }
    if (state === "class") {
      if (c === BS) { out += src.slice(i, i + 2); i += 2; continue }
      if (c === "]") state = "regex"
      out += c; i++; continue
    }
    if (c === BS) { out += src.slice(i, i + 2); i += 2; continue }
    if ((state === "sq" && c === "'") || (state === "dq" && c === '"') || (state === "tpl" && c === "`")) {
      state = "code"; lastSig = c; word = ""
    }
    out += c; i++
  }
  return out
}

describe("stripComments — DEFECT 3: a nested template literal in ${...} must not close the outer one", () => {
  // The commonest shape in this repo's HTML email builders. Copying the
  // interpolation verbatim reads the INNER opening backtick as the OUTER
  // literal's closing one; from there the machine sits in `code` inside HTML
  // text, where `/` in `</td>` opens a regex and `//` in a URL opens a comment.
  //
  // Measured 2026-08-27 on app/api/check-alerts/route.ts, where ONE desync
  // produced BOTH failure directions at once — which is why both are asserted.
  // Minimal reproducer, found by searching against the pre-fix stripper rather
  // than constructed by reasoning — several hand-written candidates re-synced
  // and would have made the negative control below vacuous.
  const sample = [
    'const h = `<table>${a ? `<td>${x}</td>` : ""}</table>`;',
    "// THIS_COMMENT_MUST_GO",
    "const u = `https://api.telegram.org/bot${TOKEN}/send`;",
  ].join("\n")

  it("keeps the source the desync blanked (the URL, cut at `https:`)", () => {
    const out = stripComments(sample)
    expect(out).toContain("api.telegram.org")
  })

  it("still strips the comment the desync left intact", () => {
    // The symptom filed 2026-08-27T0500Z: a guard reading its own explanation
    // as evidence. Asserting the ABSENCE of the false claim, not the presence
    // of a fix.
    expect(stripComments(sample)).not.toContain("THIS_COMMENT_MUST_GO")
  })

  it("NEGATIVE CONTROL — the pre-2026-08-27 stripper shows BOTH failures", () => {
    // If either of these stops failing, the controls have gone vacuous and the
    // two tests above no longer prove the defect was ever real.
    const before = stripperWithoutInterpolationStack(sample)
    expect(before).not.toContain("api.telegram.org")   // blanked real source
    expect(before).toContain("THIS_COMMENT_MUST_GO")   // left a comment intact
  })
})

describe("stripComments — the boundary that REPLACED the verbatim-interpolation one", () => {
  it("parses ${...} as code, so a comment inside an interpolation IS stripped", () => {
    // This inverts the assertion that stood here until 2026-08-27, which
    // pinned the interpolation as verbatim and called that "the safe
    // direction". DEFECT 3 in the helper's header records the measurement that
    // refuted it. Updated with a fresh measurement, as that note required —
    // not deleted.
    const s = "const t = `value: ${a // now stripped\n}`"
    expect(stripComments(s)).not.toContain("now stripped")
  })

  it("still copies template TEXT verbatim — only the interpolation is code", () => {
    expect(stripComments("const t = `see https://x.com/KEEP_ME here`")).toContain("KEEP_ME")
  })

  it("handles interpolations holding braces, strings and nested templates", () => {
    const s = 'const t = `${o({ a: "}" })}${c ? `${d}` : "{"}` ; const KEEP = 1'
    expect(stripComments(s)).toContain("KEEP")
  })
})

// ⚠ SCOPE. The block below pins the SHAPE of DEFECT 4 with a synthetic fixture.
// It does NOT walk the tree and does NOT name the affected files — the stripper's
// header claimed it did both until 2026-08-29, which is how the real population
// drifted (8 → 7) unobserved. The COUNT lives in
// `__tests__/strip-comments-defect-4-population.test.ts`. Keep them separate:
// this file is the contract, that one is the census.
describe("stripComments — DEFECT 4: JSX text is not JS (known, unfixed, pinned)", () => {
  // An apostrophe in JSX prose is not a string delimiter, but this is a JS
  // parser. `<p>Couldn't load</p>` opens an `sq` state that runs to the next
  // apostrophe. Pinned so the boundary is visible rather than silent.
  it("fails in the SAFE direction — it keeps too much, it does not blank code", () => {
    const s = ["function C() {", "  return <p>Couldn't load</p>", "}", "const KEEP_ME = 1"].join("\n")
    // The guarantee that matters: real source is never lost.
    expect(stripComments(s)).toContain("KEEP_ME")
  })

  it("is a REAL open boundary, not a hypothetical — the desync is reproduced here", () => {
    // Positive control for the claim above: without this, "fails safe" would be
    // asserting nothing, because there would be no desync to fail safely.
    const s = ["const a = <p>Couldn't</p>", "// THIS_SURVIVES_THE_DESYNC", "const b = 2"].join("\n")
    expect(stripComments(s)).toContain("THIS_SURVIVES_THE_DESYNC")
  })
})
