# ✅ CLOSED — the `roll_pack_ask_hourly_low` deadlock WATCH did not graduate: **2 deadlocks ever, none in 8 days**

**Filed 2026-08-26 (PT) by Claude Code.** Closes the WATCH opened by
[2026-08-18T1808Z](2026-08-18T1808Z-roll-pack-ask-hourly-low-deadlock-signature-during-a-saturation-spell-SYMPTOM.md),
on that filing's **own stated exit condition** rather than on a fresh judgement.

---

## The exit condition, and the measurement against it

That filing was explicit and well-constructed: it classified the deadlock as a **SYMPTOM
observed inside a saturation spell**, refused to call it a concurrency bug from a
spell-time reading, and set the graduation rule —

> *"WATCH: graduates to a fix only if it climbs across days."*

Measured over the **full retained history** of pg_cron jobid **77**
(`rpc-roll-pack-ask-hourly-low`, `cron_heavy`, `7,22,37,52 * * * *`):

| | |
|---|---:|
| runs retained (2026-07-12 → 2026-08-26 17:37Z) | **4,326** |
| failures of any kind | 66 (1.5%) |
| **failures carrying a `deadlock detected` message** | **2 (0.05%)** |

And the two are dated:

```
2026-08-17 12:22:01Z   ERROR: deadlock detected … waits for ShareLock on transaction …
2026-08-18 18:07:01Z   ERROR: deadlock detected … waits for ShareLock on transaction …
```

**Nothing since.** That is **~770 subsequent runs across 8 days with zero deadlocks**, and
the most recent failures on this job are `job startup timeout` — the known
`max_worker_processes` class, not a lock-ordering fault.

⭐ **It did not climb across days. It did the opposite.** The hypothesis in the original
filing — *"this may be pure spell aggravation that clears on its own"* — is the one the
data supports, and the recommended `FOR UPDATE SKIP LOCKED` rewrite (correctly flagged
there as pricing-write-path work, not auto-shippable) **should not be spent.**

## ⭐ And it explains that filing's own headline number

The 08-18 filing reported **"9 fails in the check window"** with a deadlock as the
`last_fail_message`. Only **2** runs in the entire retained history carry a deadlock
message, so those nine were **failures of mixed kinds with a deadlock as the most recent
one** — not nine deadlocks.

That is exactly the instrument shape established independently in
[2026-08-26T0525Z](2026-08-26T0525Z-the-cron-reschedule-exit-condition-passes-74pct-of-the-time-if-the-fix-did-nothing.md):
**`check_pgcron_recent_failures()` gates on `l.status = 'failed'` and therefore reports
LATEST-RUN status, not "has this job been failing".** Here that shape made one signature
look like nine.

⚠ **Neither filing was wrong** — 08-18 read its instrument correctly and said so, and
labelled the whole thing a symptom. **The generalisable point is that a `last_fail_message`
attaches ONE message to a COUNT of heterogeneous failures**, so the count silently inherits
the most recent signature. **Read the message distribution, never the message beside the
count.**

## 👉 Consequence for the open WAL work

The 726 MB/day change-detection fix for this same function
([2026-08-26T1650Z](2026-08-26T1650Z-the-four-unguarded-upserts-measured-and-only-one-is-pinned.md))
is **unaffected either way**, and it is worth stating why rather than leaving it implied:
adding `WHERE pack_ask_hourly_low.low_ask > EXCLUDED.low_ask` to the `ON CONFLICT DO UPDATE`
**still takes the row lock** — Postgres must lock the conflicting row to evaluate the
predicate at all. It skips the WRITE, not the LOCK. **So it neither helps nor hurts the
deadlock question**, and should not be argued for on those grounds.
