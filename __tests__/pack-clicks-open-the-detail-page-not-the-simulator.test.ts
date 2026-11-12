import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// 2026-11-12 (Trevor): "when users click a pack on the RPC pages, it should take them to a
// Pack detail page, not the pack open simulator — that should only be accessible via a link
// within the pack detail page."
//
// Tree walk (never a curated list): every .ts/.tsx under app/, components/ and lib/ that
// BUILDS a /packs/simulator/ href, outside the two places allowed to — the pack detail page
// (the one link) and the simulator's own directory. Comments are stripped first.
const ROOTS = ["app", "components", "lib"]
const ALLOWED = [
  path.join("app", "(collections)", "[collection]", "pack", "dist", "[distId]", "page.tsx"),
  path.join("app", "(collections)", "[collection]", "packs", "simulator") + path.sep,
]
// An href BUILDER: `${collection}/packs/simulator/…` or a literal "/nba-top-shot/packs/simulator/…".
// A prose route pattern ("/[collection]/packs/simulator/[distId]" in the concierge dictionary)
// is not a link and does not match.
const HREF = /\$\{[^}]+\}\/packs\/simulator\/|["'`]\/[a-z0-9-]+\/packs\/simulator\//

function walk(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
}

export function offenders(files: Array<{ file: string; src: string }>): string[] {
  return files
    .filter(({ file }) => !ALLOWED.some((a) => file === a || file.startsWith(a)))
    .filter(({ src }) => HREF.test(stripComments(src)))
    .map(({ file }) => file)
}

describe("a pack click opens the pack detail page; the simulator is linked only from there", () => {
  const files: string[] = []
  for (const r of ROOTS) walk(r, files)
  const read = files.map((file) => ({ file, src: readFileSync(file, "utf8") }))

  it("inspected the tree", () => {
    expect(files.length).toBeGreaterThan(500)
  })

  it("no surface but the pack detail page builds a simulator href", () => {
    expect(offenders(read), "Link these to /<collection>/pack/dist/<distId> instead").toEqual([])
  })

  it("the pack detail page DOES link the simulator (the one way in)", () => {
    const page = read.find((f) => f.file === ALLOWED[0])
    expect(page).toBeTruthy()
    expect(HREF.test(stripComments(page!.src))).toBe(true)
  })

  it("POSITIVE CONTROL — a planted simulator href elsewhere is caught", () => {
    const planted = [{ file: path.join("components", "packs", "X.tsx"), src: "const h = `/${c}/packs/simulator/${d}`" }]
    expect(offenders(planted)).toEqual([planted[0].file])
  })

  it("NEGATIVE CONTROL — a comment mentioning the path is not a link", () => {
    expect(offenders([{ file: "lib/y.ts", src: "// the old `/${c}/packs/simulator/` link\nconst a = \"/[collection]/packs/simulator/[distId]\"" }])).toEqual([])
  })
})
