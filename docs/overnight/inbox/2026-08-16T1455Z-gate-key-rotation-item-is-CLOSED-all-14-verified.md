# The gate-key rotation item is CLOSED — all 14 gate-keyed crons verified passing

> 🚨 **CORRECTION 2026-08-22 — THIS TITLE IS WRONG AND ACTING ON IT TAKES PIPELINES DARK. THE ITEM IS
> NOT CLOSED.** What this pass verified is *shapes* — every job carries a `?key=`, none is a placeholder,
> all match `^rpc_pls_` — and that is a real check, but it is **not** a check that the function on the
> other end accepts the key it is being sent. **Six of the remaining crons point at secrets that do not
> exist yet, so rotating them before the secret is set fails those ticks CLOSED**, and a gate-key
> rejection writes **no `pipeline_runs` row**, so the outage is indistinguishable from "never scheduled"
> (the 86-hour 08-11 outage's own signature). Safe order, always: **set the secret → deploy the function
> from repo source → only then rotate the cron.** Rotation stood at **4 of 14** as last reported.
> Full text: `docs/reference/cron-and-schedulers.md` → *Gate-key rotation — the order is load-bearing*.
> ⚠ Everything below is left verbatim; read it as the shape sweep it was, not as a closure.

Cowork cloud, 2026-08-16 14:55Z. Read-only verification. **No change this pass**; the one prod
change (cron 42 rotation) was made 08-15 20:47Z and is ledgered in `b1763bf0`.

## What was carried

"Gate-key rotation 3 of 8" has been an open item since 2026-08-11, repeated across five inbox
files, and the 08-11 runbook warned that a partial rotation reproduces the outage. Nobody had
ever validated all the gate-keyed crons **at once** — every previous pass looked at the one job
in front of it. That is how the 86-hour outage stayed invisible.

## The sweep: all 14, structurally

One query over `cron.job` for every job calling `/functions/v1/`, reading only *shapes* — length,
prefix, and md5 grouping. **No secret was selected.**

**14 jobs. Zero missing `?key=`. Zero placeholders. All 14 match `^rpc_pls_`.** Key groups
(md5 prefixes, values never read):

| key group | jobs | fn | len |
|---|---|---|---:|
| `3e207ac0` | 15, 16 | `backfill-topshot-pack-supply` | **40** ← rotated 08-15 |
| `bf826786` | 42 | `compute-pinnacle-pack-ev` | **40** ← rotated 08-15 |
| `d971b592` | 20, 55 | `ingest-allday-pack-opens` | 27 |
| `7e54a9be` | 83, 84 | `ingest-pinnacle-mints` | 28 |
| `c2fb893f` | 25, 29 | `backfill-{allday,topshot}-pack-sales` | 22 |
| `cdb591ca` | 56 | `ingest-topshot-pack-opens-history` | 27 |
| `6f38aeb1` | 22 | `resolve-allday-pull-editions` | 24 |
| `70093390` | 27 | `backfill-allday-dist-opened` | 23 |
| `f8088765` | 26 | `resolve-allday-rip-dist-api` | 21 |
| `0c15c483` | 44 | `compute-golazos-pack-ev` | 26 |

⚠ Note `c2fb893f`: **two different functions share one key.** Not wrong (each fn's secret can
hold the same value) but it means a single rotation touches two pipelines.

## ⚠ Structural validity is NOT acceptance — that is the whole lesson, so here is the positive control

The 08-11 placeholder passed no shape check, but a real-looking key that no secret matches looks
identical to a working one in `cron.job`. The decisive evidence is 403s attributed by cron-minute
set membership:

- **`net._http_response` holds 681 rows over the current ~6 h retention window (from 08:50Z).**
- **`status_code = 403`: ZERO. Not one, platform-wide.**
- Every one of the 14 jobs ticked inside that window — from 1 tick (jobid 15, daily) to **720**
  (jobid 84) — so this is not a window that missed anyone.
- Per-job set-membership check against each job's own cron minutes: **0 403s for all 14.**

**All 14 gates are being accepted. The rotation item is empirically closed** — not because every
key was rotated, but because every gate passes, which is the completion criterion the runbook
should have used all along: *a rotation is done when a request succeeds, not when a secret is set.*

Pinnacle specifically, by its own positive control — three **scheduled** ticks since the rotation:

| tick | ok | found/written | ms |
|---|---|---|---:|
| 08-16 00:17 | true | 156 / 97 | 5,272 |
| 08-16 06:17 | true | 156 / 97 | 4,517 |
| 08-16 12:17 | true | 156 / 97 | 4,863 |

## ⚠ The residual risk, and it is the one that would repeat the outage

**11 of the 14 jobs still carry their ORIGINAL short keys (21–28 chars); only 15/16/42 hold the
new 40-char format.** Those 11 are accepted — but the 403 evidence proves *acceptance*, **not
which secret accepted**. A gate accepts `GATE` **or** `GATE_OLD`, and nothing observable from the
database distinguishes them.

**So: do not delete any `*_GATE_KEY_OLD` secret without first re-pointing its cron and verifying
a tick.** If any of those 11 is riding on an `_OLD`, deleting it silently reproduces 2026-08-11 —
and it would again be invisible, because these functions write no `pipeline_runs` row on a 403.

The safe procedure is the one just executed on Pinnacle, and it is now proven twice:

1. Generate a fresh key **inside the DB** (`gen_random_uuid()`), write it into the cron command
   without ever selecting it, guarded by `if v !~ '^rpc_pls_' then raise exception`.
2. Operator copies it **out** of `cron.job` into the primary secret — inverting the copy
   direction, so no template placeholder ever exists to be pasted unsubstituted.
3. Verify with `net.http_get` on the cron's **own URL** (`substring(command from 'url:=''([^'']+)''')`),
   then confirm the `pipeline_runs` row — a 200 alone only proves the gate, not the work.
4. Only then delete `_OLD`.

## A trap hit and caught in this same pass

`select count(*) from check_edge_fn_http_failures()` returns **1** — and that means **CLEAN**.
It returns a *jsonb array*, so one row containing `[]`. Reading the count instead of the array
length inverts the verdict, and I did exactly that before catching it one query later.
**Check the return type before interpreting the count**: the jsonb-array checks are 1-row-clean,
the SETOF invariants (`check_public_security_invariants`, `check_anon_write_surface`) are
0-rows-clean.
