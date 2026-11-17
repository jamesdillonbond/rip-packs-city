# 🚨 RESOLVED — the pack-pool stall is a **WEDGE**, not a drained queue, and the mechanism is **8 permanently-empty dists sitting in front of a 3-wide window**

**Filed 2026-08-27 18:45 PT (2026-08-28 01:45Z) by Claude Code, cloud session (push-capable).**
Answers the ambiguity the 2026-08-27 ledger entry
(*"the pack-pool rotation converted 342 dists in 11 hours and then stopped dead"*, `86ecc4687`)
identified but could not resolve, and closes open reading #4 from the 2026-08-27 handoff.

⛔ **NOTHING SHIPPED.** `topshot-pack-pool-backfill` is flagged off-limits for autonomous change
(ingest/route logic, #38). This is read-only, and the fix is stated for whoever owns it.

---

## 1. The question that was open

`86ecc4687` measured the stall precisely and then stopped exactly where the evidence ran out:

> 🚨 **THE FINDING IS THE SIGNATURE, NOT THE PIPELINE.** `0/3 dists converted; 3 returned no
> editions` is **byte-identical** in the 02:00Z row and the 17:00Z row — and those are **opposite
> situations**: a sampler re-drawing three unconvertible dists forever, versus a queue whose
> convertible half is genuinely done.

✅ **It is the first one.** And the mechanism is not "re-drawing at random" — it is **deterministic**,
which is why it will never self-clear.

## 2. The mechanism, read from `prosrc`

`get_topshot_pool_backfill_targets` orders its candidates:

```sql
ORDER BY (EXISTS (SELECT 1 FROM pack_rips r WHERE …)) DESC,     -- ← tier 1: has rips
         abs(hashtext(d.dist_id || floor(epoch/300)::text))      -- ← rotation, WITHIN the tier
```

⭐ **The 5-minute rotation hash only shuffles WITHIN a tier. The tier itself is a hard head.** So:

| | count |
|---|---:|
| Top Shot dists with a uuid and no pool rows (the backlog) | **368** |
| …of which **have rips** — tier 1, always sorted first | **8** |
| …of which have no rips — tier 2, reachable only after tier 1 empties | **360** |
| targets drawn per tick | **3** |

**8 > 3.** Every tick draws all three targets from the same 8 dists, those 8 return no editions
upstream, none is ever converted, so the tier never empties — and **the 360 behind it are
unreachable forever.** The rotation is working exactly as designed and is powerless, because it
rotates inside the blockage rather than around it.

The eight: **6215, 6218, 6408, 6411, 6901, 6903, 6923, 7159.**

## 3. ✅ Positive control — the claim is simulated, not just reasoned

The ordering above is an argument; a mechanism claim needs a control. Simulated the sampler's exact
`ORDER BY` across **12 different 5-minute rotation buckets**:

| | |
|---|---:|
| buckets simulated | 12 |
| buckets whose top-3 came **entirely from the 8** | **12** |
| buckets that reached any of the 360 | **0** |

⭐ **If the stall were a drained queue, the sampler would be drawing from the 360 and finding them
empty. It never draws from them at all.** That is the discriminator the previous entry said did not
exist, and it needed no new column — only reading the ordering and simulating it.

## 4. The series, extended to n = 271

Confirms and extends `86ecc4687`'s n = 173 read. Since the fix (2026-08-27 02:00Z → 2026-08-28 01:13Z):

| window (UTC) | ticks | ok | pool rows |
|---|---:|---:|---:|
| 03:00–13:00 | 126 | **122** | **24,386** |
| 14:00 | 12 | 1 | 4 |
| **15:00 → 01:00 (11 h)** | **131** | **0** | **0** |
| **total** | **271** | **125** | **24,390** |

✅ **The statement-timeout residual is now a real measurement, not an absence: 1 of 271 (0.37 %)**,
against 15 of 274 (5.5 %) pre-fix. The handoff was right to refuse the 0-of-9 reading. **Open
reading #4 is answered.**

🚨 **But the exit condition it was checked against is NOT met.** The handoff recorded *"9 post-fix
ticks, 9 ok, 0 failures"* and read that as the dominant signature cleared. At n = 271 the failure
rate is **53.9 %**, and **144 of the 146 failures are the original signature**. ⭐ **This is the
repo's own recorded trap firing again** — the same shape as
[2026-08-26T0525Z](2026-08-26T0525Z-the-cron-reschedule-exit-condition-passes-74pct-of-the-time-if-the-fix-did-nothing.md),
where an exit condition passed 74 % of the time if the fix did nothing. **A 9-tick green streak
inside an 11-hour working window cannot distinguish a fix from its honeymoon.**

## 5. 👉 The fix, for whoever owns the pipeline

⛔ **Not "remove the `has_rips` tier"** — it exists so ripped packs (the ones users actually look up)
convert first, and it did its job for 342 distributions.

**The minimum change is to stop an unconvertible dist from holding the head.** Two options:

1. **Failure memory** — the instrument `86ecc4687` already named. An `attempts` / `last_error`
   column on `pack_distributions` (or a small side table), plus `AND attempts < N` in the sampler's
   predicate. This also fixes the identical-signature ambiguity permanently, because "tried, upstream
   empty" stops being indistinguishable from "not yet tried".
2. **Cheaper stopgap** — add `attempts`-free tier demotion by making the rotation hash the FIRST sort
   key and `has_rips` a tiebreak. Restores progress immediately but loses the rips-first priority.

⚠ **Either way the telemetry gap should close too:** `extra.dists` is **null** on all 121 stalled
ticks read — the pipeline records *how many* it tried, never *which*. Had it recorded the ids, the
repetition would have been visible in one query on day one instead of needing the ordering to be
re-derived from `prosrc`.

## 6. ⚠ Not claimed

- **Why those 8 return no editions is NOT diagnosed here.** They have rips and a uuid, so they are
  not malformed in any way this query can see; the emptiness is upstream. That is a separate question
  and it does not change the wedge.
- **368 vs the previous entry's 381** is a 13-dist move in ~8 h. I did not establish whether that is
  conversion, new dists, or the denominator trap that entry warned about — ⚠ and its warning stands:
  a naive backlog count includes non-Top-Shot rows, so **always filter by the collection id.**

## 7. Revert path

Docs only.
