# Queued — the liveness probe can be pruned by the planner, and 2 boards are still genuinely slow

Claude Code interactive, 2026-08-10 ~12:00 PT. Companion to
`2026-08-10T1700Z-board-liveness-rides-the-precompute-transaction.md` (whose "the alarm is false"
conclusion is **corrected in-file** — the alarm was a true positive).

## 0. ✅ CONFIRMED BY A FRESH SWEEP (18:58Z) — both predictions in this file held

The 18:58Z tick **succeeded** (404.8 s), so `public_board_liveness_state` refreshed for the first time
since 06:58Z and `trust_precompute_max_age_hours` reset 12.09 → **0.19**. That fresh sweep settles both
open questions with measured numbers, not inference:

**(a) The false-green is real, and worse than estimated.** `allday_scarcity_board` now probes at
**120 ms** — not the ~2,377 ms I predicted — because the pruned plan skips the FMV join entirely. The
page still pays **15,172 ms**. That is a **126× understatement**, and the board has **dropped off the
slow list altogether** while remaining ~183% over budget. Item 1 below is therefore not theoretical.

**(b) The original finding's "four of the five have no demonstrated problem at all" is REFUTED.** On a
fresh sweep, taken after the saturation window it blamed, four of the original five are still over —
two of them near 3×:

| board | fresh `elapsed_ms` | budget | % |
|---|---|---|---|
| `candy_special_serials_board` | 11,935 | 4,100 | **291%** |
| `cross_collection_deals_board` | **42,918** | 15,400 | **279%** |
| `topshot_first_mint_trophies` | 9,821 | 6,200 | 158% |
| `topshot_first_mint_trophy_stats` | 9,275 | 5,400 | 172% |
| `pack_table_rows` | 4,148 | 3,900 | 106% (**new** — was 3,440 under budget) |

⚠ `cross_collection_deals_board` is **42,918 ms, far worse than its 15,410 ms snapshot** — it is the
worst board on the estate now that AllDay's is fixed, and it is the one already carrying the standing
materialize-latest-FMV item. **Promote it above item 2.**

⚠ `public_board_slow_count` still reads **5**, so the arm looks unchanged — but the *composition*
changed underneath it (AllDay out, `pack_table_rows` in). A count-only arm cannot show that. Worth
considering whether this arm should name its members.

---

## 1. HIGH — `public_board_liveness_probe` times `count(*)`, which the planner can prune

**This is the sharpest item here, and I made it worse today.**

The probe measures every board with `EXECUTE format('SELECT count(*) FROM %s', v_reg)`. `count(*)` needs
no output columns, so **any join the planner can prove non-duplicating gets removed before execution** —
the probe then times a query the users never run.

Measured today on `allday_scarcity_board`, before/after `20260810185031`:

| | probe sees (`count(*)`) | page actually pays (FMV cols selected) |
|---|---|---|
| before (LATERAL) | 32,809 ms | ~32,809 ms — **agreed** |
| after (DISTINCT ON) | **2,377 ms** | **15,172 ms** — **6.4× understated** |

The old `LATERAL … LIMIT 1` was not provably unique, so it survived into the plan and `count(*)` was
honest by accident. `DISTINCT ON (edition_id)` **proves** `edition_id` unique, so PG removes the LEFT
JOIN. **Net effect of my own optimization: users get a 2.4× faster board, and the arm watching it goes
blind.** The arm will read GREEN at ~2.4 s for a board still at ~183% of its 8,300 ms budget.

⚠ This is the recorded caveat *"`=0` does not mean healthy — the probe times `count(*)`, which the
planner prunes"* graduating from a footnote into an active false-negative on a public board.

**Candidate fix (NOT applied — needs a decision, it will move numbers estate-wide):** force the probe to
materialize real output, e.g. `SELECT count(*) FROM (SELECT * FROM %s) t`. One line in the function.

⚠ **Do not ship this blind — three consequences to weigh first:**
1. It will raise measured time on **an unknown number of the 45 active boards**, and some will flip to
   BREACH. Those would be **true** positives, but it could turn several arms red at once.
2. **An errored probe is counted as EMPTY, not SLOW** (`v_err IS NOT NULL → n_empty`). The per-probe
   timeout is `clamp(max_ms * 1.5, 5000, 30000)`, so `allday_scarcity_board` at 15,172 ms would exceed
   its 12,450 ms cap and land in `public_board_empty_count` — reading as "renders a blank board" when it
   actually renders fine but slowly. **Fix the slow/empty conflation in the same change**, or the honest
   measurement produces a misleading label.
3. The sweep runs inside `rpc_trust_health_precompute_refresh`'s already-tight budget (see item 4).

## 2. MEDIUM — `topshot_first_mint_trophy_stats` is genuinely 3.2× over budget

`EXPLAIN ANALYZE` 2026-08-10: **17,308 ms** vs a 5,400 ms budget (the 06:58Z snapshot said 6,587 ms — it
has gotten **worse**, not better). Cost is a **Parallel Seq Scan over `sales_2026`**: 330,582 rows × 2
workers, 144,180 removed by filter, for the 180-day `serial_number > 1 AND price_usd > 0 AND
collection_id = <TS>` aggregate feeding the `avg_other_price` CTE.

Candidate: a partial covering index mirroring the proven 2026-08-08 `ed_med` fix —
`(collection_id, sold_at DESC) INCLUDE (edition_id, price_usd) WHERE serial_number > 1 AND price_usd > 0`.
⚠ **`CREATE INDEX CONCURRENTLY` only** (hot partition, constant writes), ⚠ **not runnable via the
Supabase MCP** (can't run in a txn, and the build exceeds the ~60 s tool cap) → **SQL editor / quiet
window, operator-gated**. ⚠ Also weigh the INCLUDE-blocks-HOT tradeoff on a partition the indexers write
constantly.

The other three of the five breaching boards (`topshot_first_mint_trophies`,
`candy_special_serials_board`, `cross_collection_deals_board`) were **not** individually re-measured —
do not assume they are fine, and do not assume they are broken.

## 3. LOW — `allday_scarcity_board` is still over budget after today's fix

15,172 ms vs 8,300 ms. Remaining cost is scanning **337,452** AllDay snapshot rows to pick 6,190 latest.
Further view surgery is the wrong lever; this is the standing **materialize-latest-FMV-per-edition**
item (the same one already queued for `/api/market` and `cross_collection_deals_board`). One shared
`fmv_latest` materialization would fix all three at once.

## 4. Context — the precompute is still the single point of failure

`rpc_trust_health_precompute_refresh` (jobid 222, `58 */6`) **failed again at 12:58Z on a 600.0 s kill**,
the third such failure across 08-09/08-10, always the 12:58Z tick. The probe is its passenger, so the
board arms froze at 06:58Z. `trust_precompute_max_age_hours` tracked it correctly (9.98 → 11.21 over the
session). The standing recommendation — **split it into per-leg commits using the procedure pattern
proven in prod today on `reconcile_all_saved_wallet_stats`** — is unchanged and now has a second victim.

## 5. Cosmetic — 2 orphaned rows in `public_board_liveness_state`

47 state rows vs 45 active watchlist entries. `candy_deals_board` and `topshot_underpriced_serials_board`
are `is_active = false`, but their state rows were never deleted, so they sit frozen at
**2026-08-02 01:40Z (208 h)**. They do **not** inflate any arm — the probe derives `n_slow`/`n_empty`
from its own loop over active rows, never from the table — so this is purely a hand-reading hazard. It is
exactly what made the 1700Z sweep's table read confusing. Cleanup is a 2-row delete gated on
`NOT EXISTS (… watchlist WHERE is_active)`; deliberately **not** applied here since it buys no signal.
