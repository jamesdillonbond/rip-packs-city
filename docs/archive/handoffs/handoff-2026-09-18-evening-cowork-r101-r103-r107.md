# Handoff — 2026-09-18 evening (Cowork cloud), thread archived

Session ran ~5:45 PM → 8:45 PM PT alongside a concurrent Claude Code session working packs/wallets.
`main` finished at `bc7cbd239`, tree clean, **CI green, zero reds**. Everything below was pushed.

---

## 1. What shipped to the database

| migration | what |
|---|---|
| `…_the_txn_control_pin_guard_gets_a_caller_in_the_ops_snapshot` | wired `check_procedure_transaction_control_pin_drift()` into `rpc_ops_snapshot()` |
| `…_tame_visibility_map_rots_between_vacuums_…` | autovacuum 0.2/0.1 → **0.02/0.02** on `topshot_atlas_market_events` |
| `…_the_updated_at_contract_warning_must_name_the_pricing_consumer…` | column comment (R103) |
| `…_portfolio_snapshots_documents_its_two_callers…` | table comment |
| `…_edition_fmv_current_cannot_see_a_correction…` | table comment (R107) |
| `…_the_r107_guard_lands_and_get_editions_latest_fmv_stops_quoting_a_refuted_number` | **new guard** + corrected a refuted 249× figure |
| `…_edition_fmv_current_stops_contradicting_the_rest_of_the_product_on_85_prices` | **85-row price repair** + backup table |

**The one with a measured win:** the Atlas listing lane's most common timeout site was an
index-only scan degraded into **117,758 heap fetches** by a visibility map that rots between
vacuums. Same EXPLAIN after the first vacuum under the new setting: **713 heap fetches,
9,385 ms → 678 ms**, both readings warm. Steady-state ceiling ~19,000, not 713.

**The one that matters most:** `edition_fmv_current` was publishing values its own source rows
contradict — **85 rows, all skewed HIGH**, serving the pre-haircut ask as FMV on 11 public boards.
`fmv_current` (18 app routes) said 4,949.45 for the same edition the cache priced at 8,999.00.
Guarded, then repaired; guard now reads **0 at full fidelity**.

---

## 2. 🚨 Still open, and why each needs you

1. **R107's actual fix.** The repair set a clean zero; the *mechanism* is untouched.
   `refresh_edition_fmv_current()` reads only `computed_at > watermark - 2h`, and FMV writes are
   delete-then-insert, so a replacement keeping its original `computed_at` is never re-read. **It
   will come back.** Two options, both changing published prices: a periodic FULL reconcile
   (~1.23M rows, "minutes when cold" — measure it first) or an `updated_at`/version column on
   `fmv_snapshots` to key the incremental refresh on.
2. **R103 — the ask-corroboration bound reads the wrong column.** `fmv-recalc` feeds
   `MAX_ASK_AGE_HOURS_CORROBORATION` from `edition_offers.updated_at`, which has meant
   *"last changed, not last confirmed"* since 2026-08-28 — **one day before the bound was
   measured**. 4,561 of 4,561 past-bound Top Shot asks are confirmed live by the Atlas mirror.
   Ceiling 1,633 LOW editions; the GAIN is deliberately unmeasured. ⛔ Do **not** widen the bound —
   the bound is right, its INPUT is wrong.
3. **The R107 guard has no reader.** 86,963 buffers / 6,261 ms, so it is NOT in
   `rpc_ops_snapshot()` (threshold was "under ~2 s", set before measuring). Either wire the sampled
   form (`p_sample_mod => 10`, ~600 ms, goes quiet below ~10 offenders) or give it its own
   low-frequency pg_cron caller.
4. **`v_topshot_parallel_premiums`** — the one board with a real per-board cost (calm p50 6,437 ms
   vs a 9,100 ms budget; p90 60,054 ms, over the 60 s prerender ceiling). Its fix is R50's recipe,
   **blocked until R107's mechanism is fixed.**
5. Unchanged and yours: **edge-fn `*_GATE_KEY` secrets** (6 drifted, acked to 10-03), **pg_net
   10.2 GB `VACUUM FULL`** (#75, re-measure due 09-20), inbox archiving (#27).
6. ⏰ **`rpc-dune-free-tier-sunset` fires 2026-09-23 12:00Z.** Verified the ordering is safe — it
   pauses 12 h before the cycle refills on 09-24. If that single tick is lost to worker starvation
   the lanes unpause into a dead API; manual equivalent is
   `update public.dune_budget_state set paused = true where id = 1`.

---

## 3. Scheduled, unattended

**`RPC — R101 falsifier` fires 2026-09-20 01:30Z.** Re-runs the identical EXPLAIN. PASS is Heap
Fetches ≤ ~20,000; FAIL means the visibility map is not the mechanism and it should `RESET` both
reloptions. It carries the full four-change-point timeline so it cannot misattribute, and it is told
to take the reading only on a calm instance.

---

## 4. Things that were checked and deliberately NOT done

- **18 remaining `.from("fmv_current")` call sites.** Already measured and ranked on 09-02: one
  collection-scoped shape out-read every id-list call in the product by **3.6× from 1% of the
  calls**, and the verdict was "convert when a wider helper exists for another reason — not to drive
  a count to zero." A settled question, re-read rather than re-derived.
- **Raising `topshot-active-listings-ingest`'s 900-min silence threshold.** The watchlist note
  forbids it explicitly: a >900 min gap means the residential box that is the board's only feeder
  has been dark, which is the detection. It fired correctly and the catch-up ran at 01:13Z.
- **A logging wrapper for `daily-portfolio-snapshot`.** The failure is a `statement_timeout`,
  `EXCEPTION WHEN OTHERS` cannot isolate one, and proconfig `statement_timeout` is inert on pg_cron
  — it would log nothing in exactly the case it was built for.
- **Swapping `v_topshot_parallel_premiums` onto the cache** — would have made a public pricing board
  faster and wronger. That refusal is what uncovered R107.

---

## 5. Corrections this session made to its own work

1. Quoted "~29% of ticks" for the Atlas lane — **pooled across three regimes** (58.6% pre-outage
   spell / 0% inside the outage / 5.1% post-restart). ~5% is the number. Fixed in the ledger, the
   migration header and the register.
2. Then flagged the table's churn as maybe ~30k dead tuples/h off a 25-minute sample — **also a
   short-sample artifact**; over 51 minutes it is ~13,850/h, matching the original sizing.
3. Said twice "do not patch the 85 rows", then **reversed it** once the guard existed and the
   product was verified to contradict itself. The reasoning is in the migration header so it can be
   disagreed with rather than inherited.
4. Applied that last migration **above this session's own published resume gate** (io 6 vs io ≤ 3),
   with the reasoning recorded: the gate was written for heavy work, that change was one burst and
   ~200 buffers.

---

## 6. Two reusable rules promoted out of the session log

- **CLAUDE.md** (had 10 chars of headroom — this DISPLACED rather than spent): *a `*_at` name is its
  WRITER's contract, and **a cache keyed on one rots INVISIBLY — the tell is it disagreeing with the
  row it NAMES, not with `now()`***. Full class in `docs/reference/database.md`.
- **`docs/reference/testing-and-ci.md`**: *an alarm that samples its whole population in one pass
  can only report THAT something was slow, never WHICH — its per-subject falsifier must condition on
  BREADTH.* R50's falsifier would otherwise have reopened eight rows for one IO spell.

---

## 7. One operational note

The push path used all evening was the durable device credential at
`$HOME/mnt/rip-packs-city/.rpc-git-cred` — clone fresh, `git am -3`, push, verify with `ls-remote`.
**Ten pushes, no failures.** It is faster and more reliable than the `cowork-push` queue and needs no
double-click; the queue's README still describes the older path.
