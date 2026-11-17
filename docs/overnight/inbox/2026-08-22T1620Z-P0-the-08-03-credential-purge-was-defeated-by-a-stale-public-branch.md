# 🚨 P0 — the 2026-08-03 credential purge was DEFEATED: the purged blob is still reachable on a stale branch of the PUBLIC repo

**Filed 2026-08-22 ~09:20 PT (16:20Z), Claude Code interactive. MEASURED, with a control.
OPERATOR ACTION REQUIRED — I cannot remedy this from the sandbox. Nothing was deleted.**

---

## 1. The finding, in one line

`git filter-repo` + force-push on 2026-08-03 rewrote **`main`** to purge a leaked credential file.
**It did not rewrite `origin/claude/todo-implementation-e4tib3`, which branches from the ROOT commit and
therefore still carries the entire pre-purge history — including the purged blob.** The repo is public.

## 2. Evidence, with the control that makes it decisive

Target: `scripts/fetch-allday-collection.mjs` — the file the ledger's own P0 names (*"live Dapper
session + PII committed to a PUBLIC repo … hardcoded `cf_clearance` + `nfl_session.0/1/2` cookies and an
RS256 `ID_TOKEN` whose payload carries a real email, legal name and Flow account id … tracked since
`1c3e01a8f`"*).

| | blob reachable from `origin/main` | blob `02a86fcb` (e4tib3 only) |
|---|---|---|
| reachable from `main` | yes (1 blob, the sanitized one) | **NO** |
| `eyJ` JWT header markers | **0** | **2** |
| `ID_TOKEN` references | — | 2 |
| `nfl_session` | — | 1 |
| `PASTE_FRESH` placeholder | 0 | **0** |
| `process.env` (the safe pattern) | **4** | 2 |

The introducing commit is **`1c3e01a8f` (2026-04-13, "chore: add All Day utility scripts, gitignore creds
and data dumps")** — **the exact sha the ledger's P0 records as the leak's origin.** The sanitized
control on `main` has zero JWT markers and uses `process.env`; the branch-only blob has two JWT markers
and no placeholder. Both halves of the comparison were counted by the same instrument.

⚠ **No credential value was read, printed or decoded at any point** — every cell above is a `grep -c`
count or a reachability boolean, per CLAUDE.md's secret-safety rule. The PII characterisation is quoted
from the existing ledger P0, deliberately **not** re-derived by decoding the token.

⚠ **A wrong first hypothesis, recorded so nobody re-runs it.** I first suspected
`scripts/local-cost-basis-backfill.mjs` because 3 of its 4 historical blobs lack the
`PASTE_FRESH_COOKIES_HERE` placeholder. **Refuted:** all three are reachable from `origin/main` too and
carry **zero** `cf_clearance`/`nfl_session` markers — they simply predate that constant. "Missing
placeholder" is not "contains a secret", and the main-reachability test is what separated them.

## 3. Scope — measured, not assumed

- **`origin/claude/todo-implementation-e4tib3`** (last commit 2026-08-05): merge-base with `main` is the
  **root commit `90c508a48` (2026-03-21)**. That is the signature of pre-purge lineage — the purge
  re-hashed the root, so a non-rewritten branch shares only the original root. **CARRIES the blob.**
- **`origin/claude/todo-implementation-qi4350`** (last commit 2026-08-05): merge-base `77636a51c`
  (2026-08-04, post-purge). **Tested and CLEAN** — does not carry the blob. Its 4 unique commits are
  docs/chore work.
- `origin/claude/todo-items-issues-3jqqfx`: remote ref **no longer exists**; the stale local
  remote-tracking ref was pruned and the merged local branch deleted this session.
- **No open pull requests.**

## 4. ⚠ Deleting the branch is NOT sufficient, and it is NOT free

**Not sufficient:** on GitHub, deleting a branch makes objects unreachable but they commonly remain
fetchable **by sha** until GC, and may persist in forks and caches. This repo's own ledger already
settled the principle for a different key set: *"All 8 are permanently burned; rotation is the only
remedy."* The same applies here.

**Not free:** `e4tib3` is **not** a pure fossil. Tested on a content property rather than a sha (per
CLAUDE.md's own rule): its tip tree `d6269d5fa025` matches **no** tree in `main`'s history. One
post-purge commit is unique work — **`ee94c8a2a` (2026-08-05, "Implement panini serials persistence TODO
in Plane-A ingest draft")**. Deleting the branch without triaging that commit discards it.

⚠ **The 4,024-commits-ahead number is an ARTEFACT, not 4,024 lost changes** — it is the pre-purge
re-hash of history that is already in `main`. Reading it as unmerged work would wildly overstate what is
at stake; the honest figure is **one draft commit**.

## 5. What is actually at risk — stated precisely, not inflated

The cookies (`cf_clearance`, `nfl_session.*`) date from **2026-04-13** and are session credentials; they
are almost certainly long expired, and this filing does **not** claim a live session is exposed.

🚨 **The durable harm is the PII, which does not expire.** Per the ledger P0, the RS256 `ID_TOKEN`
payload carries a **real email address, legal name, and Flow account id** — Trevor's. That has been
publicly fetchable since 2026-04-13 and remained so after the 08-03 purge was believed to have removed
it. **This is a privacy exposure first and a credential exposure second**, and it should be triaged on
that basis.

## 6. Operator actions — in order (⛔ none of these are things I can do)

1. **Triage `ee94c8a2a`** — cherry-pick the panini-serials draft onto `main` if wanted, or explicitly
   abandon it. This is the only content the deletion costs.
2. **Delete `origin/claude/todo-implementation-e4tib3` via the GitHub UI.** ⚠ CLAUDE.md records that
   remote **delete-ref 403s from the sandbox** (push-to-ref is allowed, delete-ref is not), so this must
   be done by hand. I did not attempt it.
3. **Ask GitHub Support to garbage-collect the unreachable objects** if the PII exposure is to be
   genuinely closed rather than merely hidden — branch deletion alone leaves the blob fetchable by sha.
4. **Treat the credentials as burned.** Rotation, not purging, is the remedy; assume the cookies and
   token are compromised regardless of expiry.
5. **Consider deleting `qi4350` too** — it is clean, but it is stale and it is the other half of the
   "why are there abandoned `claude/*` branches on a public repo" question. Its 4 commits are docs/chore.

## 7. The durable lesson, for CLAUDE.md or `tooling-gotchas.md`

⚠ **A `filter-repo` purge only rewrites the refs you push. Every OTHER ref that predates it keeps the
original history, and the tell is that its merge-base with `main` is the ROOT COMMIT.** This repo already
learned the root-re-hash fact once — the 08-05 SessionStart self-heal fix is about exactly that re-hash
— but it was recorded as a *branch-alignment* gotcha, so **nobody drew the security conclusion sitting
right next to it.** After any history purge, the completion check is
`git for-each-ref` → merge-base against `main` → **anything basing at the root is unpurged**, not "the
force-push succeeded."
