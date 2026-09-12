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
// ── DEFECT 3 (found 2026-08-27): the "verbatim interpolation" boundary was NOT
//    the safe direction, and it blanked real source ─────────────────────────
// This header used to say `${...}` was copied verbatim rather than re-parsed,
// and called that "the safe direction (KEEPING too much, never blanking too
// much)". 🚨 **That claim was false, and it is the reason the boundary is now
// gone.** Copying an interpolation verbatim means a NESTED template literal
// inside it — the single commonest shape in this repo's HTML email builders —
// CLOSES the outer template:
//
//     ${a != null ? `<tr><td>${fmt(a)}</td></tr>` : ""}
//      ^ still `tpl`   ^ read as the CLOSING backtick of the OUTER literal
//
// From there the machine is in `code` INSIDE HTML text, where `/` in `</td>`
// opens a regex literal and `//` in a URL opens a line comment. The state then
// ping-pongs `tpl -> regex -> code -> regex` for the rest of the file, and BOTH
// failure directions occur at once:
//
//   * comments are left INTACT (a guard reads its own explanation as evidence —
//     the exact trap this helper exists to prevent; measured on
//     app/api/check-alerts/route.ts line 80, filed 2026-08-27T0500Z with the
//     root cause NOT found and four hypotheses falsified), and
//   * real source is BLANKED (line 100 of the same file, the Telegram
//     sendMessage URL, cut at `https:` — so a guard sweeping for unbounded
//     `fetch()` calls could not see the call it was looking for).
//
// Both symptoms are ONE desync. Measured before the fix: **9 files left the
// machine in a non-`code` state at EOF**; after it, 8, all of them DEFECT 4
// below. Interpolations are now parsed as code via an explicit nesting stack
// (`tplStack`), which is what the old note meant by "recursive parsing" — done
// with the re-measurement it asked for.
//
// ⚠ CONSEQUENCE, deliberate: a `//` comment inside `${...}` IS now stripped.
// That is correct JS, and the pinned boundary test was updated (not deleted) to
// assert the new behaviour with the old stripper kept as a negative control.
//
// ── DEFECT 4 (KNOWN, UNFIXED, measured 2026-08-27): JSX TEXT IS NOT JS ─────
// ⚠ This is a JS/TS parser, and it is also run over `.tsx`. In JSX *text* an
// apostrophe is prose, not a string delimiter — so `<p>Couldn't load</p>` opens
// an `sq` state that runs to the next apostrophe, possibly hundreds of lines on.
// **7 files in this repo end in a non-`code` state for this reason** (6 `sq`,
// 1 `dq`) — measured 2026-08-29 by `__tests__/strip-comments-defect-4-population.test.ts`,
// which walks the tree, ratchets the count and prints the names on failure.
//
// ⛔ **CORRECTION, and it is the reason that test exists.** This header used to
// read "8 files … 7 `sq`, 1 `dq`; `strip-comments-shared-helper.test.ts` pins
// the population so it is visible rather than silent, and names them." **Both
// claims were false.** That contract test pins the DEFECT 4 *shape* with a
// four-line synthetic fixture; it never walked the tree and never named a file.
// So the population was free to grow unobserved, and the sentence asserting it
// was pinned is exactly what would have stopped anyone checking. The live count
// was also 7, not 8 — one file had left the population and nothing noticed.
// ⭐ **A boundary nobody can COUNT is not a visible boundary, however carefully
// it is described.** Prefer a number a test re-derives over a number in prose.
//
// ✅ Unlike DEFECT 3, this one fails in the SAFE direction: inside `sq`/`dq`
// everything is copied verbatim, so the machine KEEPS too much (comments survive)
// and never blanks code. A guard may therefore over-report on those files; it
// cannot go blind on them. Fixing it needs real JSX awareness — do not attempt
// it without a fresh measurement and the same paired negative controls.
//
// 🚨 **AND THAT "7 FILES" IS A PROXY THAT UNDER-REPORTS — it missed the worst
// file in the repo.** Re-measured 2026-09-12: **10 files, 898 lines** are read
// in a bogus string state (the same sweep read 1,764 lines earlier the same day,
// before `app/dashboard/DashboardClient.tsx` was partly reworded — a DATED
// SAMPLE, as always; re-run the census rather than quoting either number).
//
// `endState` can only see a desync STILL OPEN at EOF, and JSX prose carries
// apostrophes in PAIRS as often as not — "we'll … doesn't". The first opens
// `sq`, everything between is copied verbatim, the second CLOSES it, and the
// file reports `code`, healthy. `app/dashboard/DashboardClient.tsx` was that
// file and the largest instance here: one contraction on line 1192, **1,076 of
// its lines** read as string, **63** comment lines surviving into every guard.
// It reddened `no-rewards-promises-while-unshipped` on 2026-09-12 by presenting
// a code comment about the +50 Status award as published copy.
//
// ⚠ **THAT FILE WAS THEN PARTLY REWORDED (`0871fff1c`) AND IT IS STILL IN THE
// POPULATION — 203 lines.** A reword moves the boundary; it does not remove it,
// and it leaves behind the impression that it did. That is why the census is a
// ratchet with names in the failure message rather than a one-off fix.
//
// ⭐ **Count a boundary by its SYMPTOM, not by a proxy for it** — and the symptom
// needs no proxy, because a single- or double-quoted string CANNOT SPAN A
// NEWLINE in JS/TS. `lineStates` (returned below) makes that countable per line;
// `__tests__/strip-comments-defect-4-population.test.ts` ratchets it and names
// the files. ⚠ `tpl` is excluded there and must be: a template literal spanning
// newlines is ordinary, and the `//` inside our Cadence transactions is SOURCE
// that must survive — a first cut that counted those over-reported 13 for 10.
//
// ⚠ Until DEFECT 4 is fixed, a guard whose subject is USER-FACING COPY should
// not depend on this helper being right about JSX: blank `//`/`*` lines
// textually as well. `no-rewards-promises-while-unshipped.test.ts` (`copyOf`)
// is the worked example — "prefer a check that does not NEED it right".
//
// Blanking rule: removed characters become spaces and newlines are preserved,
// so byte offsets and LINE NUMBERS survive. Callers report positions.

const KEYWORDS_BEFORE_REGEX = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "throw", "case", "do", "else", "yield", "await",
])

/**
 * Replace comments with spaces, preserving length and line numbers, AND report
 * the state machine's terminal state.
 *
 * ⚠ Why the state is exported at all. DEFECT 4 below is a KNOWN, UNFIXED
 * boundary, and its header used to claim the contract test "pins the population
 * so it is visible rather than silent, and names them". It did not — the test
 * never walked the tree and never named a file, so the population could have
 * grown from 8 to 80 with every guard still green. A boundary nobody can COUNT
 * is not a visible boundary. `endState`/`tplDepth` are what make it countable;
 * `__tests__/strip-comments-defect-4-population.test.ts` ratchets on them.
 *
 * A healthy file ends `code` with `tplDepth === 0`. Anything else means the
 * machine desynced somewhere and the rest of that file was read in the wrong
 * state.
 *
 * `lineStates[n]` is the machine's state at the START of line n (0-based) —
 * see the DEFECT 4 note above for why a per-line state and not just an end
 * state: a desync that RE-SYNCS before EOF is invisible to `endState`, and
 * those are the majority. It is also what lets a census tell a JS comment the
 * machine wrongly kept (line-start state `sq`) from Cadence or SQL prose inside
 * a template literal that it RIGHTLY kept (state `tpl`) — a census without that
 * distinction over-counts by a factor of two.
 *
 * @param {string} src
 * @returns {{ code: string, endState: string, tplDepth: number, lineStates: string[] }}
 */
export function stripCommentsWithState(src) {
  let out = ""
  let i = 0
  /** @type {string[]} */
  const lineStates = []
  /** @type {"code"|"line"|"block"|"sq"|"dq"|"tpl"|"regex"|"class"} */
  let state = "code"
  // Template-literal nesting. Each `${` inside a template pushes a frame and
  // returns to `code`; the matching `}` pops back to `tpl`. Without this the
  // machine cannot tell an interpolation's braces from ordinary ones, and a
  // nested template literal inside `${...}` silently CLOSES the outer one.
  // See DEFECT 3 in the header.
  /** @type {number[]} */
  const tplStack = []
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

    // Record the state at each line start. `out` ends with a newline exactly
    // when the next character begins a new line, and blanking preserves
    // newlines, so this indexes the source's lines 1:1.
    if (i === 0 || src[i - 1] === "\n") lineStates.push(state)

    if (state === "code") {
      if (c === "/" && d === "/") { state = "line"; out += "  "; i += 2; continue }
      if (c === "/" && d === "*") { state = "block"; out += "  "; i += 2; continue }
      if (c === "/" && regexCanFollow()) { state = "regex"; out += c; i++; lastSig = c; word = ""; continue }

      if (c === "'") state = "sq"
      else if (c === '"') state = "dq"
      else if (c === "`") state = "tpl"
      else if (tplStack.length > 0 && c === "{") tplStack[tplStack.length - 1]++
      else if (tplStack.length > 0 && c === "}") {
        if (tplStack[tplStack.length - 1] === 0) {
          // Closes the interpolation: back into the template literal that owns it.
          tplStack.pop(); state = "tpl"
          out += c; i++; lastSig = c; word = ""; continue
        }
        tplStack[tplStack.length - 1]--
      }

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
    if (state === "tpl" && c === "$" && d === "{") {
      // Enter the interpolation as CODE, remembering the template to return to.
      tplStack.push(0); state = "code"
      out += src.slice(i, i + 2); i += 2; lastSig = "{"; word = ""; continue
    }
    if ((state === "sq" && c === "'") || (state === "dq" && c === '"') || (state === "tpl" && c === "`")) {
      state = "code"; lastSig = c; word = ""
    }
    out += c; i++
  }

  // A trailing newline (or an empty file) opens a final, characterless line
  // that the loop above never visits. Push its state so `lineStates` indexes
  // `src.split("\n")` exactly — a census that is off by one names the wrong
  // line, which is worse than not counting at all.
  if (src.length === 0 || src.endsWith("\n")) lineStates.push(state)

  return { code: out, endState: state, tplDepth: tplStack.length, lineStates }
}

/**
 * Replace comments with spaces, preserving length and line numbers.
 * The ONE entry point every guard should call.
 * @param {string} src
 * @returns {string}
 */
export function stripComments(src) {
  return stripCommentsWithState(src).code
}

export default stripComments
