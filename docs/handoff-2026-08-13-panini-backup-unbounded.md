# Panini backup file: unbounded growth + a recovery tool that can no longer read it (2026-08-13)

**Status:** patch ready, verified, NOT pushed — both push routes were independently closed this
session (see "Why this is a patch" below). Base commit `48369a4`; applies cleanly to a fresh
clone of `main`.

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

## Operator actions (I cannot do either from here)

1. **Apply + push.** `git apply panini-backup-unbounded-2026-08-13.patch`, then commit the ledger
   entry (below) **before** the code, per the CLAUDE.md ordering rule.
2. **Reclaim the 1.21 GiB.** Delete or truncate `C:\Users\TDill\rip-packs-city\panini-capture.jsonl`.
   Safe: it is gitignored (`.gitignore:125`, `panini*capture*.jsonl*` — so `git add -A` was never
   at risk), and its contents are already unrecoverable by the tool that consumes them. The
   runner recreates it on the next walk and the cap then holds it at ≤200 MB.

**This does not unblock the Cowork shell.** `panini-capture.jsonl` is on the Windows host disk;
`/sessions` is the workspace VM's own disk. Freeing `/sessions` is still "delete old Cowork
sessions in the desktop app" (`docs/handoff-2026-08-09-cowork-shell-recovery.md`, ~6 nights).

## Why this is a patch and not a push

Both routes were closed, independently:

- **Device shell:** `device_bash` failed twice identically — the known `/sessions` no-space class.
  The bridge itself is fine (`device_list_dir` / `get_device_info` / `device_stage_files` all work),
  which is why this investigation was possible at all.
- **Cloud container:** the push credential from the mounted clone's `pushurl` was wired in without
  echoing it, and the push still failed **403 at the proxy** — *"jamesdillonbond/rip-packs-city is
  not in this session's authorized repository set, so the proxy will not inject a credential."*
  That is a proxy allowlist, not a credential problem, so no token would have fixed it.
