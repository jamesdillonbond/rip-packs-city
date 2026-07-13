import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync } from "fs"
import path from "path"

// ARCHITECTURE GUARD — Vercel Pro Lambda maxDuration hard cap.
//
// Per CLAUDE.md: the Pro Lambda `maxDuration` hard cap is 800s. Anything higher
// silently sends the deploy to ERROR state — the build log shows "Compiled
// successfully" with no error text before the transition, so it fails INVISIBLY.
// Commit 32de87a set wallet-backfill-multicollection to 900 and the next 5
// deploys all failed silently until b32102e reverted to 800.
//
// This test scans every app/api route for `export const maxDuration = N` and
// fails if any exceeds 800 — catching that exact invisible-deploy-failure class
// at test time instead of after 5 broken deploys.

const REPO = process.cwd()
const API_DIR = path.join(REPO, "app", "api")
const PRO_MAX_DURATION = 800

function walkRouteFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkRouteFiles(full))
    else if (entry.name === "route.ts" || entry.name === "route.tsx") out.push(full)
  }
  return out
}

const MAXDUR_RE = /export\s+const\s+maxDuration\s*=\s*(\d+)/g

function collectMaxDurations(): { file: string; value: number }[] {
  const rows: { file: string; value: number }[] = []
  for (const file of walkRouteFiles(API_DIR)) {
    const src = readFileSync(file, "utf8")
    let m: RegExpExecArray | null
    MAXDUR_RE.lastIndex = 0
    while ((m = MAXDUR_RE.exec(src)) !== null) {
      rows.push({ file: path.relative(REPO, file), value: Number(m[1]) })
    }
  }
  return rows
}

describe("invariant: route maxDuration <= 800 (Vercel Pro cap)", () => {
  const rows = collectMaxDurations()

  it("finds maxDuration declarations to check (guard is actually running)", () => {
    // If this ever hits 0, the scan broke (moved dir / renamed export) and the
    // guard would silently pass — fail loudly instead.
    expect(rows.length).toBeGreaterThan(50)
  })

  it("no route declares maxDuration above the 800s Pro cap", () => {
    const offenders = rows.filter((r) => r.value > PRO_MAX_DURATION)
    expect(
      offenders,
      `These routes exceed the 800s Pro Lambda cap and will SILENTLY fail to deploy:\n` +
        offenders.map((o) => `  ${o.file}: ${o.value}`).join("\n"),
    ).toEqual([])
  })

  it("every declared maxDuration is a positive integer within the cap", () => {
    for (const r of rows) {
      expect(Number.isInteger(r.value), `${r.file}`).toBe(true)
      expect(r.value).toBeGreaterThan(0)
      expect(r.value).toBeLessThanOrEqual(PRO_MAX_DURATION)
    }
  })
})
