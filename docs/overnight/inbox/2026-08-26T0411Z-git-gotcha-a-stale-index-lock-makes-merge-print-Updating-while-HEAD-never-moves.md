# Candidate: promote two git gotchas into docs/reference/tooling-gotchas.md

**Source:** live incident 2026-08-25 pushing the cron-reschedule ledger entry (`2f2736c5`), reported by Trevor. Risk: DOCS-ONLY (append a lesson to a reference file). No code, no DB.

## Lesson 1 (NEW — a lying instrument) — a stale `.git/index.lock` makes `git checkout --` and `git merge` SILENTLY no-op, and `merge` even prints a success line

A zero-byte `.git/index.lock`, 5 minutes old with **no git process alive**, silently ate a `git checkout --` and a `git merge`. The tell that makes this dangerous: `git merge` printed `Updating d347b101..45481fc1` — which reads as success — **while HEAD never moved**. So "the merge said Updating" is NOT proof the merge happened. After confirming no git process was running, removing the lock let both operations proceed.

- **Verify a merge/checkout by re-reading HEAD (`git rev-parse HEAD` before/after), never by the printed "Updating X..Y" line.**
- This is a sharper variant of the already-documented "phantom index.lock / config-NUL corruption class" on the Windows↔sandbox mount — the new part is that the failure prints a *success* message.

## Lesson 2 (reinforcement of an existing rule) — two identical-looking push rejections, two unrelated causes, in one session

Pushing the same entry failed two different ways: the **sandbox** clone failed with `could not read Username` (genuinely no credential in the harvested pushurl — the "desktop pushurl harvest is dead" case), while the **local** box failed with `tip of your current branch is behind` (non-fast-forward, 3 commits behind origin). Same goal, opposite root causes. Reaffirms the standing rule: **diagnose a push failure from the ERROR STRING, not from the fact that it failed.**

- And specifically for `docs/overnight/ledger.md`: because it is append-at-top and two upstream commits (`98955481`, `218496c0`) had also prepended, `pull --rebase` lands in a ledger conflict whose ONLY correct resolution is re-splice into upstream's freshly-read copy at the first line-start `^### ` — never hand-edit the markers. (Already in ledger-discipline.md; this is a fresh instance.)

**Suggested action (for a push-capable pass):** append Lesson 1 to `docs/reference/tooling-gotchas.md` under the Windows/Git-Bash section; Lesson 2 is already covered, cite as a dated instance if useful. Then archive this inbox file.

**Risk read:** trivial, docs-only. No behavior change.
