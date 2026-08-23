// __tests__/api-fmv-demo-docs-match-implementation.test.ts
//
// /api/fmv/demo is the PUBLIC, no-auth, 1h-cached surface a developer hits to
// find out what the FMV API does. It must therefore agree with the FMV API.
//
// It did not. The route carried its OWN COPY of the serial multiplier whose
// ordinary-serial tail had drifted to `max(1, (circ/2/serial)^0.4)`, while
// `/api/fmv` computes `1 + 0.08*max(0, 1 - serial/circ)` via
// lib/fmv/serial-multiplier. For serial 100 of a /1000 edition the demo
// published 1.9x and the real endpoint returns 1.07x — a 77% overstatement of
// the serial premium, in both the `exampleAdjustments` numbers AND the
// `serialMultipliers` formula string.
//
// A duplicated pure function is a second implementation and drifts silently;
// nothing here type-checks a doc string against behaviour. So these assertions
// are DERIVED from lib/fmv/serial-multiplier — the module whose stated purpose
// is that "the pure multiplier can be unit-tested and its constants pinned" —
// rather than hand-listing the numbers, which is how the fork got out of sync
// in the first place.
//
// Scope note: this pins DOCS-MATCH-CODE, not the multiplier's values. The
// constants themselves are pinned by __tests__/serial-multiplier.test.ts, and
// deliberately so: this file must keep passing when a multiplier is
// legitimately re-fitted, and fail when the demo stops describing it.

import { describe, expect, it } from "vitest"
import { fmvSerialMultiplier } from "@/lib/fmv/serial-multiplier"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

const routeSrc = () =>
  require("fs").readFileSync(
    require("path").join(process.cwd(), "app/api/fmv/demo/route.ts"),
    "utf8"
  ) as string

/** Comments legitimately quote the OLD formula to explain the fix. */

describe("/api/fmv/demo documents the multiplier it actually uses", () => {
  it("does not re-declare a local serial multiplier", () => {
    const code = stripComments(routeSrc())
    // The fork was `function sm(serial: number, circ: number)`. Any local
    // redefinition is the defect returning, whatever it is named.
    expect(code).not.toMatch(/function\s+\w*[sS]erial\w*\s*\(/)
    expect(code).not.toMatch(/function\s+sm\s*\(/)
  })

  it("imports the shared multiplier module", () => {
    expect(stripComments(routeSrc())).toMatch(
      /import\s*\{[^}]*fmvSerialMultiplier[^}]*\}\s*from\s*["']@\/lib\/fmv\/serial-multiplier["']/
    )
  })

  it("publishes no formula string the implementation does not compute", () => {
    const code = stripComments(routeSrc())
    // The drifted tail, in the spelling the route published.
    expect(code).not.toContain("circ / 2 / serial")
    expect(code).not.toContain("circ/2/serial")
    // The real tail, as documented to callers.
    expect(code).toContain("1 + 0.08 * max(0, 1 - serial/circ)")
  })

  it("the documented tail formula reproduces the implementation", () => {
    // Evaluate the published expression and compare against the module across
    // the ordinary-serial range. This is the assertion the old docs failed.
    const documented = (serial: number, circ: number) =>
      1 + 0.08 * Math.max(0, 1 - serial / circ)

    const cases: Array<[number, number]> = [
      [24, 1000],
      [50, 1000],
      [100, 1000],
      [250, 500],
      [999, 1000],
      [2000, 5000],
      [7000, 5000], // position > 1 -> clamped to 1.0
    ]
    for (const [serial, circ] of cases) {
      expect(documented(serial, circ)).toBeCloseTo(fmvSerialMultiplier(serial, circ), 10)
    }
  })

  it("the drifted formula would NOT have satisfied that check", () => {
    // Guards the guard: proves the assertion above has teeth rather than being
    // trivially true for any curve.
    const drifted = (serial: number, circ: number) =>
      Math.max(1.0, Math.pow(circ / 2 / serial, 0.4))
    expect(drifted(100, 1000)).not.toBeCloseTo(fmvSerialMultiplier(100, 1000), 2)
    // and the size of the error is what made it worth fixing
    expect(drifted(100, 1000) / fmvSerialMultiplier(100, 1000)).toBeGreaterThan(1.7)
  })

  it("documented banded multipliers are derived, not literals", () => {
    const code = stripComments(routeSrc())
    // Each banded entry must be produced by a call, not typed as "12x"/"4.5x".
    expect(code).toMatch(/"1":\s*`\$\{sm\(1,/)
    expect(code).toMatch(/"2–10":\s*`\$\{sm\(10,/)
    expect(code).toMatch(/"11–23":\s*`\$\{sm\(23,/)
    expect(code).not.toMatch(/"1":\s*"12x"/)
    expect(code).not.toMatch(/"2–10":\s*"4\.5x"/)
  })

  it("the banded probe values land on the intended branches", () => {
    // circ=2000 is chosen so `serial === circ` cannot capture 1/10/23; if a
    // future edit picks a probe that collides, these numbers change silently.
    expect(fmvSerialMultiplier(1, 2000)).toBe(12.0)
    expect(fmvSerialMultiplier(10, 2000)).toBe(4.5)
    expect(fmvSerialMultiplier(23, 2000)).toBe(2.8)
    expect(fmvSerialMultiplier(2000, 2000)).toBe(3.0)
  })

  it("discloses that the single endpoint evaluates the curve at a default circ", () => {
    // /api/fmv calls serialMultiplier(serial, 1000) and never reads
    // circulation_count, so every non-banded multiplier it returns is computed
    // against a fabricated denominator. Publishing the curve without saying so
    // would be a precise-looking claim the endpoint cannot honour.
    expect(routeSrc()).toMatch(/default circ=1000/)
  })
})
