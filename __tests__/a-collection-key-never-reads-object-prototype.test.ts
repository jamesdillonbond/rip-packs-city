// __tests__/a-collection-key-never-reads-object-prototype.test.ts
//
// A bare `MAP[collection]` read on a plain-object map resolves a crafted key —
// "constructor", "toString", "__proto__", "hasOwnProperty" — to a TRUTHY
// Object.prototype member. That defeats the `if (!x) return 400` that follows
// it, and the inherited function reaches an RPC or a walk as if it were a
// collection's config.
//
// ── THE CASE THIS WAS WRITTEN FROM (2026-10-23) ────────────────────────────
// Six API routes read their collection map that way: four public
// (`market-analytics`, `sets-db`, `insider-signals`, `cache-refresh`), one
// public diagnostic (`wallet-preflight`) and one cron
// (`cron/golazos-storefront-reconcile`). Each one's own test of a prototype key
// failed on the old code. The fix is `lib/safe-lookup.ts` `ownLookup`, whose
// header already named this shape — it just was not used at these sites.
//
// ── WHY A BAN AT ZERO ──────────────────────────────────────────────────────
// `ownLookup` is safe for EVERY key, external or not, so there is nothing to
// allowlist: the two DB-keyed sites (`cron/lock-check-batch`,
// `wallet-backfill-multicollection`) were converted with the rest. The guard
// matches the key NAMES a collection is passed under; it is silent about a map
// keyed by some other identifier (a stated limit, not a claim of coverage).

import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

const API_ROOT = join(process.cwd(), "app", "api")

// An UPPER_CASE map indexed directly by a collection-shaped identifier.
const BARE_COLLECTION_LOOKUP =
  /\b[A-Z][A-Z0-9_]{2,}\[(?:collection|collectionSlug|slug|collectionRaw|dbSlug|collectionId)\]/g

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p)
  }
  return out
}

const toRel = (abs: string): string =>
  abs.slice(process.cwd().length + 1).split("\\").join("/")

export function findBareCollectionLookups(sources: Array<{ rel: string; src: string }>): string[] {
  const hits: string[] = []
  for (const { rel, src } of sources) {
    const code = stripComments(src)
    for (const m of code.matchAll(BARE_COLLECTION_LOOKUP)) hits.push(`${rel}: ${m[0]}`)
  }
  return hits
}

describe("a collection key never reads Object.prototype (app/api)", () => {
  const files = walk(API_ROOT)
  const sources = files.map((f) => ({ rel: toRel(f), src: readFileSync(f, "utf8") }))

  it("inspects the API tree (a guard that read nothing has not passed)", () => {
    expect(files.length).toBeGreaterThan(300)
  })

  it("no bare UPPER_CASE_MAP[collection] read — use ownLookup", () => {
    expect(findBareCollectionLookups(sources)).toEqual([])
  })

  it("planted defect: the detector flags the bare shape and passes ownLookup", () => {
    const planted = [
      { rel: "bad.ts", src: "const id = COLLECTION_UUID_MAP[collectionSlug]\n" },
      { rel: "good.ts", src: "const id = ownLookup(COLLECTION_UUID_MAP, collectionSlug)\n" },
      { rel: "comment.ts", src: "// was COLLECTION_UUID_MAP[collectionSlug]\nconst x = 1\n" },
    ]
    expect(findBareCollectionLookups(planted)).toEqual(["bad.ts: COLLECTION_UUID_MAP[collectionSlug]"])
  })
})
