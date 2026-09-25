import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { parse } from "yaml"
import { expandRoutes, registryCollectionIds, KNOWN_5XX } from "../scripts/qa/built-render-smoke.mjs"

// scripts/qa/built-render-smoke.mjs renders every page route of the BUILT app in
// CI (job `build-render`). It is the only instrument in the repo that can see
// DYNAMIC_SERVER_USAGE — the 2026-09-20 outage — so its URL derivation and its
// wiring are pinned here. Its planted-defect proof is recorded in the ci.yml
// job header: with that bug re-planted, `next build` exited 0 and this smoke
// went red on every edition URL.

const ROOT = path.resolve(__dirname, "..")
const COLLECTIONS_SRC = readFileSync(path.join(ROOT, "lib/collections.ts"), "utf8")

describe("built-render-smoke URL derivation", () => {
  it("reads collection ids from the registry, including every published one", () => {
    const ids = registryCollectionIds(COLLECTIONS_SRC)
    for (const id of ["nba-top-shot", "nfl-all-day", "laliga-golazos", "ufc", "disney-pinnacle"]) {
      expect(ids).toContain(id)
    }
    // Only the top-level `id:` of each entry — nested objects must not leak in.
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("expands [collection] once per collection and fills other params", () => {
    const out = expandRoutes(["/[collection]/edition/[slug]", "/moment/[id]"], ["a", "b"])
    expect(out.map((t: { path: string }) => t.path)).toEqual([
      "/a/edition/ci-render-probe",
      "/b/edition/ci-render-probe",
      "/moment/1",
    ])
    expect(out.every((t: { unresolved: boolean }) => !t.unresolved)).toBe(true)
  })

  it("skips API routes and Next internals, and flags an unknown param name", () => {
    const out = expandRoutes(["/api/x", "/_not-found", "/about", "/thing/[neverSeenBefore]"], ["a"])
    expect(out.map((t: { path: string }) => t.path)).toEqual(["/about", "/thing/ci-render-probe"])
    expect(out.find((t: { pattern: string }) => t.pattern === "/thing/[neverSeenBefore]")?.unresolved).toBe(true)
  })

  it("KNOWN_5XX is empty (it may only ever shrink back to empty)", () => {
    expect([...KNOWN_5XX.keys()]).toEqual([])
  })
})

describe("build-render CI job", () => {
  const wf = parse(readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8")) as {
    jobs: Record<string, any>
  }
  const job = wf.jobs["build-render"]

  it("exists, builds, then runs the smoke", () => {
    expect(job, "build-render job missing from ci.yml").toBeTruthy()
    const runs = job.steps.map((s: any) => s.run).filter(Boolean)
    const build = runs.findIndex((r: string) => /next build/.test(r))
    const smoke = runs.findIndex((r: string) => /test:render-smoke|built-render-smoke/.test(r))
    expect(build).toBeGreaterThanOrEqual(0)
    expect(smoke).toBeGreaterThan(build)
  })

  it("points Supabase at a refusing address and uses no secrets", () => {
    expect(job.env.NEXT_PUBLIC_SUPABASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(JSON.stringify(job)).not.toContain("secrets.")
  })
})
