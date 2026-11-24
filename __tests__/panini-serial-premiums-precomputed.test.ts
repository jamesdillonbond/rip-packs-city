// 2026-11-23 — panini_serial_premiums re-aggregated 90 days of panini_sales on every read (pgss: 1,822 calls,
// mean 5.2 s, ~14k disk blocks/call) for 583 rows. 20261124051857 moved the body into mv_panini_serial_premiums
// (hourly) and left the view as a thin read over it. This pins that the NEWEST definition of the view is the thin
// one, so a later CREATE OR REPLACE that pastes the aggregate back in reds here, not in pg_stat_statements.
import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const dir = join(process.cwd(), "supabase/migrations")
const sqlOf = (f: string) =>
  readFileSync(join(dir, f), "utf8")
    .split("\n")
    .filter((l) => !/^\s*--/.test(l))
    .join("\n")

const VIEW_RE = /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+public\.panini_serial_premiums\b[\s\S]*?;/gi

function newestViewBody(): { file: string; body: string } {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()
  let found: { file: string; body: string } | null = null
  for (const f of files) {
    const m = sqlOf(f).match(VIEW_RE)
    if (m) found = { file: f, body: m[m.length - 1] }
  }
  if (!found) throw new Error("no migration defines public.panini_serial_premiums")
  return found
}

describe("panini_serial_premiums reads the precomputed matview", () => {
  const { file, body } = newestViewBody()
  it("the newest definition is the 11-23 thin view", () => {
    expect(file).toMatch(/panini_serial_premiums_precomputed/)
  })
  it("selects from mv_panini_serial_premiums and never re-aggregates panini_sales", () => {
    expect(body).toMatch(/FROM\s+public\.mv_panini_serial_premiums/i)
    expect(body).not.toMatch(/panini_sales/i)
    expect(body).not.toMatch(/percentile_cont/i)
  })
  it("keeps security_invoker on the view", () => {
    expect(body).toMatch(/security_invoker\s*=\s*on/i)
  })
  it("the matview has a refresher on a schedule", () => {
    const sql = sqlOf(file)
    expect(sql).toMatch(/REFRESH MATERIALIZED VIEW CONCURRENTLY public\.mv_panini_serial_premiums/)
    expect(sql).toMatch(/cron\.schedule\('panini-serial-premiums'/)
    expect(sql).toMatch(/CREATE UNIQUE INDEX mv_panini_serial_premiums_pk/)
  })
})
