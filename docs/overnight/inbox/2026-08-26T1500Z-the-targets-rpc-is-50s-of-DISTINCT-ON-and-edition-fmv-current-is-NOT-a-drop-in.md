# ⭐ The `targets` RPC: #30's hypothesis is now MEASURED and CONFIRMED, three candidate fixes are falsified, and the fix is one INCLUDE column

**Filed 2026-08-26 (PT) by Claude Code, from Trevor's Windows box.** known-issues **#30**
recorded, on 2026-08-23, that *"the `DISTINCT ON` is the cost" is a well-supported
hypothesis, not a measurement*, and named the instrument that could settle it:
`EXPLAIN (ANALYZE, BUFFERS)`. **That instrument has now been run. The hypothesis holds,
and so does the precise mechanism #30 named.**

⛔ **This file also RETRACTS a claim of my own from earlier in the same session.** See
"What I got wrong" below — it is the most useful part.

---

## 1. Reproduced live, not read from a log

`RPC Deal Board Ingest` (Windows Task Scheduler, ~3 h) has `LastTaskResult = 1`. Run by
hand with `-DryRun` (writes nothing):

```
[listings-ingest] FATAL Error: GET targets failed: 500
                  {"error":"canceling statement due to statement timeout"}
```

✅ Re-confirms #30 and the 0630Z filing: **the run never reaches Atlas**, so `atlas-proxy`
cannot un-red it.

## 2. The production distribution (not a snapshot)

`pg_stat_statements`, the PostgREST caller of `topshot_serial_board_targets`, **69 calls**:

| calls | mean | min | max | stddev | disk reads/call | buffers/call |
|---:|---:|---:|---:|---:|---:|---:|
| 69 | **13,513 ms** | 2,258 ms | **29,949 ms** | 7,805 ms | 11,224 | 837,376 |

A mean at ~45% of the ceiling with a **max at 29,949 ms** is a query that fails on ordinary
contention — which is exactly what "40 of 40 runs failed" looks like.

⚠ **Ceiling caveat, stated rather than smoothed over.** 29,949 ms sits right on
`service_role`'s `statement_timeout=30s`, which is the natural reading. But
`database.md` records the opposite as *measured* — that `service_role`'s 30 s **does not
bind** on the PostgREST path, and that service_role-attributed statements reach **352 s**
on the same pool. **Both cannot be true here.** The failure is unambiguous
(`canceling statement due to statement timeout`); *which* ceiling produces it is not
settled by anything in this filing, and it does not change the fix.

## 3. ⭐ The decomposition, warm-vs-warm

Both variants run back to back on a warmed cache (a cold/warm pair would attribute cache
warming to the change — my first attempt did exactly that and is discarded):

| what ran | buffers | share |
|---|---:|---:|
| whole `topshot_serial_board_candidates(100)` | **927,466** | 100% |
| the `latest_fmv` `DISTINCT ON` + join, **no estimate calls at all** | **841,312** | **90.7%** |
| ⇒ all 14,748 `serial_fmv_estimate` calls, by difference | ~86,154 | **9.3%** |

**So #30 was right: the unbounded `DISTINCT ON` is ~91% of the query**, and
`serial_fmv_estimate` — which #30 flagged as "still unattributed" because
`pg_stat_statements.track = 'top'` hides nested statements — is **under a tenth of it.**

✅ **And #30's stated MECHANISM is confirmed verbatim by the plan**: it is an
`Index Scan`, **not** an Index Only Scan, on
`fmv_snapshots_2026_collection_id_edition_id_computed_at_idx`, reading **871,797 rows to
return 19,678**. The 120 MB sibling `fmv_snapshots_2026_coll_ed_ct_fmv_idx` carries
`INCLUDE (fmv_usd)` and the planner declines it — because `confidence` is still uncovered
and forces a heap fetch on every one of those 871,797 entries.

## 4. 🚨 What I got wrong, and why it is the durable part

⛔ **RETRACTED: my own claim, made earlier today, that ~96% of the cost is
`serial_fmv_estimate` and the `DISTINCT ON` is only ~4%.**

I measured the CTE "in isolation" as **32,641 buffers / 50,245 ms** and subtracted it from
the whole. That isolate selected **only `edition_id`** — a column the index covers — so
Postgres served it as an **Index Only Scan**. The function selects `fmv_usd` and
`confidence` too, which forces an **Index Scan**. The same CTE costs **32,641 buffers in
my isolate and 818,698 in context: a 25× difference produced entirely by the projection.**

⭐ **The lesson: changing what a query SELECTs can change its PLAN, so an "isolated" measurement
of a sub-expression is only valid if you isolate it with the same output columns the real
query asks for.** I had a number, a control, and a subtraction — and the whole thing was
measuring a plan the code never runs. **This is the shape that produces confidently wrong
answers with good arithmetic on top.**

## 5. Three candidate fixes, all falsified by measurement

**(a) Defer the second `serial_fmv_estimate` behind the floor** — the 0630Z filing's first
suggestion. Only **984 of 7,374 rows (13.3%)** survive the `$100` floor, so 6,390 of 14,748
calls are computed and thrown away, which looks like a 43% saving.
✅ **Provably equivalent** — built as a candidate function and diffed with `EXCEPT ALL` in
**both directions**, at the production floor **and** at `floor = 0` (the boundary where
`COALESCE(no1, perfect) IS NOT NULL` actually depends on the deferred value):
`984 = 984, 0/0` and `7,374 = 7,374, 0/0`.
⛔ **And it saves 1.7%** — 927,466 → 911,678 buffers — because the estimate calls are only
9.3% of the query to begin with. *Correct, safe, and not worth a migration on its own.*

**(b) Swap the CTE for `edition_fmv_current`** — identical row count (19,678), **111×
faster, 36× fewer buffers**, and **still wrong**: diffed over the whole population it
carries **233 `fmv_usd` and 79 `confidence` disagreements**, moving HIGH/MEDIUM membership
**7,538 → 7,568**, i.e. it **admits 30 editions the board does not currently show**.
⭐ Second time in one day that this lagging materialisation matched on COUNT and diverged
on VALUE. The `refresh_wmc_fmv_changed` fix could guard against it because the queue
carries a `computed_at` to compare; **here there is no such timestamp, so no guard exists.**
ⓘ This is also consistent with #30's existing warning not to reach for `fmv_current`.

**(c) A LATERAL loose-index-scan** — exactly equivalent, 2.4× faster, and **2.5× WORSE on
buffers** (83,078 vs 32,641 on the isolate). On an IO-bound instance buffers are the honest
instrument. Rejected.

## 6. 👉 The fix: one more column in an index that already exists

`fmv_snapshots_2026_coll_ed_ct_fmv_idx` is **already maintained for exactly this shape**:

```
btree (collection_id, edition_id, computed_at DESC) INCLUDE (fmv_usd)      -- 120 MB
```

**`confidence` is the only uncovered column the CTE reads.** Adding it makes the index
covering, which turns the `Index Scan` back into an `Index Only Scan` — the same plan my
(accidentally) isolated measurement produced at **32,641 buffers instead of 818,698**.

- Predicted: **~91% of the query's cost falls by ~25×**; mean 13.5 s → low single-digit
  seconds, with real headroom under the ceiling instead of a max at 99.8% of it.
- **No semantics change whatsoever** — it is an index, so this is not FMV logic and needs
  no equivalence proof, only a plan check afterwards.
- The partition-local index is **not** attached to a parent partitioned index (the parent
  has 4, and this is not one), so it can be replaced freely.
- ⭐ **Index DDL causes no `PGRST002` burst** (`pgrst_ddl_watch` does not list `CREATE
  INDEX`), so this does not pay the usual migration outage.
- `fmv_snapshots_2026` is 99.0% all-visible, so an Index Only Scan will actually be able to
  skip the heap; **that was checked, not assumed.**

⏳ **NOT BUILT YET, deliberately.** The CIC recipe requires a quiet window and a number to
prove it, and the instance read **9 active / 8 IO-wait / 1 autovacuum** at 15:10Z — a
saturation spell (the recipe's example of an acceptable window is 3 / 1 / 0). A 125 MB
`CREATE INDEX CONCURRENTLY` on a hot 1.28 M-row partition belongs in a quiet window.
⚠ Some of that IO pressure is **mine** — this filing's measurements repeatedly ran a
900k-buffer query. Re-read the window before building; do not treat 15:10Z as the estate's
baseline.

**Follow-up once built:** verify the plan says `Index Only Scan`, re-measure buffers, then
drop the now-redundant `INCLUDE (fmv_usd)` index (⚠ it has **76,439 scans**, so it is live —
but the new index is a strict superset, so anything using the old one can use the new).

ⓘ Unrelated, same sweep: `RPC Panini Ingest` also reports `LastTaskResult = 1`. Its runner
needs a logged-in Chrome debug profile and its own docs say to re-login when a run reports
"enumerated 0" — **an operator step, not a code fix.**
