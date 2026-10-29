// A short series tag ("S3", "'25-26") is DECODED per collection, never `S${series}` from the raw
// on-chain number (2026-10-29).
//
// WHY: /insights/new-collectors listed its gateway sets as "Archive Set S 3", "Base Set S 6" and
// "WNBA Base Set S 8". Those are Top Shot's on-chain numbers: 3 is Summer 2021 (Series 3 is
// on-chain 4), 6 is the 2023-24 season and 8 is 2025-26. The set-squeeze OG card and the
// trophy-case PDF built the same string. All three now go through `shortSeriesLabel`.
//
// POPULATION (a tree walk): every .ts/.tsx under app/ lib/ components/ whose comment-stripped
// source builds an "S" tag straight from a `.series` value, as JSX text (`S{r.series}`) or a
// template (`S${s.series}`). Zero is the bar.

import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import { shortSeriesLabel } from "@/lib/series-label"

const ROOT = join(__dirname, "..")
const DIRS = ["app", "lib", "components"]

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
}

// `S{x.series}` / `S{x.series ?? …}` in JSX, or `S${x.series}` in a template.
const RAW_TAG = /\bS(?:\{|\$\{)\s*[A-Za-z_$][\w$]*\.series\b/

describe("shortSeriesLabel", () => {
  it("decodes Top Shot's on-chain numbers through the canonical map", () => {
    expect(shortSeriesLabel(0, "nba_top_shot")).toBe("S1")
    expect(shortSeriesLabel(3, "nba_top_shot")).toBe("Sum '21")
    expect(shortSeriesLabel(4, "nba_top_shot")).toBe("S3")
    expect(shortSeriesLabel(6, "nba-top-shot")).toBe("'23-24")
    expect(shortSeriesLabel(8, "nba_top_shot")).toBe("'25-26")
    expect(shortSeriesLabel(9, "nba_top_shot")).toBe("'26-27")
  })

  it("⛔ never reads Top Shot's on-chain 3 as Series 3, nor 8 as 'S8'", () => {
    expect(shortSeriesLabel(3, "nba_top_shot")).not.toBe("S3")
    expect(shortSeriesLabel(8, "nba_top_shot")).not.toBe("S8")
  })

  it("keeps another collection's own number (0↔1 is Top-Shot-specific)", () => {
    expect(shortSeriesLabel(3, "nfl-all-day")).toBe("S3")
    expect(shortSeriesLabel(0, "nfl_all_day")).toBe("S0")
    expect(shortSeriesLabel(5, null)).toBe("S5")
  })
})

describe("no surface builds an S tag from a raw .series", () => {
  const files: string[] = []
  for (const d of DIRS) walk(join(ROOT, d), files)

  it("walks a real population", () => {
    expect(files.length).toBeGreaterThan(500)
  })

  it("finds zero `S{x.series}` / `S${x.series}` sites", () => {
    const hits = files.filter((f) => RAW_TAG.test(stripComments(readFileSync(f, "utf8"))))
      .map((f) => f.slice(ROOT.length + 1))
    expect(hits).toEqual([])
  })

  it("the pattern catches the shapes it bans (planted)", () => {
    expect(RAW_TAG.test('<span>S{r.series}</span>')).toBe(true)
    expect(RAW_TAG.test('<span>S{r.series ?? "—"}</span>')).toBe(true)
    expect(RAW_TAG.test("s.series != null ? `S${s.series}` : null")).toBe(true)
    expect(RAW_TAG.test("shortSeriesLabel(r.series, collection)")).toBe(false)
  })
})
