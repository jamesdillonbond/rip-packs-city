import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// ── THE BAKED-POPULATION-COUNT RATCHET ─────────────────────────────────────
//
// A literal population size written into user-visible copy is a claim that was
// true once and decays silently from the moment it ships. It is not a stale
// cache — nothing refreshes it and nothing goes red when it drifts.
//
// The instance that produced this guard (filed 2026-08-22, fixed 2026-08-26):
// the cross-collection board hardcoded "143 wallets hold 3+ Flow collections"
// in FOUR places — three SEO/OG/Twitter description fields and the string the
// user broadcasts from the share button — while the board itself rendered the
// live `stats.cohort_size` three lines away. Measured: 143 at some unknown past
// date, 179 on 2026-08-17, 220 on 2026-08-26. The indexed description was ~35%
// low, and the share string handed a collector a false number to publish under
// their own name.
//
// ⚠ THE SPREAD IS THE POINT. It went 1 site -> 4 by copy-paste, and a fifth
// (the squeeze board's "10 of the 8,859 editions that carry a live ask", live
// 12 of 2,944 — the denominator ~3x too large) was in an unrelated file that
// the original filing never looked at. CLAUDE.md: grep for the EXPRESSION, not
// the file. A comment next to the fix would only have been read by someone
// already in that file, which is why this is a test and not a note.
//
// ⚠ COMMENTS ARE STRIPPED FIRST, with the SHARED stripper. Prose about a
// measurement ("727 editions on this board are priced at 0.90x a single
// seller's ask") is documentation, not a published claim, and five of the six
// raw grep hits were exactly that. A guard that cannot tell copy from comment
// reports mostly noise and gets silenced. ⚠ Never a local copy of the stripper:
// a copy-pasted one blanked 100k+ chars of real source and hid a live P0.
//
// ── THE ESCAPE HATCH, and why it is a ratchet rather than an allowlist ──────
//
// Some counts are honest: a closed print run does not grow. `/insights/page.tsx`
// says the Candy MLB board covers "all 125 editions" of the 2026 MLB Base
// Series ICONs — verified against the live DB on 2026-08-26 at exactly 125, and
// a Base Series is a fixed set.
//
// So a line may carry `baked-count-ok: <reason>` in a comment on that line or
// the one above. The BAN is at zero and the SUPPRESSION is the curated list —
// that ordering is deliberate (CLAUDE.md), because an allowlist of violations
// grows quietly while a suppression list is visible. MAX_EXEMPTIONS ratchets
// DOWN only: a new baked count cannot be waved through without also lowering
// something else or arguing the number in this file.

const ROOTS = ["app/insights", "components"]
const EXTS = new Set([".tsx", ".ts"])

/** Ratchet. Lower it when an exemption is removed; never raise it. */
const MAX_EXEMPTIONS = 1

// A digit group followed by a population noun. Deliberately NOT anchored to
// specific components: the defect is the shape, and the next instance will be
// in a file nobody has thought of yet.
const BAKED = /\b\d[\d,]{1,8}\+?\s+(wallets|editions|moments|packs|sets|players|collectors|cards|holders)\b/gi

const MARKER = /baked-count-ok:\s*\S/

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const e of entries) {
    const p = path.join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (EXTS.has(path.extname(p))) out.push(p)
  }
  return out
}

type Hit = { file: string; line: number; text: string; exempt: boolean }

function scan(): { files: string[]; hits: Hit[] } {
  // ⚠ `path.relative` returns BACKSLASH separators on Windows, so every comparison
  // against a forward-slash literal (`startsWith("app/insights/")`, the ROOTS above)
  // silently misses. CI is Linux and never sees it; this box does. Normalise here so
  // the guard is platform-independent rather than platform-lucky.
  const files = ROOTS.flatMap((r) => walk(path.join(process.cwd(), r))).map((p) =>
    path.relative(process.cwd(), p).split(path.sep).join("/"),
  )
  const hits: Hit[] = []
  for (const f of files) {
    const src = readFileSync(path.join(process.cwd(), f), "utf8")
    const rawLines = src.split("\n")
    // Line numbers are preserved by the stripper (it blanks, it does not
    // delete), so a marker in the ORIGINAL source stays addressable by index
    // after stripping. Asserted below rather than assumed.
    const codeLines = stripComments(src).split("\n")
    codeLines.forEach((line, i) => {
      for (const m of line.matchAll(BAKED)) {
        const here = rawLines[i] ?? ""
        const above = rawLines[i - 1] ?? ""
        hits.push({
          file: f,
          line: i + 1,
          text: m[0].trim(),
          exempt: MARKER.test(here) || MARKER.test(above),
        })
      }
    })
  }
  return { files, hits }
}

describe("insights copy carries no baked population counts", () => {
  const { files, hits } = scan()

  it("inspects the REAL tree — a ban at population zero, not an empty sweep", () => {
    // Without this, a renamed directory or a broken extension filter makes every
    // assertion below pass by inspecting nothing.
    expect(files.length).toBeGreaterThan(100)
    expect(files.some((f) => f.startsWith("app/insights/"))).toBe(true)
  })

  it("the stripper preserves line numbers, so a marker stays addressable", () => {
    // The exemption mechanism is built on this property. If the stripper ever
    // starts deleting lines instead of blanking them, every marker silently
    // points at the wrong line and exemptions attach to the wrong code.
    const sample = "a\n// c\nb /* x\ny */ z\n"
    expect(stripComments(sample).split("\n").length).toBe(sample.split("\n").length)
  })

  it("no UNEXEMPTED baked population count appears in user copy", () => {
    const bad = hits.filter((h) => !h.exempt)
    expect(
      bad,
      `Baked population counts in user-visible copy:\n${bad
        .map((h) => `  ${h.file}:${h.line}  "${h.text}"`)
        .join("\n")}\n\n` +
        `A literal count decays the moment it ships and nothing goes red when it does.\n` +
        `Read it (the board almost always already has the value in hand), or drop the\n` +
        `number from the sentence. NEVER re-bake a fresher constant, and NEVER "?? 0" a\n` +
        `failed read into the copy — that publishes a measured zero.\n` +
        `If the population is genuinely CLOSED (a fixed print run), add a comment on the\n` +
        `line or the line above: baked-count-ok: <why it cannot grow>`,
    ).toEqual([])
  })

  it("exemptions stay rare — the ratchet only goes down", () => {
    const exempt = hits.filter((h) => h.exempt)
    expect(
      exempt.length,
      `Exempted baked counts:\n${exempt.map((h) => `  ${h.file}:${h.line}  "${h.text}"`).join("\n")}`,
    ).toBeLessThanOrEqual(MAX_EXEMPTIONS)
  })

  it("the marker actually gates — it is not decorative", () => {
    // Proves the exemption path can FAIL, both directions. Without this, a
    // marker regex that matched everything (or nothing) would look identical to
    // a working one on a clean tree.
    expect(MARKER.test("// baked-count-ok: fixed 125-card print run")).toBe(true)
    expect(MARKER.test("// baked-count-ok:")).toBe(false)
    expect(MARKER.test("// just an ordinary comment")).toBe(false)
    // And the detector itself must still see a violation when one exists.
    expect(BAKED.test("143 wallets hold 3+ Flow collections")).toBe(true)
    expect(new RegExp(BAKED.source, "i").test("the cohort of wallets")).toBe(false)
  })
})
