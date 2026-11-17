// `ilike` as a case-insensitive EQUALITY (2026-11-14, account review).
//
// PostgREST's ilike pattern treats `%` / `*` (any run) and `_` (any one character) as wildcards,
// and handles may contain `_`. Unescaped, `/profile/a_c` rendered collector "abc"'s profile, two
// matching handles made `maybeSingle()` error (a persistent 500 for one user), and an email with
// `_` could resolve to ANOTHER member's allow_list row. Every username / email lookup goes
// through this.
export function ilikeLiteral(s: string): string {
  return s.replace(/[\\%_*]/g, (c) => "\\" + c)
}
