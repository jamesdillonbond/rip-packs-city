import { describe, it, expect } from "vitest"
import { stripSqlComments, readDollarTag } from "../scripts/lib/strip-sql-comments.mjs"

// The SQL counterpart of `scripts/lib/strip-comments.mjs`, written so the
// `guards-use-the-shared-comment-stripper` ratchet can reach zero. Its header
// explains why the three migration guards could not migrate to the JS stripper;
// these are the behaviours that make this one safe to migrate them to.
//
// ⚠ Every case below is a defect one of those three guards HAD, or would have had.
// They are not synthetic: the nesting case and the format()-template case each
// produced a wrong number in this repo within the last 24 hours.

describe("stripSqlComments", () => {
  it("blanks a line comment and keeps the code around it", () => {
    const out = stripSqlComments("SELECT 1; -- hidden\nSELECT 2;")
    expect(out).toContain("SELECT 1;")
    expect(out).toContain("SELECT 2;")
    expect(out).not.toContain("hidden")
  })

  it("preserves offsets and newlines, so a caller can still report a position", () => {
    const src = "SELECT 1; -- hidden\nSELECT 2;"
    const out = stripSqlComments(src)
    expect(out).toHaveLength(src.length)
    expect(out.split("\n")).toHaveLength(2)
  })

  it("handles NESTED block comments — the non-greedy regex closes at the first one", () => {
    const out = stripSqlComments("/* a /* b */ c */ SELECT 3;")
    expect(out).toContain("SELECT 3;")
    // With `/\/\*[\s\S]*?\*\//` the comment ends after `b */`, leaving `c */` live.
    expect(out).not.toContain("c")
  })

  it("does not treat a double dash inside a string literal as a comment", () => {
    const out = stripSqlComments("SELECT 'a--b', 1;")
    expect(out).toContain("'a--b'")
    expect(out).toContain(", 1;")
  })

  it("honours the doubled-quote escape inside a literal", () => {
    const out = stripSqlComments("SELECT 'it''s -- fine', 2;")
    expect(out).toContain("it''s -- fine")
    expect(out).toContain(", 2;")
  })

  it("KEEPS a dollar-quoted body and still strips comments inside it", () => {
    // ⚠ Load-bearing: this repo's migrations put their real DDL inside `DO $mig$ … $mig$`.
    // A stripper that treats the body as an opaque string blinds every guard to it.
    const out = stripSqlComments("$mig$ SELECT 4; -- gone\n SELECT 5; $mig$")
    expect(out).toContain("SELECT 4;")
    expect(out).toContain("SELECT 5;")
    expect(out).not.toContain("gone")
  })

  it("does not mistake a parameter placeholder for a dollar quote", () => {
    const out = stripSqlComments("SELECT $1 -- gone\n, 2;")
    expect(out).toContain("$1")
    expect(out).toContain(", 2;")
    expect(out).not.toContain("gone")
  })

  it("keeps string literals by default", () => {
    const out = stripSqlComments("EXECUTE format('CREATE TABLE public.%I ()');")
    expect(out).toContain("CREATE TABLE")
  })

  it("blanks string literals on request — the format() template trap", () => {
    // Counting `CREATE TABLE` without this reads a format TEMPLATE as a declaration,
    // and the name regex backtracks off `public.` to report a table called `publi`.
    const out = stripSqlComments("EXECUTE format('CREATE TABLE public.%I ()');", {
      blankStringLiterals: true,
    })
    expect(out).toContain("EXECUTE format(")
    expect(out).not.toContain("CREATE TABLE")
  })

  it("leaves a double-quoted identifier alone", () => {
    const out = stripSqlComments('SELECT "weird--name" FROM t;')
    expect(out).toContain('"weird--name"')
  })

  it("terminates on an unclosed comment rather than looping", () => {
    expect(stripSqlComments("SELECT 1; /* never closed")).toContain("SELECT 1;")
    expect(stripSqlComments("SELECT 1; 'never closed")).toContain("SELECT 1;")
    expect(stripSqlComments("SELECT 1; $tag$ never closed")).toContain("SELECT 1;")
  })
})

describe("readDollarTag", () => {
  it("reads the bare and tagged forms", () => {
    expect(readDollarTag("$$x$$", 0)).toBe("$$")
    expect(readDollarTag("$mig$x$mig$", 0)).toBe("$mig$")
    expect(readDollarTag("$function$x$function$", 0)).toBe("$function$")
  })

  it("refuses a placeholder, a digit-leading tag, and a bare dollar", () => {
    expect(readDollarTag("$1", 0)).toBeNull()
    expect(readDollarTag("$1x$", 0)).toBeNull()
    expect(readDollarTag("$ ", 0)).toBeNull()
  })
})
