// scripts/lib/strip-sql-comments.mjs
//
// THE one SQL comment stripper — the module `guards-use-the-shared-comment-stripper`
// has been asking for since 2026-08-22.
//
// That ratchet says every guard must use `scripts/lib/strip-comments.mjs`, and it
// carried a permanent floor with this note:
//
//   "THE REMAINING 2 ARE SQL STRIPPERS, NOT JS ONES, and migrating them would be a
//    DEFECT rather than a fix: both walk supabase/migrations/*.sql, where comments
//    are -- and block pairs and bodies are dollar-quoted. The shared stripper is a
//    JavaScript state machine — it has no line-comment state for -- and no
//    dollar-quote state … They come off this list when a SQL stripper exists to
//    move them to, not before."
//
// This is that module. A ratchet with a permanent floor punishes its own success and
// trains readers to ignore its report, so the exit condition mattered more than the
// number.
//
// ── WHY A STATE MACHINE AND NOT REGEXES ───────────────────────────────────────
// The shape those three guards each grew is wrong on real Postgres in three separate
// ways, and every one of them blanks or reveals the wrong text SILENTLY — the exact
// failure mode the JS ratchet exists to prevent:
//
//   1. Postgres block comments NEST. A non-greedy regex ends at the FIRST closer, so
//      a nested opener inside a long header makes it close early and the remainder of
//      the comment reads as live code.
//   2. A double dash inside a string literal is NOT a comment. 'a--b' loses its tail,
//      so a guard scanning for a value that legitimately contains one cannot see it.
//      Single-quoted literals also carry the doubled-quote escape, which a naive scan
//      mis-pairs.
//   3. Dollar-quoted bodies must SURVIVE. This repo puts its real DDL inside them. A
//      stripper that treats them as opaque strings blinds every migration guard to the
//      statements inside a DO block — the code most worth checking.
//
// ── WHAT IT DOES ──────────────────────────────────────────────────────────────
// Blanks comments to SPACES (offsets and line numbers preserved, so a caller can still
// report a position), leaves everything else byte-identical, and recognises:
//
//   · line comments (double dash)              -> blanked
//   · block comments, NESTED                   -> blanked
//   · single-quoted literals, doubled escape   -> kept (or blanked, see the option)
//   · E'' literals with backslash escapes      -> kept (or blanked)
//   · double-quoted identifiers                -> kept, always
//   · dollar-quoted bodies                     -> KEPT, always, and re-scanned for
//                                                 comments inside, because a DO block
//                                                 body is real SQL
//
// The `blankStringLiterals` option is for one specific job and is deliberately NOT the
// default: a guard scanning for CREATE TABLE must not read a format() template as a
// declaration. Blanking literals is the difference between counting 127 real statements
// and counting 129 with two phantoms — one of which parses as a table named `publi`,
// because the name regex backtracks off `public.` when the next character is a percent
// placeholder.
//
// A dollar-quote tag must match EXACTLY: `$$` and `$mig$` are different quotes, and
// `$1` is a parameter placeholder, not a dollar quote — a tag is a dollar sign, an
// optional identifier that may not start with a digit, and a closing dollar sign.

const BLANK = " "

function isTagStart(c) {
  return c !== undefined && /[A-Za-z_]/.test(c)
}

function isTagRest(c) {
  return c !== undefined && /[A-Za-z0-9_]/.test(c)
}

/**
 * Read a dollar-quote opener at `i`. Returns the full tag text (`$$`, `$mig$`) or
 * null when this dollar sign does not open one.
 */
export function readDollarTag(src, i) {
  if (src[i] !== "$") return null
  let j = i + 1
  let first = true
  while (j < src.length && src[j] !== "$") {
    if (first ? !isTagStart(src[j]) : !isTagRest(src[j])) return null
    first = false
    j++
  }
  if (j >= src.length) return null
  return src.slice(i, j + 1)
}

/**
 * Strip SQL comments, blanking them to spaces of equal length.
 *
 * @param {string} sql
 * @param {{ blankStringLiterals?: boolean }} [opts]
 * @returns {string}
 */
export function stripSqlComments(sql, opts = {}) {
  const blankStrings = opts.blankStringLiterals === true
  const out = Array.from(sql)
  const n = sql.length
  let i = 0

  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = BLANK
  }

  while (i < n) {
    const c = sql[i]
    const c2 = sql[i + 1]

    // line comment: double dash to end of line
    if (c === "-" && c2 === "-") {
      let j = i
      while (j < n && sql[j] !== "\n") j++
      blank(i, j)
      i = j
      continue
    }

    // block comment, NESTED
    if (c === "/" && c2 === "*") {
      let depth = 1
      let j = i + 2
      while (j < n && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth++
          j += 2
          continue
        }
        if (sql[j] === "*" && sql[j + 1] === "/") {
          depth--
          j += 2
          continue
        }
        j++
      }
      const end = Math.min(j, n)
      blank(i, end)
      i = end
      continue
    }

    // dollar-quoted body: kept, and its contents re-scanned, because a DO block body
    // is real SQL and the guards need to see the statements in it.
    if (c === "$") {
      const tag = readDollarTag(sql, i)
      if (tag) {
        i += tag.length
        continue
      }
    }

    // single-quoted literal (doubled-quote escape). E'' also honours backslashes.
    if (c === "'") {
      const prev = sql[i - 1]
      const backslashEscapes = prev === "E" || prev === "e"
      let j = i + 1
      while (j < n) {
        if (backslashEscapes && sql[j] === "\\") {
          j += 2
          continue
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2
            continue
          }
          j++
          break
        }
        j++
      }
      const end = Math.min(j, n)
      if (blankStrings) blank(i, end)
      i = end
      continue
    }

    // double-quoted identifier — always kept; can never hold a comment.
    if (c === '"') {
      let j = i + 1
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2
            continue
          }
          j++
          break
        }
        j++
      }
      i = Math.min(j, n)
      continue
    }

    i++
  }

  return out.join("")
}

export default stripSqlComments
