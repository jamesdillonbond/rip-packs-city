# Board-liveness precompute wrote a FRESH 999 to BOTH public_board arms — different mechanism from the documented timeout-stale carry

**Filed by rpc-daytime-monitor, 2026-08-30 ~00:15Z (2026-08-29 ~17:15 PT). READ-ONLY sweep. SYMPTOM, not a diagnosis — the write coincided with today's ~18–21Z IO-saturation band, so per Section 1c the cause is deferred to a quiet-window re-measure. I was NOT in a spell at read time (io_wait 0, active 0–1).**

## What I observed (facts)

- `rpc_ops_snapshot()` at 2026-08-30T00:06Z reports trust-health BREACH on BOTH `public_board_empty_count = 999` and `public_board_slow_count = 999` (each `breach_at = 1`).
- The precompute row is **FRESH, not stale**: `rpc_trust_health_precompute` holds `value = 999` for both metrics with `computed_at = 2026-08-29 20:48:00Z` (age 3.36h). `trust_precompute_max_age_hours = 11.96` (ok), so this is not a dead-refresher rollback.
- `public_board_liveness_watchlist` has **45 active boards (47 total)** — so 999 cannot be a real count of empty/slow boards; it is the failure sentinel.
- Primary artifact `rpc-live-health` payload query runs clean; all 6 insights boards it liveness-checks return rows (squeeze 501, rookies 61, deals 10, cross_collection 1, new_collectors 51, pack_reality_top_ev 2). Ingest fresh (FMV/PackEV/offers writes seconds–minutes old). So the public boards themselves appear live right now.

## Why this is worth a look (the new nuance)

The standing model (inbox `2026-08-15T2240Z-the-999-sentinel-is-unreachable-on-a-timeout.md`; ledger line ~13317) is that on the instance's actual failure mode — `statement_timeout` → `query_canceled` (57014), which `WHEN OTHERS` does NOT catch — the 999 sentinel **cannot be written**, so the leg goes STALE (old value + old `computed_at`), never 999. `select * from rpc_trust_health_precompute where value = 999` was historically "zero rows, ever."

Today it is the opposite: a **fresh 999 was written** to both arms with an advanced `computed_at`. So the leg completed and deliberately emitted 999 — i.e. it hit a non-`query_canceled` condition (budget_exhausted / elapsed>max_ms / an empty-probe branch) during the IO band and wrote the sentinel rather than a real count. Net effect: a **double trust-board BREACH that reads as "999 empty + 999 slow boards"** and is indistinguishable at a glance from real breakage, when only 45 boards exist and they appear live.

⚠ Context: the board-liveness sweep was **rescheduled today** (commit `d262e8bd`, "board sweep to 0/6/11/20Z + probe window 600"). The 20:48Z write is right after the new 20:00Z tick, in the tail of today's saturation band — so the fresh-999 may be a first-tick-of-new-schedule × saturation interaction.

## Source
- `rpc_ops_snapshot()` @ 2026-08-30T00:06Z; `rpc_trust_health_precompute` (metric IN public_board_empty_count/slow_count); `public_board_liveness_watchlist` count.
- Prior art: `docs/overnight/inbox/2026-08-15T2240Z-the-999-sentinel-is-unreachable-on-a-timeout.md`; CLAUDE.md trust-board reference; ledger ~line 9653/9747/9749 (`public_board_liveness_sweep` timeout-vs-budget split).

## Risk read
Low. Instrument-fidelity only — no user-facing surface is wrong (boards are live). The risk is that a recurring fresh-999 desensitizes the trust board (two permanent BREACH arms that mean "couldn't measure").

## Suggested action (quiet-window RE-MEASURE, not a causal conclusion)
1. In a quiet window (io_wait 0), after a clean board-liveness tick, re-read `rpc_trust_health_precompute` for both arms. If they hold real small counts (0–a few), this was saturation collateral on the new schedule — close it.
2. If fresh-999 recurs on clean ticks, investigate which branch of `public_board_liveness_sweep` writes 999 to both arms at once, and consider emitting NULL/INCONCLUSIVE (the convention the Pinnacle arm already uses) instead of a 999-breach when the probe cannot complete — so "couldn't measure" stops rendering as "999 boards broken."
3. Do NOT act on the 999 as if boards are empty; they are not (validated live this tick).

---

## RESOLVED 2026-08-29 20:05 PT (2026-08-30 03:05Z) — Claude Code, interactive session. Not a defect; two attributions in the filing above are WRONG and are corrected here.

**Step 1 of the suggested action was run exactly as written, in a quiet window, and it closes the item.**

- `rpc_trust_health_precompute` now holds **`public_board_empty_count = 0` and `public_board_slow_count = 0`**, `computed_at = 2026-08-30 02:48:00Z`, read at age 6 minutes with `io_wait` quiet. Real small counts, exactly the outcome step 1 named as "close it".
- Corroborated independently of the precompute: over all 57 captures in `public_board_liveness_history`, `err IS NOT NULL` is **0** and `row_count = 0` is **0**. No board has ever failed or come back empty in the retained window.

### ⛔ CORRECTION 1 — the 999 is not a new or unexplained mechanism. It is DESIGNED, and it is reachable BY CONSTRUCTION.

The filing reasons from the 08-15 model ("on a `statement_timeout` → 57014, `WHEN OTHERS` does not catch, so the sentinel *cannot* be written and the leg goes stale"). That model is correct **for the writer it was measured on** and does not govern this one. The arms are written by `rpc_thp_leg_board_liveness()` (pg_cron **jobid 326**), whose body is explicit:

```sql
IF COALESCE((v_board->>'budget_exhausted')::boolean, false) THEN
  v_empty := 999; v_slow := 999;   -- incomplete sweep is INCONCLUSIVE, not green
```

It reads the probe's **returned JSON** rather than being killed inside it, so it never needs to catch 57014 — it sets 999 off a flag the sweep hands back. `public_board_liveness_sweep()` sets that flag itself (`v_bust := true; -- coverage is incomplete this tick; stay INCONCLUSIVE`) both on budget exit and on a predictive skip. **A fresh 999 with an advanced `computed_at` is therefore the intended output of an incomplete sweep, not evidence of a new failure branch.** "Zero rows, ever" was a property of the old path, and it stopped being true when this leg was added — not when something broke.

### ⛔ CORRECTION 2 — the 20:48Z write is NOT "right after the new 20:00Z tick" of the rescheduled sweep.

The filing attributes the timing to `d262e8bd` moving the board sweep to `0/6/11/20Z`, and reads 20:48Z as its tail. Three separate jobs are involved and the arithmetic points at a different one:

| jobid | schedule | job |
|---|---|---|
| 288 | `28 0,6,11,20 * * *` | `rpc-public-board-liveness-sweep` |
| 290 | `51 0,6,11,20 * * *` | `rpc-capture-board-liveness-history` |
| **326** | **`48 2,8,14,20 * * *`** | **`rpc-thp-leg-board-liveness`** ← writes these arms |

20:48Z and 02:48Z are both **jobid 326's own long-standing `:48` slot**, unchanged by `d262e8bd`. The "first-tick-of-new-schedule × saturation" interaction is not what happened. What remains true is the saturation half: the 20:48Z tick ran inside the 18–21Z band, the sweep did not finish its rotation, and the leg reported INCONCLUSIVE.

### ⚠ A THIRD reading I formed and then falsified, recorded so nobody re-derives it

Per-capture row counts in `public_board_liveness_history` swing **45 → 38 → 8 → 1**, which looks like a sweep silently reporting `0 empty / 0 slow` over a partial population — this platform's top defect class. **It is not.** `capture_board_liveness_history()` inserts `ON CONFLICT (view_name, checked_at) DO NOTHING`, so a board whose `checked_at` did not advance is a duplicate and is skipped. Rows-per-capture is therefore *boards re-probed since the last capture* — the coverage signal, recorded correctly. The rotation (`ORDER BY s.checked_at NULLS FIRST`) is doing its job under budget pressure. 13 of 57 captures are short, and every one of them has `total_ms` ≥ 600,173 against the 600 s probe window, which is the budget binding, not a read failing.

### Recommendation on step 2: DO NOT make it NULL/INCONCLUSIVE. Close the item instead.

The filing suggests emitting NULL rather than a 999-breach so "couldn't measure" stops rendering as "999 boards broken". The concern about legibility is fair — 999 is not a count and reads like one. But the change is the wrong direction for a **trust** instrument:

- 999 fails **CLOSED** (loud, breaches, demands a look). A NULL arm would have to be given explicit breach semantics or it fails **OPEN** — the `?? 0`-on-a-count shape CLAUDE.md bans, arriving by a different route.
- The desensitisation risk the filing names is real but is not what was observed: this was **one** inconclusive tick that self-cleared on the next one, not a recurring permanent breach.

**If legibility is later worth fixing, do it in the RENDERER — display the sentinel as `INCONCLUSIVE (sweep incomplete)` — and leave the stored value at 999 so the breach semantics are untouched.** That is a display change with no instrument risk. Not shipped here: it is operator-facing polish, not a correctness fix, and this session had no measurement saying anyone has been misled by it more than once.

**Nothing shipped. No code or DB change. Status: CLOSED — instrument behaved as designed; boards were live throughout.**
