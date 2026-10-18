import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { walkSourceFiles, repoRelative } from "./helpers/source-files"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// TEXT is painted with the text-safe tokens, never the fill red or the ghost.
//
// The scheduled axe audit (e2e/a11y.spec.ts, non-blocking) read `serious ·
// color-contrast` on 4 of 5 routes every night for a week while the workflow
// stayed green. Measured 2026-10-17 against production: the failing nodes were
// `color: var(--rpc-red)` (#E03A2F text: 4.11–4.45:1 on the dark canvases,
// ~4.0:1 on white) and `color: var(--rpc-text-ghost)` (1.78:1 — the footer and
// nav labels on every page). The record said the 10-12 token work had "already
// moved red TEXT to --rpc-red-text"; a census found 2 sites on it and 334 not,
// plus 213 ghost-as-text sites, all swapped in one commit.
//
// --rpc-red stays the FILL red (backgrounds, borders, white-on-red buttons — the
// accepted pre-launch exception, roadmap-status "Brand red on small text") and
// --rpc-text-ghost stays DECORATIVE (design-tokens-text-contrast.test.ts pins it
// as failing AA on purpose). Neither may be a `color:`.
//
// ⚠ Scope is the `color` PROPERTY spelled with the token. A helper that RETURNS
// "var(--rpc-red)" and is later used as a colour is invisible here; the axe
// audit is the instrument for that, this guard only keeps the swapped shape at 0.

const BANNED = /(?:^|[^-\w])color:\s*['"`]?var\(--(rpc-red|rpc-text-ghost)\)/g

// ⚠ The same tokens as a TERNARY BRANCH (`color: active ? "var(--rpc-red)" : …`)
// — 28 sites the first swap's regex could not see (2026-10-18). Same-line form.
// ⛔ SUPPRESSIONS — each a claim the CODE is right, with an exact count.
const DISABLED_STATE: Record<string, number> = {
  // The send button's arrow while DISABLED (empty input / request in flight):
  // WCAG 1.4.3 exempts inactive controls.
  "components/SupportChat.tsx": 1,
}

const BANNED_BRANCH = /(?:^|[^-\w])color:[^,;}\n]*\?[^,;}\n]*(["'])var\(--(rpc-red|rpc-text-ghost)\)\1/g

function offenders(src: string): string[] {
  const code = stripComments(src)
  return [...[...code.matchAll(BANNED)].map((m) => m[1]), ...[...code.matchAll(BANNED_BRANCH)].map((m) => m[2])]
}

// In-process walk, not `git ls-files` through a shell (guards-do-not-shell-out-to-grep).
const FILES = ["app", "components", "lib"]
  .flatMap((root) => walkSourceFiles(root, (n) => /\.(tsx|ts|css)$/.test(n)))
  .map(repoRelative)

describe("text colours use the text-safe tokens", () => {
  it("walks a real population (not vacuous)", () => {
    expect(FILES.length).toBeGreaterThan(500)
  })

  it("no `color: var(--rpc-red)` or `color: var(--rpc-text-ghost)` anywhere in app/components/lib", () => {
    const hits: string[] = []
    for (const f of FILES) {
      const n = offenders(readFileSync(f, "utf8"))
      if (n.length > (DISABLED_STATE[f] ?? 0)) hits.push(`${f}: ${n.join(", ")}`)
    }
    expect(hits, "paint text with var(--rpc-red-text) / var(--rpc-text-muted)").toEqual([])
  })
})

describe("the detector is not vacuous", () => {
  it("catches CSS, inline-style and template forms of both tokens", () => {
    expect(offenders(".a { color: var(--rpc-red); }")).toEqual(["rpc-red"])
    expect(offenders(`<b style={{ color: "var(--rpc-red)" }} />`)).toEqual(["rpc-red"])
    expect(offenders("const css = `.x{color:var(--rpc-text-ghost)}`")).toEqual(["rpc-text-ghost"])
  })
  it("catches either token as a ternary branch, and spares a branch that is a fill", () => {
    expect(offenders(`<b style={{ color: on ? "var(--rpc-red)" : undefined }} />`)).toEqual(["rpc-red"])
    expect(offenders(`<b style={{ color: x ? "#fff" : "var(--rpc-text-ghost)" }} />`)).toEqual(["rpc-text-ghost"])
    expect(offenders(`<b style={{ color: on ? "var(--rpc-red-text)" : undefined, background: on ? "var(--rpc-red)" : "none" }} />`)).toEqual([])
  })
  it("leaves fills, borders, the text-safe tokens and comments alone", () => {
    expect(offenders(".a { background-color: var(--rpc-red); border-color: var(--rpc-red); }")).toEqual([])
    expect(offenders(`<b style={{ borderColor: "var(--rpc-red)", background: "var(--rpc-red)" }} />`)).toEqual([])
    expect(offenders(".a { color: var(--rpc-red-text); } .b { color: var(--rpc-text-muted); }")).toEqual([])
    expect(offenders("/* color: var(--rpc-red) */ .a {}")).toEqual([])
  })
})

// ─── Hardcoded low-alpha white TEXT (2026-10-18, #194 b) ─────────────────────
// `color: rgba(255,255,255,0.25–0.45)` fails AA on every dark canvas (0.45 on
// #0d0d0d is ~4.4:1; 0.4 is 3.81:1 — axe read 25 of them on one pack page).
// 85 sites were raised to 0.5 (5.34:1). They stay HARDCODED on purpose: the
// pack page paints hardcoded dark backgrounds in light theme too, so a
// theme-aware token there would turn dark-on-dark. OG image routes are exempt —
// Satori cannot resolve var() and paints a fixed dark card.
const LOW_ALPHA = /(?:^|[^-a-zA-Z])color:\s*['"`]?rgba\(255, ?255, ?255, ?0?\.[0-4][0-9]*\)/g
const lowAlpha = (src: string) => [...stripComments(src).matchAll(LOW_ALPHA)].length

// ⛔ SUPPRESSIONS are claims that the CODE is right, each with its reason and an
// exact count — a second hit in the same file still fails.
const DECORATIVE: Record<string, number> = {
  // "[ MOMENT VIDEO ]" — an 8 px watermark painted BEHIND the slab when a moment has
  // no video (zIndex 0). Incidental text; WCAG 1.4.3 exempts it.
  "components/TrophySlab.tsx": 1,
}

describe("no low-alpha white text", () => {
  it("app/components/lib hold no `color: rgba(255,255,255,<0.5)` (OG routes exempt)", () => {
    const hits = FILES.filter((f) => !f.startsWith("app/api/og/"))
      .filter((f) => lowAlpha(readFileSync(f, "utf8")) > (DECORATIVE[f] ?? 0))
    expect(hits, "use rgba(255,255,255,0.5) or var(--rpc-text-muted)").toEqual([])
  })
  it("the detector fires on the banned shape and spares 0.5+, borders and backgrounds", () => {
    expect(lowAlpha(`<b style={{ color: "rgba(255,255,255,0.4)" }} />`)).toBe(1)
    expect(lowAlpha(".a{color:rgba(255, 255, 255, .35)}")).toBe(1)
    expect(lowAlpha(`<b style={{ color: "rgba(255,255,255,0.5)", border: "1px solid rgba(255,255,255,0.2)", background: "rgba(255,255,255,0.06)" }} />`)).toBe(0)
    expect(lowAlpha(".a{border-color:rgba(255,255,255,0.3)}")).toBe(0)
  })
})
