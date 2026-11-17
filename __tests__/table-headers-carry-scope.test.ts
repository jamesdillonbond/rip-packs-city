import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"

// Every <th> in app/ and components/ states its scope (2026-10-24). Before this,
// 519 header cells relied on screen readers guessing the header/cell relationship;
// a codemod tagged them `scope="col"` (every one sat in a <thead> — no row headers
// existed). A new table that adds a bare <th> fails here. A row header is welcome:
// write scope="row".

const ROOT = join(__dirname, "..")

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (e.endsWith(".tsx")) out.push(p)
  }
  return out
}

/** Line numbers of <th> opening tags with no scope attribute (JSX braces skipped). */
export function bareTh(src: string): number[] {
  const out: number[] = []
  const re = /<th(\s|>)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    let i = m.index + 3
    let depth = 0
    for (; i < src.length; i++) {
      const c = src[i]
      if (c === "{") depth++
      else if (c === "}") depth--
      else if (c === ">" && depth === 0) break
    }
    if (!/\bscope=/.test(src.slice(m.index, i))) out.push(src.slice(0, m.index).split("\n").length)
  }
  return out
}

describe("table header cells carry scope", () => {
  it("catches a planted defect, and an arrow function before scope does not fool it", () => {
    expect(bareTh(`<table><thead><tr><th className="x">A</th></tr></thead></table>`)).toEqual([1])
    expect(bareTh(`<th onClick={() => go()} scope="col">A</th>`)).toEqual([])
    expect(bareTh(`<th\n  scope="row"\n>A</th>`)).toEqual([])
    expect(bareTh(`<thead><tr><th>A</th></tr></thead>`)).toEqual([1])
  })
  it("finds none in app/ or components/", () => {
    const files = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "components"))]
    expect(files.length).toBeGreaterThan(500)
    const bad: string[] = []
    let seen = 0
    for (const f of files) {
      const src = readFileSync(f, "utf8")
      seen += (src.match(/<th(\s|>)/g) ?? []).length
      for (const n of bareTh(src)) bad.push(`${relative(ROOT, f)}:${n}`)
    }
    expect(seen, "the walk inspected no <th> at all").toBeGreaterThan(400)
    expect(bad, 'add scope="col" (or scope="row" for a row header)').toEqual([])
  })
})
