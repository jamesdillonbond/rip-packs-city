# ✅ ROOT CAUSE FOUND AND FIXED — the shared comment stripper desyncs on a nested template literal, and it fails in BOTH directions at once

**Filed 2026-08-27 17:56 PT (2026-08-28 00:56Z) by Claude Code, cloud session (push-capable).**
Closes the diagnosis half of
[2026-08-27T0500Z](2026-08-27T0500Z-the-shared-comment-stripper-leaves-a-comment-line-intact-in-one-file.md),
which reproduced the symptom, falsified four hypotheses, and explicitly asked for the
instrumentation step taken here. ⭐ **Its "cheapest next step" was the right one and it worked on the
first try:** *"instrument the stripper to dump its state machine at line 80 for this file, rather
than bisecting inputs further."*

---

## 1. The mechanism

`scripts/lib/strip-comments.mjs` documented a boundary it called safe:

> ⚠ KNOWN AND DELIBERATE BOUNDARY — `${...}` inside a template literal is copied verbatim, NOT
> re-parsed. […] That is the safe direction (this stripper's failure mode must be KEEPING too much,
> never blanking too much).

🚨 **The claim in the second sentence is false, and that is the finding.** Copying an interpolation
verbatim means a **nested template literal inside it** — the commonest shape in this repo's HTML
email builders — is not recognised as nested, so its opening backtick is read as the **closing**
backtick of the OUTER literal:

```
${a.fmv != null ? `<tr><td>${fmt(a.fmv)}</td></tr>` : ""}
 ^ still `tpl`   ^ read as the OUTER literal's closing backtick
```

From there the machine is in `code` **inside HTML text**, where `/` in `</td>` opens a regex literal
and `//` in a URL opens a line comment. Traced on `app/api/check-alerts/route.ts`, the state then
ping-pongs `tpl → regex → code → regex → …` for the rest of the file.

## 2. ⭐ Why nobody found it by looking at either symptom

**Both failure directions are the SAME desync**, and they are 20 lines apart in one file:

| line | raw | what the stripper did |
|---:|---|---|
| **80** | `// \`fetch()\` has no default timeout…` | **left INTACT** — a guard reads its own explanation as evidence |
| **100** | `` `https://api.telegram.org/bot${TOKEN}/sendMessage`, `` | **BLANKED at `https:`** — real source hidden from a guard |

The 0500Z filing found line 80 and reasonably looked for something that *exposes comments*; the
recorded DEFECT-1 relative *hides code*. It concluded "they may or may not share a root". **They do,
and it is neither: it is a state desync that produces whichever symptom the next line happens to
present.** Chasing either alone leads away from it.

⛔ **So do not reason about this stripper in terms of "which direction does it fail".** Once
desynced it does both, and the direction observed is an artifact of the text that follows.

## 3. What was measured, with the controls

- **Instrument:** the stripper copied and patched to record `state` at every newline plus a
  `finalState` at EOF. Positive control (`const a = 1` → `code`) and negative control (an
  unterminated template → `tpl`) both behave, so a `code` reading is informative.
- **Population, EOF-state invariant** (a well-formed file must leave the machine in `code`):
  **9 of 2,836 files desynced before the fix, 8 after** — the 8 are all DEFECT 4 below.
- ⚠ **EOF state is a LOWER BOUND, not the population.** `check-alerts` and `support-report` desync
  *mid-file* and re-sync before EOF, so neither is in the 9. **A file passing the EOF check is not a
  file the stripper read correctly** — do not use that number as an all-clear.
- ⚠ **My first blast-radius sweep (`://` present in source, absent from output) reported 5 files and
  3 of them were FALSE POSITIVES** — trailing `// comments` containing a URL, stripped entirely
  correctly. The filter skipped lines *starting* with `//` and not lines *ending* with one. Corrected
  before use; recorded because the raw "5 files" number is wrong and may otherwise get quoted.

## 4. The fix, and the one it replaces

Interpolations are now parsed as **code** via an explicit nesting stack (`tplStack`): `${` inside a
template pushes a frame and returns to `code`; the matching `}` pops back to `tpl`. Braces are
counted only in `code` state, so strings, regexes and comments inside an interpolation cannot
miscount it. **This is the "recursive parsing" the old note warned against doing without
re-measuring — done with the re-measurement it asked for.**

⚠ **Deliberate consequence:** a `//` comment inside `${...}` **is** now stripped. That is correct JS.
The pinned boundary test was **updated, not deleted**, as its own note required.

⭐ **The negative control was found by SEARCH, not by construction.** Four hand-written "obvious"
reproducers all re-synced (even backtick parity within the line) and would have made the control
**vacuous** — a test asserting the defect was real while proving nothing. The minimal true
reproducer, verified against the pre-fix stripper loaded straight from `git show HEAD:`, is one line:

```js
const h = `<table>${a ? `<td>${x}</td>` : ""}</table>`;
```

## 5. ✅ Verification

- `__tests__/strip-comments-shared-helper.test.ts` — **18 pass**, including a paired negative control
  asserting the pre-fix stripper shows **both** failures.
- **FULL SUITE: 1,386 files / 15,204 tests, all pass.** ⭐ **This is the result that mattered most and
  it is a genuine surprise worth recording: 49 files import this helper, and revealing
  previously-hidden source to all of them reddened NOTHING.** Read honestly, that is weaker news than
  it sounds — it means no guard was *depending* on the broken behaviour, not that no guard was
  *misreading* because of it. A guard that silently under-counted still passes after it starts
  counting correctly.
- `npx tsc --noEmit` clean.

## 6. ⚠ DEFECT 4 — a second, distinct blindness, KNOWN and UNFIXED

**JSX text is not JS.** In `<p>Couldn't load</p>` the apostrophe is prose, but this is a JS parser, so
it opens an `sq` state that runs to the next apostrophe — possibly hundreds of lines on. **8 files end
in a non-`code` state for this reason** (7 `sq`, 1 `dq`), among them `app/rewards/page.tsx`,
`components/InsiderSignals.tsx` and `app/legal/fmv-methodology/page.tsx`.

✅ **Unlike DEFECT 3 this one genuinely does fail in the safe direction** — inside `sq`/`dq`
everything is copied verbatim, so the machine KEEPS too much and never blanks code. A guard may
**over-report** on those 8 files; it cannot go blind on them. Pinned in the test file with a positive
control so the boundary is visible rather than silent.

⛔ **Do not attempt a JSX fix without the same paired controls and a fresh measurement.** And note
the honest limit of the "fails safe" claim: it is safe for guards that look for a *defect*, and
**unsafe for any guard that looks for an ABSENCE** — over-reporting is a false pass there. No such
guard was identified; none was searched for either.

## 7. Revert path

`git revert` the commit, or restore `scripts/lib/strip-comments.mjs` from `415db92b5`. No DB state,
no prod data. ⚠ Reverting also reverts the ratchet lowering in the same series only if that commit is
reverted too — they are separate commits on purpose.
