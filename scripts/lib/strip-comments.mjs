// scripts/lib/strip-comments.mjs
//
// THE one comment stripper. 37 files had grown their own copy; this exists so
// there is a single implementation to fix when it is wrong — and it has been
// wrong twice, in two different ways, each of which HID REAL SOURCE FROM A
// GUARD. A blind stripper is the worst kind of guard bug: every check built on
// it passes, reports a population, and is silently reading a blanked file.
//
// ── DEFECT 1 (found 2026-08-22): the regex stripper, 20 copies ──────────────
// The copy-pasted shape stripped BLOCK comments before LINE comments:
//     .replace(/\/\*[\s\S]*?\*\//g, blanks)      // block first
//     .replace(/(^|[^:])\/\/.*$/gm, ...)         // line second
// So an ordinary line comment mentioning a glob path —
//     // short form used by /api/* endpoints
// — opens a block comment that the regex closes at the NEXT `*/` anywhere in
// the file, hundreds of lines later. Measured across 1,315 files: 55 files,
// 109,123 characters of real source blanked. It hid a live P0 (the D12b
// order-book surface in CollectionAnalyticsClient.tsx, ~19.6k chars invisible).
//
// ── DEFECT 2 (found 2026-08-22, in the PROPOSED FIX): regex literals ────────
// ⚠ The state-machine stripper written to replace it was ALSO blind, just
// somewhere else, and lifting it verbatim would have swapped one blind
// stripper for another. It had no regex-literal state, so a regex ENDING in an
// escaped slash —
//     if (!/^https?:\/\//i.test(url))
// — presents the raw characters `\` `/` `/`. The trailing escaped slash and
// the regex's own closing slash are ADJACENT, the machine read them as `//`,
// and blanked the rest of the line. Measured: 80 occurrences in 66 files,
// INCLUDING the guards' own `.replace(/\/\*[\s\S]*?\*\//g, ...)` bodies — so
// the corrected stripper would have blanked the very code implementing it.
//
// Hence the regex-literal state below. Deciding whether `/` opens a regex or
// is division needs the previous significant token: a regex may follow an
// operator, an opening bracket, a comma, or a keyword, but NOT an identifier,
// a number, `)` or `]` (those mean division).
//
// ⚠ KNOWN AND DELIBERATE BOUNDARY — `${...}` inside a template literal is
// copied verbatim, NOT re-parsed. A `//` inside an interpolation is preserved
// rather than stripped. That is the safe direction (this stripper's failure
// mode must be KEEPING too much, never blanking too much), and
// strip-comments.test.mjs pins it so the boundary is visible rather than
// silent. Do not "fix" it into recursive parsing without re-measuring.
//
// Blanking rule: removed characters become spaces and newlines are preserved,
// so byte offsets and LINE NUMBERS survive. Callers report positions.

const KEYWORDS_BEFORE_REGEX = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "throw", "case", "do", "else", "yield", "await",
])

/**
 * Replace comments with spaces, preserving length and line numbers.
 * @param {string} src
 * @returns {string}
 */
export function stripComments(src) {
  let out = ""
  let i = 0
  /** @type {"code"|"line"|"block"|"sq"|"dq"|"tpl"|"regex"|"class"} */
  let state = "code"
  const BS = String.fromCharCode(92) // backslash, written this way so this
                                     // file contains no literal `\/` sequence

  // Last significant (non-space, non-comment) character emitted in code state,
  // plus the identifier/keyword ending there. Together they decide whether the
  // next `/` opens a regex or is a division operator.
  let lastSig = ""
  let word = ""

  const regexCanFollow = () => {
    if (word && !KEYWORDS_BEFORE_REGEX.has(word)) return false // identifier => division
    if (word) return true                                      // keyword => regex
    if (lastSig === "") return true                            // start of file
    return !(/[A-Za-z0-9_$)\]]/.test(lastSig))                 // ) ] ident num => division
  }

  while (i < src.length) {
    const c = src[i]
    const d = src[i + 1]

    if (state === "code") {
      if (c === "/" && d === "/") { state = "line"; out += "  "; i += 2; continue }
      if (c === "/" && d === "*") { state = "block"; out += "  "; i += 2; continue }
      if (c === "/" && regexCanFollow()) { state = "regex"; out += c; i++; lastSig = c; word = ""; continue }

      if (c === "'") state = "sq"
      else if (c === '"') state = "dq"
      else if (c === "`") state = "tpl"

      if (/[A-Za-z0-9_$]/.test(c)) word += c
      else if (!/\s/.test(c)) word = ""
      // a run of whitespace ends the word but does not clear lastSig
      if (!/\s/.test(c)) lastSig = c
      out += c; i++; continue
    }

    if (state === "line") {
      if (c === "\n") { state = "code"; out += c; word = "" } else out += " "
      i++; continue
    }

    if (state === "block") {
      if (c === "*" && d === "/") { state = "code"; out += "  "; i += 2; word = ""; continue }
      out += c === "\n" ? c : " "
      i++; continue
    }

    if (state === "regex") {
      if (c === BS) { out += src.slice(i, i + 2); i += 2; continue }
      if (c === "[") state = "class"
      else if (c === "/") { state = "code"; lastSig = "/"; word = "" }
      else if (c === "\n") { state = "code"; word = "" } // unterminated: bail rather than run away
      out += c; i++; continue
    }

    if (state === "class") { // inside a regex [...] where `/` is not special
      if (c === BS) { out += src.slice(i, i + 2); i += 2; continue }
      if (c === "]") state = "regex"
      out += c; i++; continue
    }

    // sq | dq | tpl — copy verbatim, honour escapes
    if (c === BS) { out += src.slice(i, i + 2); i += 2; continue }
    if ((state === "sq" && c === "'") || (state === "dq" && c === '"') || (state === "tpl" && c === "`")) {
      state = "code"; lastSig = c; word = ""
    }
    out += c; i++
  }

  return out
}

export default stripComments
