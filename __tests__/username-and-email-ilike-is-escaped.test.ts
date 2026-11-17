import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { ilikeLiteral } from "@/lib/db/ilike-literal"

// 2026-11-14 (account review): `.ilike("username", handle)` treats `_` / `%` / `*` in the input as
// WILDCARDS. Handles may contain `_`: /profile/a_c rendered collector "abc"'s profile, two matches
// made maybeSingle() 500 every request for one user, and an email with `_` could resolve to
// ANOTHER member's allow_list row (/api/profile/me returned their wallet as the viewer's). A
// username / email lookup must go through lib/db/ilike-literal.ts. BAN AT ZERO over a tree walk.

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

const OFFENDER = /\.ilike\(\s*["'](username|email)["']\s*,\s*(?!\s|ilikeLiteral\(|literal\b)/

export function offenders(files: Array<{ path: string; src: string }>): string[] {
  const hits: string[] = []
  for (const { path, src } of files) {
    src.split("\n").forEach((line, i) => {
      if (OFFENDER.test(line)) hits.push(`${path}:${i + 1}: ${line.trim()}`)
    })
  }
  return hits
}

describe("username / email ilike lookups are escaped", () => {
  const files = ["app", "lib"].flatMap((d) => walk(d)).map((path) => ({ path, src: readFileSync(path, "utf8") }))

  it("inspects the tree (not vacuous)", () => {
    expect(files.length).toBeGreaterThan(500)
  })
  it("no .ilike('username' | 'email', <raw>) anywhere in app/ or lib/", () => {
    expect(offenders(files)).toEqual([])
  })
  it("PLANTED DEFECT: a raw lookup is caught; an escaped one is not", () => {
    expect(offenders([{ path: "x.ts", src: `q.ilike("username", handle)` }])).toHaveLength(1)
    expect(offenders([{ path: "x.ts", src: `q.ilike('email', user.email)` }])).toHaveLength(1)
    expect(offenders([{ path: "x.ts", src: `q.ilike("username", ilikeLiteral(handle))` }])).toHaveLength(0)
  })
  it("ilikeLiteral escapes every PostgREST ilike wildcard and the escape itself", () => {
    expect(ilikeLiteral("a_c")).toBe("a\\_c")
    expect(ilikeLiteral("tre%")).toBe("tre\\%")
    expect(ilikeLiteral("x*y")).toBe("x\\*y")
    expect(ilikeLiteral("back\\slash")).toBe("back\\\\slash")
    expect(ilikeLiteral("plain")).toBe("plain")
  })
})
