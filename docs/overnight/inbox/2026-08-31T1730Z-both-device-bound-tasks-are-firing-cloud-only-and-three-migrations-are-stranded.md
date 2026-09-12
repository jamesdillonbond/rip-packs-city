> ⓘ **SUPERSEDED — filed late (2026-09-12) from the claude.ai Project archive; no action for the drain.** This filing was written by a Cowork cloud pass between 2026-08-29 and 2026-09-01 that could not push, so it never reached `docs/overnight/inbox/` at the time; its ledger entry DID land. It is committed now, unedited below the banner, so that citations by path resolve and the record is complete. **Read the ledger entry for that pass, not this body.**
>
> Recovered by the 2026-09-12 Cowork session that pruned the Project (`docs/overnight/ledger.md`, 2026-09-12 · "a third push path from Cowork").

# 2026-08-31T17:25Z — Both "device-bound" autonomous tasks are now measured firing cloud-only, 40 minutes apart, and three migrations are stranded

**Status:** needs Trevor. Nothing here was changed unilaterally.

## What is new since the 16:35Z filing

The 16:35Z pass reported that `trig_018AyNcnbCZuYb1Ztts6rbBR` ("RPC autonomous pass (every 2h) —
device-bound v2, folder-attached") **fired at 16:18Z with no device bridge**, and correctly said it
could not tell from inside the session whether the binding was never attached or the machine was
asleep at 09:18 PT.

**This session is the second data point.** It is `trig_01AZzLzkTPp5xbSjK1EFmeCw` ("RPC autonomous
pass (every 2h, device-bound: can push)"), fired on schedule at **16:58Z / 09:58 PT**, and it too has
**no `mcp__remote-devices__*` tools of any kind** — not a failed call, not an offline device: the
tool family is absent from the session, and the session banner states outright that this task was
created without computer access.

So: **two different tasks, both named device-bound, fired 40 minutes apart on the same morning, and
neither had a bridge.**

That does not distinguish "the machine was unreachable at both 09:18 and 09:58 PT" from "neither
binding is actually attached" — both remain live. It *does* rule out the narrower story that only
v2's binding was mis-set, which is what the 16:35Z filing left open.

## Live trigger state, read this pass (not quoted from a handoff)

| trigger | name | cron (UTC) | enabled | next |
|---|---|---|---|---|
| `trig_018AyNcnbCZuYb1Ztts6rbBR` | RPC autonomous pass (every 2h) — device-bound v2, folder-attached | `18 */2 * * *` | ✅ | 18:18Z |
| `trig_01AZzLzkTPp5xbSjK1EFmeCw` | RPC autonomous pass (every 2h, device-bound: can push) | `58 */2 * * *` | ✅ | 18:58Z |

**Both are enabled.** That is 24 autonomous passes a day, in pairs 40 minutes apart, each of which
may apply migrations to production.

## The cost, measured

`check-migration-parity` is authoritative **by NAME**. Derived fresh this pass against `origin/main`
`7c63fa3`: **three** migrations are applied to prod with no committed file, all of them from
cloud-only firings that could not push:

| version | applied | from |
|---|---|---|
| `20260831163201` | 16:32Z | the 16:18Z v2 firing |
| `20260831171418` | 17:14Z | this firing |
| `20260831171605` | 17:16Z | this firing |

Byte-exact text for all three is in the Project (`claude/migration-<version>-…-APPLIED-COMMIT-ONLY.sql`),
each md5-verified against `md5(array_to_string(statements, E'\n'))`. ⛔ They must be committed from
those files, never retyped.

⚠ "Migration parity" is a **daily** workflow and is path-triggered, so a docs-only commit will not
run it — these can sit green for hours.

## What needs Trevor's decision

1. **Which single task survives.** Two overlapping autonomous passes both applying DDL to the same
   production database is a hazard independent of the push problem, and it doubles the spend. The
   16:35Z pass declined to delete `trig_01AZzLzkTPp5xbSjK1EFmeCw` on the grounds that the premise for
   deleting it — that v2 can push — had just been measured false. That reasoning still holds, and
   this pass likewise changed nothing.
2. **Re-create the survivor from the Claude desktop app on the machine that should run it**, with the
   device binding attached at creation. A binding cannot be added to an existing task, and a task
   created from web or phone can never reach a computer.
3. **Check the machine is actually awake at the firing minutes**, or move the cron to hours when it
   is. Two consecutive Sunday-morning firings (09:18 and 09:58 PT) found nothing to talk to.

Until one of those happens, every cloud-only firing that ships a migration adds to the stranded pile,
and the revert path for live production SQL lives only in a Project doc.
