import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// A Vercel Cron request arrives on the production DEPLOYMENT url, which this project's SSO protection
// covers. A cron route that derives an origin from that request and POSTs back to it gets a Vercel
// 401 before our handler runs: every #245 wallet-backfill resume did, 2026-11-10, while its route
// test (request on www) passed. Self-calls use lib/canonical-origin.ts. Tree walk, so a new cron
// route is covered without being listed; a population of zero is fine.

const ROOT = join(process.cwd(), "app", "api", "cron")
const ORIGIN_FROM_REQUEST = /new\s+URL\(\s*(req|request)\.url\s*\)\.origin|\b(req|request)\.nextUrl\.origin/

function routes(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...routes(p))
    else if (name === "route.ts") out.push(p)
  }
  return out
}

// Every route Vercel Cron calls, wherever it lives: the cron tree plus each vercel.json cron path.
function vercelCronRoutes(): string[] {
  const v = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")) as { crons?: Array<{ path: string }> }
  return (v.crons ?? [])
    .map((c) => join(process.cwd(), "app", c.path.split("?")[0], "route.ts"))
    .filter((f) => { try { return statSync(f).isFile() } catch { return false } })
}

describe("cron routes never call back to the request's own origin", () => {
  const files = [...new Set([...routes(ROOT), ...vercelCronRoutes()])]
  it("inspects the cron route tree (count stated, not silent)", () => {
    expect(files.length).toBeGreaterThan(0)
    // vercel.json targets outside app/api/cron are in the population too (e.g. /api/send-digest)
    expect(files.some((f) => f.endsWith(join("api", "send-digest", "route.ts")))).toBe(true)
  })
  it("no cron route derives an origin from the request url", () => {
    const offenders = files.filter((f) => ORIGIN_FROM_REQUEST.test(stripComments(readFileSync(f, "utf8"))))
    expect(offenders.map((f) => f.slice(process.cwd().length + 1))).toEqual([])
  })
  it("the pattern catches the shape it bans (planted-defect self-check)", () => {
    expect(ORIGIN_FROM_REQUEST.test("const origin = new URL(req.url).origin")).toBe(true)
    expect(ORIGIN_FROM_REQUEST.test("const o = request.nextUrl.origin")).toBe(true)
    expect(ORIGIN_FROM_REQUEST.test("const origin = CANONICAL_ORIGIN")).toBe(false)
  })
})
