// 2026-11-07 review: wallet-search started its cache upsert, edition seed,
// progressive classify and cost-basis writes as bare promises and returned the
// response. On Vercel a lambda can be frozen once the response is sent, so a
// write still pending then silently never lands. Each must go through
// keepAlive(), which hands the promise to after() (guarded for a missing
// request scope) and still starts the work where it started before.
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

const src = stripComments(readFileSync("app/api/wallet-search/route.ts", "utf8"))

describe("wallet-search background writes are kept alive", () => {
  it("keepAlive hands the settled promise to after() inside a guard", () => {
    const fn = src.slice(src.indexOf("function keepAlive("), src.indexOf("async function seedEditionsToSupabase"))
    expect(fn).toMatch(/after\(settled\)/)
    expect(fn).toMatch(/try\s*\{/)
  })

  it.each([
    ["the wmc cache upsert", /keepAlive\(upsertWalletMomentsCache\(wallet, rows\)\)/],
    ["the progressive classify", /keepAlive\(progressivelyClassify\(rows, wallet\)\)/],
    ["the edition seed", /keepAlive\(\s*getCollectionId\(\)\.then/],
    ["the cost-basis upsert", /keepAlive\(\(supabaseAdmin as any\)\s*\.from\("moment_acquisitions"\)/],
    ["the sales backfill", /keepAlive\(\(async \(\) =>/],
  ])("%s goes through keepAlive", (_label, re) => {
    expect(src).toMatch(re)
  })

  it("no bare fire-and-forget statement is left", () => {
    expect(src).not.toMatch(/^\s*upsertWalletMomentsCache\(/m)
    expect(src).not.toMatch(/^\s*(if \([^)]*\) )?progressivelyClassify\(/m)
    expect(src).not.toMatch(/getCollectionId\(\)\.then\(\(collectionId\) => \{/)
    expect(src).not.toMatch(/^\s*;\((supabaseAdmin|async)/m)
  })
})
