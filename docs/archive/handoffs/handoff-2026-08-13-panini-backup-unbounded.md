# Panini backup file: unbounded growth + a recovery tool that can no longer read it (2026-08-13)

**Status: SHIPPED 2026-08-13** — ledger `6edea505`, code `d5815d66`, ledger correction `7278aa43`.
Scripts on `main` are byte-identical to the delivered patch. 1,210 MiB reclaimed.
Written from Cowork cloud where both push routes were closed (see "Why this is a patch" below);
applied and pushed from the desktop. Base commit was `48369a4`.

⚠ **One claim in the original text below was wrong and is corrected in "Outcome" — see item 3.**
Left in place rather than edited out, because what disproved it is the point.

**Files:** `scripts/ingest-panini-runner.mjs`, `scripts/panini-replay.mjs`. Local-only runner
scripts on the residential box. No route, no DB, no migration, no cron, no prod state.

---

## What was actually wrong

Found while checking `df -h /sessions` (which could not run — see the last section).

`C:\Users\TDill\rip-packs-city\panini-capture.jsonl` is **1,268,982,254 bytes (1.21 GiB)**,
modified today, still growing.

⚠ **My first read of this was wrong and is worth recording.** I attributed it to the
`PANINI_OPS_CAPTURE_FILE` instrumentation — the *optional* discovery capture. That one is
**fine**: it caps at 25 MB and keeps one rotated generation, which is exactly what
`panini-ops-capture.jsonl` (19.8 MB) + `.jsonl.1` (26.2 MB) show. It is working as designed.

The 1.21 GiB file is `PANINI_BACKUP_FILE` — the always-on disaster-recovery backup at
`ingest-panini-runner.mjs:106`, written **before** every POST, on every batch, of every 4-hourly
walk, with **no cap, no rotation, and no pruning on success**.

The bound it needed already exists 87 lines below it, on the *less* important file. The author
reasoned explicitly about unbounded growth there — *"this runs on Trevor's residential box every
4h forever… ~3-4 MB/day compounding with nothing ever reading it"* — and capped it. The backup
file, which is written far more often and holds far more per write, got no such treatment.

## The part that matters more than the disk

`panini-replay.mjs` — the recovery tool this backup **exists to feed** — did:

```js
const lines = fs.readFileSync(FILE, "utf8").split(/\r?\n/).filter(Boolean);
```

That materializes the whole file as **one JavaScript string**. Node caps a single string at
`buffer.constants.MAX_STRING_LENGTH` = **536,870,888 bytes** on 64-bit. The backup is
**1,268,982,254 bytes — 2.36× the cap.**

So the safety net had already stopped being a safety net, silently, and would only have revealed
that at the exact moment it was needed: a bad token, a walk to recover, and the recovery script
throws `ERR_STRING_TOO_LONG` before POSTing a single batch.

**Measured, not inferred** (both scripts run against a real 550 MB fixture of the same shape):

| | batches delivered |
|---|---|
| old `panini-replay.mjs` | **0** — `ERR_STRING_TOO_LONG` |
| new `panini-replay.mjs` | **55 / 55 accepted** |

And the conversion boundary itself, pinned exactly: `Buffer.alloc(MAX).toString("utf8")` succeeds,
`Buffer.alloc(MAX+1).toString("utf8")` throws `ERR_STRING_TOO_LONG` — that is the same conversion
`readFileSync(file, "utf8")` performs internally.

## What the patch changes

**1. `ingest-panini-runner.mjs` — bound the backup.** New `appendBackup()` mirroring the
ops-capture treatment: `PANINI_BACKUP_MAX_BYTES` (default **100 MB**), rotate to `.1` rather than
truncate so a recovery already in flight keeps its evidence.

Sizing: the file reached 1.21 GiB in ~26 days live ⇒ **~46 MB/day**, ~7.8 MB/walk at 6 walks/day.
A 100 MB cap with one generation retains **100–200 MB ≈ 2–4 days ≈ 13–26 walks** — far more than
the actual recovery window, which is *one* walk (you notice a 401 within a run).

**2. `panini-replay.mjs` — stream instead of slurp.** `readline` over `createReadStream`, so the
script is independent of the cap rather than merely lucky. It also now replays the **rotated
generation first** (`.1`, then live) in capture order — without that, rotation could hide exactly
the batches you are trying to recover, reintroducing the same class of silent gap.

## Verification

- `node --check` clean on both.
- Rotation tested against the **verbatim shipped bytes** (extracted with `sed` from the patched
  file, not a retyped copy), across caps 30 / 100 / 1000 B. Properties pinned: **total never
  exceeds 2× cap**, **the newest batch is always retained**, and a fresh file with no prior
  generation **never rotates**.
- ⚠ My first version of that test asserted "10/10 lines preserved, zero loss" and **failed at
  5/10** — the assertion was wrong, not the code. With a 1-generation scheme, retention is
  bounded at 2× cap by construction; a cap small enough to force two rotations legitimately drops
  the first generation. Restated to pin the real property. Recording it because the failure mode
  is a test that would have "passed" a fix that didn't rotate at all.
- Replay tested end-to-end against a local server: rotated-first ordering (`old-1, old-2, new-1,
  new-2`), blank lines skipped, CRLF handled, plus the 550 MB old-vs-new run above.

## Operator actions (as written — both now COMPLETE)

1. **Apply + push.** `git apply panini-backup-unbounded-2026-08-13.patch`, then commit the ledger
   entry **before** the code, per the CLAUDE.md ordering rule.
2. **Reclaim the 1.21 GiB.** Delete or truncate `C:\Users\TDill\rip-packs-city\panini-capture.jsonl`.
   Safe: it is gitignored (`.gitignore:125`, `panini*capture*.jsonl*` — so `git add -A` was never
   at risk), and its contents are already unrecoverable by the tool that consumes them. The
   runner recreates it on the next walk and the cap then holds it at ≤200 MB.

**This does not unblock the Cowork shell.** `panini-capture.jsonl` is on the Windows host disk;
`/sessions` is the workspace VM's own disk. Freeing `/sessions` is still "delete old Cowork
sessions in the desktop app" (`docs/handoff-2026-08-09-cowork-shell-recovery.md`, ~6 nights).

---

## Outcome (appended 2026-08-13, post-ship)

**1. The fix validated itself in production before anyone could act on it.** The runner reads
`scripts/` straight from the working tree, so its next 4-hourly walk picked up the patched code and
the cap **fired on the real 1.21 GiB file**, rotating it to `.1`. Confirmation on the actual
artifact, not a fixture. Verified on disk: `panini-capture.jsonl.1` = 0 B (truncated),
`panini-capture.jsonl` growing normally under the cap.

**2. Verification on the real file beat the fixture.** The handoff's evidence was a 550 MB
synthetic; the desktop pass ran both paths against the **actual 1.21 GiB** artifact — old path
throws `ERR_STRING_TOO_LONG`, new path streams **15,279 batches in 3.7 s**, zero parse failures.

**3. ⚠ Operator action 2's stated safety reason above is WRONG, and this ship is what disproved
it.** "Already unrecoverable by the tool that consumes it" was true only of the *pre-patch* world.
The moment streaming replay landed — in the same ship — the file became perfectly readable, so the
justification for deleting it evaporated at the instant the deletion was authorised. **The verdict
was still right; the reason was not.** The honest reason is **already ingested**, verified by the
file's 17:23 mtime matching the newest `panini_fmv_snapshots` row exactly.

The general form, which is the reusable part: **when a fix and a destructive cleanup ship together,
the fix can invalidate the cleanup's safety argument. Re-derive that argument against the
post-patch world before acting, not the world that motivated it.**

**4. The rotation moved the destructive target mid-plan.** Between measuring 1.21 GiB and acting,
the cap rotated the blob to `.1` and a fresh live file took the old path — so the approved truncate
hit the **live** file mid-walk. Nothing lost (the backup is written before the POST, and those
POSTs were landing: 78 rows in the following 10 minutes), but by luck, not design. **Re-`stat` a
destructive target after any pause — a live writer can rename it out from under a plan that was
correct when it was made.**

## Why this is a patch and not a push

Both routes were closed, independently:

- **Device shell:** `device_bash` failed twice identically — the known `/sessions` no-space class.
  The bridge itself is fine (`device_list_dir` / `get_device_info` / `device_stage_files` all work),
  which is why this investigation was possible at all.
- **Cloud container:** the push credential from the mounted clone's `pushurl` was wired in without
  echoing it, and the push still failed **403 at the proxy** — *"jamesdillonbond/rip-packs-city is
  not in this session's authorized repository set, so the proxy will not inject a credential."*
  That is a proxy allowlist, not a credential problem, so no token would have fixed it.
