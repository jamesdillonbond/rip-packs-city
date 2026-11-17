# pack-EV / `fmv_current`: both owed measurements are done in a QUIET window — and one of them refutes the earlier refutation's mechanism

**Filed 2026-09-01 ~23:5x PT (2026-09-02 ~07:00Z), Claude Code cloud session.**
**Nothing shipped.** The item is marked *Trevor's call* in CLAUDE.md (re-seeding a pinned fixture on
pack-EV) and that marker is respected here. What this filing does is discharge the **two measurements
the 2026-08-18 filing said must be run before either fix ships**, both of which it had to abandon
because the instance was in a saturation spell.

Continues `inbox/2026-08-18T1410Z-pack-ev-lateral-verified-and-the-array-pushdown-does-not-transfer.md`
and `inbox/2026-08-16T1829Z-fmv-current-does-not-push-down-through-distinct-on.md`.

**Positive control for the window:** at measurement time `pg_stat_activity` held **4 active client
backends, 3 in IO wait, longest active query 4 s** (against the 08-18 window's 69% of sessions in IO
wait). Every number below is warm-vs-warm on the same instrument in the same session.

---

## 1. ✅ OWED MEASUREMENT — *"does any edition actually carry snapshots under more than one
`collection_id`?"* — the answer is **NO, zero**

The 08-18 filing tried this twice and both attempts timed out. Run over the whole table:

| | |
|---|---:|
| rows in `fmv_snapshots` | **1,384,957** |
| distinct `edition_id` | **27,179** |
| editions with snapshots under **>1** `collection_id` | **0** |

**Two consequences, and the second is the one that matters for the decision.**

1. ⭐ **The feared pre-existing defect does not exist.** The 08-18 filing flagged that if such editions
   existed, the OLD `LEFT JOIN fmv_current` had been *"silently dropping the non-latest collection's
   price all along"*. It has not, because the population is empty.
2. 👉 **The coverage that re-seeding the fixture would remove is coverage of a state production has
   never held.** The pin's D3/D6 rows seed `eA` under BOTH `ts` and `other` — a state `fmv_current`
   (`DISTINCT ON (edition_id)`) cannot emit AND that the raw table has never contained. Re-seeding
   them onto distinct edition uuids per collection therefore loses nothing observable. **That does not
   make it not a decision — it makes it a much cheaper one.**

## 2. ⛔ REFUTED — the "cost crossover", and with it the last hope for a fixture-preserving fix

The 08-18 filing offered a *"leading explanation (UNCONFIRMED)"* for why the fixture-preserving
`= ANY(v_ids)` probe timed out: a planner cost crossover between ~500 ids (fast, as `/api/fmv` runs it)
and ~3,097 (the pack pool), flipping the plan off the index. It explicitly said **"this is a hypothesis,
not a measurement"** and that a chunked `= ANY` would then be a genuine third option needing no fixture
change at all.

**Plain `EXPLAIN` at six array sizes against the real `fmv_current`:**

| ids | top node | plan shape | `Index Cond`s | total cost |
|---:|---|---|---:|---:|
| 3 | Subquery Scan | Unique → Merge Append → Index Scan | 6 | 260.75 |
| 100 | Subquery Scan | *identical* | 6 | 7,899.84 |
| 500 | Subquery Scan | *identical* | 6 | 26,955.46 |
| 1,000 | Subquery Scan | *identical* | 6 | 36,042.14 |
| 1,500 | Subquery Scan | *identical* | 6 | 37,947.70 |
| 3,097 | Subquery Scan | *identical* | 6 | 43,463.46 |

**The plan never flips.** The `Index Cond` survives on all three partitions at every size, and the cost
grows **sub-linearly** — nothing like "materialise all 27k editions once". There is no crossover.

**So why did the probe time out at 55 s on 08-18? The spell.** Executed now, warm:

| shape | buffers | ms | rows |
|---|---:|---:|---:|
| `LEFT JOIN fmv_current` (the live code) | **1,046,192** (08-16 filing) | killed at 55 s | — |
| **`LEFT JOIN LATERAL … ORDER BY computed_at DESC LIMIT 1`** | **18,657** | **265** | 3,097 |
| `= ANY(3,097 uuids)` on `fmv_current` | **256,030** | 619 | 3,097 |
| `= ANY(1,000)` | 85,067 | 128 | 1,000 |
| `= ANY(500)` | 43,648 | 66 | 500 |

⭐ **The `= ANY` shape WORKS — it never needed 55 s — and it is still the wrong fix, for a reason that
is now measured rather than guessed.** Its cost is **linear in the number of ids**: 500 → 43,648,
1,000 → 85,067, 3,097 → 256,030 (= 43,648 × 6.19, within 3%). **So chunking at 500 like `/api/fmv` buys
NOTHING** — six chunks cost the same ~262k as one call. The third option is dead.

👉 **The mechanism, and it is the transferable part.** `= ANY` prunes which EDITIONS are read; it does
not prune which SNAPSHOTS. `fmv_current` is `DISTINCT ON (edition_id)`, so for every matched edition it
still reads that edition's **entire** snapshot history and then Uniques it — ~82.7 buffers per edition,
against a mean of **50.9 snapshots per edition** (1,384,957 / 27,179). The lateral's
`ORDER BY computed_at DESC LIMIT 1` stops after **one** row per edition. **A pushdown that selects rows
but not VERSIONS is not a fix for a latest-per-key view**, and no batch size changes that.

⚠ **A refutation whose stated mechanism is false is not a safe thing to inherit.** The 08-18 conclusion
(*don't take the `= ANY` route*) survives; its reasoning did not, and the reasoning is what a later
session would have re-used. The observation behind it — a 55 s timeout — was taken in the same spell the
filing itself warned was not usable for wall times, and was then read as evidence about the plan.

## 3. Where that leaves the decision

The lateral is confirmed at **18,657 buffers vs 1,046,192** — a **56× cut** — on a leg that costs
jobid 71 (`rpc-backfill-historical-pack-ev`) roughly **100 min/week of `cron_heavy` producing zero
rows**, on the instance whose IO budget is the platform's number-one problem and is pinned at 100% by
the R46 decision.

**The only remaining blocker is the one CLAUDE.md names: re-seeding D3/D6 in
`supabase/tests/compute_pack_ev_per_edition_weighted.sql`.** Both alternatives that would have avoided
it are now measured dead. Section 1 shows the coverage given up is of an impossible-and-never-observed
state.

⛔ **Deliberately NOT done here, and each for a stated reason:**
- **The migration is not written to `supabase/migrations/`.** A committed-but-unapplied migration puts
  the repo and the DB out of step and turns `npm run db:pins:check` red — the documented staleness trap,
  and the 08-18 filing's own instruction.
- **The fixture is not re-seeded.** That is the decision itself, not a mechanical edit.
- **`CREATE OR REPLACE VIEW fmv_current` is not touched** — it carries `security_invoker=true` and a
  replace with no `WITH` clause strips it. The fix is entirely caller-side.
- **The empty-`fmv_snapshots_2027` probes (~33% of the lateral's buffers) are NOT bounded away.** An
  edition whose newest snapshot predates any `computed_at` bound would silently lose its price.

**Probes cleaned up:** three `zz_probe_*` scratch functions were created via `execute_sql` and dropped;
`pg_proc` re-checked, **0 remaining**.
