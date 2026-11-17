import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// Holds `compute-topshot-pack-ev/index.ts` in sync with the tested mirror in
// `supabase/functions/_shared/topshot-pack-ev-row.ts`.
//
// WHY A SOURCE GUARD AND NOT A UNIT TEST. That edge function is 1,583 lines of Deno source
// measured by NO coverage gate (the primary gate stops at `app/**/route.ts` + `lib/**`, the
// component gate at `components/**` + `app/**/*Client.tsx`, the worker gate at
// `workers/**`), and it computes the PUBLIC +EV badge inline rather than through a
// function. There is nothing importable to unit-test, so the mirror carries the tests and
// this guard asserts the deployed arithmetic still matches it.
//
// ⚠ BE HONEST ABOUT WHAT THIS PROVES. It pins the EXPRESSIONS, not the behaviour of the
// deployed function: it cannot see anything about the surrounding control flow, and a
// change that keeps these five lines while altering what feeds them passes. It is a
// tripwire on the arithmetic, which is the part that decides the badge — not a substitute
// for the edge function importing the mirror, which remains the ideal end state and needs
// a redeploy of the pack-EV writer to reach.
//
// This is the same arrangement the repo already uses for `computeDualPrice`, which exists
// in `_shared`, in `lib/`, and inline in this very file, kept honest by
// `__tests__/edge-inline-copy-drift-guard.test.ts`. The difference is only that this
// derivation was never a function, so the inline-copy guard cannot reach it.

const root = path.resolve(__dirname, "..")
const EDGE = "supabase/functions/compute-topshot-pack-ev/index.ts"
const MIRROR = "supabase/functions/_shared/topshot-pack-ev-row.ts"

/** Strip `//` and block comments, PRESERVING offsets is unnecessary here — we only test
 *  containment — but stripping is REQUIRED: both files' headers discuss these expressions
 *  in prose, and the mirror's doc comments name the rules verbatim. Without this the guard
 *  would happily match its own documentation and assert nothing. */

const collapse = (s: string) => s.replace(/\s+/g, " ")

const edgeSrc = collapse(stripComments(readFileSync(path.join(root, EDGE), "utf8")))
const mirrorSrc = collapse(stripComments(readFileSync(path.join(root, MIRROR), "utf8")))

// [ label, expression as it appears in the edge fn, why a drift here bites ]
const EXPRESSIONS: Array<[string, string, string]> = [
  [
    "net EV",
    "const packEv = Math.round((grossEv - dual.packPrice) * 100) / 100",
    "the number the badge is decided on; a rounding change moves packs across the boundary",
  ],
  [
    "the +EV badge itself",
    'const isPositiveEv = dual.priceSource !== "none" && packEv > 0',
    "drop the priceSource clause and EVERY unbuyable pack becomes the loudest +EV on the board, " +
      "because an unbuyable pack prices at 0 and its whole gross EV becomes its net",
  ],
  [
    "value ratio withheld on a zero price",
    "const valueRatio = dual.packPrice > 0 ? Math.round((grossEv / dual.packPrice) * 1000) / 1000 : null",
    "substituting a denominator publishes a ratio nobody measured — the `|| 1` class",
  ],
  [
    "the pack_ev_latest range clamp",
    "const clamp = (v: number) => Math.max(-10000, Math.min(1000000, v))",
    "pack_ev_latest filters BETWEEN -10000 AND 1000000, so an unclamped outlier does not " +
      "render large — the pack DISAPPEARS from every EV surface",
  ],
  [
    "depletion percentage",
    "const depletionPct = f.totalPackCount > 0 ? Math.min(100, Math.max(0, Math.round(((f.totalPackCount - f.totalUnopened) / f.totalPackCount) * 100))) : null",
    "an unknown print run must be NULL, not 0 — a 0 claims none of the pack has been opened",
  ],
]

describe("compute-topshot-pack-ev: the inline +EV arithmetic matches its tested mirror", () => {
  it("reads a real edge function and a real mirror (guard isn't inert)", () => {
    expect(edgeSrc.length).toBeGreaterThan(20_000)
    expect(mirrorSrc).toContain("export function derivePackEvRow")
  })

  it("the comment stripper actually removes prose (else the guard matches its own docs)", () => {
    // Both files discuss `priceSource !== "none"` in prose. If stripping regressed, this
    // guard would pass against a file whose CODE had been changed but whose comments still
    // described the old behaviour — the exact failure the repo has hit five times.
    const raw = readFileSync(path.join(root, MIRROR), "utf8")
    expect(raw).toMatch(/No \+EV without a price/)
    expect(stripComments(raw)).not.toMatch(/No \+EV without a price/)
  })

  it.each(EXPRESSIONS)("%s is unchanged in the deployed edge function", (_label, expr) => {
    expect(edgeSrc).toContain(collapse(expr))
  })

  it("the mirror computes the same five things", () => {
    // Named rather than string-matched, because the mirror is free to be formatted
    // differently — it is the TESTS on the mirror that pin its behaviour, and this only
    // asserts the mirror still exposes the surface the edge function is being held to.
    for (const name of [
      "const packEv =",
      "const isPositiveEv =",
      "const valueRatio =",
      "const depletionPct =",
      "export function clampEv",
    ]) {
      expect(mirrorSrc, `mirror lost ${name}`).toContain(collapse(name))
    }
  })

  it("the edge function has NOT quietly started importing the mirror without this guard being retired", () => {
    // If someone does the right thing and makes the edge function import the mirror, the
    // expression assertions above become false and this suite would fail confusingly.
    // Catch that case explicitly and say what to do, rather than leaving a green-looking
    // guard that is actually blocking the better outcome.
    const importsMirror = /_shared\/topshot-pack-ev-row/.test(edgeSrc)
    expect(
      importsMirror,
      "compute-topshot-pack-ev now imports _shared/topshot-pack-ev-row — that is the ideal " +
        "end state. DELETE this source-drift guard: the mirror's own unit tests are then " +
        "testing the real code path, and these expression assertions are obsolete.",
    ).toBe(false)
  })
})
