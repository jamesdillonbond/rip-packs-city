import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// 2026-11-27: a league / brand page (/<collection>/property/<slug>) is an ISR page with a multi-read render
// (the page payload plus, on Panini, the Teams / Nations read). That morning every Panini league page was
// serving "Couldn't load this page" from ISR; the read itself was the cause (migration 20261127155238), but
// the same morning a 14-row table of league links was added to the Panini Analytics tab with Next's default
// viewport prefetch — the /teams storm of 11-12 again (see franchise-hub-links-do-not-prefetch.test.ts).
// Every <Link> to a league page opts out of prefetch.
//
// Tree walk over app/ and components/: every <Link …> opening tag whose attributes reach a league page — a
// literal "/property/" path, paniniPropertyHref(, candyPropertyHref( or paniniScopePageHref( — must carry
// prefetch={false}.
const ROOTS = ["app", "components"]
const TO_LEAGUE_PAGE = /\/property\/|paniniPropertyHref\(|candyPropertyHref\(|paniniScopePageHref\(/

function walk(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith(".tsx")) out.push(p)
  }
}

/** Opening <Link …> tags (multi-line), up to the first `>` that closes the tag at brace depth 0. */
function linkTags(src: string): string[] {
  const tags: string[] = []
  let i = 0
  while ((i = src.indexOf("<Link", i)) !== -1) {
    let depth = 0
    let j = i + 5
    for (; j < src.length; j++) {
      const c = src[j]
      if (c === "{") depth++
      else if (c === "}") depth--
      else if (c === ">" && depth === 0) break
    }
    tags.push(src.slice(i, j + 1))
    i = j
  }
  return tags
}

export function offenders(files: Array<{ file: string; src: string }>): { inspected: number; out: string[] } {
  const out: string[] = []
  let inspected = 0
  for (const { file, src } of files) {
    for (const t of linkTags(stripComments(src))) {
      if (!TO_LEAGUE_PAGE.test(t)) continue
      inspected++
      if (!/prefetch=\{false\}/.test(t)) out.push(file)
    }
  }
  return { inspected, out }
}

describe("links to league / brand pages do not prefetch", () => {
  const files: string[] = []
  for (const r of ROOTS) walk(path.join(process.cwd(), r), files)
  const sources = files.map((file) => ({ file: path.relative(process.cwd(), file), src: readFileSync(file, "utf8") }))

  it("every <Link> to a league page carries prefetch={false}", () => {
    const { inspected, out } = offenders(sources)
    // The guard must be looking at something: the two grids, the product index, the league map strip,
    // the Analytics table and its note, the Candy pack line, the serial-premiums line.
    expect(inspected).toBeGreaterThanOrEqual(7)
    expect(out).toEqual([])
  })

  it("planted defect: a prefetching link is caught, an opted-out one is not, and prose is ignored", () => {
    const bad = { file: "x.tsx", src: `<Link href={paniniPropertyHref(c, s)}>a</Link>` }
    const lit = { file: "y.tsx", src: `<Link\n  href="/candy-mlb/property/mlb"\n  style={{ a: 1 }}\n>a</Link>` }
    const good = { file: "z.tsx", src: `<Link prefetch={false} href={candyPropertyHref(c, s)}>a</Link>` }
    const prose = { file: "w.tsx", src: `// <Link href="/x/property/y"> in a comment\n<Link href="/leagues">a</Link>` }
    expect(offenders([bad, lit, good, prose]).out).toEqual(["x.tsx", "y.tsx"])
  })
})
