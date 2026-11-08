// 2026-11-07: the extra-case cap is enforced by a BEFORE INSERT trigger as well
// as the route's count (a double-click could pass the count twice). The trigger
// hardcodes the limit, so it must equal MAX_EXTRA_CASES.
import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { MAX_EXTRA_CASES } from "@/lib/trophy/cases"

const file = readdirSync("supabase/migrations").find((f) => f.endsWith("_audit_20261107_trophy_cases_extra_cap_enforced_in_db.sql"))

describe("trophy-case cap in the database", () => {
  it("the migration exists", () => {
    expect(file).toBeTruthy()
  })
  it("its limit equals MAX_EXTRA_CASES and it serialises per user", () => {
    const sql = readFileSync(`supabase/migrations/${file}`, "utf8")
    const m = sql.match(/IF n >= (\d+) THEN/)
    expect(Number(m?.[1])).toBe(MAX_EXTRA_CASES)
    expect(sql).toMatch(/pg_advisory_xact_lock\(hashtextextended\('trophy_cases:' \|\| NEW\.user_id::text/)
    expect(sql).toMatch(/BEFORE INSERT ON public\.trophy_cases/)
  })
  it("the route maps the trigger's refusal to 409", () => {
    const src = readFileSync("app/api/profile/trophy-cases/route.ts", "utf8")
    expect(src).toContain('"23514"')
    expect(src).toContain("trophy_case_cap_reached")
  })
})
