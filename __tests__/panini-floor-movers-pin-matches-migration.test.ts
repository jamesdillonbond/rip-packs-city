import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

/**
 * supabase/tests/mv_panini_floor_movers.sql asserts the floor-movers MV's exclusions (left the board, under $5,
 * unchanged, aged-out rise, no base) and its window flag. Those assertions prove the PRODUCTION view only if the
 * pin's DDL IS the migration's — the function drift guard covers functions, not materialized views, so this one
 * diffs the view body itself. Re-pin both together.
 */
const ROOT = join(__dirname, "..")
const START = "CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_panini_floor_movers AS"
const END = "WITH NO DATA;"

function body(text: string): string {
  const i = text.indexOf(START)
  const j = i < 0 ? -1 : text.indexOf(END, i)
  return i < 0 || j < 0 ? "" : text.slice(i, j + END.length).replace(/\s+/g, " ").trim()
}

describe("mv_panini_floor_movers pin", () => {
  const migs = readdirSync(join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql") && body(readFileSync(join(ROOT, "supabase/migrations", f), "utf8")))
  it("exactly one migration defines the view (a redefinition must move this test's pointer)", () => {
    expect(migs).toEqual(["20261104182819_audit_20261104_panini_floor_movers.sql"])
  })
  it("the pin's view DDL is the migration's, whitespace-normalised", () => {
    const mig = body(readFileSync(join(ROOT, "supabase/migrations", migs[0]), "utf8"))
    const pin = body(readFileSync(join(ROOT, "supabase/tests/mv_panini_floor_movers.sql"), "utf8"))
    expect(mig.length).toBeGreaterThan(500)
    expect(pin).toBe(mig)
  })
})
