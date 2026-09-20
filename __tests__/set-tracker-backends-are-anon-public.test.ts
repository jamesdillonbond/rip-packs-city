import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import { isPublicPath } from "@/proxy"

/**
 * EVERY SET TRACKER BACKEND THE CLIENT CAN DISPATCH TO MUST BE ANON-PUBLIC.
 *
 * 🚨 WHY THIS EXISTS, and it is the fifth instance of one shape. `/[collection]/sets`
 * is anon-public by proxy.ts's feature-tab regex and every collection's copy is in
 * the sitemap, but the page is a client shell whose ONLY data comes from one fetch.
 * If that fetch's route is gated, the reader gets the login HTML, `.json()` throws,
 * and the tab renders an error for a wallet that resolves perfectly well. The route
 * is fixed; the SURFACE is not — CLAUDE.md states it directly: *a fix to a route is
 * not a fix to the surface until its CALLER can reach it.*
 *
 * The prior four, all in proxy.ts's own comments: `/api/pinnacle-wallet` (2026-07-26),
 * `/api/pinnacle-sniper-feed` and `/api/pack-listings` (2026-09-04), `/api/profile/me`
 * (2026-09-04). The fifth was `/api/pinnacle-set-progress`, shipped 2026-09-20 with
 * Pinnacle's Sets tab and **missed by a full green suite** — found only by fetching
 * the deployed route and reading `x-matched-path: /login`.
 *
 * ⛔ SO THIS DOES NOT SPELL THE LIST. A hardcoded list beside a registry goes stale
 * silently — that is the defect, not the cure. The population is DERIVED from the
 * dispatch in `CollectionSetsClient.tsx`, so the day a sixth collection gets its own
 * backend, this reds unless that backend is also reachable by the reader who can see
 * the tab.
 *
 * ── WHAT IT IS STRUCTURALLY SILENT ABOUT, stated rather than implied ───────────
 *  · An endpoint built from a variable rather than written as a literal — the
 *    extractor would not see it. The vacuity arm bounds this: it fails if the walk
 *    stops finding the backends it knows exist.
 *  · Whether the route ANSWERS correctly once reached. That is the route's own test.
 *  · Per-set detail endpoints reached with `?set=` — same base paths, so covered.
 */

const CLIENT = path.join(
  process.cwd(),
  "app",
  "(collections)",
  "[collection]",
  "sets",
  "CollectionSetsClient.tsx",
)

/** Every `/api/...` literal in the client, comments stripped so a prose mention
 *  of a retired route cannot enter the population. */
function dispatchedEndpoints(): string[] {
  const src = stripComments(readFileSync(CLIENT, "utf8"))
  const found = new Set<string>()
  for (const m of src.matchAll(/["'`](\/api\/[A-Za-z0-9/-]+)/g)) found.add(m[1])
  return [...found].sort()
}

describe("every Set Tracker backend is reachable by an anonymous reader", () => {
  const endpoints = dispatchedEndpoints()

  it("is not vacuous — the walk found the backends we know exist", () => {
    expect(
      endpoints.length,
      `extracted only ${endpoints.length} endpoint(s) from CollectionSetsClient.tsx — ` +
        `the extractor is broken, or a dispatch was moved behind a variable`,
    ).toBeGreaterThanOrEqual(4)
    // Named so a silent narrowing of the regex cannot pass this arm.
    for (const known of ["/api/sets", "/api/sets-db", "/api/pinnacle-set-progress"]) {
      expect(endpoints, `${known} is no longer dispatched from the client`).toContain(known)
    }
  })

  it.each(dispatchedEndpoints())("%s is anon-public", (ep) => {
    expect(
      isPublicPath(ep, "GET"),
      `${ep} backs /[collection]/sets — a page proxy.ts serves to anonymous readers ` +
        `and the sitemap advertises — but it is NOT in proxy.ts's PUBLIC_READ_APIS. ` +
        `An anonymous reader's fetch 307s to /login, .json() throws, and the Set ` +
        `Tracker renders an error for a wallet that resolves fine.`,
    ).toBe(true)
  })

  it("the page itself is anon-public on every published collection — the other half of the pair", () => {
    // A public API behind a gated page would be the same defect mirrored.
    for (const slug of ["nba-top-shot", "nfl-all-day", "laliga-golazos", "disney-pinnacle"]) {
      expect(isPublicPath(`/${slug}/sets`, "GET"), `/${slug}/sets is gated`).toBe(true)
    }
  })
})
