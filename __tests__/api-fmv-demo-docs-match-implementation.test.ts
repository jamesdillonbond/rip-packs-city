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

// ── RE-PINNED 2026-10-10 (known-issues #18): the premise changed. /api/fmv no longer
// uses lib/fmv/serial-multiplier's flat bands; it prices the serial premium with the
// FITTED model through ONE batch call (serial_fmv_multiplier_batch -> serial_fmv_estimate).
// The property this file protects is unchanged — the demo documents what the API does,
// with no second implementation — so the demo now computes its examples through that
// same call and publishes no constants at all. The flat-band assertions that lived here
// (derived banded entries, the 0.08 tail formula, the circ=1000 disclosure) pinned a
// model the API no longer runs, so they are replaced, not loosened.

import { describe, expect, it } from "vitest"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

const src = (rel: string) =>
  require("fs").readFileSync(require("path").join(process.cwd(), rel), "utf8") as string
const routeSrc = () => src("app/api/fmv/demo/route.ts")
const apiSrc = () => src("app/api/fmv/route.ts")

describe("/api/fmv/demo documents the multiplier /api/fmv actually uses", () => {
  it("does not re-declare a local serial multiplier", () => {
    const code = stripComments(routeSrc())
    expect(code).not.toMatch(/function\s+\w*[sS]erial\w*\s*\(/)
    expect(code).not.toMatch(/function\s+sm\s*\(/)
  })

  it("the demo and the API make the SAME fitted call", () => {
    for (const code of [stripComments(routeSrc()), stripComments(apiSrc())]) {
      expect(code).toMatch(/rpc\(\s*["']serial_fmv_multiplier_batch["']/)
    }
  })

  it("neither imports the flat-band module the API no longer runs", () => {
    for (const code of [stripComments(routeSrc()), stripComments(apiSrc())]) {
      expect(code).not.toMatch(/from\s*["']@\/lib\/fmv\/serial-multiplier["']/)
    }
  })

  it("the demo publishes no flat-band constant or formula", () => {
    const code = stripComments(routeSrc())
    expect(code).not.toContain("1 + 0.08")
    expect(code).not.toMatch(/["'`]12(\.0)?x/)
    expect(code).not.toMatch(/["'`]4\.5x/)
    expect(code).not.toMatch(/default circ=1000/)
  })
})
