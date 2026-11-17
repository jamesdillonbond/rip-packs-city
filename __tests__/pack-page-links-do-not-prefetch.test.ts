import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// 2026-11-16: a pack page (/<collection>/pack/dist/<id>, and /<collection>/pack/<nft> which
// redirects to it) is an ISR page (revalidate 600) whose render fans out to ~8 bounded reads
// (ev_contributors, pack_market, drop_pool, pack_lifecycle, pack_sales_history, …, 5 s each).
// The wallet Packs table, the pack-market / pack-reality boards, pack history, grails and
// chase lists render one <Link> per pack, and Next's default viewport prefetch fetches every
// visible one: a burst of cold regenerations, each degraded one cached for the revalidate
// window. This is the RULE the /teams franchise-hub storm proved (franchise-hub-links-do-not-
// prefetch.test.ts, 2026-11-12: "any grid of links to a heavy ISR route wants the same"),
// applied to pack links. ⚠ It is NOT proven by a pack incident: the 11-16 8:15:35 AM PT read
// (six pack-detail panels timing out in one millisecond, logged under one
// GET /panini-blockchain/collection request id) is ONE pack render whose whole fan-out hit a
// slow moment, and what triggered that render was not established.
//
// Tree walk over app/ and components/: every <Link …> opening tag whose attributes build a
// /pack/dist/ or /pack/${…} href must carry prefetch={false}.
const ROOTS = ["app", "components"]
const PACK_HREF = /\/pack\/(dist\/)?\$\{|\/pack\/dist\//

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
    if (!/\s/.test(src[i + 5] ?? "")) { i += 5; continue } // <LinkButton, <Links…
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
      if (PACK_HREF.test(t) && !/prefetch=\{false\}/.test(t)) out.push(file)
    }
  }
  return out
}

describe("links to a pack page never prefetch it", () => {
  const files: string[] = []
  for (const r of ROOTS) walk(r, files)
  const read = files.map((file) => ({ file, src: readFileSync(file, "utf8") }))
  const withPack = read.filter(({ src }) => linkTags(stripComments(src)).some((t) => PACK_HREF.test(t)))

  it("found the pack links (the wallet Packs table and the pack-market board among them)", () => {
    const names = withPack.map((f) => f.file)
    expect(names).toContain(path.join("components", "packs", "WalletPacksView.tsx"))
    expect(names).toContain(path.join("app", "insights", "topshot-pack-market", "page.tsx"))
    expect(withPack.length).toBeGreaterThanOrEqual(10)
  })

  it("every <Link> to a /pack/ page carries prefetch={false}", () => {
    expect(offenders(read)).toEqual([])
  })

  it("POSITIVE CONTROL — a planted prefetching pack link is caught", () => {
    const src = "<Link\n  href={`/${collection}/pack/dist/${encodeURIComponent(row.dist_id)}`}\n  style={{ a: 1 }}\n>x</Link>"
    expect(offenders([{ file: "x.tsx", src }])).toEqual(["x.tsx"])
    const sealed = "<Link href={`/${collection}/pack/${encodeURIComponent(row.pack_nft_id)}`}>x</Link>"
    expect(offenders([{ file: "y.tsx", src: sealed }])).toEqual(["y.tsx"])
  })

  it("NEGATIVE CONTROL — prefetch={false} passes; a non-pack link is ignored", () => {
    expect(offenders([{ file: "a.tsx", src: "<Link href={`/x/pack/dist/${d}`} prefetch={false}>x</Link>" }])).toEqual([])
    expect(offenders([{ file: "b.tsx", src: "<Link href={`/x/packs`}>x</Link>" }])).toEqual([])
    expect(offenders([{ file: "c.tsx", src: "<Link href=\"/dashboard/packs\">x</Link>" }])).toEqual([])
  })
})
