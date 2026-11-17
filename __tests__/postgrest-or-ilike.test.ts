import { describe, it, expect } from "vitest"
import { postgrestOrIlike } from "@/lib/postgrest-or-ilike"

// 2026-11-14: the market's multi-set filter narrows in the DB with this string. Unquoted, a set
// name with a comma ("Me, Myself, and I") would split into broken or() terms.
describe("postgrestOrIlike", () => {
  it("double-quotes every value so commas and parentheses stay inside it", () => {
    expect(postgrestOrIlike("set_name", ["Me, Myself, and I", "Base (Gold)"])).toBe(
      'set_name.ilike."*Me, Myself, and I*",set_name.ilike."*Base (Gold)*"',
    )
  })
  it("backslash-escapes a double quote and a backslash inside a value", () => {
    expect(postgrestOrIlike("set_name", ['Say "Hi"', "a\\b"])).toBe(
      'set_name.ilike."*Say \\"Hi\\"*",set_name.ilike."*a\\\\b*"',
    )
  })
})
