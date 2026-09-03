import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "fs"
import path from "path"

// BAN AT ZERO — every read of the `fmv_current` VIEW must carry an `edition_id`
// qual.
//
// `fmv_current` is `SELECT DISTINCT ON (edition_id) … FROM fmv_snapshots ORDER BY
// edition_id, computed_at DESC`. A qual on `edition_id` becomes an index
// condition on the partitioned `fmv_snapshots_<year>_edition_id_computed_at_*`
// indexes. A qual on ANY OTHER column — or on a column of an embedded table —
// cannot, so Postgres builds the entire DISTINCT ON (1.39M rows → 27k) and
// filters afterwards. There is nothing to notice at runtime: the answer is
// correct, and only the buffer count says anything happened.
//
// Both live instances were found on 2026-09-02, AFTER a sweep the same day had
// cleared the app layer as "clean":
//
//   /api/overview-stats     count .eq(collection_id).eq(confidence)
//                           1,331,923 buffers / 14,085 ms   →  edition_fmv_current, 909 / 39 ms
//   /api/support-chat       .select("… editions!inner(external_id)").eq("editions.external_id", k)
//                           933,871 buffers /  1,390 ms     →  .eq("edition_id", edition.id), 6 / 0.06 ms
//
// ⚠ The second is the one a grep for `collection_id` would never have found: the
// offending column is not in the read's own table. **Assert the property the
// plan depends on — an edition_id qual is PRESENT — rather than enumerating the
// columns that are wrong.** A ban list is only ever as long as the last incident.
//
// 👉 Collection-scoped FMV has a home: `edition_fmv_current`, a real table
// refreshed hourly that carries `collection_id`. Bounded id lists have
// `get_editions_latest_fmv(uuid[])`, whose per-id LATERAL LIMIT 1 costs ~4
// buffers/edition against the view's ~70. Neither is this guard's business —
// this one only insists the view is never scanned whole.

const ROOTS = ["app", "lib"]
const READ = '.from("fmv_current")'

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

/** Every `.from("fmv_current")` call site in the tree, with the statement text
 *  that follows it. Lines that are themselves comments are skipped — one such
 *  comment (in lib/concierge/fmv-distribution.ts) exists precisely to tell the
 *  reader NOT to use the shape it names, and must not be read as a call.
 *  ⚠ Deliberately a line test, not a comment stripper: the repo's stripper has
 *  silently blanked code three times, and a check that cannot need it right is
 *  better than one that does. */
function callSites(): Array<{ file: string; line: number; stmt: string }> {
  const sites: Array<{ file: string; line: number; stmt: string }> = []
  for (const root of ROOTS) {
    for (const file of walk(path.join(process.cwd(), root))) {
      const src = readFileSync(file, "utf8")
      if (!src.includes(READ)) continue
      let i = 0
      while ((i = src.indexOf(READ, i)) !== -1) {
        const lineStart = src.lastIndexOf("\n", i) + 1
        const prefix = src.slice(lineStart, i).trim()
        if (!prefix.startsWith("//") && !prefix.startsWith("*")) {
          const seg = src.slice(i, i + 800)
          const end = seg.search(/;\s*\n/)
          sites.push({
            // ⚠ Forward slashes regardless of platform: the `startsWith("app/")`
            // and exact-path assertions below matched nothing against the
            // backslash paths `path.relative` emits on Windows (Trevor's box,
            // 2026-09-03) while CI (Linux) was green.
            file: path.relative(process.cwd(), file).split(path.sep).join("/"),
            line: src.slice(0, i).split("\n").length,
            stmt: end > 0 ? seg.slice(0, end) : seg,
          })
        }
        i += READ.length
      }
    }
  }
  return sites
}

const KEYED = /\.(eq|in)\(\s*["']edition_id["']/

describe("fmv_current is never scanned whole", () => {
  it("inspects the call sites it claims to — a walk that found nothing would pass vacuously", () => {
    // ⚠ The count is the assertion that this guard RAN. A broken walk (wrong
    // root, a rename, a bad extension filter) returns [] and every check below
    // passes over an empty set. Three guards in this repo have died that way.
    const sites = callSites()
    expect(sites.length).toBeGreaterThanOrEqual(12)
    // …and it reached both layers, not just whichever one is listed first.
    expect(sites.some((s) => s.file.startsWith("app/"))).toBe(true)
    expect(sites.some((s) => s.file.startsWith("lib/"))).toBe(true)
  })

  it("every read carries an edition_id qual", () => {
    const offenders = callSites()
      .filter((s) => !KEYED.test(s.stmt))
      .map((s) => `${s.file}:${s.line}`)
    expect(offenders).toEqual([])
  })

  it("POSITIVE CONTROL: the matcher rejects the two shapes that were live", () => {
    // Neither of these is hypothetical; both shipped and both are quoted from
    // the code as it stood on 2026-09-02.
    const collectionScoped = `.from("fmv_current")
      .select("edition_id", { count: "exact", head: true })
      .eq("collection_id", collectionId)
      .eq("confidence", "HIGH")`
    const embedFiltered = `.from("fmv_current")
      .select("fmv_usd, confidence, edition_id, editions!inner(external_id)")
      .eq("editions.external_id", editionKey)
      .limit(1)`
    expect(KEYED.test(collectionScoped)).toBe(false)
    expect(KEYED.test(embedFiltered)).toBe(false)
    // …and accepts the keyed forms, so it is not simply always-false.
    expect(KEYED.test(`.from("fmv_current").select("x").eq("edition_id", id)`)).toBe(true)
    expect(KEYED.test(`.from("fmv_current").select("x").in("edition_id", chunk)`)).toBe(true)
  })

  it("POSITIVE CONTROL: a comment naming the shape is not counted as a call", () => {
    // lib/concierge/fmv-distribution.ts carries `⛔ DO NOT put this back to
    // .from("fmv_current").in("edition_id", ids)`. It passes the rule by
    // accident today; reworded to name only the table it would FAIL one, so the
    // skip has to be real rather than incidental.
    const sites = callSites()
    expect(sites.some((s) => s.file === "lib/concierge/fmv-distribution.ts")).toBe(false)
    // and the file does contain the string, so the exclusion is doing work
    expect(readFileSync(path.join(process.cwd(), "lib/concierge/fmv-distribution.ts"), "utf8")).toContain(READ)
  })
})
