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

describe("stripComments — the documented boundary, pinned so it is visible not silent", () => {
  it("copies ${...} inside a template literal verbatim rather than re-parsing it", () => {
    // Deliberate: the failure direction must be KEEPING too much, never
    // blanking too much. If someone makes interpolation recursive, this test
    // should be updated with a fresh measurement, not deleted.
    const s = "const t = `value: ${a // not stripped\n}`"
    expect(stripComments(s)).toContain("not stripped")
  })
})
