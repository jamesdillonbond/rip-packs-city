# Top Shot pack supply is a 73-day-old snapshot, `pack_distributions.updated_at` says "4 hours", and the `data_stale` alert on that very table is structurally blind to it

*Claude Code (cloud), 2026-09-09 17:0x PT / 2026-09-10T00:02Z. **READ-ONLY. Nothing paused, nothing shipped, and the reason is stated at the bottom rather than implied.** Opened to answer the one blocking question left by `2026-09-08T0530Z-five-lanes-still-fire-into-the-dead-topshot-gql-host…` — "name the live path keeping `pack_distributions` fresh, then jobid 15 can be paused" — and the answer turned out to change that filing's reasoning.*

---

## 1. The live path is NAMED — and it is a caller source the standing enumeration does not contain

**`cron-job.org → Supabase Edge Function `seed-topshot-pack-distributions` → `seed_topshot_pack_distributions(p_rows jsonb)` via PostgREST`, 4-hourly at minute :13.**

Three independent lines, none of them a guess:

1. **`pg_stat_statements` shows the RPC arriving through PostgREST** — the statement is wrapped in `WITH pgrst_source AS (… "public"."seed_topshot_pack_distributions"("p_rows" := …))`, 684 calls. A `pgrst_` wrapper means the REST API, so it is **not** pg_cron, **not** a trigger and **not** any in-database caller — which is exactly why the prior filing's six-source sweep came back empty.
2. **The repo's only caller of that RPC is a Supabase Edge Function**, `supabase/functions/seed-topshot-pack-distributions/index.ts:201`. Confirmed by grep across `.ts/.tsx/.mjs/.js/.json/.yml`, excluding migrations.
3. **The write timestamps place the schedule.** Top Shot rows in `pack_distributions` were last written at **2026-09-09 20:13:10Z** and, before that, **16:13:16Z** — exactly 4 h apart, at minute **:13**. And `.github/workflows/topshot-active-listings-ingest.yml` independently lists `seed-topshot-pack-distributions` among the minute-:13 cohort it was moved off in July. Two records agreeing that were written for different reasons.

⭐ **Promote this: an EDGE FUNCTION invoked by an external scheduler is a caller source the standing list misses.** CLAUDE.md's rule requires six sources (`pg_proc.prosrc`, `pg_views.definition`, `cron.job.command`, `pg_trigger`, a full-repo grep, the Cowork artifacts' HTML) plus cron-job.org (seventh) and this box's Task Scheduler (eighth). **A repo grep does find the edge function's source — but only if you grep for the SQL FUNCTION NAME rather than the pipeline name**, and nothing in the enumeration tells you the invoker. ⚠ **The discriminator is free and decisive: a `pgrst_source` wrapper in `pg_stat_statements` proves the call arrived over HTTP.** Reach for that before concluding "no caller".

## 2. Two facts the prior filing rested on are ARTIFACTS, and its conclusion does not follow from them

It argued the supply data "is arriving by some path despite jobid 15 failing every run", from (a) `pack_distributions.updated_at` fresh within 24 h and (b) `total_sealed` populated on 2,099 of 2,099. **Both are true and neither is evidence.**

- ⛔ **`total_sealed` is `GENERATED ALWAYS AS GREATEST(total_minted - total_opened, 0)`**, and `depletion_pct` is generated the same way (`information_schema.columns`, verified). "Populated on 2,099 of 2,099" is a **tautology** wherever the two inputs are non-null. It cannot go stale, cannot go NULL while its inputs are set, and says nothing whatever about freshness.
- ⛔ **`pack_distributions.updated_at` is bumped by the CATALOG lane, which deliberately does not write the supply columns.** The edge function states this itself: *"We deliberately DO NOT send total_minted/total_opened: the `seed_topshot_pack_distributions` RPC leaves those columns untouched on conflict."* So `updated_at` measures the freshness of `title`/`image_url`/`metadata`, not of supply. ⚠ **This is CLAUDE.md's `*_at`-is-not-its-contract trap, and here the gap between the two is ~73 days.**

## 3. The supply IS stale — measured, with a positive control

`public.topshot_pack_supply`, live:

| | |
|---|---|
| rows | **2,085** |
| `supply_ok = true` | 2,083 |
| older than 30 days | **2,068 (99.2%)** |
| **median `updated_at`** | **2026-06-28** (≈73 days) |
| newest successful fetch | **2026-08-26 08:15Z** (two days before the host died) |

And on the dists a user can actually reach: of **86,752** Top Shot `pack_drop_pool` rows joining supply, **86,542 (99.8%)** are backed by supply older than 30 days, median as-of **2026-06-28**.

✅ **`pack_distributions` is an exact mirror of that, so it cannot be fresher than its source.** Across all 2,083 `supply_ok` rows, `pd.total_minted` and `pd.total_opened` are **identical to `topshot_pack_supply` on 2,083 of 2,083 — zero divergence in either direction, on both columns.** So no "open/rip pipeline" is currently refreshing them, whatever the ownership comment says.

✅ **POSITIVE CONTROL, because a zero is worthless without one:** the same comparison run over the 2 rows with `supply_ok = false` reports a difference on **2 of 2, both columns** (those rows hold NULL supply while `pack_distributions` holds a value). The query can see divergence; there is none to see.

## 4. jobid 15 reports `succeeded` while its work fails, and the honest record is in a column nobody reads

⚠ **`cron.job_run_details` for jobid 15 (`rpc-backfill-pack-supply`, `15 8 * * *`) reads `status = succeeded`, `return_message = "1 row"` on both 09-08 and 09-09.** The pg_net dispatch returned a row; the downstream route 530'd. So the scheduler's own record and the prior filing's `pipeline_runs` reading ("0 ok, 0 rows") **disagree, and the scheduler is the one that lies** — the same `ok`-is-overloaded class already filed against `rows_written`, one layer up.

⭐ **Credit where it is due, and it is the reason this was diagnosable at all: `topshot_pack_supply` carries `supply_ok` and `supply_err`, and on failure it writes NULL supply rather than zeros.** Its two most recent rows read `supply_ok=false, supply_err='HTTP 530', total_minted=null, total_opened=null`. That is the honest shape this repo keeps asking for, already implemented.

🚨 **And nothing reads it.** `grep -rn "supply_ok\|supply_err\|topshot_pack_supply" app components lib` returns **zero matches**. The honesty columns exist, are correct, are maintained daily — and reach no surface, no guard and no alert.

## 5. THE FINDING: an alert named `data_stale` on `pack_distributions` that cannot see this table's staleness

`get_pipeline_alerts_core()` is the only DB object that alerts on this table. Its arm:

```sql
SELECT jsonb_build_object(
  'severity', CASE WHEN age > interval '14 days' THEN 'high' ELSE 'medium' END,
  'type',     'data_stale',
  'pipeline', 'pack_distributions',
  'detail',   'Last seen ' || age::text || ' ago')
FROM (SELECT (now() - max(first_seen_at)) AS age FROM public.pack_distributions) pd
WHERE age > interval '7 days'
```

⛔ **It keys on `max(first_seen_at)` — "has a NEW distribution appeared" — and is labelled `type: data_stale, pipeline: pack_distributions`, which reads as a freshness verdict on the table.** It is structurally silent about `total_minted`/`total_opened`/`total_sealed`/`depletion_pct`, the columns every pack surface actually renders. **Measured now: age 6d 19h, so it does not fire — and it would not have fired at any point across the 73-day drift, as long as new dists keep being catalogued 4-hourly.** ⚠ This is the standing rule *"ask what a passing guard is structurally SILENT about"*, with the answer being the four columns the alert's own name promises to cover.

⭐ **The compounding shape is what makes it worth filing rather than shrugging at:** a lane dies → its failure is recorded honestly in a column nothing reads → a sibling lane keeps bumping the row's `updated_at` → a generated column keeps returning a value → and the alert named for this table measures a third thing entirely. **Four independent layers each doing something defensible, and the net effect is that a 73-day-old number is indistinguishable from a fresh one at every level.**

## 6. Blast radius — stated as scope, not as harm

`depletion_pct` / `total_sealed` are read by `/insights/pack-reality`, `/api/public/insights/topshot-pack-market`, `/api/pack-ev`, `/api/packs/grails`, the pack dist page, the pack simulator, both pack OG cards, `PacksDashboard` and `lib/packs/pack-deals.ts`.

⚠ **NOT CLAIMED: that a user is currently seeing a wrong number.** Three reasons to withhold that: `#50` records the Top Shot +EV ranker as already drained to **0 rows** with an honest staleness branch, so the highest-stakes surface is not publishing these at all; the pack dist page is demonstrably careful about NULL-vs-0 depletion and describes itself as *"based on Rip Packs City's cached snapshot"*; and **pack supply is genuinely slow-moving** — a 73-day-old mint count for a long-closed drop may still be correct. **What IS established is that no surface, guard or alert can tell the difference**, and that the one place the truth is recorded (`supply_ok`/`supply_err`) reaches none of them.

## 7. Disposition — and why nothing was shipped

⛔ **jobid 15 was NOT paused, and the prior filing's precondition for pausing it is now met but its ARGUMENT is not.** That filing offered "supply data is provably fresh from elsewhere" as the safety case; §2–3 refute it. The lane costs **1 run/day**, it is the only thing that would resume automatically if `public-api.nbatopshot.com` returns, and pausing it would delete the last daily record that the upstream is still dead — trading a 1/day cost for a silent blind spot. **Leave it running.**

⛔ **The alert arm was NOT extended, deliberately.** A supply-age arm would fire immediately and stay red for as long as the upstream is dead, i.e. indefinitely — this estate's own **permanently-red instrument** trap (`#25`), and it would be the fifth layer of noise rather than the first layer of signal. The useful version of that arm is one that distinguishes *"the supply source is dead, known, and accepted"* from *"the supply source broke today"*, and that needs the pack-ask/pool source decision in **`#50`**, which is Trevor's.

**Suggested order for whoever picks this up:**

1. **Cheapest real win, and it is not an alert:** surface `topshot_pack_supply.updated_at` as an as-of on any pack surface that renders depletion. The data exists and is per-dist; the surfaces render a derived number with no age.
2. **Then** decide the supply source (folded into `#50` — same dead host, same decision).
3. **Only then** an alert arm, calibrated against whatever the answer to (2) makes "normal".
