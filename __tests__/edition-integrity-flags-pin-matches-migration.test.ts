import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

/**
 * supabase/tests/v_edition_integrity_flags_tier_absent_at_source.sql asserts the integrity view's tier arm
 * (2026-11-09: a hydrated Candy edition whose key proves the source had no Rarity is counted apart; a
 * fabricated or unmapped-rarity edition stays a defect). Those assertions prove the PRODUCTION view only if the
 * pin's DDL IS the migration's — the function drift guard covers functions, not views — so this diffs the view
 * body itself. A later redefinition must move both together.
 */
const ROOT = join(__dirname, "..")
const START = "CREATE OR REPLACE VIEW public.v_edition_integrity_flags WITH (security_invoker = on) AS"
const END = "ORDER BY collection;"

function body(text: string): string {
  const i = text.indexOf(START)
  const j = i < 0 ? -1 : text.indexOf(END, i)
  return i < 0 || j < 0 ? "" : text.slice(i, j + END.length).replace(/\s+/g, " ").trim()
}

describe("v_edition_integrity_flags pin", () => {
  const migs = readdirSync(join(ROOT, "supabase/migrations"))
    .filter((f) => f.endsWith(".sql") && body(readFileSync(join(ROOT, "supabase/migrations", f), "utf8")))
    .sort()
  it("the NEWEST migration defining the view is the one this pin tracks", () => {
    expect(migs.at(-1)).toMatch(/_audit_20261112_candy_native_rarity_label_and_open_editions_absent_at_source\.sql$/)
  })
  it("the pin's view DDL is the migration's, whitespace-normalised", () => {
    const mig = body(readFileSync(join(ROOT, "supabase/migrations", migs.at(-1)!), "utf8"))
    const pin = body(readFileSync(join(ROOT, "supabase/tests/v_edition_integrity_flags_tier_absent_at_source.sql"), "utf8"))
    expect(mig.length).toBeGreaterThan(1000)
    expect(pin).toBe(mig)
    // security_invoker must survive the CREATE OR REPLACE (it resets reloptions otherwise)
    expect(mig).toContain("WITH (security_invoker = on)")
  })
})
