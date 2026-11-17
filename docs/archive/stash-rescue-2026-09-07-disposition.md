# Stash disposition — 2026-09-07 (PT)

The three stash entries parked on Trevor's clone were **resolved and dropped** this session.
Every patch is preserved as text in [`stash-rescue-2026-08-23/`](stash-rescue-2026-08-23/) —
nothing was lost, and each drop is justified below by evidence, not by age.

⚠ **The 2026-08-23 README in that folder says "Both entries are still in `git stash list`."
That sentence is now FALSE and is left unedited on purpose** (`docs/archive/**` is frozen
history). This file is the forward record; read it, not that sentence, for current state.

## Why each was safe to drop

`git stash list` indices shift as entries are added, so each is identified by its message and
base commit, never by index.

| stash | message | base | archived as | disposition |
|---|---|---|---|---|
| `stash@{0}` | `nightly-pass-continuity-0903` | `2f126324` | `stash-2-On-main--nightly-pass-continuity-0903.txt` | **LANDED.** Its ledger entry is in `docs/overnight/ledger.md` on main today — `grep -c '2026-09-03 · ⚪ NOTHING SHIPPED — quiet healthy night'` returns **1** in `ledger.md` and **0** in the archive, so it is live, not rolled. The other three files (`metrics-latest.json`, `docs/sessions/2026-09.md`, a handoff) are rolling state files main has since rewritten. |
| `stash@{1}` | `autostash` (2026-08-16) | `f29c3373` | `stash-0-On-main--autostash.txt` | **SUPERSEDED, and applying it would REGRESS main.** The e2e harness the 08-23 README flagged as "worth a look" has since LANDED — `e2e/healthy-page.ts` and `e2e/smoke-selfcheck.spec.ts` both resolve in `HEAD`. Its `TopSalesBoardClient.tsx` half is strictly older: it removes the 2026-09-04 CSP fix that routes arweave.net sale art through the same-origin avatar proxy (`displayImg`/`avatarDisplayUrl`), which main carries and the stash does not. |
| `stash@{2}` | `wip-catalog-fault-distinction` (2026-08-13) | `85562e25` | `stash-1-On-main--wip-catalog-fault-distinction.txt` | **SUPERSEDED, and applying it would REGRESS main.** It narrows `SEARCH_EDITIONS_QUERY` (drops `birthdate`/`birthplace`/`draftYear`), drops the `isSentinel` import main now uses at two call sites, and replaces main's measured cron comment with the stale "daily at 4am ET (cron-job.org)" claim that same comment documents as false. |

## The one thing worth salvaging was already pinned — by a test, not a comment

`stash@{2}` carried a comment absent from main: the 2026-08-11→08-12 outage where `description`
was moved **inside** `Play.stats`, the upstream answered HTTP 422 for every page, and the run
still reported `sets_processed=257 / gql_calls=257 / editions_upserted=0 / errors_count=0` — the
green-pipeline-blind-to-its-own-work shape.

⭐ **Do not port it.** Main protects that query shape with something strictly stronger:
`__tests__/api-admin-backfill-topshot-catalog.test.ts` → `it("keeps description on Play, OUTSIDE
the stats block")`, which asserts `description` is present in the query **and absent from the
stats block**, plus the mirror-image assertion that the bio fields *are* on `PlayStats`. A test
that reds on the regression beats a comment only read by someone already in the file.

## Rule this run confirms

⚠ **Diff a stash against its OWN base (`git diff 'stash@{N}^' 'stash@{N}'`), never against
`HEAD`.** `git diff HEAD stash@{0}` on this repo rendered a **42 KB, whole-tree** diff — every
commit main had made since the stash was taken, presented as if the stash had made it. The
direction also inverts: content main GAINED reads as a `-` line the stash would "remove".
