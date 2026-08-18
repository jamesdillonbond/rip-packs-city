import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { isPublicPath } from "@/proxy"
import { leakSites } from "./helpers/driver-message-leak"

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

// The leak-detection patterns live in __tests__/helpers/driver-message-leak.ts
// so this guard and its authenticated-surface sibling cannot drift apart. That
// split exists because this guard once shipped with FOUR spellings where the
// guard it replaced had FIVE, and the missing inline-ternary form was still
// live on 12 sites. Add a new spelling THERE, not here.

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

/**
 * Exported handlers declared with an EMPTY parameter list, e.g.
 * `export async function GET() {`.
 *
 * ⚠ WHY THIS EXISTS — the exclusion above is a claim about a FILE, and the
 * defect is per-HANDLER. `/api/cron/price-snapshots` gates its POST on
 * `INGEST_SECRET_TOKEN`, so the gate assertion below (a file-level grep) passed
 * on it for as long as it has existed — while its GET took no parameters at
 * all, could therefore not read a header, a cookie or a query param, and served
 * every anonymous caller. Measured 2026-08-18: FOUR such handlers under the two
 * excluded prefixes, three of them publishing `error.message` and two
 * fabricating a success out of a failed read.
 *
 * ⚠ ZERO-ARG DOES NOT IMPLY UNAUTHENTICATABLE ON ITS OWN, and assuming it does
 * is a false positive I nearly shipped: `cookies()` / `headers()` from
 * `next/headers` are ambient in the App Router, so a zero-arg handler importing
 * them CAN authenticate. The file's import list is checked too.
 */
function unauthenticatableHandlers(src: string): { name: string; body: string }[] {
  if (/from\s+["']next\/headers["']/.test(src)) return []
  const re = /^export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD)\s*\(\s*\)/gm
  const out: { name: string; body: string }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    // Slice to the next top-level `export ` (or EOF) so a leak in a NEIGHBOURING
    // authenticated handler cannot be attributed to this one.
    const rest = /^export\s/gm
    rest.lastIndex = m.index + 1
    const n = rest.exec(src)
    out.push({ name: m[1], body: src.slice(m.index, n ? n.index : src.length) })
  }
  return out
}

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

// ── THE PREFIX EXCLUSION IS PER-FILE; THE SURFACE IS PER-HANDLER ───────────
//
// The block above skips app/api/admin/** and app/api/cron/** wholesale, on the
// stated reasoning that the route's own bearer check turns an unauthenticated
// caller away before the query runs. That reasoning is sound for a handler that
// can READ the bearer. A handler declared `GET()` cannot, and `isPublicPath`
// returns true for both prefixes, so it is as anonymous as /api/market.
//
// This is the recorded "ask what a passing guard is structurally SILENT about"
// lesson, in its usual shape: the guard's own derivation fixed its blast radius,
// and the gate assertion it leans on greps the FILE, so one gated handler
// vouched for every other handler beside it.
describe("admin/cron handlers that cannot authenticate are anon surfaces too", () => {
  const gatedFiles = ROUTE_FILES.filter((f) => SECRET_GATED_PREFIXES.some((p) => f.startsWith(p)))

  it("still enumerates the excluded prefixes (not vacuously passing)", () => {
    // ⚠ Asserts on the WALK, never on how many handlers are still dirty — a
    // threshold on the dirty count goes red the moment the population reaches
    // zero, which is the goal. This must stay satisfiable at zero.
    expect(gatedFiles.length).toBeGreaterThan(80)
    const probes = gatedFiles.filter((f) => unauthenticatableHandlers(readFileSync(join(process.cwd(), f), "utf8")).length)
    // The population is real and non-empty: these handlers exist and are anon.
    // If this ever hits zero the check below is trivially true, and the honest
    // response is to delete both, not to leave a green test asserting nothing.
    expect(probes.length).toBeGreaterThan(0)
  })

  it("no unauthenticatable admin/cron handler publishes a driver message", () => {
    const offenders: string[] = []
    for (const f of gatedFiles) {
      const src = readFileSync(join(process.cwd(), f), "utf8")
      for (const h of unauthenticatableHandlers(src)) {
        const hits = leakSites(h.body)
        if (hits.length) offenders.push(`${f} -> ${h.name}()\n    ${hits.join("\n    ")}`)
      }
    }
    expect(
      offenders,
      "These handlers take no request parameter, so they cannot check the bearer " +
        "their sibling POST checks — and isPublicPath lets anyone reach them. " +
        'Use `apiErrorResponse(err, "api/<route>")` from lib/api-error.ts.\n\n' +
        offenders.join("\n\n")
    ).toEqual([])
  })
})
