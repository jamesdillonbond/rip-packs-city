import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { isPublicPath } from "@/proxy"
import {
  leakSites,
  OPERATOR_SECRET_RE,
  SESSION_GATE_RE,
} from "./helpers/driver-message-leak"

// Source guard: no route a SIGNED-IN user can reach may publish a driver
// message either.
//
// WHY A SECOND GUARD.
//
// The sibling guard (anon-api-no-driver-message-leak-guard) derives its file
// set by executing `isPublicPath` from proxy.ts — a genuinely good design, and
// the reason it cannot miss a route someone forgets to add to a list. But that
// design also fixes its SCOPE: it asserts the property only for routes an
// ANONYMOUS visitor can reach. Everything behind sign-in was outside it by
// construction.
//
// That gap was not theoretical. A sweep of the routes proxy.ts gates found the
// same defect on 120 sites across 64 files — the collector's own /profile,
// /wallet, /alerts, /watchlist and /portfolio surfaces — publishing Postgres's
// own text to the logged-in user. One of them, /api/profile/trophy/reorder, was
// rendered STRAIGHT INTO A TOAST by app/dashboard/page.tsx, so a statement
// timeout was shown to a collector as the reason their trophy case did not
// save.
//
// A signed-in user is still a member of the public. The only routes where a
// driver message is acceptable are the ones gated on a shared OPERATOR SECRET,
// where the reader is holding the token.
//
// THE REMEDY when this fails: `apiErrorResponse(err, "api/<route>")` from
// lib/api-error.ts. If the failure is an actionable CALLER error rather than an
// internal one — a username that does not resolve, say — use
// `unresolvedIdentifierResponse()` (or return your own fixed copy). Reading a
// thrown message SERVER-SIDE to classify is fine; publishing it is not.

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name === "route.ts" || name === "route.tsx") out.push(p)
  }
  return out
}

const ROUTE_FILES = walk(join(process.cwd(), "app", "api")).map((p) =>
  p.slice(process.cwd().length + 1).replace(/\\/g, "/")
)

/** Proxy-bypassed so their own bearer-secret check can BE the gate. */
const SECRET_GATED_PREFIXES = ["app/api/admin/", "app/api/cron/"]

function isOperatorSurface(file: string, src: string): boolean {
  if (SECRET_GATED_PREFIXES.some((p) => file.startsWith(p))) return true
  // A shared operator secret AND no session resolution — the reader is holding
  // the token. A route doing both (e.g. a user route that also accepts a cron
  // bearer) is NOT excused: a real person can still reach it.
  return OPERATOR_SECRET_RE.test(src) && !SESSION_GATE_RE.test(src)
}

const USER_REACHABLE = ROUTE_FILES.filter(
  (f) => !isOperatorSurface(f, readFileSync(join(process.cwd(), f), "utf8"))
)

describe("API routes a signed-in user can reach never publish a driver message", () => {
  it("derives a non-trivial route set", () => {
    // A sanity floor. Without it a broken walk() would leave this guard
    // asserting the property over an EMPTY set — the exact failure mode that
    // made an earlier version of a sibling guard useless.
    expect(ROUTE_FILES.length).toBeGreaterThan(300)
    expect(USER_REACHABLE.length).toBeGreaterThan(150)
    for (const anchor of [
      "app/api/profile/trophy/route.ts",
      "app/api/watchlist/route.ts",
      "app/api/portfolio/route.ts",
      "app/api/wallet/pack-summary/route.ts",
    ]) {
      expect(USER_REACHABLE, `${anchor} must be in the user-reachable set`).toContain(anchor)
    }
  })

  it("excludes only surfaces that really are operator-gated", () => {
    // The exclusion is sound only while every excluded route actually requires
    // a shared secret. If one stops, it becomes a genuinely user-reachable
    // surface this guard is skipping — the worst possible combination.
    const excluded = ROUTE_FILES.filter((f) => !USER_REACHABLE.includes(f))
    const ungated: string[] = []
    for (const f of excluded) {
      const src = readFileSync(join(process.cwd(), f), "utf8")
      if (!OPERATOR_SECRET_RE.test(src)) ungated.push(f)
    }
    expect(ungated, `excluded but carrying no operator-secret gate:\n${ungated.join("\n")}`).toEqual([])
  })

  it("publishes no driver message on any user-reachable route", () => {
    const offenders: string[] = []
    for (const f of USER_REACHABLE) {
      const hits = leakSites(readFileSync(join(process.cwd(), f), "utf8"))
      if (hits.length) offenders.push(`${f}\n    ${hits.join("\n    ")}`)
    }
    expect(
      offenders,
      `These routes publish a driver message to a signed-in user.\n` +
        `Use apiErrorResponse(err, "api/<route>") from lib/api-error.ts.\n\n` +
        offenders.join("\n")
    ).toEqual([])
  })

  it("the anon guard's set is a SUBSET of this one (no route is unguarded)", () => {
    // Belt and braces: every anon-reachable, non-operator route must also be
    // covered here, so the two guards together leave no gap between them.
    const anonNonOperator = ROUTE_FILES.filter((f) => {
      const src = readFileSync(join(process.cwd(), f), "utf8")
      if (isOperatorSurface(f, src)) return false
      const url =
        "/" +
        f
          .replace(/^app\//, "")
          .replace(/\/route\.tsx?$/, "")
          .replace(/\/\([^)]*\)/g, "")
          .replace(/\[\.\.\.([^\]]+)\]/g, "$1")
          .replace(/\[([^\]]+)\]/g, "$1")
      return isPublicPath(url, "GET") || isPublicPath(url, "POST")
    })
    const missing = anonNonOperator.filter((f) => !USER_REACHABLE.includes(f))
    expect(missing).toEqual([])
  })
})
