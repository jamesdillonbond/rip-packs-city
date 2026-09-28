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
  // 2026-09-28 — the wide path streamed the collection's sold_at index until it
  // had a window, so a sparse wide set (77 sales in a year against 1.1M) walked
  // the whole year and timed out. The replacement bounds that pass and falls back
  // to a per-edition window that keeps the year floor as an index bound.
  it("the wide path's pass over the collection is bounded, and a sparse set falls back per edition", () => {
    const mig = readFileSync(join(process.cwd(), "supabase", "migrations", "20260928143942_audit_20260928_get_set_activity_sparse_wide_set_per_edition_path.sql"), "utf8")
    expect(mig).toMatch(/ORDER BY s\.sold_at DESC\s+LIMIT 5000\s+\) p\s+WHERE \(p\.s\)\.edition_id = ANY\(v_edition_ids\)\s+LIMIT v_window/)
    expect(mig).toMatch(/IF v_year_rows < 5000 THEN\s+v_mode := 'head';\s+ELSE\s+v_mode := 'per_edition_year';/)
    expect(mig).toMatch(/AND s\.edition_id = ed\.id\s+AND s\.sold_at >= CASE WHEN v_mode = 'per_edition_year'\s+THEN now\(\) - interval '365 days'/)
    // no unbounded collection stream is left: every sales scan keyed only on the
    // collection carries LIMIT 5000
    const collectionScans = mig.match(/WHERE s\.collection_id = p_collection_id\s+AND s\.sold_at >= now\(\) - interval '365 days'\s+(ORDER BY s\.sold_at DESC\s+)?LIMIT (\d+)/g) ?? []
    expect(collectionScans).toHaveLength(2)
    expect(mig).not.toMatch(/AND s\.sold_at >= now\(\) - interval '365 days'\s+AND s\.edition_id = ANY\(v_edition_ids\)/)
    expect(mig).toMatch(/REVOKE ALL ON FUNCTION public\.get_set_activity\(uuid, text, integer, integer\) FROM PUBLIC, anon, authenticated;/)
    expect(mig).toMatch(/GRANT EXECUTE ON FUNCTION public\.get_set_activity\(uuid, text, integer, integer\) TO service_role;/)
  })
})
