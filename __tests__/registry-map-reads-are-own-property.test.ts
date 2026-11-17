import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { walkSourceFiles, repoRelative } from "./helpers/source-files"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// The collection registry's bridge maps are plain objects, so a bracket read
// with an externally controlled key answers "constructor" / "toString" /
// "__proto__" with an Object.prototype member — truthy, so it passes every
// `if (!uuid)` guard. Passed on as an RPC argument, JSON.stringify drops the
// function, the parameter falls to its SQL default (the Top Shot UUID, or NULL
// = every collection), and the route answers with another collection's data
// under the requested label. The 2026-10-10 audit found it live on
// /api/analytics, /api/wallet-search, /api/profile/top-moments,
// /api/wmc-fmv-populate, /api/wallet/pack-history and the admin FMV haircut.
//
// Read them with ownLookup (lib/safe-lookup) or the registry helpers
// (getCollectionUuid / toDbSlug / fromDbSlug). A literal key is fine.
// Tree walk, banned at zero.

const MAPS = ["COLLECTION_UUID_BY_SLUG", "SLUG_TO_DB_SLUG", "DB_SLUG_TO_SLUG"]
const BARE = new RegExp(`\\b(${MAPS.join("|")})\\[(?!\\s*["'][^"']*["']\\s*\\])`)

function sources(): string[] {
  return ["app", "lib", "components"]
    .flatMap((root) => walkSourceFiles(root, (n) => /\.tsx?$/.test(n)))
    .map(repoRelative)
}

describe("registry bridge maps are read by own property only", () => {
  const files = sources()

  it("walks the tree (not vacuous)", () => {
    expect(files.length).toBeGreaterThan(1000)
    const users = files.filter((f) => MAPS.some((m) => readFileSync(f, "utf8").includes(m)))
    expect(users.length).toBeGreaterThan(20)
  })

  it("no bare bracket read with a non-literal key", () => {
    const offenders: string[] = []
    for (const f of files) {
      const src = stripComments(readFileSync(f, "utf8"))
      src.split("\n").forEach((line, i) => {
        if (BARE.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it("the detector fires on the shape it bans and spares a literal key", () => {
    expect(BARE.test("const u = COLLECTION_UUID_BY_SLUG[slug] ?? null")).toBe(true)
    expect(BARE.test("SLUG_TO_DB_SLUG[slug ?? \"\"]")).toBe(true)
    expect(BARE.test("COLLECTION_UUID_BY_SLUG[\"nba-top-shot\"]")).toBe(false)
    expect(BARE.test("ownLookup(COLLECTION_UUID_BY_SLUG, slug)")).toBe(false)
  })
})
