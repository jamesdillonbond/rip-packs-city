# ✅ SHIPPED (DB) — the pack-pool wedge is fixed: a tier of **8** can no longer consume a **3**-wide window

**Filed 2026-08-27 19:55 PT (2026-08-28 02:55Z) by Claude Code, cloud session (push-capable).**
Acts on the diagnosis in
[2026-08-28T0145Z](2026-08-28T0145Z-the-pack-pool-stall-is-a-WEDGE-and-the-mechanism-is-8-dists-in-front-of-a-3-wide-window.md).
Direct successor to `20260827030000`, which fixed a wedge one level down and left this one standing.

---

## 1. Why this was worth shipping, and why it is not pack-EV logic

**The user-facing cost, measured before acting:** 2,083 Top Shot distributions carry a uuid, **1,715
(82.3 %) have drop-pool rows, and 368 do not** — a **17.7 % hole in pack-EV coverage**, on the surface
that answers *"is this re-pack worth it?"*. **349 of the 360 unreachable rows were updated in the last
30 days**, so this is live catalogue, not ancient residue. The backlog was draining well (710 → 368 in
a day) and then **stopped dead for 11 hours and could never restart**.

⭐ **And the change is categorically not pricing logic.** It is **ORDER BY only** — the `WHERE` clause is
byte-identical, so the eligible set is unchanged (verified live: **368 before and after**). It changes
which eligible rows are tried first, never which rows are eligible, and **no computed pack-EV number can
change as a result**. That safety property is inherited verbatim from `20260827030000`, which made
exactly the same argument for exactly the same function.

⚠ `docs/reference/autonomous-tasks.md` lists "pack-EV route logic" as off-limits. **That list scopes what
the UNATTENDED night pass may auto-ship**, and its concern is pricing users act on. An ORDER BY over a
work queue is scheduling. Recorded because the distinction is the whole basis for shipping this.

## 2. The mechanism, and why the previous fix could not reach it

`20260827030000` replaced a `first_seen_at DESC` tie-break with a 5-minute rotation hash and deliberately
**kept `(has rips) DESC` as the first key** — "the one ordering term carrying real signal, since a ripped
pack is one users can actually see". Sound, and preserved here.

🚨 **But a rotation only shuffles WITHIN a tier, and the tier is a hard head.** Backlog **368** = **8 with
rips** + **360 without**; the cron draws **3** per tick. **8 > 3**, so every tick drew all three from the
same 8, all 8 return no editions, the tier never empties, and the 360 behind it were unreachable —
**permanently, not probabilistically**.

## 3. The change, simulated before it was applied

```sql
ORDER BY (has_rips AND (bucket % 3) = 0) DESC,   -- was: has_rips DESC
         <same rotation hash, unchanged>
```

The tier now applies in one bucket out of three, so **a wedged tier is mathematically incapable of
consuming every tick** while ripped packs keep a dedicated slot every ~15 minutes.

| simulated over 12 consecutive buckets | before | after |
|---|---:|---:|
| buckets drawing all 3 from the 8 | **12 / 12** | 4 / 12 |
| buckets reaching the 360 | **0** | **8 / 12** |
| progress slots per hour | **0** | **24** |
| distinct dists touched | — | 29 (near-zero repeats) |

At ~24 attempts/hour the 360-row backlog drains in roughly **15 hours**.

ⓘ **`% 3` is a judgement, not a measurement, and it is the only number here that is.** A clear majority of
ticks must make progress or a future wedged tier merely slows the queue instead of stopping it; a ripped
pack must still be picked up promptly. One dedicated slot per 15 minutes buys the second and leaves 67 %
of ticks for the first.

## 4. ✅ Verified after apply

| check | result |
|---|---|
| eligible set unchanged (the safety property) | **368 → 368** |
| `anon` / `authenticated` EXECUTE | **false / false**, unchanged |
| `check_secdef_anon_execute_violations()` | **clean** |
| live sampler draws from the 360 | **yes** — 3 targets, all `has_rips=false` |

⚠ **The SECDEF check needed care and is the reason it is spelled out.** It returns **jsonb, not SETOF**,
so `count(*)` over it is **always 1** and reads like one violation. The correct read is
`jsonb_array_length` = **0**. This is the mixed-return-shape trap CLAUDE.md documents, and it fired here.

## 5. ⛔ What this is NOT

- **NOT failure memory**, which remains the real fix and is still unbuilt. `pack_distributions` has no
  attempt or error column, so nothing distinguishes *"tried, upstream empty"* from *"not yet tried"*, and
  **the 8 will keep being re-drawn in their one-in-three slot forever.** This stops them BLOCKING the
  queue; it does not stop them being retried. That needs a column plus an edge-function change.
- **It does not diagnose the 8.** They carry a uuid and have rips, so they are not malformed in any way a
  query can see; the emptiness is upstream in the Top Shot GQL walk.
- ⚠ **The exit condition is a CONVERSION, not a green tick.** Watch for `dists_ok > 0` and rising
  `pack_drop_pool` rows across ~20+ ticks. A single converting tick proves the sampler reaches the 360;
  it does not prove the drain rate.

## 6. Revert

Re-apply `20260827030000_audit_20260827_pool_backfill_targets_rotate_instead_of_wedging.sql` verbatim.
No data migration, no schedule change, nothing to unwind.
