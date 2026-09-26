import { describe, it, expect } from "vitest"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// BAN: a `wallet_moments_cache` read keyed on `moment_id` with no collection
// (or wallet) scope in the same query chain.
//
// ── WHY (2026-09-25, register #142) ─────────────────────────────────────────
// `wallet_moments_cache` holds every collection, and moment ids are only
// unique WITHIN a collection: Top Shot nft 6024287 and All Day nft 6024287 are
// two different moments. The Top Shot on-chain sales indexer looked the sale's
// nft up with `.from("wallet_moments_cache").select(…).in("moment_id", batch)`
// — no `collection_id` — so an All Day row answered for a Top Shot sale. Its
// edition_key ("2527") failed the Top Shot edition lookup, so the EDITION fell
// through to the `moments` table and landed correctly (LaMelo Ball 35:816) —
// but the SERIAL had already been taken from the foreign row (Amon-Ra St.
// Brown's #2630 on a 2,021-print edition) and the fall-through only fills a
// serial that is still null. Measured over the last 180 days: 659 Top Shot
// on-chain sales collide with a foreign cache row in the CURRENT cache
// snapshot, 333 carry exactly the foreign serial, 102 provably differ from
// the `moments` table's serial. The "serial above circulation" falsifier sees
// only the subset whose foreign serial happens to exceed the print run; a
// foreign serial of #7 on a common reads as a premium serial to the FMV route.
//
// Every sibling indexer already scoped this read; one did not, and no comment
// could have caught it. This walks the tree so the next unscoped read fails
// CI rather than pricing a wrong serial for four months.
//
// The rule: a chain from `.from("wallet_moments_cache")` that filters on
// `moment_id` must also filter on `collection_id` or `wallet_address` (a
// wallet is one chain, so its ids do not collide).

const ROOTS = ["app", "lib", "supabase/functions", "workers", "scripts"]

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const e of entries) {
    if (e === "node_modules" || e.startsWith(".")) continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|mjs|js)$/.test(e) && !p.includes("__tests__")) out.push(p)
  }
  return out
}

/**
 * Every `.from("wallet_moments_cache")` chain that filters on moment_id and
 * carries no collection_id / wallet_address filter. A chain ends at the first
 * `;`, `)` that closes the await/Promise.all argument, or blank line after the
 * `.from(` — the PostgREST builder chains never span a blank line here, and
 * over-reading into the next statement can only hide a defect by finding a
 * scope that belongs to something else, so the window is the smaller of
 * "next blank line" and "next `;`".
 */
export function findUnscopedMomentIdReads(roots: string[] = ROOTS): string[] {
  const hits: string[] = []
  for (const root of roots) {
    for (const file of walk(root)) {
      const src = stripComments(readFileSync(file, "utf8"))
      const re = /\.from\(\s*["']wallet_moments_cache["']\s*\)/g
      let m: RegExpExecArray | null
      while ((m = re.exec(src))) {
        const rest = src.slice(m.index)
        const semi = rest.indexOf(";")
        const blank = rest.search(/\n[ \t]*\n/)
        const ends = [semi, blank].filter((n) => n > 0)
        const chain = rest.slice(0, ends.length ? Math.min(...ends) : Math.min(rest.length, 1200))
        const keyedOnMomentId = /\.(in|eq)\(\s*["']moment_id["']/.test(chain)
        if (!keyedOnMomentId) continue
        const scoped = /\.eq\(\s*["'](collection_id|wallet_address)["']/.test(chain)
        if (!scoped) hits.push(`${file}:${src.slice(0, m.index).split("\n").length}`)
      }
    }
  }
  return hits
}

describe("wallet_moments_cache reads keyed on moment_id are scoped to a collection or a wallet", () => {
  it("no site in the tree reads the cache by moment_id alone (moment ids collide across collections)", () => {
    const hits = findUnscopedMomentIdReads()
    expect(
      hits,
      `unscoped wallet_moments_cache reads keyed on moment_id — a foreign collection's row can answer (#142, the Top Shot sales indexer's serials):\n  ${hits.join("\n  ")}`,
    ).toEqual([])
  })

  it("the sweep sees a real population (not vacuously passing)", () => {
    // The scoped reads it must have walked past: the Top Shot sales indexer's
    // 4a lookup (the fixed site) and its Golazos sibling.
    const indexer = stripComments(readFileSync("app/api/sales-indexer/route.ts", "utf8"))
    expect(indexer).toMatch(/\.from\("wallet_moments_cache"\)[\s\S]{0,200}\.eq\("collection_id", TOPSHOT_COLLECTION_ID\)[\s\S]{0,120}\.in\("moment_id"/)
    expect(walk("app").length).toBeGreaterThan(100)
  })

  it("catches a planted unscoped read, and passes a scoped one and a non-moment_id one (the detector is falsifiable)", () => {
    const dir = mkdtempSync(join(tmpdir(), "wmc-scope-"))
    try {
      mkdirSync(join(dir, "app"))
      writeFileSync(
        join(dir, "app", "bad.ts"),
        `const { data } = await sb\n  .from("wallet_moments_cache")\n  .select("moment_id, edition_key, serial_number")\n  .in("moment_id", batch)\n\nconst other = 1;\n`,
      )
      writeFileSync(
        join(dir, "app", "good.ts"),
        `const a = await sb.from("wallet_moments_cache").select("moment_id").eq("collection_id", X).in("moment_id", batch);\n` +
          `const b = await sb.from("wallet_moments_cache").select("moment_id").eq("wallet_address", w).eq("moment_id", id).maybeSingle();\n` +
          `const c = await sb.from("wallet_moments_cache").select("moment_id").eq("wallet_address", w).limit(5);\n`,
      )
      const hits = findUnscopedMomentIdReads([join(dir, "app")])
      expect(hits).toHaveLength(1)
      expect(hits[0]).toMatch(/bad\.ts:2$/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
