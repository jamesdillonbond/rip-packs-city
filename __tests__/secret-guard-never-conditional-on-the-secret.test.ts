import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

/**
 * 2026-10-27: four ingest/backfill WRITE routes guarded with `if (expectedToken && !bearerMatches(...))` — with the
 * secret unset the whole check was skipped and anyone could write. They now call the helper unconditionally
 * (bearerMatches is false without a configured secret). A guard conditioned on the secret's presence is banned at
 * zero. Population: a walk of app/ and lib/ (comments stripped with the one shared stripper).
 */
function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}
const files = [...walk(join(process.cwd(), "app")), ...walk(join(process.cwd(), "lib"))]
const SHAPE = /\b[A-Za-z_$][\w$.]*\s*&&\s*!\s*(bearerMatches|tokenMatches)\(/g

describe("a secret guard never depends on the secret being configured", () => {
  it("the walk inspected a real tree", () => {
    expect(files.length).toBeGreaterThan(500)
  })
  it("no `secret && !bearerMatches(…)` / `&& !tokenMatches(…)` guard", () => {
    const hits: string[] = []
    for (const f of files) {
      const m = stripComments(readFileSync(f, "utf8")).match(SHAPE)
      if (m) hits.push(`${f.slice(process.cwd().length + 1)}: ${m.join(" | ")}`)
    }
    expect(hits, hits.join("\n")).toEqual([])
  })
})
