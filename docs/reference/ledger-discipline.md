<!-- Extracted from CLAUDE.md on 2026-08-17 to bring that file under the memory-file
char limit. Content is VERBATIM; CLAUDE.md carries a one-line pointer to this file.
Same rules apply: every number here is a dated sample - re-measure before quoting. -->

# Ledger discipline (the full rule)

## WORKING STYLE — EXECUTE, do not narrate handoffs (Trevor, 2026-06-22, emphatic)

Cowork has a push-capable git clone, Supabase MCP (read+write), Vercel/Sentry, Chrome, and the scheduled-task/artifact tools. **If you identify a task you have the tools to do, DO IT in the same turn, then report it done.** Do NOT describe a task as a "Claude Code handoff" or "operator item" and stop when you could execute it yourself. Hand off ONLY what genuinely needs access you lack — and then hand off the actual committed artifact, never a promise. Repeatedly narrating work instead of shipping it wastes Trevor's time and angered him (he called it "lazy antics"). Ship first, summarize second, keep talk minimal.

**LOG EVERY CHANGE THAT TOUCHES `main` OR PROD STATE TO THE LEDGER (Trevor, 2026-07-16).** Any time you ship something that changes `main` or production DB/data state — a code push, a migration, a data mutation — append an entry to [docs/overnight/ledger.md](../../docs/overnight/ledger.md) *in addition to* shipping and summarizing. This applies to interactive Claude Code / Cowork sessions, not just the overnight passes. Keep it short: **date · what shipped · revert path** (the `git revert <sha>` and/or `DROP FUNCTION` / undo-SQL needed to reverse it). Newest entries go at the top of the dated section, in the same turn that ships the work — not as a deferred follow-up. **RE-READ THE LEDGER FROM DISK IMMEDIATELY BEFORE WRITING IT.** It is append-at-top and multiple sessions write it concurrently. Never write back a whole copy you read earlier in the session — splice your entry into the freshly-read file. This bit on 2026-07-19: commit `fecda2e` silently deleted 13 entries (353 → 340 entries, 3,298 → 3,184 lines) *while adding* its own entry, so it looked like normal growth — destroying revert paths for live prod migrations, including Claude Code's own `candy_offers` entry. Sanity check after writing: `grep -c '^### ' docs/overnight/ledger.md` must go UP by exactly the number of entries you added; if it went DOWN you just destroyed someone's revert path. ⚠ **SPLICE AT A LINE-START `^### `, NEVER at a substring match on `### ` — and that count check CANNOT catch you if you get this wrong.** A substring splice lands mid-sentence: your heading ends up buried inside another line (so the entry has no heading at all) and the host sentence's tail becomes a bogus heading, so the count goes UP by one and the CI `ledger-guard`'s heading-SET comparison sees nothing removed. Both checks pass on a damaged file. This has happened **five times**, twice on 2026-08-13 alone: `697dd86b` cut the ledger header in half by splicing on the `### <date>` that header quoted as a format example, and `49a8702a` hit the identical point hours later **while the repair for the first was being written** — so this is not an occasional slip, it is what the write path does whenever a doc quotes the format. Three more from 2026-08-11 are still live (filed, not repaired — `docs/overnight/inbox/2026-08-14T0210Z-…`; nothing is lost there, so the risk of a bad de-duplication outweighs the legibility gain). Containment is `scripts/find-swallowed-ledger-headings.awk`, run as a DELTA check inside `ledger-guard`; run it yourself after any hand-edit. ⚠ **It PRINTS A COUNT, not one line per offender — `| wc -l` on it always reads 1 and tells you nothing.** Read the value: it is **3** today (the three un-repaired 2026-08-11 splices) and has been stable there. A whole session's worth of "swallowed=1" readings came from piping it to `wc -l`; the delta checks were still sound because they `diff`ed the full output (`3` vs `3`), but the printed label was wrong. **Compare the number, or diff the output — never count its lines.** ⚠ Its rule is subtler than it looks — "a mid-line `### <date>` not preceded by a backtick" misses the incident that motivated it, because that splice landed immediately *after* a backtick; what distinguishes a deliberate citation is a **closed** code span. A rejected `git push` means someone else landed work — re-read after the pull, never rebase a whole-file rewrite. ⚠ **WHEN THE REBASE CONFLICTS ON THE LEDGER, DO NOT HAND-EDIT THE MARKERS** — this session already committed conflict markers into it once (`6b6e0194`). The safe resolution is mechanical: `git show :2:docs/overnight/ledger.md > /tmp/theirs.md` (`:2` is the UPSTREAM side during a rebase), then re-splice YOUR entry into *that* file at the first line-start `^### ` and `git add` it. That is the same discipline as the write path — start from the freshly-read file, never from the copy you had — and it makes the count check meaningful again, because the baseline is theirs. Verified 2026-08-16: 1497 → 1498 (+1 exactly), swallowed still 3, zero markers. ⚠ **AND THE RECIPE HAS A TRAP THAT COMMITTED MARKERS A SECOND TIME (2026-08-16, caught before push, repaired by `--amend`) — the safety check itself is the hazard, and it is the SAME substring-vs-line-start class this paragraph is about.** A resolver that verifies its output with an **unanchored** `"<<<<<<<" in out` trips on any entry that *quotes* the markers in prose — and an entry describing a previous marker incident does exactly that (upstream's entry cited `` `<<<<<<< HEAD` / `=======` / `>>>>>>>` `` verbatim). So the check fired on a **correct** resolution. ⚠ **Worse, the abort did not protect anything: `git add … && git rebase --continue` ran as a SEPARATE statement, not gated on the resolver's exit code, so the un-written CONFLICTED file was staged and committed** — the guard converted a good outcome into a bad one. Two rules: **anchor the marker check to line start** (`^<<<<<<< `, `^=======$`, `^>>>>>>> `) exactly as the splice is anchored, and **gate the `git add` on the resolver actually succeeding** (`python3 … && git add … && git rebase --continue`). Recovery, if it lands anyway: it is only the 3 marker LINES that are wrong — both sides' entries are intact — so strip lines matching those anchors, assert exactly 3 were removed and that headings equal upstream+N, then `git commit --amend`. ⚠ Also **restore the blank line before your heading**: a conflict resolution can butt `### ` directly against the previous bullet, which every other entry in the file has a blank line before. ⚠ **BUT CHECK THAT ONE AS A DELTA, NEVER ABSOLUTELY — measured 2026-08-16, 303 headings already lack the blank line**, so "every heading is preceded by `\n\n`" fires on a perfectly correct resolution and is unusable as a gate. Assert `noblank(out) <= noblank(theirs)`, i.e. *I introduced no new instance*. **This is the same shape as the incident that added the rule** (a safety check that fired on a correct resolution and then broke a good commit) and it appeared on the very next resolution after that rule landed, so the generalization is worth stating outright: **a ledger check whose baseline you have not measured is a check you do not know the meaning of** — measure the file first, then decide whether the assertion is `== 0` or `<= before`. Skip it for pure research / Q&A / no-op turns that change nothing on `main` or prod — those have no revert path and only dilute the ledger.

🚨 **`git revert <sha>` paths recorded BEFORE 2026-08-03 no longer resolve, in this file and in the ledger.** The `git filter-repo` + force-push on 2026-08-03 (purging leaked live Dapper session cookies, `ba6ffef2`) rewrote every pre-purge commit sha. Measured 2026-08-03: **11 of 12** spot-checked shas are gone (`4d1b74c7`→ now `3809425b`, `e719e5e5`, `8d1b9827`, `cb46a406`, `abe40f79`, `c1d25139`, `1a4c77a7`, `f1c20d0c`, `49b92983`, `2c5c9ad2`, `b4328b17`, …). **A missing sha does NOT mean the commit never existed** — find it by its commit MESSAGE (`git log --grep=`), or recover old→new from the Vercel deployment list, which still stores each old sha beside its full commit message. **The DB half of every revert path is unaffected** (revert SQL names functions/tables, not shas). Any sha you cite from here on is post-purge and fine.

---

## The resolver's OWN guards go stale — two live instances, 2026-08-17

⚠ **Both of these fired on CORRECT splices, and both were survivable only because the `git add` was gated on the resolver's exit code.** That gating is the load-bearing part of the recipe above; without it each of these would have staged a bad file instead of refusing.

1. **The unanchored marker check, reproduced within an hour of reading the rule that documents it.** A resolver verifying its output with `'<<<<<<<' in out` aborted a correct resolution, because ledger entries **quote** conflict markers in prose — including the entries describing previous marker incidents. **Anchor to line start** (`^<<<<<<< `, `^=======$`, `^>>>>>>> `), exactly as the splice itself is anchored. This is now the **sixth** recorded instance of the substring-vs-line-start class in this file.

2. **⚠ NEW — a title assertion pinned to a literal from the PREVIOUS run.** The resolver asserted the spliced entry's heading contained a fixed string (`'CLAUDE.md refresh'`) as a sanity check that it had grabbed the right block from `:3`. That is correct exactly once: the **next** push, with a different entry, it rejected a perfectly good splice. **Parameterize it** — pass the expected title in (`sys.argv[1]`), or assert the shape (`^### 2026-`) rather than the content.

⚠ **The generalization is one this repo already holds for tests, and it applies to the write path too: a guard that NAMES its instances dies on a rename.** Three CI guards have died that way. A resolver is a guard; the same rule binds. **Assert the PROPERTY (a line-start heading, a +1 delta, no line-start markers), never a spelling you happened to use last time.**

⚠ **And keep the delta checks, which is what makes a stale guard survivable:** `headings(out) == headings(theirs) + 1` and `noblank(out) <= noblank(theirs)` are both baseline-relative, so they stayed correct across two rebases while the content-pinned assertion did not.


---

## Future-dated headings — the warning was not the fix (2026-08-17)

The ledger is dated **Pacific**. Almost every writer runs on **UTC**: CI, the cloud sandbox, the nightly pass. Between 17:00 PT and midnight PT, UTC is already on the next day, so a session that stamps from `date -u` writes a heading dated **tomorrow** — which sorts wrong in a newest-first file and reports work on a day that has not happened.

⚠ **Measured 2026-08-17: FOUR entries mis-stamped inside 35 minutes** — `4b32934` (18:21 PT), `a18c39a` (18:09), `b7ec40b` (18:04), `2892f29` (17:46), all authored on the 17th, all stamped `2026-08-18`, all interleaved with correctly-dated 08-17 entries. The warning was **already present in both this file's header and CLAUDE.md** the entire time. Four repeats past a documented warning is the signal to stop writing warnings and make the thing mechanically detectable.

**Shipped:** `scripts/find-future-dated-ledger-headings.mjs`, wired into the `ledger-guard` CI job as a **ban at population zero** (the four were corrected, so any hit is new). Prints the count, `--show` lists offenders.

- ⚠ **The guard MUST do its own UTC→PT conversion, and that is why it is Node rather than awk beside its sibling `find-swallowed-ledger-headings.awk`.** A check that asks the runner for "today" computes *the same wrong date the bug did*, so a tomorrow-stamped entry looks like today's and it passes — the guard reproduces the exact defect it exists to catch. awk has no timezone database, and the shell fallbacks are worse than useless here: `TZ=America/Los_Angeles date` in Git Bash returns UTC labelled `GMT`, and bare `date` there has read a full calendar day ahead. **Verified by running the guard under `TZ=UTC`, `Asia/Tokyo`, `Pacific/Kiritimati` and `America/New_York` — 2 every time, while a naive host-clock version scored 1 and "thought today was 2026-08-18".**
- ⚠ **Derive the date from `formatToParts`, never from a locale's format string.** Asking `Intl.DateTimeFormat("en-CA", …)` for a YYYY-MM-DD shape is a trap: on a small-ICU Node build every non-`en-US` locale silently falls back to `en-US`, which formats `M/D/YYYY`, and the string comparison then never fires. Parts are locale-independent. The guard also asserts the assembled date matches `[0-9]{4}-[0-9]{2}-[0-9]{2}` and **exits 2 rather than passing** if it cannot derive one.
- ⚠ **Match `^### <ISO date>` strictly.** A loose "heading dated later than today" comparison fires on `### <date>` (quoted as a format example in the ledger's own header) and on every `### audit_20260705_*` heading, because both sort above a numeric date as strings. All three shapes are in the fixture and must stay silent.
- ⚠ **The CI step fails loudly if `node` is absent** rather than skipping. A guard that silently no-ops is indistinguishable from a passing one.

## Revert paths: `<sha>` is the convention, and naming the SUBJECT is what makes it usable (2026-08-17)

**Measured on the live ledger**, 1,665 entries: **1,009 record a revert path with an unresolved
`<sha>` placeholder, 136 carry a real sha, 520 have no revert line at all** (research / no-op
entries, correctly). So among entries that *claim* a revert path, **88% are unresolved**. `<sha>`
appears 1,098 times against 17 for `<this sha>` — the placeholder is the house convention, not a
lapse by one writer.

⚠ **Those three buckets are CLASSIFIER-dependent, so state the rule or the next reader will read a
re-derivation as rot.** The figures above segment on `^### ` and require a `**Revert…:**` line. An
independent classifier re-derived on the same file keyed on the `git revert` ARGUMENT instead — placeholder
if it starts `<`, real if it matches `[0-9a-f]{7,40}` — and read **1,094 · 130 · 439** over 1,666
entries, because entries naming `git revert` in prose without a `**Revert:**` line move from the
third bucket into the first. **The load-bearing number is the SHARE, and it is stable across both
rules: 88% vs 89% unresolved.** Re-derive the share; do not quote the buckets.

**Decision: keep the placeholder. Do not sweep, do not gate.**

- ⛔ **Do NOT add a delta guard on the placeholder count.** Measured before proposing it: **8 of the
  11 most recent ledger-touching commits would have RED**, because a `SHIPPED` entry legitimately
  adds a placeholder every time. The count rising is the convention working, not damage — unlike the
  swallowed-heading count, which only rises on a defect. **A guard whose trigger is the normal case
  gets switched off in a week.**
- ⛔ **Do NOT sweep the backlog.** Only **551** placeholder entries are dated on/after 2026-08-03 and
  could be resolved at all; the other **460** predate the `filter-repo` purge, so their shas no
  longer exist and no sweep can recover them. A ~551-entry mechanical diff across an append-at-top
  file that several sessions write concurrently costs more collisions than it buys.
- ✅ **A placeholder is HONEST from a session that cannot push.** The sha is not knowable before the
  push, and `git pull --rebase` rewrites it afterwards — so the alternative to a placeholder is a
  *guessed* sha, which resolves locally as a dangling object and fails for everyone else. **That is
  strictly worse than an admitted blank.**

**What to write instead — name the commit SUBJECT beside the placeholder**, so the entry carries its
own recovery:

```
**Revert:** `git revert <sha>` — resolve it with:
  git revert "$(git log -1 --format=%H --grep='test(ledger-guard): derive the strict-vs-loose counts')"
```

- ✅ **Verified on full history 2026-08-17** (a shallow clone cannot test this — the first attempt
  returned "no match" purely because the clone held 87 commits, all from one day). Post-purge:
  `derive the strict-vs-loose counts` → `0632156`. **Pre-purge, where the recorded SHA is dead, the
  MESSAGE still resolves:** `concierge model-retirement guard` → `4d192be1` (2026-06-22),
  `Special Serial Owners` → `821b6a28` (2026-06-19). **Resolve-by-subject is the one recovery path
  that survives a history rewrite**, which is exactly why it beats a sha that does not.
- ✅ **It fails LOUDLY on a bad subject rather than reverting the wrong thing:** an unmatched `--grep`
  yields an empty string and `git revert ""` exits **128** with `fatal: bad revision ''`. A resolver
  that silently picked a neighbouring commit would be the dangerous version.
- ⚠ Quote the subject **distinctively enough to be unique** — `--grep` takes the most recent match,
  and this repo has many commits sharing a prefix like `docs(ledger):`.

## Two rules the 2026-08-22/23 overnight added, both learned the hard way

⚠ **READ THE SHA IN A SEPARATE COMMAND FROM THE ONE THAT WRITES THE STAMP.** The ledger already says
to stamp the real revert sha *after* the push. That is necessary and not sufficient: twice in one night
a session composed the stamp text inside the same command that printed `git log`, which makes the sha a
**prediction**, not a reading — and a rebase had moved it both times. The commit succeeds, the entry
looks right, and the revert path points at nothing. **Two commands: read, then write.**

⚠ **A CORRECTED DATE IS NOT A CLOBBER, and the guard used to say it was.**
`find-future-dated-ledger-headings.mjs` fails a heading stamped in a day that has not happened in PT.
The repair it demands — correcting the date in the heading — removes one heading string and adds
another, so the count holds and the set moves, and the no-clobber arm's bare `comm -23` read that as
the concurrent-session clobber. **The guard punished the repair its sibling demanded**, and the only
escapes were mislabelling the commit `[ledger-roll]` or leaving `main` red (measured live: `0fa5388b`
failed the first arm, `2d082db1` — its correction — failed the second).
`scripts/find-clobbered-ledger-headings.mjs` now exempts a vanished heading **only** when another
heading carries the same body. A delete, a remove-one/add-one swap at identical count, and a *reworded*
heading are all still reported; `__tests__/ledger-clobber-detector.test.ts` pins that, and mutating the
detector to exempt everything reds three of its arms.

## The inbox INDEX has the same failure mode as the ledger, and now the same kind of watcher

`docs/overnight/inbox/INDEX.md` is a map of the live queue, and it lies in both directions.
**2026-08-22 22:59** — a concurrent session wrote back a stale copy and dropped **nine** filings, one
titled HIGH-PRIORITY, exactly the clobber this file's ledger rules exist to prevent, on the other map.
**2026-08-23 ~08:00** — the overnight pass archived two drained filings and left their entries, so the
index called two closed items open. Both were caught by
`__tests__/inbox-index-lists-every-filing.test.ts` (ban at zero, both directions) on the next CI run,
neither by a reader. ⚠ **Archiving a filing means deleting its entry in the same commit** — and if the
archive decision is later reversed, the entry has to come back with it.

## 🚨 The trap none of the above catches: `git add -A` in the same command as a stash pop

**2026-08-29** — a `git stash pop` after `git pull --rebase` conflicted on the ledger, and the
`git add -A` **in the same shell command** staged the conflicted file. Three line-anchored markers
reached `main` (`211428ef7`). Every rule above was followed: the entry was re-read from disk, spliced
at a line-start `^### `, and all four guards were run and green — **before** the pull. The failure was
in the COMMAND SHAPE, not the splice, and it happened at the one moment none of the guards re-run.

Three things follow, and the third is the one that had been missing for months:

- ⛔ **Never `git add -A` in the same command as a `stash pop`, a `pull --rebase`, or a `merge`.**
  Stage by name, and only after checking for markers. A compound command hides the conflict notice
  above its own output.
- ⚠ **`git stash pop` on a conflict KEEPS the stash entry** (`git stash list` still shows it) — which
  reads like a safety net and is not one, because the working tree is already conflicted and `add -A`
  will happily commit it. Drop the stash only after the file is verified clean.
- 🚨 **The repo had extensive written guidance about this exact trap and ZERO instruments for it.**
  Nothing in 1,399 test files checked for conflict markers. `__tests__/no-conflict-markers-on-main.test.ts`
  now does, over every tracked non-binary file from `git ls-files`. **Written guidance is not an
  instrument: it fires only on someone who remembers to read it, at the moment they are least likely to.**

⚠ **The guard is line-anchored and requires BOTH an opening and a closing marker**, because an
unanchored grep for these strings returns hits on this repo's own prose describing the incident (that
false positive is recorded above), and because a Markdown setext H1 underline is a line of `=`.
Its positive control is not synthetic — it runs against `211428ef7:docs/overnight/ledger.md`, the
actual bad commit, and reds.

**Recovery, when markers do reach `main`:** both sides are usually intact and complete. Verify that
each side starts at a `^### ` heading, keep BOTH (newest first), and delete only the three marker
lines — programmatically, with the ordering asserted. Then re-run all four guards before committing.

---

## ✅ 2026-09-01 — THE RECIPE IS NOW AN EXECUTABLE: `scripts/resolve-ledger-rebase-conflict.mjs`

**Written because I hit instance SEVEN of the unanchored-marker false positive myself, roughly an hour
after reading the section above that documents it.** A rebase conflicted; I followed the recipe
correctly — re-splice into `:2:` at the first `^### `, gate `git add` on the resolver — and my *own*
retyped check was `merged.includes("<<<<<<<")`. It refused a **correct** resolution, because this ledger
quotes conflict markers in prose while describing this very class (9 occurrences in the file, **0** at
line start). ⭐ **Prose did not survive contact with retyping. Six sessions, then me.**

```bash
node scripts/resolve-ledger-rebase-conflict.mjs && git add docs/overnight/ledger.md
GIT_EDITOR=true git rebase --continue
```

It implements every rule in this file and **refuses to write unless all of them pass**, so the `&&`
gating is safe:

| rule | how |
|---|---|
| splice at a **line-start** `^### ` | `findIndex(l => /^### /.test(l))`, never a substring |
| **anchored** marker check | `/^(<<<<<<< \|=======$\|>>>>>>> )/m` — the seven-time bug |
| **gate `git add`** on the resolver | exits non-zero on any failure |
| heading delta | asserts `after - before === <entries carried>`, not a fixed +1 |
| blank-line check as a **DELTA** | asserts `noblank(out) <= noblank(upstream)` |
| no content-pinned title assertion | auto-derives the entries to carry; nothing is spelled literally |

⚠ **The blank-line baseline is computed at RUN TIME, deliberately.** This file records **303** headings
lacking a preceding blank line on 2026-08-16; the live measurement on **2026-09-01 is 80**. The number
moved, so hard-coding either one would have produced a guard that fires on a correct splice. **A ledger
check whose baseline you have not measured is a check you do not know the meaning of** — so it measures.

**It auto-derives what to carry across**: the run of headings at the top of `:3:` that `:2:` does not
have. There is no hand-typed entry file and no title literal, which retires the second stale-guard
instance recorded above. ⚠ **It deliberately refuses** if the heading delta is not exactly that count —
the correct outcome when a session ALSO edited an older entry, which this append-at-top file's recipe
does not cover.

**Proven against the known offender, not a fixture:**
`__tests__/ledger-rebase-resolver-marker-check-is-anchored.test.ts` asserts in order that (1) the
offender still exists — an unanchored pattern DOES match the live ledger, which is the non-vacuity guard
— (2) the anchored pattern does not, and (3) the script contains no `includes("<<<<<<<")`.
⭐ **Mutation-tested both ways**: reverting the script to the unanchored form reds the suite with the
intended message; restoring it greens. The guard is known to be able to FAIL, not merely observed passing.
