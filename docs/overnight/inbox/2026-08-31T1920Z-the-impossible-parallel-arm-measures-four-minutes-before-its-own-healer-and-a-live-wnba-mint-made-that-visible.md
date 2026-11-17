> ⓘ **SUPERSEDED — filed late (2026-09-12) from the claude.ai Project archive; no action for the drain.** This filing was written by a Cowork cloud pass between 2026-08-29 and 2026-09-01 that could not push, so it never reached `docs/overnight/inbox/` at the time; its ledger entry DID land. It is committed now, unedited below the banner, so that citations by path resolve and the record is complete. **Read the ledger entry for that pass, not this body.**
>
> Recovered by the 2026-09-12 Cowork session that pruned the Project (`docs/overnight/ledger.md`, 2026-09-12 · "a third push path from Cowork").

# The `topshot_impossible_parallel_serials` arm went red on a LIVE WNBA MINT — and it is structurally incapable of ever reading the healed state

**Filed 2026-08-31 19:2xZ (12:2x PT) · cloud pass, no desktop bridge, cannot push · read from the system catalog, not from a handoff**

## What is red

`v_rpc_trust_health`: **`topshot_impossible_parallel_serials` = 10, breach_at = 3, status BREACH.**
It was **not** in the 0935Z `metrics-latest.json` breach list, so it went red during today.

The other breach, `unmapped_resolution_backlog_max` = **258** (breach 100), is the known structural
`nfl_all_day` residual and is **improving**: 295 (08-29) → 275 (08-30) → 265 (08-31 09:35Z) → **258**.
⭐ And `public_board_slow_count` has **cleared** — the `candy_scarcity_board` contention trend
(390,435 ms 08-28 → 55,075 → 46,555 → worst 4,890 on 08-31) has carried it under the bar.

## The live count is ZERO

The arm's leg counts *sales rows*, not editions:

```sql
FROM editions e JOIN sales s ON s.edition_id = e.id
WHERE e.collection_id = '95f28a17-…'      -- NBA Top Shot
  AND e.external_id ~ '::'                 -- parallels only
  AND e.circulation_count > 0
  AND s.serial_number > e.circulation_count
```

Run live at **19:12:27Z: `count = 0`, distinct editions = 0.** The precomputed row says 10, stamped
**18:48:00Z**, 0.40 h old — fresh, not stale. So the arm is not broken and it is not lagging.

## ⚠ The ordering defect: the measurement fires FOUR MINUTES BEFORE the healer

| jobid | jobname | schedule | role |
|---|---|---|---|
| **324** | `rpc-thp-leg-impossible-parallel` | `48 0,6,12,18 * * *` | **measures** |
| **219** | `rpc-selfheal-impossible-parallel-circ` | `52 */6 * * *` | **heals** |

Both on the same 6-hourly cycle, measurement at **:48**, heal at **:52**. **The arm can therefore only
ever publish each cycle's PRE-HEAL PEAK** — the maximum backlog, never the residual. Both jobs
succeeded on every tick today (00:48/00:52, 06:48/06:52, 12:48/12:52, 18:48/18:52); nothing failed.

⭐ **This was introduced by the 2026-08-17 cadence cut and its consumer check could not have caught it.**
That entry moved jobid 219 from `52 * * * *` to `52 */6 * * *` and checked carefully for consumers —
*"0 `pipeline_cadence_watchlist` arms, 0 views reading the function or `impossible_parallel_circ_raises`,
0 other functions referencing either"*. **That check looked for readers of the HEALER. This arm reads
the `editions`/`sales` join directly**, names neither the function nor the raises table, and so was
invisible to it. Under the old hourly heal the pre-heal window was ~1 h and stayed under 3; at 6 h it
accumulates ~6× as much.

## But the red is ALSO telling the truth today — the inflow really did spike

`impossible_parallel_circ_raises`, editions raised per day:

| 08-18 | 08-19 | 08-20 | 08-21 | 08-22 | 08-24 | 08-25 | 08-26 | 08-27 | 08-28 | 08-29 | **08-31** |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 17 | 15 | 15 | 11 | 2 | 1 | 2 | 1 | 1 | 1 | 1 | **8** |

**Today is ~8× the trailing-week baseline**, and all seven of the 18:52Z raises are the same thing —
**WNBA parallels, Series 8, an actively-minting drop** whose recorded circulation lags real mint:

| external_id | set | old_circ → new_circ |
|---|---|---|
| `259:8950::18` | WNBA Top Shot This — Jonquel Jones | **1 → 50** |
| `257:8878::17` | WNBA Rookie Debut — Grace VanSlooten | 69 → 89 |
| `257:8871::17` | WNBA Rookie Debut — Alex Fowler | 81 → 89 |
| `257:8872::17` | WNBA Rookie Debut — Aubrey Griffin | 77 → 82 |
| `258:8913::16` | WNBA Base Set — Nyara Sabally | 89 → 96 |
| `258:8911::16` | WNBA Base Set — Dominique Malonga | 91 → 93 |
| `258:8898::16` | WNBA Base Set — A'ja Wilson | 78 → 81 |

⛔ **This is not corruption and the healer is working.** It is the ordinary "circulation is a snapshot of
a set still minting" case, monotonic and raise-only.

## The user-facing consequence, which is the part worth a decision

For **up to 6 hours** during a live mint, a WNBA parallel's `circulation_count` is below its true
supply. In that window a moment page can render a serial above its own circulation (**"#50 / 1"** for
the Jonquel Jones edition), and the `serialMultiplier` tail term prices it with a **smaller** premium
(the term clamps to 1.0 while `serial > circ`) — conservative, never inflated, per the 08-17 entry.
That entry accepted *"up to ~6 h … on ~3 editions/day"*. **Today it was 7 editions in a single cycle.**
The accepted cost has been exceeded, in the direction the entry predicted, by a live drop.

## 👉 FOR TREVOR — a threshold/cadence call, deliberately NOT taken here

Three mutually exclusive options; each has a cost, and **none is clearly-safe enough to ship
unilaterally**, which is why this is filed rather than fixed.

1. **Re-derive `breach_at` from the post-08-17 distribution.** Honest, keeps the inflow signal. But
   thresholds re-derived from a measured distribution are your call (same class as the
   `max_silent_minutes` 420-vs-676/677/474/341/335/303 item).
2. **Move jobid 324 to fire AFTER jobid 219** (e.g. `56 0,6,12,18`). One-line schedule change, no DDL,
   no pin. Makes the arm measure the **residual** — which is arguably what a self-heal verification arm
   is for — but it would then read ~0 permanently and **stop reporting inflow spikes like today's**.
   ⛔ Not taken: making a red arm green by moving the clock is exactly the move that hides a real signal.
3. **Restore the healer to hourly.** Cuts the staleness window 6 h → 1 h. ⛔ Not taken: the 08-17 entry
   cut it *because* `raise_impossible_parallel_circ()` is a heavy disk reader (~1.2 GB and ~46 s per
   call, one of the instance's top-3 readers), and reversing that trade re-adds ~6× that cost. That was
   a deliberate, documented decision two weeks old — not a cloud pass's to reverse.

⚠ **Whichever is chosen, record it against the 08-17 entry**, and add the transferable rule that entry
missed: **a consumer sweep must look for readers of the CONDITION, not only readers of the function and
its audit table.** This arm re-derives the predicate itself, so it referenced neither.
