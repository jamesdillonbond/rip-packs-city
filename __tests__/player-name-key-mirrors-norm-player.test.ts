import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { playerNameKey } from "@/lib/filter-match"

// lib/filter-match.ts playerNameKey claims to MIRROR Postgres public._norm_player
// (#221: the collection dropdown and client filter collapse on it; the server filter
// in get_wallet_moments_with_fmv matches with _norm_player). A header claiming to
// mirror another implementation is an untested claim until diffed against it, so this
// replays every expectation the SQL pin asserts for _norm_player against the TS key.
const pin = readFileSync("supabase/tests/norm_player.sql", "utf8")
const cases = Array.from(pin.matchAll(/_assert_eq\(_norm_player\(('(?:[^']|'')*'|NULL)\),\s*'((?:[^']|'')*)'/g)).map((m) => ({
  input: m[1] === "NULL" ? null : m[1].slice(1, -1).replace(/''/g, "'"),
  want: m[2].replace(/''/g, "'"),
}))

describe("playerNameKey mirrors _norm_player", () => {
  it("reads a real population of cases from the SQL pin", () => {
    expect(cases.length).toBeGreaterThanOrEqual(6)
  })
  it.each(cases)("$input → $want", ({ input, want }) => {
    expect(playerNameKey(input)).toBe(want)
  })
})
