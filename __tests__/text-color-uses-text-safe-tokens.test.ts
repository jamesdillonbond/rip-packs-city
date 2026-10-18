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

function offenders(src: string): string[] {
  return [...stripComments(src).matchAll(BANNED)].map((m) => m[1])
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
      if (n.length) hits.push(`${f}: ${n.join(", ")}`)
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
  it("leaves fills, borders, the text-safe tokens and comments alone", () => {
    expect(offenders(".a { background-color: var(--rpc-red); border-color: var(--rpc-red); }")).toEqual([])
    expect(offenders(`<b style={{ borderColor: "var(--rpc-red)", background: "var(--rpc-red)" }} />`)).toEqual([])
    expect(offenders(".a { color: var(--rpc-red-text); } .b { color: var(--rpc-text-muted); }")).toEqual([])
    expect(offenders("/* color: var(--rpc-red) */ .a {}")).toEqual([])
  })
})
