import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// 2026-09-25 — the set page gained a "Recent Sales" panel (get_set_activity,
// the team function's shape keyed on the set). TeamActivity's empty copy
// CONCLUDES ("No recent sales."), so the read must be THREE-STATE end to end:
// fetched through sectionRowsResult (never sectionRows, which degrades a failed
// read to [] and would publish that sentence out of an outage), its `ok` passed
// to the component, the section shown on rows OR on failure, and Pinnacle — whose
// sales live elsewhere — never asked, so it can never be told "no recent sales".

const src = stripComments(readFileSync(join(process.cwd(), "app", "(collections)", "[collection]", "set", "[slug]", "page.tsx"), "utf8"))

describe("set page — Recent Sales is three-state", () => {
  it("reads get_set_activity through sectionRowsResult, not sectionRows", () => {
    expect(src).toMatch(/sectionRowsResult<ActivityRow>\("set activity", "get_set_activity"/)
    expect(src).not.toMatch(/sectionRows<ActivityRow>\([^)]*get_set_activity/)
  })
  it("passes the read's ok to TeamActivity and shows the section on rows OR failure", () => {
    expect(src).toMatch(/<TeamActivity collectionUrlSlug=\{collection\} rows=\{activityRes\.rows\} ok=\{activityRes\.ok\} \/>/)
    expect(src).toMatch(/activityRes\.rows\.length > 0 \|\| !activityRes\.ok/)
  })
  it("never asks for Pinnacle (its sales are not in `sales`), and reads it as a clean empty", () => {
    expect(src).toMatch(/const wantsActivity = !isPinnacleUrlSlug\(collection\)/)
    expect(src).toMatch(/wantsActivity \? fetchActivity\(coll\.id, slug, 20\) : Promise\.resolve\(\{ rows: \[\], ok: true \}\)/)
    expect(src).toMatch(/\{wantsActivity && \(activityRes\.rows\.length > 0 \|\| !activityRes\.ok\) && \(/)
  })
  it("the migration exists, is service_role-only, and floors the wide path to a year", () => {
    const mig = readFileSync(join(process.cwd(), "supabase", "migrations", "20260925093248_audit_20260925_get_set_activity_the_set_pages_recent_sales_panel.sql"), "utf8")
    expect(mig).toMatch(/REVOKE ALL ON FUNCTION public\.get_set_activity\(uuid, text, integer, integer\) FROM PUBLIC, anon, authenticated;/)
    expect(mig).toMatch(/s\.sold_at >= now\(\) - interval '365 days'/)
  })
})
