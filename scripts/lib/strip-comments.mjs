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
// ── DEFECT 4 (found 2026-08-27, FIXED 2026-09-12): JSX TEXT IS NOT JS ──────
// ⚠ This is a JS/TS parser, and it is also run over `.tsx`. In JSX *text* an
// apostrophe is prose, not a string delimiter — so `<p>Couldn't load</p>` used to
// open an `sq` state that ran to the next apostrophe, possibly hundreds of lines
// on, handing every guard built on this helper a comment as source.
//
// **The population at the time of the fix: 10 files, 899 lines** — re-measured
// 2026-09-12 by `__tests__/strip-comments-defect-4-population.test.ts`, which
// walks the tree, counts it and names the files. It is **0** below; the ratchets
// there are now bans at zero.
//
// ⛔ **TWO CORRECTIONS THIS DEFECT EARNED ALONG THE WAY, both worth keeping.**
// (a) The header once read "8 files … `strip-comments-shared-helper.test.ts`
// pins the population and names them". Both claims were false — that contract
// test pins the *shape* with a four-line synthetic fixture and never walked the
// tree. ⭐ **A boundary nobody can COUNT is not a visible boundary, however
// carefully it is described.** (b) The replacement census counted `endState`,
// which can only see a desync STILL OPEN at EOF — and JSX prose carries
// apostrophes in PAIRS as often as not ("we'll … doesn't"), so the machine
// re-synced and reported `code`, healthy. That proxy missed the worst file in
// the repo: `app/dashboard/DashboardClient.tsx`, 1,076 of its lines read as
// string, 63 comment lines surviving into every guard. ⭐ **Count a boundary by
// its SYMPTOM, not by a proxy for it** — a single- or double-quoted string
// CANNOT SPAN A NEWLINE in JS/TS, so a line whose START state is `sq`/`dq` IS a
// desync. That is what `lineStates` (returned below) makes countable.
//
// 🚨 **(c) AND THE THIRD CORRECTION IS THE ONE THAT MATTERS MOST: THIS DEFECT
// DID NOT "FAIL SAFE", AND THIS HEADER SAID IT DID FOR SIXTEEN DAYS.** The
// removed sentence read: *"✅ Unlike DEFECT 3, this one fails in the SAFE
// direction: inside `sq`/`dq` everything is copied verbatim, so the machine
// KEEPS too much and never blanks code."* Measured against TypeScript on the
// shipped stripper the day of the fix: **2 files, 46 characters of real source
// BLANKED** — DEFECT 3's direction, the one that hid a live P0. The clearest is
// `app/(analytics)/analytics/api/page.tsx:116`, the production base URL printed
// on a public page. JSX text is not a string state at all; it was parsed as
// CODE, where `//` in a URL opens a line comment. Every guard received:
//
//     "            https:                      "
//
// ⭐⭐ **WHY THE CLAIM SURVIVED: THE CENSUS COUNTED ONE SYMPTOM AND THE SAFETY
// CLAIM WAS GENERALISED FROM IT.** `sq`/`dq` line states really are verbatim
// and really do only keep too much — so a census built on them can only ever
// report the safe half, and reports it completely. The other half of the same
// root cause (a `//` in JSX text) is INVISIBLE to that instrument by
// construction, and it is the unsafe half. **Ask what a passing guard is
// structurally SILENT about before quoting it as a safety property** — and
// never derive a claim about a DEFECT from an instrument that measures one of
// its SYMPTOMS. The oracle below has no symptom in it at all, which is the
// point: it compares every character against what the compiler says.
//
// ── HOW THE FIX WORKS, and the one genuinely ambiguous character ───────────
// Two new states. `jsxTag` is inside `< … >`, where quotes ARE delimiters
// (attribute values) and `{` opens an expression container. `jsxText` is inside
// an element's children, where quotes are PROSE, `{` opens an expression
// container and `<` starts a nested or closing tag. Both copy verbatim, so a
// `//` in a URL or a `/* */` in prose survives — correctly, because in JSX text
// they are text. Element depth and the expression-container stack are one
// mechanism (`exprStack`), so `{cond && <b>x</b>}` nests correctly, and a JSX
// comment `{/* … */}` needs no special case at all: `{` enters code, where the
// block-comment rule already applies.
//
// 🚨 **`<` IS THE AMBIGUOUS CHARACTER AND TYPESCRIPT ITSELF CANNOT RESOLVE IT
// WITHOUT KNOWING THE FILE'S LANGUAGE VARIANT** — which is exactly why TS
// requires the trailing comma in a `.tsx` generic arrow, `<T,>(v) => v`. This
// helper gets no filename (91 files call it, all as `stripComments(src)`), so it
// resolves `<` in two stages: it must be in EXPRESSION position — the same
// predicate that decides regex-vs-division, so `useState<string>(…)`,
// `Map<K, V>`, `a < b` and every other identifier-preceded `<` is never a
// candidate — and it must not be a type-parameter list IMMEDIATELY APPLIED to a
// call, `<T,>(` / `<T>(`, which is the one shape JSX never has.
// ⚠ **The residual ambiguity is real, and MY FIRST MEASUREMENT OF IT WAS
// WRONG — which is the most useful thing in this header.** I grepped for
// `<tag>(`, found every hit identifier-preceded and therefore already blocked,
// and wrote "zero instances exist in this tree". The census then failed on
// `app/(collections)/[collection]/challenges/page.tsx`: `<> (last updated
// {d})</>` is a FRAGMENT whose text begins with `(`. ⭐ **The grep answered a
// narrower question than the one the code asks** — it could not match `<>`,
// because the pattern required an identifier between the brackets. A guard's
// population must be counted by the guard's own predicate, not by a regex that
// resembles it. Two rules now close it: a fragment is never a parameter list
// (a parameter list cannot be empty), and the `(` must follow the `>` with NO
// whitespace. What remains — `<p>(optional)</p>`, no space — is zero in this
// tree by the real predicate, and the oracle below names it the day it appears.
//
// ⭐⭐ **THE CONTROL THAT MAKES THIS FIX A MEASUREMENT RATHER THAN A STORY:**
// `__tests__/strip-comments-matches-typescript.test.ts` parses every file in the
// tree with the TypeScript compiler — an INDEPENDENT instrument, and the ground
// truth for JSX, since it is the thing that defines it — enumerates the comment
// ranges it finds, and asserts they are EXACTLY the ranges this helper blanks.
// Both directions in one assertion: a range TS sees and we keep is a comment
// leaking into a guard; a range we blank and TS does not see is SOURCE BEING
// DESTROYED, which is DEFECT 1/2/3's direction and the one that hid a live P0.
//
// ⚠ **The standing advice below SURVIVES the fix and should not be deleted.** A
// guard whose subject is USER-FACING COPY should still not depend on this helper
// being right about JSX: blank `//`/`*` lines textually as well.
// `no-rewards-promises-while-unshipped.test.ts` (`copyOf`) is the worked example
// — "prefer a check that does not NEED it right". Four defects in four different
// places is the argument; a fifth is a matter of time.
//
// Blanking rule: removed characters become spaces and newlines are preserved,
// so byte offsets and LINE NUMBERS survive. Callers report positions.

const KEYWORDS_BEFORE_REGEX = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "throw", "case", "do", "else", "yield", "await",
])

/**
 * Is the `<` at `lt` the start of a TYPE PARAMETER LIST rather than a JSX tag?
 *
 * This is the second of the two stages described under DEFECT 4 in the header,
 * and it only ever runs on a `<` that already passed the expression-position
 * test — so `useState<string>(…)`, `Map<K, V>` and `a < b` never reach it.
 * What is left is the genuinely ambiguous shape that TypeScript resolves by
 * file extension and this helper cannot: `<T,>(v: T) => v` (a `.tsx` generic
 * arrow) and `type Bound = <T>(p: Promise<T>) => …` (a generic function type).
 *
 * ⭐ The discriminator is that a type parameter list is IMMEDIATELY APPLIED —
 * its matching `>` is followed by `(`. A JSX opening tag never is, unless its
 * text begins with `(` on the same line; see the measured residue in the header.
 *
 * Anything that can only be JSX ends the scan early: an `=` is an attribute, a
 * quote is an attribute value, `/` is a closing or self-closing tag, `{` is a
 * spread or an expression container, and a newline means a multi-line tag.
 *
 * @param {string} src
 * @param {number} lt index of the `<`
 * @returns {boolean}
 */
function looksLikeTypeParameterList(src, lt) {
  // A FRAGMENT is never a type parameter list — a parameter list cannot be
  // empty. ⚠ This line is load-bearing: `<> (last updated {d})</>` is JSX whose
  // text begins with `(`, and without it the tag reads as `<>` applied to a
  // call. It is the one live instance the first cut of this function got wrong.
  if (src[lt + 1] === ">") return false
  let depth = 0
  for (let j = lt; j < src.length; j++) {
    const ch = src[j]
    if (ch === "\n" || ch === "=" || ch === "'" || ch === '"' || ch === "`") return false
    if (ch === "/" || ch === "{") return false
    if (ch === "<") { depth++; continue }
    if (ch === ">") {
      depth--
      if (depth > 0) continue
      // ⚠ IMMEDIATELY applied, with NO whitespace between. Skipping spaces here
      // widens the false-positive window to any JSX whose text starts with `(`
      // after a space, for no gain: a generic arrow is always written `<T,>(v)`.
      return src[j + 1] === "("
    }
  }
  return false
}

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
  /** @type {"code"|"line"|"block"|"sq"|"dq"|"tpl"|"regex"|"class"|"jsxTag"|"jsxText"} */
  let state = "code"
  // Expression-container nesting, ONE stack for both shapes that suspend a
  // verbatim region to run code inside it: a template literal's `${…}` and a
  // JSX `{…}`. Each frame remembers the state to return to, how many ordinary
  // `{` are open inside it, and the JSX element depth that was live when it was
  // pushed — so `` `${<b>x</b>}` `` and `{cond && <b>x</b>}` both nest.
  // Without this the machine cannot tell an interpolation's braces from
  // ordinary ones, and a nested template literal inside `${…}` silently CLOSES
  // the outer one. See DEFECT 3 in the header.
  /** @type {{ back: string, braces: number, jsxDepth: number, tagClosing: boolean }[]} */
  const exprStack = []
  // Open JSX elements in the CURRENT expression context; saved/restored by the
  // frames above so a nested element cannot close an outer one.
  let jsxDepth = 0
  // The state a closing quote returns to. `code` normally; `jsxTag` for an
  // attribute value, which must go back into the tag and not into code.
  let stringBack = "code"
  // Likewise for a comment. ⚠ A `//` or `/* */` BETWEEN ATTRIBUTES is a real
  // comment — `<button onClick={t} // why \n className="x">` — and TypeScript
  // treats it as trivia. Copying it verbatim was the last comment leak the
  // oracle found, in 20 files.
  let commentBack = "code"
  // Whether the tag currently being scanned is a CLOSING tag (`</p>`), which
  // pops an element instead of pushing one.
  let tagClosing = false
  const BS = String.fromCharCode(92) // backslash, written this way so this
                                     // file contains no literal `\/` sequence

  // Last significant (non-space, non-comment) character emitted in code state,
  // plus the identifier/keyword ending there. Together they decide whether the
  // next `/` opens a regex or is a division operator.
  let lastSig = ""
  let word = ""
  // Whether whitespace has ended the current word, so the next identifier
  // character starts a NEW one rather than extending it. DEFECT 5.
  let wordEnded = false

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

      // A JSX element can only appear in expression position — the same test
      // that decides regex-vs-division — and must be followed by an identifier
      // start or `>` (a fragment). See DEFECT 4 in the header for why the
      // second stage exists and what it can still not resolve.
      if (c === "<" && d !== undefined && /[A-Za-z_$>]/.test(d) && regexCanFollow() &&
          !looksLikeTypeParameterList(src, i)) {
        state = "jsxTag"; tagClosing = false
        out += c; i++; lastSig = c; word = ""; continue
      }

      if (c === "'") state = "sq"
      else if (c === '"') state = "dq"
      else if (c === "`") state = "tpl"
      else if (exprStack.length > 0 && c === "{") exprStack[exprStack.length - 1].braces++
      else if (exprStack.length > 0 && c === "}") {
        const top = exprStack[exprStack.length - 1]
        if (top.braces === 0) {
          // Closes the container: back into the template literal or the JSX
          // that owns it, with that context's element depth restored.
          exprStack.pop(); state = top.back
          jsxDepth = top.jsxDepth; tagClosing = top.tagClosing
          out += c; i++; lastSig = c; word = ""; continue
        }
        top.braces--
      }

      // ⚠ A run of whitespace ENDS the word (the next identifier is a new one)
      // but does not clear `lastSig`. See DEFECT 5 in the header: writing this
      // as a bare `word += c` silently concatenates across the whitespace, so
      // `continue` on one line and `return` on the next make `continuereturn`,
      // which is not a keyword — and the regex after it reads as division.
      if (/[A-Za-z0-9_$]/.test(c)) { word = wordEnded ? c : word + c; wordEnded = false }
      else if (/\s/.test(c)) wordEnded = true
      else { word = ""; wordEnded = false }
      if (!/\s/.test(c)) lastSig = c
      out += c; i++; continue
    }

    // Inside `< … >`. Quotes here ARE delimiters (attribute values) and must
    // return to the tag, not to code; `{` opens an expression container.
    if (state === "jsxTag") {
      // Comments between attributes are trivia, exactly as in code. `/>` is
      // checked below and cannot be confused with either opener.
      if (c === "/" && d === "/") { commentBack = "jsxTag"; state = "line"; out += "  "; i += 2; continue }
      if (c === "/" && d === "*") { commentBack = "jsxTag"; state = "block"; out += "  "; i += 2; continue }
      if (c === "'") { stringBack = "jsxTag"; state = "sq"; out += c; i++; continue }
      if (c === '"') { stringBack = "jsxTag"; state = "dq"; out += c; i++; continue }
      if (c === "{") {
        exprStack.push({ back: "jsxTag", braces: 0, jsxDepth, tagClosing })
        jsxDepth = 0; state = "code"
        out += c; i++; lastSig = "{"; word = ""; continue
      }
      if (c === "/" && d === ">") {
        // Self-closing: the element never opens, so depth is unchanged.
        out += c + d; i += 2
        state = jsxDepth > 0 ? "jsxText" : "code"
        if (state === "code") { lastSig = ")"; word = "" } // an element is a VALUE
        continue
      }
      if (c === ">") {
        out += c; i++
        if (tagClosing) {
          if (jsxDepth > 0) jsxDepth--
          state = jsxDepth > 0 ? "jsxText" : "code"
          if (state === "code") { lastSig = ")"; word = "" }
        } else {
          jsxDepth++; state = "jsxText"
        }
        continue
      }
      out += c; i++; continue
    }

    // Inside an element's children. Quotes are PROSE here — the whole of
    // DEFECT 4 — and so are `//` and `/* */`, which is why this copies verbatim.
    if (state === "jsxText") {
      if (c === "<" && d === "/") { tagClosing = true; state = "jsxTag"; out += c + d; i += 2; continue }
      if (c === "<") { tagClosing = false; state = "jsxTag"; out += c; i++; continue }
      if (c === "{") {
        exprStack.push({ back: "jsxText", braces: 0, jsxDepth, tagClosing })
        jsxDepth = 0; state = "code"
        out += c; i++; lastSig = "{"; word = ""; continue
      }
      out += c; i++; continue
    }

    if (state === "line") {
      if (c === "\n") { state = commentBack; commentBack = "code"; out += c; word = "" } else out += " "
      i++; continue
    }

    if (state === "block") {
      if (c === "*" && d === "/") {
        state = commentBack; commentBack = "code"
        out += "  "; i += 2; word = ""; continue
      }
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
      exprStack.push({ back: "tpl", braces: 0, jsxDepth, tagClosing })
      jsxDepth = 0; state = "code"
      out += src.slice(i, i + 2); i += 2; lastSig = "{"; word = ""; continue
    }
    if ((state === "sq" && c === "'") || (state === "dq" && c === '"')) {
      // `stringBack` is `jsxTag` for an attribute value, `code` otherwise.
      state = stringBack; stringBack = "code"; lastSig = c; word = ""
    } else if (state === "tpl" && c === "`") {
      state = "code"; lastSig = c; word = ""
    }
    out += c; i++
  }

  // A trailing newline (or an empty file) opens a final, characterless line
  // that the loop above never visits. Push its state so `lineStates` indexes
  // `src.split("\n")` exactly — a census that is off by one names the wrong
  // line, which is worse than not counting at all.
  if (src.length === 0 || src.endsWith("\n")) lineStates.push(state)

  // `tplDepth` keeps its name and its meaning — an expression container left
  // OPEN at EOF, which is a desync whichever shape opened it. It now counts JSX
  // containers as well as `${…}`; both are unclosed braces and neither is ever
  // legitimate at EOF. `jsxDepth` is reported separately so an unclosed ELEMENT
  // is distinguishable from an unclosed brace.
  return { code: out, endState: state, tplDepth: exprStack.length, jsxDepth, lineStates }
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
