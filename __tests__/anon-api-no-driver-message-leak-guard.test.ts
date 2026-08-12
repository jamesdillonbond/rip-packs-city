import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { isPublicPath } from "@/proxy"

// Source guard: no route that ANONYMOUS visitors can reach may publish a driver
// message.
//
// WHY THIS EXISTS, AND WHY IT DERIVES ITS OWN FILE LIST.
//
// This defect has now been "fixed" four times, and every fix was filed with the
// scope of wherever someone happened to be looking:
//
//   deep-audit D3  →  /api/sets alone (the Set Tracker rendered
//                     "canceling statement due to statement timeout" under an
//                     ERROR heading to anonymous visitors)
//   2026-08-11     →  six /api/public/insights routes...
//   ...same day    →  ...which turned out to be all 29 of them
//   2026-08-12     →  43 more sites across 33 files, on the routes proxy.ts lets
//                     anon reach OUTSIDE /api/public
//
// A hand-maintained list of routes cannot catch the route nobody thought to add,
// so this test does not keep one. It EXECUTES the real security wall —
// `isPublicPath` from proxy.ts, the same function that decides this at runtime —
// over every route file on disk, and asserts the property on whatever comes back
// true. Widen the public surface in proxy.ts and this guard widens with it, in
// the same commit.
//
// THE REMEDY when this fails: `apiErrorResponse(err, "api/<route>")` from
// lib/api-error.ts (or `boardUnavailable` under /api/public/insights, which is a
// thin alias of it). It classifies server-side, logs the detail, and returns
// stable copy + a code — plus `no-store` so a transient 503 is not edge-cached
// into a sustained outage, and `Retry-After` when retrying is reasonable.
//
// ⚠ This must be a SOURCE test. No type forbids the defect: a string in a
// response body type-checks perfectly, so `tsc` can never catch a regression,
// and the response is a 200-family JSON body that no 5xx metric will flag.

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name === "route.ts" || name === "route.tsx") out.push(p)
  }
  return out
}

/** app/api/moment/[id]/route.ts -> /api/moment/id (route groups stripped). */
function urlFor(file: string): string {
  return (
    "/" +
    file
      .replace(/\\/g, "/")
      .replace(/^app\//, "")
      .replace(/\/route\.tsx?$/, "")
      .replace(/\/\([^)]*\)/g, "")
      .replace(/\[\.\.\.([^\]]+)\]/g, "$1")
      .replace(/\[([^\]]+)\]/g, "$1")
  )
}

/**
 * Spellings the leak has actually taken in this repo. All four were found in
 * production code; a grep for any ONE of them finds well under half the class,
 * which is why they are enumerated rather than approximated.
 */
function leakSites(src: string): string[] {
  const hits: string[] = []
  const lines = src.split("\n")

  // (1) `error: err.message` — and the `message:` / `details:` variants.
  //     `result.message` and friends are DOMAIN values from our own helpers
  //     (the concierge's tool payloads), not driver text.
  const direct =
    /\b(?:error|details|message)\s*:\s*(?!result\.|item\.|row\.|payload\.)[A-Za-z_$][\w$]*(?:\?\.)?\.message\b/
  // (2) `error: String(err)` — stringifying the caught value.
  const stringified = /\berror\s*:\s*String\(\s*(?:err|e|error|ex|caught)\b/
  // (3) template interpolation of a caught value into the body.
  const interpolated = /\berror\s*:\s*`[^`]*\$\{\s*(?:err|e|ex|caught)(?:\?\.)?\.message/

  // (4b) The INLINE ternary, written straight into the response body:
  //       `{ error: err instanceof Error ? err.message : "Unknown error" }`
  //   Distinct from (4): there is no intermediate variable, so the indirect
  //   scan below never sees it, and `direct` does not match because `error:` is
  //   followed by an identifier + `instanceof`, not by `<id>.message`. The
  //   sibling public-insights guard has always carried this shape; it was the
  //   one spelling this guard did not inherit, and 7 anon-reachable routes were
  //   still publishing through it.
  const inlineTernary = /\berror\s*:\s*[A-Za-z_$][\w$]*\s+instanceof\s+Error\s*\?\s*[A-Za-z_$][\w$]*(?:\?\.)?\.message/

  // (4) The indirect form: `const msg = e instanceof Error ? e.message : ...`
  //     then `{ error: msg }` further down. Collect the variable names first.
  const indirect = new Set<string>()
  for (const m of src.matchAll(
    /const\s+([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\s+instanceof\s+Error\s*\?\s*[A-Za-z_$][\w$]*\.message/g
  )) {
    indirect.add(m[1])
  }
  const indirectRx = indirect.size
    ? new RegExp(`\\berror\\s*:\\s*(?:${[...indirect].join("|")})\\b`)
    : null

  lines.forEach((line, i) => {
    if (
      direct.test(line) ||
      stringified.test(line) ||
      interpolated.test(line) ||
      inlineTernary.test(line) ||
      (indirectRx && indirectRx.test(line))
    ) {
      hits.push(`${i + 1}: ${line.trim()}`)
    }
  })
  return hits
}

const ROUTE_FILES = walk(join(process.cwd(), "app", "api")).map((p) =>
  p.slice(process.cwd().length + 1).replace(/\\/g, "/")
)

/**
 * /api/admin/** and /api/cron/** ARE returned public by isPublicPath, but only
 * so that the proxy steps out of the way and the route's OWN bearer-secret check
 * can be the gate (see proxy.ts step 2). An unauthenticated caller is turned away
 * before the query runs, so a driver message there reaches an operator, not the
 * public. They are excluded — but the exclusion is itself asserted below, so it
 * cannot quietly come to cover an UNGATED admin route.
 */
const SECRET_GATED_PREFIXES = ["app/api/admin/", "app/api/cron/"]

const ANON_ROUTES = ROUTE_FILES.filter((f) => {
  if (SECRET_GATED_PREFIXES.some((p) => f.startsWith(p))) return false
  const url = urlFor(f)
  // GET is the read surface that matters here; the POST-body read-computes
  // (/api/fmv, /api/pack-ev, ...) are covered by the POST arm.
  return isPublicPath(url, "GET") || isPublicPath(url, "POST")
})

describe("anon-reachable API routes never publish a driver message", () => {
  it("derives a non-trivial route set from the real proxy.ts wall", () => {
    // A sanity floor: if a refactor breaks urlFor() or the proxy import, this
    // guard would silently pass over an EMPTY set and assert nothing. That is
    // the failure mode that made an earlier version of a sibling guard useless.
    expect(ROUTE_FILES.length).toBeGreaterThan(300)
    expect(ANON_ROUTES.length).toBeGreaterThan(100)
    // Spot-anchor a few known-public routes so the filter cannot quietly narrow.
    for (const anchor of [
      "app/api/market/route.ts",
      "app/api/sets/route.ts",
      "app/api/entity/edition/route.ts",
      "app/api/fmv/route.ts",
    ]) {
      expect(ANON_ROUTES, `${anchor} must be in the anon set`).toContain(anchor)
    }
  })

  it("every excluded admin/cron route really does gate itself on a secret", () => {
    // The exclusion above is only sound while these routes actually check a
    // bearer secret themselves. If one stops, it becomes a genuinely anon
    // surface that this guard is skipping — the worst possible combination.
    const ungated: string[] = []
    for (const f of ROUTE_FILES) {
      if (!SECRET_GATED_PREFIXES.some((p) => f.startsWith(p))) continue
      const url = urlFor(f)
      if (!isPublicPath(url, "GET") && !isPublicPath(url, "POST")) continue
      const src = readFileSync(join(process.cwd(), f), "utf8")
      // Either an inline secret check, or delegation to one of the shared
      // gate helpers — lib/admin-auth's verifyAdminRequest (Bearer
      // RPC_ADMIN_TOKEN, deny-by-default) or lib/studio-sales-history's
      // runStudioHistoryDrain (Bearer INGEST_SECRET_TOKEN | CRON_SECRET, 401).
      // Both were verified to 401 an unauthenticated caller when this list was
      // written; a route delegating elsewhere must be added deliberately.
      const gated =
        /RPC_ADMIN_TOKEN|INGEST_SECRET_TOKEN|CRON_SECRET|ADMIN_API_KEY|requireUser|getCurrentUser|requireAdmin|assertAdmin|verifyAdminRequest|runStudioHistoryDrain/.test(
          src
        )
      if (!gated) ungated.push(f)
    }
    expect(
      ungated,
      "These routes bypass the proxy AND have no in-route secret/session check, " +
        "so they are anonymously callable: " + ungated.join(", ")
    ).toEqual([])
  })

  it("no anon-reachable route returns a driver message in its body", () => {
    const offenders: string[] = []
    for (const f of ANON_ROUTES) {
      const hits = leakSites(readFileSync(join(process.cwd(), f), "utf8"))
      if (hits.length) offenders.push(`${f}\n    ${hits.join("\n    ")}`)
    }
    expect(
      offenders,
      "These routes are reachable by ANONYMOUS visitors and put the database's own " +
        "text in the response body (and, at a bare 500, in the hard-5xx budget). " +
        'Replace with `apiErrorResponse(err, "api/<route>")` from lib/api-error.ts.\n\n' +
        offenders.join("\n\n")
    ).toEqual([])
  })
})
