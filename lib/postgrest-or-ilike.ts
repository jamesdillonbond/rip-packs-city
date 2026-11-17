// lib/postgrest-or-ilike.ts
//
// Build a PostgREST `or()` filter string that substring-matches ANY of `values` on `column`
// (2026-11-14, the market's multi-set filter). PostgREST's or() grammar reserves `,` `.` `:` `(`
// `)`; a value carrying them must be double-quoted, with `"` and `\` backslash-escaped inside the
// quotes. Set names do carry them ("Me, Myself, and I"). `*` is PostgREST's like-wildcard inside
// or(). `%` / `_` in a value still act as wildcards — an OVER-match, which callers settle with an
// exact check after the read; never an under-match.
export function postgrestOrIlike(column: string, values: readonly string[]): string {
  return values
    .map((v) => `${column}.ilike."*${v.replace(/["\\]/g, (m) => "\\" + m)}*"`)
    .join(",")
}
