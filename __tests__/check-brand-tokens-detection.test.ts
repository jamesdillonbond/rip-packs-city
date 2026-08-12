import { describe, it, expect } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import path from "node:path"

// ── Guard for the guard: scripts/check-brand-tokens.mjs ─────────────────────
//
// That script runs in the BLOCKING `typecheck` CI job and is the only thing
// stopping hardcoded brand/neutral literals from regrowing in ~180 cleaned
// surfaces. Nothing tested it. Its entire detection surface is five regexes and
// a 3-line comment window — and a regex that quietly stops matching does not
// fail: the script prints "N surface(s) clean" and exits 0. A weakened guard and
// a genuinely clean repo are byte-identical from CI's point of view, which is
// the same failure shape as the pin-staleness parser blind spot that silently
// dropped two pins from the live-drift check (fixed 2026-08-08).
//
// Technique mirrors __tests__/db-pin-staleness-parser-coverage.test.ts: read the
// script's ACTUAL regex literals out of its source and exercise them, rather
// than restating them here. A copy would drift and then assert nothing — the
// exact defect this file exists to prevent.
//
// It also pins the two PROTECTED lists against rot: the script counts a missing
// file as a violation (good), but that only surfaces as a generic failure, so
// these assertions name the stale entry directly.

const ROOT = path.resolve(__dirname, "..")
const SCRIPT = path.join(ROOT, "scripts", "check-brand-tokens.mjs")

const src = readFileSync(SCRIPT, "utf8")

/** Pull a named top-level regex literal out of the script and rebuild it. */
function regexFromScript(name: string): RegExp {
  // Matches `const NAME =` followed (possibly on the next line) by /.../flags
  const m = src.match(new RegExp(`const ${name}\\s*=\\s*\\n?\\s*(/.*/[gimsuy]*);`))
  if (!m) throw new Error(`could not extract regex ${name} from check-brand-tokens.mjs`)
  const body = m[1]
  const lastSlash = body.lastIndexOf("/")
  return new RegExp(body.slice(1, lastSlash), body.slice(lastSlash + 1))
}

/** Pull a `const NAME = [ "a", "b" ];` string array out of the script. */
function listFromScript(name: string): string[] {
  const start = src.indexOf(`const ${name} = [`)
  if (start < 0) throw new Error(`could not find list ${name}`)
  const end = src.indexOf("];", start)
  return [...src.slice(start, end).matchAll(/"([^"]+)"/g)].map((m) => m[1])
}

describe("check-brand-tokens: the brand LITERAL detector", () => {
  const LITERAL = regexFromScript("LITERAL")

  it("catches every literal the brand rule forbids", () => {
    // These three are the whole point of the guard: CLAUDE.md forbids hardcoding
    // them anywhere in UI in favour of var(--rpc-red)/--font-display/--font-mono.
    expect(LITERAL.test("color: '#E03A2F'")).toBe(true)
    expect(LITERAL.test("color: '#e03a2f'")).toBe(true) // case-insensitive
    expect(LITERAL.test("fontFamily: 'Barlow Condensed'")).toBe(true)
    expect(LITERAL.test("fontFamily: 'Share Tech Mono'")).toBe(true)
  })

  it("does not flag the tokens it is steering people toward", () => {
    // A guard that flags the correct answer trains people to add exceptions.
    expect(LITERAL.test("color: var(--rpc-red)")).toBe(false)
    expect(LITERAL.test("fontFamily: var(--font-display)")).toBe(false)
    expect(LITERAL.test("fontFamily: var(--font-mono)")).toBe(false)
  })
})

describe("check-brand-tokens: the var() fallback escape hatch", () => {
  const FALLBACK = regexFromScript("FALLBACK")
  const VAR_FALLBACK = regexFromScript("VAR_FALLBACK")

  it("permits the documented var(--rpc-red, #E03A2F) fallback form", () => {
    expect(FALLBACK.test("color: var(--rpc-red, #E03A2F)")).toBe(true)
    expect(FALLBACK.test("color: var(--rpc-accent, #E03A2F)")).toBe(true)
  })

  it("does NOT treat a bare literal as a fallback", () => {
    // If this ever returned true, every hardcoded #E03A2F would be waved through.
    expect(FALLBACK.test("color: #E03A2F")).toBe(false)
  })

  it("strips a var() fallback containing nested rgba() parens", () => {
    // The one-level-nested-parens case is why VAR_FALLBACK is not a naive
    // /var\([^)]*\)/ — that would stop at rgba's first ')' and leave the neutral
    // literal exposed, producing a false positive on correct code.
    const line = "background: var(--rpc-surface, rgba(255,255,255,0.06));"
    expect(line.replace(VAR_FALLBACK, "")).not.toMatch(/rgba\(\s*255/)
  })
})

describe("check-brand-tokens: the light-mode NEUTRAL detector", () => {
  const NEUTRAL = regexFromScript("NEUTRAL")

  it("catches white-alpha and the near-black surface rgba forms", () => {
    expect(NEUTRAL.test("rgba(255,255,255,0.06)")).toBe(true)
    expect(NEUTRAL.test("rgba( 255 , 255 , 255 , 0.1)")).toBe(true) // whitespace-tolerant
    expect(NEUTRAL.test("rgba(13,13,13,0.9)")).toBe(true)
    expect(NEUTRAL.test("rgba(8,8,8,1)")).toBe(true)
  })

  it("catches the neutral hex vocabulary in both short and long form", () => {
    for (const hex of ["#fff", "#ffffff", "#000", "#000000", "#080808", "#0a0a0a", "#0d0d0d", "#111", "#111111", "#1a1a1a", "#1f1f1f", "#222", "#222222"]) {
      expect(NEUTRAL.test(`background: ${hex};`), `${hex} should be flagged`).toBe(true)
    }
  })

  it("deliberately allows rgba(0,0,0,*) — scrims and shadows are permitted", () => {
    // Documented in the script. Pinned so a future "tighten the regex" pass
    // notices it is a decision, not an oversight.
    expect(NEUTRAL.test("box-shadow: 0 2px 8px rgba(0,0,0,0.4)")).toBe(false)
  })

  it("does not flag semantic (non-neutral) colors", () => {
    expect(NEUTRAL.test("color: #E03A2F")).toBe(false)
    expect(NEUTRAL.test("color: #34d399")).toBe(false)
    // \b-anchored: a longer hex that merely starts with a neutral prefix is not
    // one of the listed neutrals.
    expect(NEUTRAL.test("color: #111abc")).toBe(false)
  })
})

describe("check-brand-tokens: the TAILWIND neutral-class detector", () => {
  const TAILWIND_NEUTRAL = regexFromScript("TAILWIND_NEUTRAL")

  it("catches the washing-out / black-on-black class vocabulary", () => {
    for (const cls of ["text-white", "bg-white", "border-white", "bg-black", "text-black"]) {
      expect(TAILWIND_NEUTRAL.test(`className="${cls} p-4"`), cls).toBe(true)
    }
  })

  it("catches the raw zinc palette across every utility prefix", () => {
    for (const cls of ["bg-zinc-950", "text-zinc-100", "border-zinc-800", "divide-zinc-700", "ring-zinc-400"]) {
      expect(TAILWIND_NEUTRAL.test(`className="${cls}"`), cls).toBe(true)
    }
  })

  it("does not flag semantic palette classes", () => {
    // Flagging these would make the guard unusable and drive blanket exceptions.
    for (const cls of ["text-emerald-400", "bg-red-500/10", "border-amber-300"]) {
      expect(TAILWIND_NEUTRAL.test(`className="${cls}"`), cls).toBe(false)
    }
  })
})

describe("check-brand-tokens: the brand-exception window", () => {
  // The script scans `lines.slice(Math.max(0, i - 3), i + 1)` — the offending
  // line plus THREE preceding lines. Replicated here from the script's own
  // source so a change to the window size is caught rather than assumed.
  it("uses a 3-line lookback, and the script still says so", () => {
    expect(src).toContain("lines.slice(Math.max(0, i - 3), i + 1)")
  })

  function suppressed(lines: string[], i: number): boolean {
    return /brand-exception/.test(lines.slice(Math.max(0, i - 3), i + 1).join("\n"))
  }

  it("suppresses on the same line and up to 3 lines above", () => {
    expect(suppressed(["color: #E03A2F // brand-exception"], 0)).toBe(true)
    expect(suppressed(["// brand-exception", "a", "b", "color: #E03A2F"], 3)).toBe(true)
  })

  it("does NOT suppress from 4 lines above", () => {
    // The bound matters: too wide and one annotation silently covers unrelated
    // literals further down the file.
    expect(suppressed(["// brand-exception", "a", "b", "c", "color: #E03A2F"], 4)).toBe(false)
  })
})

describe("check-brand-tokens: the PROTECTED lists are not stale", () => {
  const PROTECTED = listFromScript("PROTECTED")
  const NEUTRAL_PROTECTED = listFromScript("NEUTRAL_PROTECTED")

  it("extracts both lists (guards against a silently-empty sweep)", () => {
    // A parser that matched nothing would make every assertion below vacuous.
    expect(PROTECTED.length).toBeGreaterThan(10)
    expect(NEUTRAL_PROTECTED.length).toBeGreaterThan(10)
  })

  it("every brand-protected file still exists", () => {
    const missing = PROTECTED.filter((f) => !existsSync(path.join(ROOT, f)))
    expect(
      missing,
      "These files are listed as brand-protected but no longer exist — a rename " +
        "silently drops a cleaned surface out of the guard's coverage. Update the " +
        "PROTECTED list in scripts/check-brand-tokens.mjs."
    ).toEqual([])
  })

  it("every neutral-protected file still exists", () => {
    const missing = NEUTRAL_PROTECTED.filter((f) => !existsSync(path.join(ROOT, f)))
    expect(missing, "Stale NEUTRAL_PROTECTED entries in scripts/check-brand-tokens.mjs.").toEqual([])
  })
})
