# Candidate: `atlas-proxy` will NOT un-red `topshot-active-listings-ingest` — re-verified live, and the real blocker is one RPC

**Source:** live measurement 2026-08-26 06:30Z (23:30 PT 08-25), Claude Code autonomous. Read-only: `pipeline_runs`, `pipeline_runs_daily`, `cron`/`pg_proc`, GitHub Actions logs. **No writes.** Risk: **MEASUREMENT / DOCS**.

## The headline — known-issues #20's warning HOLDS, re-verified today

#20 already says *"Do not credit #20 with un-redding this workflow"*. **That is correct and now re-verified against a run from three hours ago.** The most recent GHA run (`2026-08-26T04:07Z`) died **31 seconds in**:

```
[listings-ingest] FATAL Error: GET targets failed: 500
  {"error":"canceling statement due to statement timeout"}
    at getTargets (scripts/ingest-topshot-active-listings.mjs:89)
```

**Before the first Atlas call is made.** The last **12 of 12** workflow runs are `failure`.

## 🚨 The instrument trap — and I nearly published the opposite conclusion

Measured from `pipeline_runs` alone, the picture is *"9 of 9 failures in 72 h are `egress_blocked`, zero DB timeouts"* — which reads as *"the DB-timeout class is gone, so shipping `atlas-proxy` now fixes everything."* **That is wrong, and it is wrong by CONSTRUCTION:**

- The route writes its `pipeline_runs` row **only on the final POST** (`if (body.final || body.deactivate)`).
- `GET ?phase=targets` runs **first**, from the runner.
- **So a targets timeout can never produce a row.** `pipeline_runs` is structurally blind to the dominant failure, and every rate derived from it describes only the runs that got *past* targets.

⭐ **This is why the original ~60 % `egress_blocked` figure arose at all** — it is the failure rate *among rows that exist*. Two arms, two populations, and the one that matters leaves no row. (`measuring-one-arm-of-a-two-caller-pipeline`, met head-on.)

⚠ **Corroboration, not just the one run:** `pipeline_runs_daily` shows **13 runs logged in 72 h** and **112 logged runs over 22 days** for a pipeline the workflow fires ~8–11×/day — i.e. most ticks never log at all. `last_error` is `egress_blocked` on every one of those 22 days, which is exactly what a blind instrument looks like when it can only ever see one class.

## The real blocker, located

`?phase=targets` → `topshot_serial_board_targets()` → a thin join over **`topshot_serial_board_candidates(p_min_no1_estimate)`**, which is where the cost lives:

```sql
WITH latest_fmv AS (                      -- DISTINCT ON over ALL TopShot snapshots
  SELECT DISTINCT ON (fs.edition_id) …
  FROM fmv_snapshots fs
  WHERE fs.collection_id = '95f28a17-…'   -- 871,886 rows → 19,678 editions
  ORDER BY fs.edition_id, fs.computed_at DESC
), base AS (
  SELECT …,
    (serial_fmv_estimate(…, 1, …) ->> 'estimate_usd')::numeric  AS no1_estimate_usd,
    (serial_fmv_estimate(…, e.circulation_count, …) ->> 'estimate_usd')::numeric AS perfect_estimate_usd
  FROM editions e JOIN latest_fmv lf ON lf.edition_id = e.id
  WHERE … AND lf.confidence IN ('HIGH','MEDIUM')                 -- 13,199 eligible editions
)
SELECT … FROM base
WHERE COALESCE(no1_estimate_usd, 0) >= p_min_no1_estimate;       -- ⚠ the floor filters OUTPUT, not COST
```

🚨 **`serial_fmv_estimate` is called TWICE PER EDITION, for every HIGH/MEDIUM TopShot edition, BEFORE the `$100` floor can prune anything** — order ~26,000 calls per invocation. **The floor bounds the OUTPUT, not the COST**, the shape CLAUDE.md already names, and the same family as the `drain_fmv_cold_tail` unscoped-aggregate fixed on 2026-08-26.

**Measured population (2026-08-26 06:30Z):** 13,199 eligible TopShot editions · 871,886 TopShot `fmv_snapshots` rows · 19,678 distinct editions in that table.

## Suggested direction — NOT shipped, and deliberately so

⛔ **This is FMV/ingest route logic, which is off-limits for autonomous shipping**, and it re-prices a board. Filed for Trevor's call. Two candidates, cheapest first:

1. **Defer the second call.** `perfect_estimate_usd` is only needed in the final projection and in the `COALESCE(no1, perfect) IS NOT NULL` test. Computing it via a `LATERAL` after the floor filter would **halve** the calls immediately, with no change to the result set for rows where `no1` is non-NULL. ⚠ The `COALESCE` fallback means rows with NULL `no1` still need it — so the equivalence has to be proven, not assumed.
2. **Pre-filter on a necessary condition.** If `no1_estimate_usd` is monotone in `lf.fmv_usd`, a cheap `lf.fmv_usd >= k` pre-filter prunes before any function call. ⚠ **That monotonicity is a CLAIM about `serial_fmv_estimate` and must be measured**, not assumed — the serial-premium and ASK-clamp branches could break it.

⭐ **Whatever ships, prove equivalence over the whole population first** (the standard this repo set with the cold-tail fix: *0 of 1,281,003 rows differed*), and compare **buffers**, not wall-clock, since a saturation spell confounds timing in both directions.

## What this changes about the register

- **#20 (`atlas-proxy`)** — its own "do not credit this with un-redding the workflow" line is **re-verified**; the entry needs no correction, only a fresher date. Shipping it remains worthwhile for the 9-of-40 class, just not as a fix for the red workflow.
- **#30** — the DB timeout at `?phase=targets` is **still the dominant failure as of 2026-08-26 04:07Z**, and now has a located cause rather than a symptom.

**Risk read:** none — read-only. The action is a decision about one RPC.

---

## Addendum — how isolated is this? A candidate list, explicitly NOT a defect list

If a route can fail *before* it writes its `pipeline_runs` row, every health number derived from that table is a survivor rate. Measured across `app/api/**/route.ts` (2026-08-26 06:40Z):

- **97 routes** write a `pipeline_runs` row.
- **78 of them carry no invocation heartbeat.**
- Ranked by `return NextResponse.json(...)` paths reachable *before* the log call, the worst are
  `topshot-active-listings-ingest` (**9**, log at 86 % through the file), `pinnacle-metadata-backfill` (**8**),
  then `apply-fmv-haircut` (4) and six routes at 3.

⛔ **These numbers are a SEARCH ORDER, not a finding, and must not be quoted as a defect count.** Three reasons the honest reading is narrower:

1. **Most early returns are auth/validation 4xx.** A `401` or `bad json` is genuinely not a pipeline tick and *should not* log one. Only a return on a **data-read failure** creates the blindness.
2. **The heartbeat rule is scoped.** CLAUDE.md requires an invocation heartbeat for **`after()` routes**, because `try/catch` cannot catch a `maxDuration` kill. "78 without a heartbeat" is not 78 violations — most of these are not `after()` routes.
3. **Only one is measured.** `topshot-active-listings-ingest` is confirmed by a live log; the rest are unexamined.

⭐ **The cheap per-route test, in one command** — compare what the table logged against what actually ran:

```
gh run view "$(gh run list --workflow=<wf>.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --log-failed
```

⚠ **And the free tell that needs no log at all: compare LOGGED runs to EXPECTED ticks.** 13 logged in 72 h for a pipeline firing ~8–11×/day is the signature. A high failure rate on a small logged population is not "the" rate — it is the rate among the runs that survived long enough to be counted.
