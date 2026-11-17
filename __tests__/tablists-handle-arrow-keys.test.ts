import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// 2026-11-07: every element that claims role="tablist" must wire the shared
// keyboard contract (lib/a11y/tablist-keys.ts). Nine tablists in eight files
// claimed the role with no arrow-key handling. Tree walk, banned at zero.

const ROOT = join(__dirname, "..")
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx$/.test(e)) out.push(p)
  }
  return out
}

/** Each `role="tablist"` (literal or conditional `"tablist"`) opening tag must carry onKeyDown. */
export function tablistsWithoutKeys(src: string): number[] {
  const s = stripComments(src)
  const lines = s.split("\n")
  const hits: number[] = []
  lines.forEach((ln: string, i: number) => {
    if (!/["']tablist["']/.test(ln) || !/role/.test(ln)) return
    // the opening tag: from the nearest `<` at or before this line to the next `>`
    let start = i
    while (start > 0 && !/<[a-zA-Z]/.test(lines[start])) start--
    let end = i
    while (end < lines.length - 1 && !/>/.test(lines[end])) end++
    const tag = lines.slice(start, end + 1).join("\n")
    if (!/onKeyDown\s*=\s*\{\s*onTablistKeyDown\s*\}/.test(tag)) hits.push(i + 1)
  })
  return hits
}

describe("every role=\"tablist\" handles arrow keys through the shared helper", () => {
  it("catches a planted defect", () => {
    expect(tablistsWithoutKeys(`<div role="tablist" aria-label="x">\n  <button role="tab" />\n</div>`)).toEqual([1])
    expect(tablistsWithoutKeys(`<div\n  role={on ? "tablist" : "navigation"}\n  className="x"\n>`)).toEqual([2])
    expect(tablistsWithoutKeys(`<div role="tablist" onKeyDown={onTablistKeyDown}>\n</div>`)).toEqual([])
    expect(tablistsWithoutKeys(`<div\n  role="tablist"\n  aria-label="x"\n  onKeyDown={onTablistKeyDown}\n>`)).toEqual([])
    // a different handler is not the shared contract
    expect(tablistsWithoutKeys(`<div role="tablist" onKeyDown={mine}>`)).toEqual([1])
  })
  it("finds none in app/ or components/", () => {
    const files = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "components"))]
    expect(files.length).toBeGreaterThan(400)
    const bad: string[] = []
    for (const f of files) for (const n of tablistsWithoutKeys(readFileSync(f, "utf8"))) bad.push(`${relative(ROOT, f)}:${n}`)
    expect(bad, "add onKeyDown={onTablistKeyDown} (lib/a11y/tablist-keys) to the element carrying role=\"tablist\"").toEqual([])
  })
})
