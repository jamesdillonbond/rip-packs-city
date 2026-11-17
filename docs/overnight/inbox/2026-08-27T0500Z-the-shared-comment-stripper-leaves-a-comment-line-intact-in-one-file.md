# ⚠ The SHARED comment stripper leaves a `//` line INTACT in `check-alerts/route.ts` — symptom confirmed, root cause NOT found, four hypotheses falsified

**Filed 2026-08-26 ~22:0x PT (2026-08-27 05:0xZ) by Claude Code, from Trevor's box.**
Found while building the unbounded-fetch ratchet, which the defect was silently corrupting.
⚠ **This is a REPRODUCTION plus a list of dead ends, not a diagnosis.** It is filed so the next
person does not re-test what has already been ruled out.

---

## 1. The symptom

`scripts/lib/strip-comments.mjs` — the mandatory shared stripper, enforced by
`__tests__/guards-use-the-shared-comment-stripper.test.ts` (`MAX_LOCAL_STRIPPERS`, down only) —
does **NOT** blank line 80 of `app/api/check-alerts/route.ts`:

```
// `fetch()` has no default timeout and this work runs in `after()` under
```

`stripComments(raw)` returns that line **byte-identical**. Verified by locating `fetch()` at index
4705 in the stripped output and printing both the raw and stripped line 80 — they match.

⚠ **It blanks the identical line in isolation**, and in every other file in the sweep. So this is
file-state dependent, not a problem with that line.

## 2. Why it matters beyond one file

**49 files import this helper**, and its entire purpose is to stop a guard reading its own
explanation as evidence — a trap this repo has hit at least six times. Here it **failed at exactly
that job**: my new ratchet counted the comment above as an unbounded `fetch(` call site. ⭐ **The
trap arrived THROUGH the mandated protection rather than around it**, which is the part worth
remembering: "we used the shared stripper" is not, by itself, a guarantee that comments were stripped.

⚠ **Any guard using this helper on a file with the same (unknown) property is silently reading
comment text as code.** Nobody would see it — the guard still reports a number.

## 3. ⭐ The reproduction boundary, which is the useful artifact

Bisecting the file by starting offset: **a chunk starting at line 69 reproduces; starting at line 70
does not.** Line 69 is the closing line of a multi-line HTML template literal:

```
</body></html>`;
```

Read naively that is suggestive — a scan beginning there meets a CLOSING backtick first and could
treat it as an OPENING one, putting everything after "inside a template literal" where `//` is not a
comment. ⚠ **But that explains the CHUNK, not the FULL FILE**, and the full file reproduces too. So
the boundary is a lead, not the mechanism.

## 4. ⛔ Falsified — do NOT re-test these

Each was checked in isolation against the shared stripper and **blanked correctly**:

| hypothesis | result |
|---|---|
| Backtick imbalance in the file | ⛔ **FALSIFIED by counting**: 86 backticks total (even), 20 inside `//` comments (even), 66 outside (even) |
| A template literal containing a URL (`https://…`) | ⛔ blanks correctly |
| A multi-line template literal, with or without a URL | ⛔ blanks correctly |
| A regex literal containing quote chars (`/[&<>"']/g`, line 73) | ⛔ blanks correctly, incl. single- and double-quote-only variants |
| A `//` line containing paired or odd backticks | ⛔ blanks correctly |

## 5. 👉 For whoever takes it

- The remaining suspects are **cumulative state across the file** — the recorded *block-first*
  weakness (`stripcomments-block-first-hides-real-code-from-guards`) is the obvious relative, but
  that one HIDES code, and this one **exposes comments**; they may or may not share a root.
- **Cheapest next step:** instrument the stripper to dump its state machine at line 80 for this file,
  rather than bisecting inputs further — input bisection has already given the boundary and stopped
  being informative.
- ⛔ **Do NOT "fix" it by rewording the comment.** The comment is correct; the stripper is wrong, and
  rewording hides a defect that affects 49 importers.
- ⚠ **Changing the helper is its own job** — 49 importers, and `MAX_LOCAL_STRIPPERS` exists because a
  hand-rolled copy once blanked 100k+ chars of real source and hid a live P0. Any change needs the
  existing importers re-proven, not just the new case.

## 6. What was done instead (so this is not blocking)

`__tests__/unbounded-fetch-in-after-routes-ratchet.test.ts` was made **immune** rather than made to
depend on the fix: a zero-argument `fetch()` is never a real call site (a real one always carries a
URL), so it is skipped and the count no longer depends on stripping having succeeded. Pinned with
fixtures asserting both `// see \`fetch()\` for why` and `await fetch()` count as zero.

⭐ **That is a general tactic worth reusing: where a shared helper is unreliable, prefer a check that
does not NEED the helper to be right over one that assumes it is.**
