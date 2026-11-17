// Every link to a collection's squeeze board is that collection's OWN page (2026-10-27). All Day's boards moved
// off the Top Shot pages' `?collection=nfl-all-day` toggle onto /insights/allday-squeeze and
// /insights/allday-set-squeeze, which carry All Day's title, canonical and OG card; a link built as
// `/insights/squeeze?collection=…` lands on a URL whose metadata is Top Shot's. Links go through
// squeezeBoardPath / setSqueezeBoardPath (lib/insights/squeeze-collections.ts). Tree walk over app/ and
// components/, comments stripped; the API and OG routes (which READ ?collection=) are out of scope.
import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import { squeezeBoardPath, setSqueezeBoardPath } from "@/lib/insights/squeeze-collections"

const ROOT = process.cwd()
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || p.startsWith(join(ROOT, "app", "api"))) continue
      walk(p, out)
    } else if (/\.tsx?$/.test(name)) out.push(p)
  }
  return out
}
// A Top Shot squeeze page path followed by a query that carries collection= (literal or interpolated).
// The bounded `[^\n]{0,160}?` also reaches a collection= nested inside an interpolation (the rookies shape).
const TOGGLE_LINK = /\/insights\/(?:set-)?squeeze\?(?:[^\n]{0,160}?collection=|\$\{[^\n]{0,80}?\}(?:player|set)=)/

describe("squeeze-board links use each collection's own page", () => {
  const files = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "components"))]

  it("walks the tree (not vacuous)", () => {
    expect(files.length).toBeGreaterThan(200)
    expect(files.some((f) => f.endsWith(join("set-squeeze", "SetSqueezeBoardClient.tsx")))).toBe(true)
  })

  it("no link is built as /insights/(set-)squeeze?…collection=…", () => {
    const offenders = files
      .filter((f) => TOGGLE_LINK.test(stripComments(readFileSync(f, "utf8"))))
      .map((f) => relative(ROOT, f))
    expect(offenders).toEqual([])
  })

  it("the pattern catches the shapes it bans (planted)", () => {
    expect(TOGGLE_LINK.test("href={`/insights/squeeze?collection=nfl-all-day&player=X`}")).toBe(true)
    expect(TOGGLE_LINK.test("href={`/insights/squeeze?${legQs}set=${s}`}")).toBe(true)
    expect(TOGGLE_LINK.test('"/insights/set-squeeze?collection=nfl-all-day"')).toBe(true)
    expect(TOGGLE_LINK.test("href={`/insights/squeeze?${home.topShot ? \"\" : `collection=${home.collection}&`}player=${p}`}")).toBe(true)
    expect(TOGGLE_LINK.test("href={`${squeezeBoardPath(c)}?player=${p}`}")).toBe(false)
    expect(TOGGLE_LINK.test('"/insights/squeeze?player=X"')).toBe(false)
  })

  it("the helpers name each collection's page", () => {
    expect(squeezeBoardPath("nfl-all-day")).toBe("/insights/allday-squeeze")
    expect(squeezeBoardPath("nba-top-shot")).toBe("/insights/squeeze")
    expect(setSqueezeBoardPath("nfl-all-day")).toBe("/insights/allday-set-squeeze")
    expect(setSqueezeBoardPath("nba-top-shot")).toBe("/insights/set-squeeze")
  })
})
