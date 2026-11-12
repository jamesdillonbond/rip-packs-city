import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// 2026-11-12: a franchise hub (/teams/<league>/<slug>) is an ISR page that fans out to
// every collection's get_team_detail + top editions + activity. The /teams index rendered
// ~100 hub cards with Next's default viewport prefetch, so one visit regenerated dozens of
// cold hubs at once; their panels blew the 10 s budget together (Atlanta, Boston, Brooklyn,
// Charlotte in the same second, 7:53 AM PT) and each degraded render was cached for the
// 600 s revalidate window. Every <Link> to a hub must opt out of prefetch.
//
// Tree walk over app/ and components/: every <Link …> opening tag whose attributes call
// franchiseHubPath( must carry prefetch={false}.
const ROOTS = ["app", "components"]

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

export function offenders(files: Array<{ file: string; src: string }>): string[] {
  const out: string[] = []
  for (const { file, src } of files) {
    for (const t of linkTags(stripComments(src))) {
      if (t.includes("franchiseHubPath(") && !/prefetch=\{false\}/.test(t)) out.push(file)
    }
  }
  return out
}

describe("links to a franchise hub never prefetch it", () => {
  const files: string[] = []
  for (const r of ROOTS) walk(r, files)
  const read = files.map((file) => ({ file, src: readFileSync(file, "utf8") }))

  it("found the hub links (the /teams index among them)", () => {
    const withHub = read.filter(({ src }) => linkTags(stripComments(src)).some((t) => t.includes("franchiseHubPath(")))
    expect(withHub.map((f) => f.file)).toContain(path.join("app", "teams", "page.tsx"))
  })

  it("every <Link> calling franchiseHubPath( carries prefetch={false}", () => {
    expect(offenders(read)).toEqual([])
  })

  it("POSITIVE CONTROL — a planted prefetching hub link is caught", () => {
    const src = "<Link\n  key={t.slug}\n  href={franchiseHubPath(l, t.slug)}\n  style={{ a: 1 }}\n>x</Link>"
    expect(offenders([{ file: "x.tsx", src }])).toEqual(["x.tsx"])
  })

  it("NEGATIVE CONTROL — prefetch={false} passes; a non-hub link is ignored", () => {
    expect(offenders([{ file: "a.tsx", src: "<Link href={franchiseHubPath(a, b)} prefetch={false}>x</Link>" }])).toEqual([])
    expect(offenders([{ file: "b.tsx", src: "<Link href={`/x/${y}`}>x</Link>" }])).toEqual([])
  })
})
