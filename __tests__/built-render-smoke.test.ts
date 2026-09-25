import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { parse } from "yaml"
import {
  expandRoutes,
  registryCollectionIds,
  KNOWN_5XX,
  prerenderedPaths,
  withPrerendered,
  sessionCookie,
  TEST_ACCESS_TOKEN,
} from "../scripts/qa/built-render-smoke.mjs"

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

  it("KNOWN_5XX holds only the deliberate failed-read throw, each entry with a reason", () => {
    // Growing this list needs a reason as strong as this one: the route THROWS on
    // a failed read on purpose (a false 404 was the alternative).
    expect([...KNOWN_5XX.keys()]).toEqual(["/edition/[id]"])
    for (const why of KNOWN_5XX.values()) expect(String(why).length).toBeGreaterThan(40)
    const src = readFileSync(path.join(ROOT, "app/edition/[id]/page.tsx"), "utf8")
    expect(src, "the /edition/[id] exemption's premise (a deliberate throw) is gone — remove it").toMatch(
      /if \(!ok\) throw new Error/,
    )
  })

  it("prerendered paths are added, deduped, and exclude api/internal/file routes", () => {
    const paths = prerenderedPaths({
      routes: { "/a": {}, "/api/x": {}, "/_not-found": {}, "/robots.txt": {}, "/analytics/sales/topshot": {}, "/index": {} },
    })
    expect(paths.sort()).toEqual(["/a", "/analytics/sales/topshot"])
    const merged = withPrerendered([{ pattern: "/a", path: "/a", unresolved: false }], paths)
    expect(merged.map((t: { path: string }) => t.path)).toEqual(["/a", "/analytics/sales/topshot"])
  })

  it("routes with a UUID format check get a UUID placeholder", () => {
    const out = expandRoutes(["/edition/[id]", "/analytics/sets/[set_id]", "/moment/[id]"], [])
    const byPattern = Object.fromEntries(out.map((t: { pattern: string; path: string }) => [t.pattern, t.path]))
    expect(byPattern["/edition/[id]"]).toMatch(/\/edition\/[0-9a-f-]{36}$/)
    expect(byPattern["/analytics/sets/[set_id]"]).toMatch(/[0-9a-f-]{36}$/)
    expect(byPattern["/moment/[id]"]).toBe("/moment/1")
  })

  it("the signed-in session cookie carries the stub's token under @supabase/ssr's key", () => {
    const c = sessionCookie("http://127.0.0.1:54329")
    expect(c.startsWith("sb-127-auth-token=base64-")).toBe(true)
    const session = JSON.parse(Buffer.from(c.split("=base64-")[1], "base64url").toString())
    expect(session.access_token).toBe(TEST_ACCESS_TOKEN)
    expect(session.expires_at).toBeGreaterThan(Date.now() / 1000)
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

  it("points Supabase at the local stub and uses no secrets", () => {
    expect(job.env.NEXT_PUBLIC_SUPABASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(JSON.stringify(job)).not.toContain("secrets.")
  })
})
