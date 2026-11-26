// The `?token=` query-string form of a SERVER SECRET is retired (2026-11-26).
//
// A secret in a URL lands in Vercel access logs, browser history and Referer
// headers. proxy.ts stopped honouring it on 2026-11-04 (R133); ~60 route
// handlers still re-checked it themselves. proxy.ts `queryTokenSighting` logged
// every /api request carrying a `token` param from 2026-11-19: a week of ZERO
// real sightings (only the 11-24 positive control), so every route is now
// header-only. This ratchet bans reading a `token` query param anywhere in
// app/ or lib/ at ZERO, except the email-link routes, whose `token` is a
// per-subscriber link token and not a server secret.
//
// Tree walk (not a curated list), comments stripped, and the matcher is proven
// on planted defects below so it cannot pass by being unable to match.

import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

const ROOT = join(__dirname, "..")
const LINK_TOKEN_ROUTES = new Set([
  "app/api/subscribe/unsubscribe/route.ts",
  "app/api/subscribe/verify/route.ts",
  "app/api/email/confirm/route.ts",
])

// `.get("token")`, `.get('token')`, `.get(`token`)`, `.has("token")` on anything
// whose receiver mentions searchParams (req.nextUrl.searchParams, url.searchParams,
// new URL(x).searchParams, a destructured `searchParams`).
const QUERY_TOKEN_READ = /searchParams\s*\)?\s*\.\s*(?:get|getAll|has)\s*\(\s*["'`]token["'`]\s*\)/

function walk(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) out.push(p)
  }
  return out
}

describe("?token= server-secret form stays retired", () => {
  it("the matcher catches every planted shape (positive controls)", () => {
    for (const planted of [
      `const t = req.nextUrl.searchParams.get("token") ?? ""`,
      `const t = url.searchParams.get('token')`,
      "const t = new URL(req.url).searchParams.get(`token`)",
      `if (searchParams . get ( "token" )) {}`,
      `const has = req.nextUrl.searchParams.has("token")`,
    ]) {
      expect(QUERY_TOKEN_READ.test(stripComments(planted)), planted).toBe(true)
    }
    // ...and does not fire on neighbours.
    expect(QUERY_TOKEN_READ.test(`req.headers.get("x-ingest-token")`)).toBe(false)
    expect(QUERY_TOKEN_READ.test(`searchParams.get("tokenId")`)).toBe(false)
    expect(QUERY_TOKEN_READ.test(stripComments(`// searchParams.get("token") was retired`))).toBe(false)
  })

  it("no route or lib file reads a `token` query param except the email-link routes", () => {
    const files = [...walk(join(ROOT, "app"), []), ...walk(join(ROOT, "lib"), [])]
    // Assert the population this guard inspected — a walk that found nothing passes vacuously.
    expect(files.length).toBeGreaterThan(500)
    const offenders: string[] = []
    const linkRoutesSeen: string[] = []
    for (const f of files) {
      const rel = relative(ROOT, f).split("\\").join("/")
      const src = stripComments(readFileSync(f, "utf8"))
      if (!QUERY_TOKEN_READ.test(src)) continue
      if (LINK_TOKEN_ROUTES.has(rel)) linkRoutesSeen.push(rel)
      else offenders.push(rel)
    }
    expect(offenders).toEqual([])
    // The exemption is a claim about real files: each one must still exist and
    // still read its link token, or the allowlist has gone stale.
    expect(linkRoutesSeen.sort()).toEqual([...LINK_TOKEN_ROUTES].sort())
  })
})
