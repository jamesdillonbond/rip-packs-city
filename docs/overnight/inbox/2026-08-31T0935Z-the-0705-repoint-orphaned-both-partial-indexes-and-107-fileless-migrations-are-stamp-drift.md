# A correctness fix on 2026-07-05 orphaned both partial indexes behind `get_serial_backfill_targets` — and 107 "fileless" migrations are stamp drift, not missing files

**2026-08-31 09:35Z (02:35 PT) · cloud pass · one shipped, one filed**

## 1. The orphaned index — SHIPPED (migration `20260831093302`)

`audit_20260705_serial_recovery_null_sentinel` widened the serial-recovery predicate from
`serial_number = 0` to `(serial_number IS NULL OR serial_number = 0)`. **That change was correct** and it kept
the drain honest. What nobody checked is that the two partial indexes on each `sales` partition are shaped for
the two halves **separately**:

| index | predicate |
|---|---|
| `idx_sales_<yr>_null_serial` | `(sold_at) WHERE serial_number IS NULL AND nft_id IS NOT NULL` |
| `sales_<yr>_collection_id_idx` | `(collection_id) WHERE serial_number = 0` |

**Neither predicate is implied by the OR.** From 07-05 the planner has had no usable index and has read the whole
heap of all eight partitions on every call.

⭐ **Why it went unseen for eight weeks: that entry verified the repoint on ROWS RETURNED** — it proudly records
*"3,296 TS + ≥5,000 AllDay recoverable targets"* — **and never on buffers.** A widened predicate that returns
more rows looks like a success on a row count no matter what it costs.

📏 EXPLAIN (ANALYZE, BUFFERS) **through the function** (never the body with literals):

| | buffers | disk reads | time | rows |
|---|---:|---:|---:|---:|
| 09:0xZ before | 121,608 | 109,371 (854 MB) | 6,656 ms | 1 |
| 09:31Z after, cold-ish | 10,340 | 1,191 | 694 ms | 1 |
| 09:31Z after, warm | 10,340 | 0 | 21.3 ms | 1 |

⚠ **The claim is the 11.8× drop in TOTAL BUFFERS TOUCHED**, because that is a plan change and cannot be a cache
effect. The 313× wall-clock figure is warm-vs-cold and is **not** the claim.

Only **1,929 rows in the whole table** satisfy the predicate, against **1.29 GB of heap** — a **120 KB** index
standing in for a full-heap scan. Built CONCURRENTLY 09:16–09:30Z by one-off postgres pg_cron jobs 417–424
(8/8 succeeded, 8.7–11.4 s each, all unscheduled after; 0 invalid indexes, 0 `tmp-idx%` jobs left). ⚠ Nothing is
ATTACHed to the partitioned parent **on purpose** — a query on `public.sales` expands to the partitions and uses
each child's own indexes, so ATTACH buys nothing and takes ACCESS EXCLUSIVE on the parent.

## 2. 🚨 What the index does NOT fix — and this is the part that needs Trevor

The 09:0xZ call found **one** actionable row against **1,917** qualifying, because
`sales_serial_backfill_failures` holds the rest on a **24 h cooldown**. Those rows re-enter every 24 h, fail
again, and go back on cooldown. Last six runs: **0/1/2/4/3/0 rows = ~10 sales resolved in 12 h.**

⭐ **This ledger already recorded the cure, on 2026-07-05:** *"9,675 AllDay NOT recoverable from this session …
needs the deployed `sales-serial-backfill` edge fn triggered with a real `INGEST_SECRET_TOKEN` — operator/CC
action."* **The index makes the treadmill cheap. Only an operator can stop it.**

## 3. 107 "fileless" migrations are stamp drift — the version check over-reports 54×

Derived at 09:35Z against `origin/main` `a1e0fd0` (`git ls-tree`, **not** the working tree), 437 register rows
since 2026-08-01:

- **by VERSION: 109** have no file carrying that 14-digit stamp;
- **by NAME: 2** — `audit_20260831_pause_wallet_username_resolver_cadence_arm` (`20260831030424`, applied by the
  03:0xZ cloud pass, staged in the Project, still uncommitted) and tonight's `20260831093302`.

**So 107 of the 109 are version-stamp mismatches: the file exists, under a different stamp.** Open-threads item 6
records this class as having **two** instances and offers *"rename the file to the recorded version"* as the
remedy. That is a **107-file chore**, and doing it would rewrite eight weeks of history for a cosmetic match.

👉 **Recommendation, for Trevor not for a night pass:** keep `check-migration-parity` authoritative **by NAME**
(which is what actually answers *"is prod running SQL that is not in the repo?"*), and record stamp drift as an
expected, benign consequence of applying through `apply_migration` and writing the file afterwards. ⛔ The
standing instruction to *"compare versions and not just names"* is what produces the 109, and taken literally it
would put 107 files that exist on a drift list.
