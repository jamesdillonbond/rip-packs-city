// __tests__/entity-recent-low-is-never-labelled-floor.test.ts
//
// known-issues #143 (2026-09-25): `fmv_snapshots.floor_price_usd` is not a
// floor ask. On fmv-recalc's main sales path it is `Math.min(...prices)` over
// the window's SALES; other writers put a low ask or a fresh ask in the same
// column. The entity pages (team / player / set / series tiles and stat strips)
// read it as `floor_usd` / `floor_total_usd` and printed it as "Floor" and
// "Floor Total" — measured on Candy MLB, 100 of 125 editions read BELOW the
// confirmed live floor (Aaron Judge: "Floor $2.50" vs a $4.84 confirmed floor,
// $2.50 being a sale nobody can buy at).
//
// The fix is the label: every surface that renders this value calls it a
// "Recent Low" through the shared constants in components/entity/_shared.tsx.
// This walk bans the old labels in any file that touches the value, so a new
// entity surface cannot re-introduce "Floor" beside it.
//
// ⚠ What it does NOT cover: a surface that shows a REAL ask (the edition page's
// "Floor ask", Candy's confirmed floor) is legitimately a floor — those files do
// not read `floor_usd` / `floor_total_usd` and are out of this walk's population.

import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import stripComments from "../scripts/lib/strip-comments.mjs"

const ROOT = path.resolve(__dirname, "..")
const ROOTS = ["app/(collections)", "app/teams", "components/entity"]

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith(".tsx")) out.push(p)
  }
  return out
}

const files = ROOTS.flatMap((r) => walk(path.join(ROOT, r)))
const readers = files.filter((f) => /\bfloor_(total_)?usd\b/.test(readFileSync(f, "utf8")))

// The banned spellings: a JSX text node reading exactly "Floor", or the string
// "Floor Total" anywhere (a label prop, a template, a header).
const BANNED = [/>\s*Floor\s*</, /["'`]Floor Total["'`]/]

function offenders(src: string): string[] {
  const code = stripComments(src)
  return BANNED.filter((re) => re.test(code)).map(String)
}

describe("entity surfaces never label a recent low as a floor (#143)", () => {
  it("inspects a non-empty population of files that read the value", () => {
    // Positive control on the walk itself: the four stat strips and the tile
    // grid all read it today. If this drops to zero the walk is broken, not clean.
    expect(readers.length).toBeGreaterThanOrEqual(5)
  })

  it("no reader renders 'Floor' or 'Floor Total'", () => {
    const bad = readers
      .map((f) => ({ f: path.relative(ROOT, f), hits: offenders(readFileSync(f, "utf8")) }))
      .filter((x) => x.hits.length > 0)
    expect(bad).toEqual([])
  })

  it("the ban catches the pre-#143 spellings (planted defects)", () => {
    expect(offenders(`<StatCell label="Floor Total" value={x} />`)).not.toEqual([])
    expect(offenders(`<div style={{ fontSize: 9 }}>Floor</div>`)).not.toEqual([])
    // ...and stays quiet on the fixed forms and on a genuine ask label.
    expect(offenders(`<StatCell label={RECENT_LOW_TOTAL_LABEL} value={x} />`)).toEqual([])
    expect(offenders(`<div>{RECENT_LOW_LABEL}</div>`)).toEqual([])
    expect(offenders(`<div>Floor ask</div>`)).toEqual([])
  })
})
