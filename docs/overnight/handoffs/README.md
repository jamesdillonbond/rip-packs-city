# Parked patches — work that is WRITTEN but NOT VERIFIED

⛔ **Nothing in this directory has been type-checked, tested or mutation-checked.** A patch lands here
only when the session that wrote it lost the ability to run the gate before it could ship. **Do not
apply one and push it without running the full gate yourself** — the whole reason it is here rather
than on `main` is that its author could not.

## Why the directory exists

`git format-patch` hand-offs are already a documented fallback in CLAUDE.md for a session that cannot
push (`Rip Packs City/` at the repo root, gitignored). That path assumes the *push* is what failed.
This one is for the other failure: the push works and the **verification** does not, which is the
case where shipping is exactly the wrong move.

⚠ **An unverified change on `main` overnight is worse than no change**, because a red gate blocks the
next session's unrelated work and nobody is watching. Parking it costs one commit and loses nothing.

## Applying one

```bash
git apply docs/overnight/handoffs/<name>.patch
npx tsc --noEmit
npx vitest run <the tests the patch adds>
# then the mutation check the patch's own header names, then ship or discard
```

⚠ **A patch here can go stale.** It is a diff against the tree at the moment it was written; if the
files it touches have moved on, `git apply` will say so — re-derive rather than force it.

## Retiring one

Delete the file in the commit that ships the work, or in the commit that decides against it. **A patch
left here after it has shipped is a duplicate of `main` that reads as outstanding work** — the same
failure mode `docs/overnight/inbox/INDEX.md` records for an entry left behind after archiving.

---

## Live

- **`2026-09-03-top-movers-total-budget.patch`** — bounds the unbounded per-wallet loop in
  `/api/profile/top-movers` with one TOTAL deadline, each read bounded by the remainder, plus five
  test cases. Written 2026-09-03 ~02:50 PT; the ledger entry of that date carries the reasoning, the
  sizing evidence and the exact finish steps. ⚠ Its shipping commit must ALSO lower `BUDGET` from
  **131 → 130** in `__tests__/api-routes-that-degrade-honestly-also-bound-their-reads.test.ts`, which
  asserts `.toBe()` — CI goes red if the conversion lands without it.
