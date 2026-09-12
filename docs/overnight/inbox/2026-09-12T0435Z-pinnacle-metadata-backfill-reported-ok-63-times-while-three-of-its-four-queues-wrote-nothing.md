# `pinnacle-metadata-backfill` reported `ok` 63 times in a row while three of its four queues wrote NOTHING — three causes, two fixed tonight and one filed

**2026-09-12T04:35Z (2026-09-11 21:35 PT) · Claude Code (cloud) · instance QUIET at every measurement (1 active backend, 0 IO waiters) — stated up front because every cost number below depends on it.**

Found by draining register **#71 item (1)**, which named this route's Q3/Q4 discovery pools as a false PostgREST bound and said the fix was "a bounded cursor over the pool, not a bigger limit". It is — but the pool is **56,440 rows, not the ">= 9,000" the register recorded**, and re-deriving that number is what turned a lint-shaped finding into a lane that has been converging on nothing since at least 2026-09-09.

## What the lane's own numbers say

63 retained hourly runs (73 h), **63 `ok`, 86 rows written**. Every run is byte-identical in shape:

```
q1_eligible 1 · q1_skipped_no_sample 1 · q2_eligible 50 · q3_eligible 0 · q4_eligible 2-3
catalog_upserted 1-2 · serials_filled 0 · rows_written 1-2
```

⭐ **`rows_written` equals `catalog_upserted` on every one of them**, and `rows_written` is the sum of five counters — so `mint_count_filled`, `edition_keys_resolved` and `disagreements_corrected` were **0 on all 63 runs**. ⛔ **None of those three was published in `extra`.** The instrument carried the two counters that were moving and omitted the three that were not, which is the #70 trap one level down: a per-step count with no sibling count cannot show a step that never fires.

## Cause 1 — an unordered 1,000-row head of a 56,440-row pool (FIXED tonight)

Q3 and Q4 each read their own candidate pool with `.limit(5000)` / `.limit(8000)` and **no `.order()`**. PostgREST clamps to 1,000, so each saw an undefined physical head that **never moved**.

Measured against production, not inferred:

| | reachable to the old read | actually in the collection |
|---|---|---|
| Q4 targets (composite key with no complete `pinnacle_editions` row) | 2–3 per tick | **9** |
| Q3 disagreements (`wmc.edition_key` ≠ `pinnacle_nft_map.edition_key`) | **0**, every tick | **5** |
| distinct composite edition_keys | ~unknown subset | **419** (423 incl. integer-only) |

⛔ **The obvious repair is the expensive one, and it was measured before being rejected** — all on the idle instance:

```
DISTINCT ON over the pool            38,398 buffers /  8,076 ms   (external merge sort, 4.8 MB)
full wmc x pinnacle_nft_map join    213,341 buffers / 12,110 ms   (nested loop, 56,440 probes)
the same join with nestloop off     145,054 buffers / 28,145 ms
```

⭐ **What shipped instead: a LOOSE INDEX SCAN.** `idx_wmc_coll_ek_serial_cover` is `(collection_id, edition_key, serial_number) INCLUDE (moment_id)`, so a recursive "next key strictly greater than the last" walk returns all 423 distinct keys for **2,154 buffers / 255 ms — 18× cheaper than the `DISTINCT ON`, and COMPLETE rather than a head.** Q4 resolves its targets from that list (9 of 9 reachable, **2,300 buffers / 98 ms** end to end). Q3 walks the same list behind a persisted cursor, 25 keys per tick (**1,280 rows, 5,966 buffers, 877 ms cold**), wrapping at the end: a full pass is ~17 hourly ticks, and the per-pass total (~100k buffers) is **half** the single full join it replaces.

⭐ **Positive control, run end to end before shipping the route half:** three successive calls walked the whole key list and returned **2 then 3 disagreements — the same 5 the full-scan measurement found** — then the fourth call reported `q3_wrapped: true, q3_pass: 1, q3_cursor_before: null`. Work the old read reported as `q3_eligible: 0` on 63 consecutive runs.

⚠ **The cursor advances on KEY BOUNDARIES, deliberately.** One key holds up to **1,510 rows** today, so a row-count-based page could split a key and let rows fall between two slices; a key is now always scanned whole.

## Cause 2 — the same structurally unfillable candidates are retried every hour, forever (FILED, not fixed)

Q1 and Q2 are not victims of the cap; their pools are tiny. They are victims of **never recording an attempt**.

- **Q2** selects Pinnacle `wallet_moments_cache` rows with `edition_key IS NULL`, `order by last_seen_at desc`, cap 50. The pool is **197 rows across 16 wallets, and every one of them was last seen 2026-05-07/08 — four months ago.** The order is stable, the pool does not change, so the same 50 rows are fetched and fanned out to Cadence every hour and resolve **0**.
- **Q1** has exactly **2** candidates (`mint_count IS NULL` with a non-null `edition_key`): `WDAS-LGEV3-MNF:Quartis:1` and `STAR-GEN-LFGE:Genesis:1`. One is correctly counted as `q1_skipped_no_sample`; the other is "eligible" every tick and fills nothing.

**Leading hypothesis, stated as one:** the borrow returns no `PinInfo` for these moments because the wallets no longer hold them (`if (!info) continue`), so a cache row four months stale can never resolve from the chain. ⚠ **NOT verified on-chain from here** — this sandbox has no Flow egress, production reads route through the proxy. **Falsifier:** borrow any one of the 197 `moment_id`s from its recorded wallet; if `PinInfo` comes back, the hypothesis is wrong and the bug is in the decode/apply path instead.

**Proposed fix (a real fix, not a bigger cap):** stamp an attempt on every candidate the queue fans out — a `last_metadata_attempt_at` on the wmc row, `order by … nulls first` — so the walk advances past what it cannot fill instead of re-buying the same failure hourly. ⛔ **Deliberately not shipped tonight:** it is a column on a 2.3 M-row table plus a write per attempt, and the cheaper-looking alternative (deleting stale cache rows) is a data mutation on a user-facing holdings surface, not a cleanup.

## Cause 3 — Q4's completeness test could be un-satisfied by Q4's own writer (FIXED tonight, and it refutes a guess I nearly filed)

I was about to file "Q4 upserts 1-2 rows an hour and the eligible count never falls" as *probably* the same stale-cache story as Q1/Q2. It is not, and the live read says so plainly. Three of the nine targets have **chain-written catalog rows with real on-chain mint counts** — and a `character_name` of `'Unknown'`:

```
PAS-LEEV2-TS30:Radiant Chrome:1   mint 270   updated 2026-09-10 09:22Z
PAS-LEV1-PTRE:Standard:1          mint 299   updated 2026-09-12 04:22Z   <- one tick ago
WDAS-LEEV2-P100:Radiant Chrome:1  mint 148   updated 2026-09-09 20:22Z
```

⛔ **The completeness test was `character_name <> 'Unknown'`, and the writer converts an EMPTY on-chain characterName to the literal `'Unknown'`** — deliberately, because it must not invent a name. So for any edition whose Pinnacle shape metadata carries no character, the repair writes the exact value that re-selects it next tick. **A repair loop that cannot terminate, by construction**, and the `updated_at` stamps are its fingerprints.

⚠ **And this is the one place my Q3/Q4 fix would have made things WORSE before it made them better:** completeness is now evaluated over the whole key list, so all three would be re-upserted every hour instead of occasionally.

**Fixed in migration `20260912043447`: COMPLETE now means CHAIN-WRITTEN — `edition_key` and `mint_count` both present.** That is a claim about provenance, which is what Q4 can actually establish, and it cannot be un-satisfied by the writer's own output. Measured effect: `q4_targets_total` **9 → 7**. Three rows leave the queue; ⭐ **one JOINS it — `STAR-GEN-LFGE:Genesis:1`, a real character name with a NULL `mint_count`, which is Q1's own never-filling candidate.** The predicate is not simply looser: it is a different, checkable question.

⚠ **The exclusion is PUBLISHED, not silent** — `q4_unknown_name_chain_written` (3 today) rides in the payload and in `extra`. ⛔ **Stated cost:** if Pinnacle ever populates the shape metadata for those three, nothing will pick it up — Q4 will not re-read a chain-written row. That is the deliberate trade for a lane that terminates.

## What this costs, honestly

Small. The lane is ~2.5–3.5 s per tick and writes 1–2 rows. **The finding is not the money, it is that `ok=true` and a non-zero `rows_written` held steady for 63 runs across a lane where three of four queues could not have succeeded** — and that the two instruments that would have shown it (the missing counters, and a population next to each capped list) were the two things absent from `extra`.

## Shipped with this filing

- Migrations `20260912042349` (state table + `pinnacle_metadata_discovery`) and `20260912043447` (the chain-written completeness predicate). Service-role only, RLS on, verified `anon`/`authenticated` EXECUTE false, exactly one overload, `check_secdef_anon_exec_drift()` length 0. ⭐ The committed file's function body md5s **identical** to the deployed `prosrc` (whitespace-normalised), so the repo record is the applied SQL and not a retyping of it.
- Route: both false-bound pools replaced by the RPC; an errored **or null-payload** discovery is a 500, never an empty queue (mutation-proven: forcing the old "render it as empty" branch reds the new case).
- `extra` now publishes all five write counters plus `q4_targets_total`, `distinct_edition_keys`, `q3_keys_scanned`, `q3_cursor_after`, `q3_wrapped`, `q3_pass`.

**Re-check condition for the fix (so it is falsifiable rather than declared):** within ~17 ticks the log should show `q3_wrapped: true` at least once and `disagreements_corrected` non-zero on the ticks whose slice contains the 5 known pairs; `q4_targets_total` should fall from 9 toward 0. ⚠ **If `q4_targets_total` stays at 7 while `catalog_upserted` keeps reporting rows every tick, there is a FOURTH loop of the Cause-3 shape hiding behind a different column** — look at which `pinnacle_editions` column the upsert leaves in the state the predicate rejects, exactly as `character_name` was.
