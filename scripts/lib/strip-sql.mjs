// scripts/lib/strip-sql.mjs
//
// Blank SQL COMMENTS (and, optionally, string-literal CONTENT) before a guard
// greps a migration, WITHOUT moving a single character.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// `scripts/lib/strip-comments.mjs` is the shared stripper for JavaScript and
// TypeScript, and `guards-use-the-shared-comment-stripper` ratchets the number
// of hand-rolled copies down toward zero. Two migration guards were parked on
// that ratchet with an explicit note:
//
//     "THE REMAINING 2 ARE SQL STRIPPERS, NOT JS ONES, and migrating them would
//      be a DEFECT rather than a fix: both walk `supabase/migrations/*.sql`,
//      where comments are `--` and `/* */` and bodies are dollar-quoted. The
//      shared stripper is a JavaScript state machine — it has no `--` state and
//      no dollar-quote state. They come off this list when a SQL stripper
//      exists to move them to, not before."
//
// This is that SQL stripper. A third guard arrived on 2026-09-05 and reddened
// `main`, which is what made the missing tool worth building rather than worth
// allowing for a third time.
//
// ── WHY A CHARACTER LEXER AND NOT A CHAIN OF `.replace()` CALLS ─────────────
// 🚨 The three implementations it replaces were all chained regexes, and that
// shape is BLIND IN BOTH DIRECTIONS — this repo has recorded being fooled by a
// blind stripper three separate times:
//
//   · Comment-first ordering destroys a `--` that lives INSIDE a string
//     literal, leaving that literal's opening quote unpaired, so the NEXT
//     apostrophe in the file closes a literal that never opened and everything
//     between two unrelated quotes is blanked as "a string".
//   · Literal-first ordering does the mirror image: an apostrophe inside a
//     comment (`-- the edition's name`) opens a literal that runs to the next
//     quote anywhere later in the file.
//
// A single left-to-right pass has no ordering to get wrong: whichever construct
// OPENS first consumes the others until it closes, which is exactly Postgres's
// own rule. It is also why this file contains no regex of the shape the ratchet
// hunts for — the helper must not be an instance of the defect it retires.
//
// ── OFFSETS ARE PRESERVED, AND THAT IS LOAD-BEARING, NOT TIDINESS ──────────
// ⚠ Every blanked character becomes ONE space; newlines (`\n` and `\r`) are kept
// as themselves. The output has the same `.length` as the input, the same line
// numbering, and the same distance between any two surviving tokens.
//
// That last property is what a caller actually depends on:
// `migration-new-function-states-its-anon-exec-decision` matches
// `REVOKE[\s\S]{0,200}?…public.<fn>\s*\(` — a BOUNDED window. Collapsing a
// 300-character comment to a single space would pull a REVOKE and a function
// name inside a 200-character window they were never within, and the guard
// would vouch for a decision the file does not state. Blanking in place cannot
// do that.
//
// ── WHAT IT DELIBERATELY DOES *NOT* DO ─────────────────────────────────────
// ⛔ It does not hide dollar-quoted function bodies. `$$ … $$` is recognised
// only so an apostrophe inside one (`$$ … it's … $$`) cannot open a phantom
// literal; the body itself is then stripped RECURSIVELY, as the SQL it is.
// That is deliberate and the guards in this tree rely on it — the RLS guard's
// header is written around `CREATE TEMP TABLE _rwfc_recent` appearing *inside* a
// function body, and a commented-out statement inside a body must be blanked the
// same as one outside it.
//
// ⛔ It is not a parser and cannot tell you what a statement MEANS. It answers
// exactly one question — "is this character code, or is it commentary?" — and a
// guard that needs more than that needs more than a stripper.

/**
 * True when `sql` opens a dollar-quoted string at `i`, and if so how long its
 * tag is. Postgres tags are `$$` or `$tag$`, tag being an identifier.
 * Returns 0 when this `$` is not a dollar-quote opener (e.g. the `$1` of a
 * parameter reference).
 */
function dollarTagLength(sql, i) {
  if (sql[i] !== "$") return 0
  let j = i + 1
  while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) j += 1
  if (sql[j] !== "$") return 0
  return j - i + 1
}

/**
 * Blank the comments in a SQL string, preserving every offset.
 *
 * @param {string} sql
 * @param {{ literals?: boolean }} [options]
 *   `literals: true` additionally blanks the CONTENT of single-quoted string
 *   literals, keeping the two quote characters themselves. Callers that scan
 *   for DDL want this: several migrations build statements dynamically via
 *   `format('CREATE TABLE IF NOT EXISTS public.%I …')`, and a scan that reads
 *   the format STRING reports a declaration that does not exist — one earlier
 *   draft reported a table literally called `publi`, because `%I` is not an
 *   identifier and the pattern backtracked into the word `public`.
 * @returns {string} same length, same lines, commentary blanked to spaces.
 */
export function stripSql(sql, options = {}) {
  const blankLiterals = options.literals === true
  const n = sql.length
  const out = new Array(n)

  let i = 0
  const keep = () => {
    out[i] = sql[i]
    i += 1
  }
  const blank = () => {
    const c = sql[i]
    out[i] = c === "\n" || c === "\r" ? c : " "
    i += 1
  }

  while (i < n) {
    const c = sql[i]
    const next = sql[i + 1]

    // ── line comment: `--` to end of line ──────────────────────────────────
    // ⚠ Stops on `\r` as well as `\n`. A JS `.` does not match `\r`, which is
    // how the CRLF form of this bug has bitten this repo before: a `--.*$`
    // strip silently no-ops on a CRLF file and every comment stays visible.
    if (c === "-" && next === "-") {
      while (i < n && sql[i] !== "\n" && sql[i] !== "\r") blank()
      continue
    }

    // ── block comment: `/* */`, and Postgres NESTS them ───────────────────
    // ⚠ The nesting is not pedantry. `/* a /* b */ c */` closes at the FIRST
    // `*/` for a non-greedy regex, so `c */` is handed back to the caller as
    // code — which is how a commented-out block gets scanned as a live
    // statement. Depth-counting is the whole reason this branch is not a
    // one-line replace.
    if (c === "/" && next === "*") {
      let depth = 0
      while (i < n) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth += 1
          blank()
          blank()
          continue
        }
        if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1
          blank()
          blank()
          if (depth === 0) break
          continue
        }
        blank()
      }
      continue
    }

    // ── dollar-quoted body: recognise, then strip the INTERIOR recursively ─
    const tagLen = dollarTagLength(sql, i)
    if (tagLen > 0) {
      const tag = sql.slice(i, i + tagLen)
      const close = sql.indexOf(tag, i + tagLen)
      // An unterminated body is a broken file; treat the opener as ordinary
      // text rather than swallowing the rest of the migration.
      if (close === -1) {
        keep()
        continue
      }
      const bodyStart = i + tagLen
      for (let k = 0; k < tagLen; k += 1) keep()
      const inner = stripSql(sql.slice(bodyStart, close), options)
      for (let k = 0; k < inner.length; k += 1) out[bodyStart + k] = inner[k]
      i = close
      for (let k = 0; k < tagLen; k += 1) keep()
      continue
    }

    // ── single-quoted literal, `''` being the escaped quote ───────────────
    // The DELIMITERS always survive even when the content is blanked, so a
    // caller can still see that a string was here (`format( '' )`) rather than
    // finding two unrelated tokens newly adjacent.
    if (c === "'") {
      keep()
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          if (blankLiterals) {
            blank()
            blank()
          } else {
            keep()
            keep()
          }
          continue
        }
        if (sql[i] === "'") {
          keep()
          break
        }
        if (blankLiterals) blank()
        else keep()
      }
      continue
    }

    // ── double-quoted identifier ──────────────────────────────────────────
    // NEVER blanked under any option: a quoted identifier is the very thing
    // these guards match on (`CREATE TABLE "myTable"`). It is lexed only so a
    // `--` or an apostrophe inside one cannot open a comment or a literal.
    if (c === '"') {
      keep()
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          keep()
          keep()
          continue
        }
        if (sql[i] === '"') {
          keep()
          break
        }
        keep()
      }
      continue
    }

    keep()
  }

  return out.join("")
}
