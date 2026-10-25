import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

// ─────────────────────────────────────────────────────────────────────────────
// THE ADMIN TOKEN IS COMPARED IN ONE PLACE (security audit 2026-10-25, R134).
//
// 13 routes compared RPC_ADMIN_TOKEN themselves — `auth === \`Bearer ${admin}\``
// or `provided !== adminToken` — so (a) the compares were not constant-time and
// (b) moving admin from a static token to short-lived sessions (R134 step 2)
// would have meant editing every one of them. Every check now goes through
// lib/admin-auth.ts `verifyAdminRequest` or lib/auth/bearer-secret.ts
// `bearerMatches` / `tokenMatches` by NAME ("RPC_ADMIN_TOKEN"), so step 2 is a
// change to those helpers alone.
//
// Ban at zero, tree walk: no app/ lib/ components/ file READS the env var except
// the helpers and the curated list below, each with its reason.
// ─────────────────────────────────────────────────────────────────────────────

const READ = /process\.env\.RPC_ADMIN_TOKEN\b|process\.env\[\s*["']RPC_ADMIN_TOKEN["']\s*\]/

const ALLOWED: Record<string, string> = {
  "app/api/admin/recalc-ultimate-fmv/route.ts":
    "presence check only, to answer 500 'not configured' instead of a misleading 401; the compare is verifyAdminRequest",
  "app/api/cron/topshot-catalog-backfill/route.ts":
    "FORWARDS the token as a Bearer header to /api/admin/backfill-topshot-catalog (Vercel cron sends CRON_SECRET); no compare",
}

function tracked(): string[] {
  return execFileSync("git", ["ls-files", "-z", "--", "app", "lib", "components"], { encoding: "utf8" })
    .split("\0")
    .filter((f) => /\.(ts|tsx|mjs|js)$/.test(f))
}

describe("RPC_ADMIN_TOKEN is read only by the shared helpers", () => {
  const files = tracked()
  const readers = files.filter((f) => {
    try {
      return READ.test(readFileSync(f, "utf8"))
    } catch {
      return false
    }
  })

  it("inspects the tree (a walk that reads nothing passes vacuously)", () => {
    expect(files.length).toBeGreaterThan(500)
    expect(files.filter((f) => f.startsWith("app/api/admin/")).length).toBeGreaterThan(30)
  })

  it("no file outside the allow-list reads the env var", () => {
    expect(readers.filter((f) => !(f in ALLOWED))).toEqual([])
  })

  it("every allow-list entry still reads it (no stale suppression)", () => {
    expect(Object.keys(ALLOWED).filter((f) => !readers.includes(f))).toEqual([])
  })

  it("the pattern fires on the shapes it replaced (planted)", () => {
    expect(READ.test("const admin = process.env.RPC_ADMIN_TOKEN;")).toBe(true)
    expect(READ.test('const t = process.env["RPC_ADMIN_TOKEN"]')).toBe(true)
    expect(READ.test('bearerMatches(h, "RPC_ADMIN_TOKEN")')).toBe(false)
  })
})
