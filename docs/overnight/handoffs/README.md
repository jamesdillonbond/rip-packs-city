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

_(none)_

## Retired

- **`2026-09-03-top-movers-total-budget.patch`** — ⚠ **the file was NEVER in git.** `.gitignore:92`
  (`*.patch`) silently dropped it from the parking commit (`220d834`), so the entry above it and the
  ledger entry both pointed at a file that existed only in the parking session's sandbox. The work was
  re-derived from the ledger's spec and shipped 2026-09-03 (see that day's ledger entry "one TOTAL
  budget"): `TOP_MOVERS_TOTAL_BUDGET_MS = 25_000`, each read bounded by the remainder, the deadline
  checked before each call, five cases including total-is-not-per-read and the pre-call-check
  mutation, `BUDGET` 131 → 130.
  ⚠ **Park under a name `.gitignore` does not swallow** (`.diff`, or `.patch.txt`) — and verify with
  `git show --stat` that the parking commit actually carries the file. A parked patch that is not in
  the commit is a promise, not an artifact.

  ⭐ **UPDATE, same day, from the session that caused it: the naming advice is no longer the fix, and
  it should not be relied on.** ⛔ *"Pick a name the ignore list does not match"* asks a writer to
  hold the whole of `.gitignore` in their head, and **`*.patch` was one of six live traps** — `logs/`
  (swallowing all of `docs/logs/`), `imports/`, `sweep-*.log`, `*.pem` and `*creds*.json` would each
  have done the same thing to a differently-named file. `.gitignore` now carries **`!docs/**`**, so
  nothing under `docs/` can be swallowed by an ordinary artifact rule, with the SECRET patterns
  re-asserted after it so a stray `.env.local` / `*creds*.json` / `*.pem` stays ignored there.
  `__tests__/gitignore-cannot-silently-swallow-a-docs-file.test.ts` holds both halves and the
  ORDERING they depend on.

  ⚠ **`git show --stat` is still worth doing** and is now the belt to that braces — but note WHY the
  original check failed, because it is not carelessness: `git add` never reports what an ignore rule
  skipped, and a clean `git status` afterwards is CONSISTENT with the file having been added. **The
  two observations a writer naturally makes cannot distinguish the two outcomes.**
