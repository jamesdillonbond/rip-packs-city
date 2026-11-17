// __tests__/strip-sql-shared-helper.test.ts
//
// A SECOND, INDEPENDENTLY DERIVED SPECIFICATION of the shared SQL stripper in
// `scripts/lib/strip-sql-comments.mjs`, alongside that helper's own suite in
// `__tests__/lib-strip-sql-comments.test.ts`.
//
// ⭐ THE OVERLAP IS DELIBERATE AND IS THE POINT. On 2026-09-05 two sessions
// independently hit the same red ratchet and independently built the same tool:
// two single-pass SQL lexers, written without sight of each other, from the same
// starting note ("they come off this list when a SQL stripper exists to move them
// to"). Rather than pick one and discard the other's work, the two were compared
// as implementations — across all **909** migrations, the table set, the view set
// and the function set they derive are **byte-for-byte identical**, as is their
// output on offsets, CRLF and every edge case below. One implementation survived;
// these cases did too, because they assert things the surviving suite does not:
// the apostrophe-inside-a-COMMENT direction, CRLF line endings, an apostrophe
// inside a dollar-quoted body, an UNTERMINATED dollar tag, and the negative
// control that a stripper cannot pass by blanking everything.
//
// 🚨 THAT LAST ONE IS WHY THIS FILE IS NOT REDUNDANT. A stripper's failure mode is
// silent by construction: it returns a string, the caller greps it, finds nothing,
// and reports a clean population that is clean only because the source was hidden.
// CLAUDE.md records the JS stripper being trusted blind three separate times. Every
// case here asserts what SURVIVED, and one asserts that commentary-free SQL comes
// back BYTE-IDENTICAL — without which a stripper that blanked its entire input
// would satisfy every other assertion in this file.
//
// ⭐ THE HEADLINE CASE IS NOT SYNTHETIC. `20260811003456_…board_liveness_history
// _decoupled_capture.sql` contains, on line 26:
//
//     RAISE EXCEPTION 'public_board_liveness_state is absent -- refusing to
//                      build history for a table that does not exist';
//
// The RLS guard's old chained-regex stripper blanked `--` comments BEFORE pairing
// quotes, so that `--` ate the literal's own closing quote. The now-unpaired
// opening quote then paired with the next apostrophe in the file — `interval '90
// days'`, 47 lines later — and everything between them was blanked as "string
// content", including the file's real
// `CREATE TABLE public.public_board_liveness_history` AND its
// `ENABLE ROW LEVEL SECURITY`. A guard whose entire job is to notice a new public
// table could not see one, in a file named after it, and was green.

import { describe, expect, it } from "vitest"
import { stripSqlComments } from "../scripts/lib/strip-sql-comments.mjs"

const strip = stripSqlComments as (sql: string, options?: { blankStringLiterals?: boolean }) => string

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

  it("🚨 OFFSETS SURVIVE AN ASTRAL CHARACTER — 50 of 909 migrations contain one", () => {
    // 🚨 THIS FAILED WHEN IT WAS WRITTEN, and it is the reason a second suite was
    // worth keeping after two sessions built the same stripper. The
    // implementation used `Array.from(sql)` to build its output buffer, which
    // iterates by CODE POINT, while every index it then uses — `sql[i]`,
    // `blank(from, to)`, `sql.length` — is a UTF-16 CODE UNIT. An emoji is one
    // code point and two code units, so every one of them made the output a
    // character SHORTER than the input and slid every offset after it.
    //
    // ⛔ That silently breaks the single property callers depend on.
    // `migration-new-function-states-its-anon-exec-decision` matches
    // `REVOKE[\s\S]{0,200}?…public.<fn>\s*\(` — a BOUNDED window — so drifting
    // offsets can pull a REVOKE and a function name inside a window they were
    // never within, and the guard vouches for a decision the file never states.
    //
    // ⚠ THE EXISTING OFFSET TEST DID NOT CATCH IT BECAUSE ITS FIXTURE WAS ASCII.
    // That is the whole lesson: an offset assertion over ASCII proves nothing
    // about offsets, and this tree's migration headers are full of 🚨 and ⛔.
    const sql = "-- \u{1F6A8} alarm comment\nCREATE TABLE public.after_emoji (id int);\n"
    const out = strip(sql)
    expect(out.length).toBe(sql.length)
    expect(out).toContain("CREATE TABLE public.after_emoji")
    expect(out).not.toContain("alarm comment")
    // The emoji itself is commentary and must be gone, not half-gone: a blanked
    // surrogate PAIR is two spaces, never one space and one orphaned half.
    expect(out).not.toMatch(/[\uD800-\uDFFF]/)
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

    const out = strip(sql, { blankStringLiterals: true })

    // The CREATE TABLE is code and MUST survive. This is the assertion the old
    // implementation failed.
    expect(out).toContain("CREATE TABLE IF NOT EXISTS public.board_liveness_history")
    // The literal's content is blanked, its delimiters kept.
    expect(out).not.toContain("refusing to build")
    expect(out).not.toContain("90 days")
    // ⚠ The DELIMITERS are blanked along with the content, and that is this
    // implementation’s choice rather than a requirement: the alternative (keep the
    // quotes, blank the interior) derives an IDENTICAL table/view/function set
    // across all 909 migrations. What is NOT optional is that the literal stops
    // being greppable, which is what the two assertions above pin.
    expect(out).toMatch(/RAISE EXCEPTION +;/)
  })

  it("an apostrophe inside a COMMENT does not open a literal", () => {
    // The mirror-image failure: literal-first ordering. `edition's` opens a
    // string that runs to the next quote anywhere later in the file.
    const sql = ["-- the edition's display name", "CREATE TABLE public.wanted (id int);", "SELECT 'x';"].join("\n")
    const out = strip(sql, { blankStringLiterals: true })
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

  it("keeps literal CONTENT by default and blanks it only under { blankStringLiterals: true }", () => {
    // The two callers genuinely differ: the anon-exec and view guards want the
    // literal text, the RLS guard must not read `format('CREATE TABLE …')` as a
    // declaration. A single default would have been wrong for one of them.
    const sql = "SELECT format('CREATE TABLE IF NOT EXISTS public.%I', n);"
    expect(strip(sql)).toContain("CREATE TABLE IF NOT EXISTS")
    expect(strip(sql, { blankStringLiterals: true })).not.toContain("CREATE TABLE IF NOT EXISTS")
  })

  it("`''` is an escaped quote, not the end of the literal", () => {
    const out = strip("SELECT 'it''s here' AS x; CREATE TABLE public.after (id int);", { blankStringLiterals: true })
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
    expect(strip(sql, { blankStringLiterals: true })).toContain("CREATE TABLE public.still_seen")
  })

  it("a double-quoted identifier is never blanked, even under { blankStringLiterals: true }", () => {
    // A quoted identifier is the very thing these guards match on.
    const out = strip('CREATE TABLE "myTable" (id int);', { blankStringLiterals: true })
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
    expect(strip(sql, { blankStringLiterals: true })).toBe(sql)
  })
})
