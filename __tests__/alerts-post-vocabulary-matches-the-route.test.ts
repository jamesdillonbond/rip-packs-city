import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { walkSourceFiles, repoRelative } from "./helpers/source-files"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// Every client that POSTs to /api/alerts must send an alert_type the route
// accepts. Until 2026-10-09 two did not: the collection table's bell sent
// "below_price" and /dashboard/alerts sent "below_price" / "below_fmv_pct" —
// the route's ALERT_TYPES check 400'd every one, so neither surface ever
// created an alert ("Failed to set alert" on every click).
//
// Derived from the route source (a route file cannot export a constant), and
// from a tree walk of the files that call it — not a curated list.

const ROUTE = "app/api/alerts/route.ts"

function routeAlertTypes(): string[] {
  const m = readFileSync(ROUTE, "utf8").match(/const ALERT_TYPES = \[([^\]]+)\]/)
  if (!m) throw new Error("ALERT_TYPES not found in " + ROUTE)
  return [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1])
}

function postingFiles(): string[] {
  return ["app", "components", "lib"]
    .flatMap((root) => walkSourceFiles(root, (n) => /\.tsx?$/.test(n)))
    .map(repoRelative)
    .filter((f) => f !== ROUTE)
    .filter((f) => {
      const src = readFileSync(f, "utf8")
      return /fetch\(\s*["'`]\/api\/alerts["'`]/.test(src) && /method:\s*["']POST["']/.test(src)
    })
}

describe("POST /api/alerts — every caller speaks the route's vocabulary", () => {
  const types = routeAlertTypes()

  it("reads the route's ALERT_TYPES", () => {
    expect(types).toEqual(["price_below", "fmv_below", "fmv_above", "discount_above"])
  })

  const files = postingFiles()
  it("finds the POSTing clients (not vacuous)", () => {
    expect(files).toEqual(
      expect.arrayContaining([
        "components/collection/CollectionMomentTable.tsx",
        "app/dashboard/alerts/DashboardAlertsClient.tsx",
      ]),
    )
  })

  for (const f of files) {
    it(`${f} sends only accepted alert_type literals`, () => {
      const src = stripComments(readFileSync(f, "utf8"))
      for (const m of src.matchAll(/alert_type:\s*"([a-z_]+)"/g)) expect(types).toContain(m[1])
      // the two legacy spellings the route rejects
      expect(src).not.toMatch(/"below_price"|"below_fmv_pct"/)
    })
  }

  it("the collection table's bell scopes the alert to its collection", () => {
    const src = stripComments(readFileSync("components/collection/CollectionMomentTable.tsx", "utf8"))
    const i = src.indexOf('fetch("/api/alerts"')
    expect(i).toBeGreaterThan(-1)
    // without collection_id the route defaults to Top Shot, so an All Day bell
    // created an alert on the Top Shot edition with the same key
    expect(src.slice(i, src.indexOf("})", i))).toMatch(/collection_id:/)
  })
})
