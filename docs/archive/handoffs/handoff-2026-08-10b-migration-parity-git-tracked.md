# Handoff — 2026-08-10 (PT) · close the `migration-parity` untracked blind spot

> ⚠ **Scope:** this is a **cloud Cowork session** limitation only. Your box and Claude Code push
> normally. **Commit and push this as usual.**

> ✅ **This payload is REGENERABLE — do not treat the patch as precious.** It is two edits to
> `scripts/check-migration-parity.mjs` and `.github/workflows/migration-parity.yml`, fully described
> below. If the patch is truncated, missing, or won't apply, **rebuild it from this document
> instead of asking for the bytes again.** (The 68-migration patch was silently truncated at exactly
> 50,000 chars in chat delivery; that failure is only expensive when the receiver has no other
> source of truth.)

**Patch:** `0002-migration-parity-git-tracked.patch` — 10,654 bytes, 2 files, +95/−15.
Applies to `f2b4030d`. Verified: `git am` onto a pristine checkout of the parent yields a
**byte-identical tree** (`13227776…`), and `node --check` passes post-apply.

```bash
cd /c/Users/TDill/rip-packs-city
git pull --rebase
git am 0002-migration-parity-git-tracked.patch
git push origin main
```

---

## The defect

`check-migration-parity.mjs` built its "repo side" from `readdirSync(supabase/migrations)`. **A file
on disk that was never `git add`ed satisfied the check.** That is not a corner case — it is the
exact state the job exists to catch: a session applies a migration via MCP, cannot push, and leaves
the `.sql` untracked in the working tree.

You found it live: `20260811033305` / `20260811033331` (candy pack-EV) sat untracked with their
ledger entry already committed, and the 3-day window read **0** the whole time. The check was blind
to its own headline scenario.

## The change

**`scripts/check-migration-parity.mjs`**

1. New `committedNames()` — reads `git ls-tree -r --name-only HEAD -- supabase/migrations`. Returns
   `null` (not an empty set) when git can't answer, so the caller can distinguish "nothing
   committed" from "couldn't look".
2. `main()` now keeps `diskNames` *and* `tracked`, and classifies each drift row:
   - `[UNTRACKED]` — on disk, absent from HEAD → fix is one `git add`
   - `[MISSING]` — no file at all → fix is a recovery
3. **No-git fallback warns loudly on stderr** and degrades to the directory scan. It never silently
   reports green under the weaker test. The summary line also switches `committed` → `on disk` so
   the log states which test actually ran.
4. Recovery instructions rewritten: pull the SQL byte-exactly from
   `supabase_migrations.schema_migrations.statements` and md5-verify, rather than retyping from a
   ledger entry. That is how the 68-migration backlog was actually repaired.

**`.github/workflows/migration-parity.yml`**

5. Second annotation for the untracked class, keyed on `^UNTRACKED (`. The **existing** annotation's
   grep string (`applied to PRODUCTION with no committed file`) is deliberately unchanged so it
   still fires.

## Verification actually run

| | result |
|---|---|
| `node --check`, YAML parse, `bash -n` on the run block | all OK |
| **Regression proof** — fixture with one committed / one untracked / one absent migration | shipped script: **exit 0**, "Every migration … has a committed file". New script: **exit 1**, `[UNTRACKED] 20260102000000 audit_bravo` |
| Both workflow greps against real output | headline MATCH · untracked MATCH |
| No-git path | warns, then degrades, and says which test ran |
| Real repo git side | 509 committed `.sql` = 509 on disk, 0 untracked (507 versioned + 2 legacy unversioned) — matches your count |

The fixture stubs `@supabase/supabase-js` with a canned `rpc()` and runs the **real script**
end-to-end, so this tests shipped code, not a re-implementation of it.

## Deliberately NOT done

- **The 30-day window still reports 316 missing.** Deep historical backlog that predates the job;
  the workflow header already classes it that way. Worth keeping stated out loud so "parity 0" at
  3/14 days is never read as "all migrations are committed".
- **The job is still reporting-only** (`|| true` + `::warning::`). Making it enforcing is your call
  and the header documents how. I'd wait until the 30-day number stops moving.
- A caveat on the new test: `git ls-tree HEAD` accepts a **locally committed but unpushed** file. In
  CI that's moot (the checkout *is* the pushed commit); locally it means the check answers "is it in
  the repo's history", not "has it reached origin".

## Revert

`git log --grep='migration-parity was blind to its own headline scenario'` → `git revert <sha>`.
Sha is not knowable in advance — `git am` re-commits under your committer identity.
CI-only change; no prod effect, no runtime code touched.
