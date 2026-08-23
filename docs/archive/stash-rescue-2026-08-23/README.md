# Stash rescue — 2026-08-23

Two stash entries were parked on this clone and flagged as at risk of silent loss.
**Nothing was dropped, applied or modified.** Both entries are still in `git stash list`.
These files are read-only backups so the work cannot vanish to a `git stash clear`,
a bad `pop`, or a future `--autostash` rebase.

| file | from | taken | base commit | notes |
|---|---|---|---|---|
| `stash-0-On-main--autostash.txt` | `stash@{0}` | 2026-08-16 11:39 PT | `f29c3373` | **Orphaned ~7 days.** A `--autostash` rebase did not restore it. 5 files: e2e smoke self-check harness (`e2e/healthy-page.ts`, `e2e/smoke-selfcheck.spec.ts`, `playwright.config.ts`) + `TopSalesBoardClient.tsx` + a ledger line. No untracked component. |
| `stash-1-On-main--wip-catalog-fault-distinction.txt` | `stash@{1}` | 2026-08-13 08:04 PT | `85562e25` | Named WIP, 3 files: catalog backfill fault distinction + its deep test. No untracked content (`stash@{1}^3` resolves but holds 0 files — verified with `git ls-tree -r`, not with `rev-parse --verify`, which only proves the ref exists). |

Both base commits are **ancestors of `origin/main`**, so either can be replayed forward.

⚠ **CLAUDE.md rule: never `pop` a stash across bases.** Check out the recorded base commit,
pop there, commit, then `git reset --soft <upstream>` — or apply the captured diff onto a
worktree at that base. Popping either of these directly onto today's `main` is how the
ledger got conflict markers before.

⚠ The `stash@{0}` e2e harness is worth a look before discarding: `e2e/` is the only
instrument on this platform that can measure layout (jsdom returns a zero box for every
element), so a smoke self-check there covers a real blind spot.
