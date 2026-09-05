// __tests__/strip-sql-shared-helper.test.ts
//
// `scripts/lib/strip-sql.mjs` is the SQL counterpart of the shared JS/TS
// stripper, written on 2026-09-05 so the three migration guards that had each
// rolled their own could stop.
//
// 🚨 THIS FILE EXISTS BECAUSE A STRIPPER THAT IS BLIND STILL PASSES AND STILL
// REPORTS A POPULATION. CLAUDE.md records the shared JS stripper being trusted
// blind three separate times — "USING it is not a guarantee it stripped". A
// stripper's failure mode is silent by construction: it returns a string, the
// caller greps it, finds nothing, and reports a clean population that is clean
// only because the source was hidden. So every case below asserts what SURVIVED,
// not merely that something was removed.
//
// ⭐ THE HEADLINE CASE IS NOT SYNTHETIC. `20260811003456_…board_liveness_history
// _decoupled_capture.sql` contains, on line 26:
//
//     RAISE EXCEPTION 'public_board_liveness_state is absent -- refusing to
//                      build history for a table that does not exist';
//
// The RLS guard's old stripper blanked `--` comments BEFORE pairing quotes, so
// that `--` ate the literal's own closing quote. The now-unpaired opening quote
// then paired with the next apostrophe in the file — `interval '90 days'`, 47
// lines later — and everything between them was blanked as "string content",
// including the file's real `CREATE TABLE public.public_board_liveness_history`
// AND its `ENABLE ROW LEVEL SECURITY`. A guard whose entire job is to notice a
// new public table could not see one, in a file named after it, and was green.

import { describe, expect, it } from "vitest"
import { stripSql } from "../scripts/lib/strip-sql.mjs"

const strip = stripSql as (sql: string, options?: { literals?: boolean }) => string

describe("stripSql blanks commentary without moving a character", () => {
  it("OFFSETS ARE PRESERVED — output length and line count are identical", () => {
    // Load-bearing, not tidiness: `migration-new-function-states-its-anon-exec-
    // decision` matches `REVOKE[\s\S]{0,200}?…public.<fn>\s*\(`, a BOUNDED
    // window. A stripper that collapsed a 300-char comment to one space would
    // pull a REVOKE and a function name inside a window they were never within,
    // and the guard would vouch for a decision the file does not state.
    const sql = "CREATE TABLE t(); /* a fairly long comment here */\n-- another\nSELECT 1;\n"
    const out = strip(sql)
    expect(out.length).toBe(sql.length)
    expect(out.split("\n").length).toBe(sql.split("\n").length)
  })

  it("blanks line and block comments but keeps the code around them", () => {
    const out = strip("SELECT 1; -- drop table users\n/* CREATE VIEW v */ SELECT 2;")
    expect(out).not.toContain("drop table users")
    expect(out).not.toContain("CREATE VIEW")
    expect(out).toContain("SELECT 1;")
    expect(out).toContain("SELECT 2;")
  })

  it("🚨 REGRESSION — a `--` INSIDE a literal does not eat the literal's closing quote", () => {
    // The real defect, reduced. The old chained-regex stripper blanked the
    // comment first, unpairing the quote, and then swallowed the CREATE TABLE.
    const sql = [
      "RAISE EXCEPTION 'state is absent -- refusing to build';",
      "CREATE TABLE IF NOT EXISTS public.board_liveness_history (id int);",
      "SELECT 1 WHERE x < now() - interval '90 days';",
    ].join("\n")

    const out = strip(sql, { literals: true })

    // The CREATE TABLE is code and MUST survive. This is the assertion the old
    // implementation failed.
    expect(out).toContain("CREATE TABLE IF NOT EXISTS public.board_liveness_history")
    // The literal's content is blanked, its delimiters kept.
    expect(out).not.toContain("refusing to build")
    expect(out).not.toContain("90 days")
    // The delimiters survive in place (offsets preserved), content blanked.
    expect(out).toMatch(/RAISE EXCEPTION ' +';/)
  })

  it("an apostrophe inside a COMMENT does not open a literal", () => {
    // The mirror-image failure: literal-first ordering. `edition's` opens a
    // string that runs to the next quote anywhere later in the file.
    const sql = ["-- the edition's display name", "CREATE TABLE public.wanted (id int);", "SELECT 'x';"].join("\n")
    const out = strip(sql, { literals: true })
    expect(out).toContain("CREATE TABLE public.wanted")
  })

  it("NESTED block comments close at the OUTER `*/`, not the first one", () => {
    // A non-greedy regex closes at the first `*/` and hands `CREATE TABLE …` back
    // as live code — a commented-out block read as a declaration.
    const out = strip("/* outer /* inner */ CREATE TABLE public.ghost (id int); */ SELECT 1;")
    expect(out).not.toContain("CREATE TABLE")
    expect(out).toContain("SELECT 1;")
  })

  it("CRLF — a line comment ends at the carriage return, not at the next `\\n`", () => {
    // A JS `.` does not match `\r`, so a `--.*$` strip silently no-ops on CRLF
    // and every comment stays visible. Recorded in CLAUDE.md; pinned here.
    const out = strip("-- hidden\r\nCREATE TABLE public.visible (id int);\r\n")
    expect(out).not.toContain("hidden")
    expect(out).toContain("CREATE TABLE public.visible")
  })

  it("keeps literal CONTENT by default and blanks it only under { literals: true }", () => {
    // The two callers genuinely differ: the anon-exec and view guards want the
    // literal text, the RLS guard must not read `format('CREATE TABLE …')` as a
    // declaration. A single default would have been wrong for one of them.
    const sql = "SELECT format('CREATE TABLE IF NOT EXISTS public.%I', n);"
    expect(strip(sql)).toContain("CREATE TABLE IF NOT EXISTS")
    expect(strip(sql, { literals: true })).not.toContain("CREATE TABLE IF NOT EXISTS")
  })

  it("`''` is an escaped quote, not the end of the literal", () => {
    const out = strip("SELECT 'it''s here' AS x; CREATE TABLE public.after (id int);", { literals: true })
    expect(out).not.toContain("here")
    expect(out).toContain("CREATE TABLE public.after")
  })

  it("a dollar-quoted body is stripped as SQL, not hidden", () => {
    // Deliberate: the RLS guard's own header is written around `CREATE TEMP
    // TABLE _rwfc_recent` appearing INSIDE a function body. Hiding bodies would
    // silently shrink every one of these guards' populations.
    const sql = ["CREATE FUNCTION public.f() RETURNS void AS $fn$", "BEGIN", "  -- hidden note", "  CREATE TEMP TABLE _scratch AS SELECT 1;", "END", "$fn$;"].join("\n")
    const out = strip(sql)
    expect(out).toContain("CREATE TEMP TABLE _scratch")
    expect(out).not.toContain("hidden note")
  })

  it("an apostrophe inside a dollar-quoted body cannot open a phantom literal", () => {
    const sql = ["SELECT $$it's fine$$;", "CREATE TABLE public.still_seen (id int);", "SELECT 'z';"].join("\n")
    expect(strip(sql, { literals: true })).toContain("CREATE TABLE public.still_seen")
  })

  it("a double-quoted identifier is never blanked, even under { literals: true }", () => {
    // A quoted identifier is the very thing these guards match on.
    const out = strip('CREATE TABLE "myTable" (id int);', { literals: true })
    expect(out).toContain('"myTable"')
  })

  it("an UNTERMINATED dollar tag does not swallow the rest of the file", () => {
    // A broken file must degrade to "treat it as text", never to "hide
    // everything after it" — the latter is a silent population shrink.
    const out = strip("SELECT $$ oops;\nCREATE TABLE public.tail (id int);")
    expect(out).toContain("CREATE TABLE public.tail")
  })

  it("NEGATIVE CONTROL — a `$1` parameter is not read as a dollar quote", () => {
    const out = strip("SELECT * FROM t WHERE id = $1 AND b = $2;")
    expect(out).toBe("SELECT * FROM t WHERE id = $1 AND b = $2;")
  })

  it("NEGATIVE CONTROL — SQL containing no commentary is returned byte-identical", () => {
    // Without this, a stripper that blanked EVERYTHING would pass every case
    // above, since they all assert on absence.
    const sql = "CREATE TABLE public.t (id int);\nALTER TABLE public.t ENABLE ROW LEVEL SECURITY;\n"
    expect(strip(sql)).toBe(sql)
    expect(strip(sql, { literals: true })).toBe(sql)
  })
})
