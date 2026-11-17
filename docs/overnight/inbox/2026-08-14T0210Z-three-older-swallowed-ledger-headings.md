# Three older swallowed ledger headings (2026-08-11), unrepaired

**Filed** 2026-08-13 19:15 PT / 2026-08-14 02:15Z · Claude Code, interactive · read-only finding
**Severity** low (legibility + heading integrity; **no content lost**)
**Do NOT auto-ship** — see "Why this is filed and not fixed".

## What

`docs/overnight/ledger.md` carries three entry headings that were **swallowed into
prose** by a splice on the substring `### ` instead of a line-start `^### `. Same
mechanism as `697dd86b` (2026-08-13), which was repaired in the same session that
filed this; these three are older and were found only because a detector was
written instead of the damage being assumed to be a one-off.

Current locations (line numbers drift as the file grows — re-find with the
detector, do not trust these):

    awk -v show=1 -f scripts/find-swallowed-ledger-headings.awk docs/overnight/ledger.md

At filing time it printed three lines, ~1200 / ~1218 / ~1234, all inside the
2026-08-11 pair of entries:

- `2026-08-11 · SHIPPED — test coverage … OG cards now provably render their DATA branch`
- `2026-08-11 · SHIPPED — wmc now carries the FMV confidence label …`

Their bodies are additionally **interleaved and partly duplicated**: the block at
~1196-1211 and the block at ~1222-1239 repeat the same migration list, the same
"Backfill state — PARTIAL" paragraph, the same ~59 ms/row measurement and the same
"Still owed: part C" paragraph.

## Why this matters, and how much

- **Nothing is lost.** Every bullet and every revert path is present — twice in
  places. This is not the concurrent-session clobber the `ledger-guard` exists to
  stop; it is the *other* failure mode, where a heading is destroyed rather than
  deleted.
- **The two entries are unfindable by heading**, which is how every session reads
  this file (`grep '^### '`), and two host sentences are cut in half mid-word.
- **Both integrity checks passed at the time**, and structurally had to: the
  heading count went UP (a bogus fragment became a heading) and the heading SET
  lost nothing. A check that counts headings cannot see a heading turned into prose.

## Why this is filed and not fixed

Repairing today's incident was safe because it was a clean two-halves cut with a
recoverable original (`git show 697dd86b^`). These three are interleaved with
duplicated paragraphs, so a correct repair means deciding which copy of each
paragraph is canonical inside a 13,000-line file that **several sessions write
concurrently**. A wrong de-duplication would delete real content — causing exactly
the loss this would be fixing — and would need `[ledger-roll]` to get past the
guard, removing the one signal that a removal was reviewed. The cost of leaving it
is legibility; the cost of a bad fix is a destroyed revert path.

## If you do repair it

1. Recover the originals from the commits that added them —
   `git log --oneline --all -- docs/overnight/ledger.md` around 2026-08-11, then
   `git show <sha>^:docs/overnight/ledger.md` for each — and reconstruct the two
   entries as they were authored.
2. Splice at a **line-start** `^### ` only.
3. Verify with the detector (must reach 0) **and** with a heading-set diff proving
   only the bogus fragments disappeared.
4. The commit needs `[ledger-roll]`; say in the body exactly which headings were
   removed and why, since that tag also disables the clobber guard.

## Containment already in place

`scripts/find-swallowed-ledger-headings.awk` runs inside the CI `ledger-guard` as a
**delta** check: these three do not red anyone's push, but a fourth instance fails
CI on the commit that introduces it.
