// 2026-11-07 review: an empty floor on a Top Shot parallel printing read
// "per-printing floor not yet indexed" whether the market read FAILED or
// answered with no ask — and per-printing asks have been indexed since #206.
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import { parallelFloorSubline } from "@/lib/edition-detail-format"

describe("parallel floor sub-line", () => {
  it("a failed market read says it could not load, never 'not indexed' or 'no ask'", () => {
    const s = parallelFloorSubline(false)
    expect(s).toMatch(/couldn.t load/)
    expect(s).not.toMatch(/indexed|no ask/)
  })
  it("an answered read with no ask says none is on file", () => {
    expect(parallelFloorSubline(true)).toBe("no ask on file for this printing")
  })
  it("the edition page passes the market read's ok and the stale copy is gone", () => {
    const src = stripComments(readFileSync("app/(collections)/[collection]/edition/[slug]/page.tsx", "utf8"))
    expect(src).toContain("parallelFloorSubline(bundleRes.ok)")
    expect(src).not.toContain("per-printing floor not yet indexed")
  })
})
