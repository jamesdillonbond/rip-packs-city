# Panini freshness check — scheduled-task prompt (source of truth)

Routine `trig_01K68ddYeWqUumNN2RavC4ht` ("Panini freshness check", 11:00 AM PT daily). It is **device-bound**: its prompt can only be edited from Claude Desktop on the bound laptop — the RemoteTrigger API returns 403 `routine_bind_update_proof_required` from any session. Edit here first, then paste everything below the line into the task's prompt field.

2026-09-27: added the 09-24/25 `panini-1.1.0` engine regime note, Query 6b (same-engine paired confidence drift) and Escalation 5; retired the `pct_hi_med_repeat` < ~68 gate, which fired a false alarm that morning.

2026-10-04 (~11 PM PT): **this file had gone STALE. The live routine prompt was edited on 10-01 (multi-product THIRD regime, the re-based cohort gate, Query 6b = OLD-CATALOGUE AGE) and this copy still held the 09-27 text.** It now mirrors the live prompt read back via `RemoteTrigger get`, plus the 10-04 changes: a FOURTH-regime note (`panini-1.2.0`, the 2-hour walk, `NO_DATA` retirement rows); `absurd_24h` counts only prices over $100k that no sale anchors (`big_sale_backed_24h` and `retired_no_data_24h` are report-only); the null-FMV gate excludes `NO_DATA`; Query 6b gains `old_older_7d_walked_24h`, and Escalation 5 reports walked-but-not-repriced editions as PRICES NOT RETIRED, not STARVING. Both edited queries were run against prod on 10-04 (the split read 35 of 38). ⚠ **Before editing this file, diff it against the live prompt** (`RemoteTrigger get`, field `derived_state.prompt`). A content `update` is refused (403 `routine_bind_update_proof_required`) even from Claude Code on the bound laptop; only fields like `enabled` go through. **Paste from Claude Desktop.**

<!-- paste everything below this line -->

Read-only freshness + failure-triage check for the Rip Packs City Panini residential ingest runner (2026 Prizm World Cup was the only product until 09-29; the walk now covers every admitted product — see the THIRD regime change below). Run this every time, self-contained. Take NO corrective action — report only.

⚠ **REGIME CHANGE 2026-09-19 — read this before interpreting anything.** Two commits that day (`8e40e742d` 10:33 PT, `878ec188e` 11:06 PT, both Trevor + Claude Opus 5) changed what a walk IS. Before: the walk queue WAS the grid enumeration, so `walking === wc_pskus` and the runner could only ever refresh what the grid scroll happened to surface — 1,265 of 5,071 editions (24.9%) had gone unwalked 45+ days. After: the grid keeps DISCOVERY, our own catalogue supplies REFRESH, oldest-first — `walking` is now ~the full catalogue (5,078) and `order_mode` reads `stalest-first (N new + M known)`. Consequences you must not re-litigate:
- **`wc_pskus` no longer sets walk length.** Any diagnosis that pins low throughput on enumeration levers (`PANINI_ENUM_MAX_ITERS`, `PANINI_ENUM_BUDGET_MIN`, the cardset filter) is now wrong by construction unless Escalation 3 has fired. Enumeration only governs DISCOVERY of new pskus.
- **`walking === wc_pskus` is now a DEFECT SIGNAL, not normal.** It means `fetchWalkOrder()` returned empty (the walk-order endpoint 503'd or was unreachable) and the runner fell back to the old shuffle. See Escalation 3.
- **The HIGH/MEDIUM confidence share stepped DOWN and that is the fix working, not a regression.** See Query 6 and the note under it. Do not report ~61% as a collapse from ~87%. (Those percentages are themselves 1.0.0-era; see the SECOND regime change.)
- `walking` counts the QUEUE, not what was walked — the per-card loop breaks on `WALK_BUDGET_MS`. It is an upper bound.

⚠ **SECOND REGIME CHANGE 2026-09-24 ~9:30 PM PT — the FMV ENGINE changed (`panini-1.0.0` → `panini-1.1.0`).** Shipped deliberately (handoff `claude/handoff-2026-09-24-2130pt-panini-fmv-1-1-0-shipped.md`): HIGH now needs 3 real sales in 30 days, MEDIUM 1–2, no-recent-sale pricing is labelled LOW, and the ASK_ONLY floor multiplier fell 0.90× → 0.50×, in exchange for median pricing error 57.6% → 33.3% (n=9,129 sales). It moved every confidence figure in Query 6 DOWN, for every cohort, permanently:
- **The 09-20 figures (83.3% repeat cohort, 87.5% 15-day aggregate, the ~68% floor) are RETIRED.** They are 1.0.0 numbers and 1.1.0 cannot reach them. On 09-27 this check fired a false "regression" on exactly that comparison (handoff `claude/handoff-2026-09-27-panini-freshness-check-false-alarm-and-stale-gate.md`). Never compare a 1.1.0 confidence share to a 1.0.0 one.
- **Under 1.1.0 the daily repeat-cohort HIGH/MEDIUM share SWINGS by design, roughly alternating ~26% ↔ ~52%** (measured per PT day: 09-25 25.9 · 09-26 51.9 · 09-27 29.9 · 09-28 50.3, each on n_repeat ≈ 2,200–2,900). Stalest-first rotation walks different slices of the catalogue on different days and liquidity differs by slice. One low day is NOT a signal; the gate below is set under the observed floor.
- Do not pool `algo_version`s. Any 15-day baseline that still straddles 09-24 mixes engines; the gate below uses only 1.1.0 rows.

⚠ **THIRD REGIME CHANGE 2026-09-29 — the walk covers MANY products, and bootstraps new ones.** Trevor's 29 products were admitted 09-29; the walk now prepends held-but-unlisted editions (`held_uncatalogued`) and, for a product admitted <12 h ago with zero catalogue rows, NARROWS a whole walk to that product (`bootstrap_set_ids`, shipped 09-30). Consequences:
- The catalogue grew ~5,100 → ~8,700 editions in two days. Absolute edition counts from before 09-29 are not comparable.
- **While new products are being priced, the walk can spend whole days on never-priced editions, so `n_repeat` can be 0** (09-29 and 09-30 both read n_repeat = 0: every 1.1.0 row those days was a new edition's first price). That is expected and is NOT a pricing signal — report it and skip the confidence gate.
- The cost is that the OLD catalogue ages while new products bootstrap. Query 6b measures that; Escalation 5 gates on it.

⚠ **FOURTH REGIME 2026-09-30 → 10-04 — `panini-1.2.0` engine, a 2-hour walk, and NO_DATA rows.** (1) Since 09-30 the engine is `panini-1.2.0` (Trevor approved). It changes ONLY the LOW tier, which now prices at the median of the edition's last ≤3 sales at any age instead of Panini's lifetime average. HIGH / MEDIUM / ASK_ONLY are unchanged, so the 1.1.0 cohort floor below still applies. `algo_list_24h` = `panini-1.2.0` alone is normal. (2) Since 10-03 the walk runs every 2 h, not every 4 h as STEP 2 says: FULL at 2/6/10 AM-PM PT, WALK-only at 12/4/8. A `panini-ingest` gap > 2.5 h is a real gap. (3) **From 2026-10-04 ~10:30 PM PT, `confidence = 'NO_DATA'` rows with a NULL `fmv_usd` are a price RETIRED, not a write failure.** Before that, a walked card with no sale ever and ZERO listed wrote no snapshot, so its last ASK_ONLY price, set off an ask since delisted, stayed current: 41 editions, $396k, oldest 241 h, all walked within the day. That was the 10-04 Escalation 5 hit ("39 old editions"); the walk was reaching them every day. Fix `d730717d6`. Expect a handful of NO_DATA rows a day; hundreds would mean the stats payload lost `for_sale_count`.

STEP 1 — Query. Use the Supabase MCP `execute_sql` tool (if it isn't already loaded, find it with ToolSearch: query "select:execute_sql" or keyword "execute_sql supabase"). Run all EIGHT queries (Query 6b is new 2026-09-30) against project id `bxcqstmqfzmuolpuynti`, one call each (multi-statement calls return only the last result).

Query 1 — 24h rollup + auth signal. `walks_24h` is COMPUTED here; do not eyeball it out of Query 2 (that query's window is 72h, not 24h, and a miscount flips Case A against Case D):

WITH w AS (
  SELECT started_at,
         CASE WHEN started_at - lag(started_at) OVER (ORDER BY started_at) > interval '15 minutes'
              OR lag(started_at) OVER (ORDER BY started_at) IS NULL THEN 1 ELSE 0 END AS nw
  FROM pipeline_runs WHERE pipeline='panini-ingest' AND started_at > now() - interval '24 hours'
)
SELECT
  round(extract(epoch from (now() - max(e.last_seen_at)))/3600,1) AS hours_old,
  max(e.last_seen_at) AS last_refresh,
  count(*) AS editions,
  count(*) FILTER (WHERE e.last_seen_at > now() - interval '24 hours') AS refreshed_24h,
  (SELECT count(*) FROM pipeline_runs r WHERE r.pipeline='panini-ingest' AND r.started_at > now() - interval '24 hours') AS batches_24h,
  (SELECT count(*) FROM pipeline_runs r WHERE r.pipeline='panini-ingest' AND r.started_at > now() - interval '24 hours' AND coalesce((r.extra->>'editions')::int,0) > 0) AS productive_batches_24h,
  (SELECT coalesce(sum(nw),0) FROM w) AS walks_24h
FROM panini_editions e;

⚠ These are BATCH counts, not walk counts — a healthy day is ~6 walks and ~350 batches. The old field names `runs_24h` / `productive_runs_24h` invited exactly that confusion; Cases B and C still key on the batch counts, Cases A and D on `walks_24h`.

Query 2 — PER-WALK breakdown with its own gates. Groups consecutive batches into walks on a >15-minute gap (an hour-bucket query cannot do this: a walk straddles hour boundaries and two walks can share one hour). `fmv_yield` and `pct_of_median` are the two per-walk gates — both relative, both self-updating:

WITH r AS (
  SELECT started_at,
         coalesce((extra->>'editions')::int,0) AS eds,
         CASE WHEN started_at - lag(started_at) OVER (ORDER BY started_at) > interval '15 minutes'
              OR lag(started_at) OVER (ORDER BY started_at) IS NULL
         THEN 1 ELSE 0 END AS new_walk
  FROM pipeline_runs
  WHERE pipeline='panini-ingest' AND started_at > now() - interval '72 hours'
), w AS (SELECT *, sum(new_walk) OVER (ORDER BY started_at) AS walk_id FROM r),
b AS (
  SELECT walk_id, min(started_at) AS t0, max(started_at) AS t1,
         count(*) AS batches, sum(eds) AS edition_writes
  FROM w GROUP BY walk_id
), y AS (
  SELECT b.*,
         (SELECT count(DISTINCT s.edition_id) FROM panini_fmv_snapshots s
           WHERE s.computed_at >= b.t0 AND s.computed_at <= b.t1 + interval '5 minutes') AS priced_eds
  FROM b
), m AS (
  SELECT y.*,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY prev.edition_writes) AS median_prev_writes,
         count(prev.*) AS prev_n
  FROM y LEFT JOIN y prev ON prev.t0 < y.t0 AND prev.walk_id >= y.walk_id - 6
  GROUP BY y.walk_id, y.t0, y.t1, y.batches, y.edition_writes, y.priced_eds
)
SELECT to_char(t0 AT TIME ZONE 'America/Los_Angeles','MM-DD HH24:MI') AS start_pt,
       round(extract(epoch from (t1-t0))/60,1) AS minutes,
       batches, edition_writes, priced_eds,
       round(priced_eds::numeric / nullif(edition_writes,0),2) AS fmv_yield,
       round(median_prev_writes) AS median_prev_writes, prev_n,
       round(100.0 * edition_writes / nullif(median_prev_writes,0)) AS pct_of_median,
       round(extract(epoch from (now()-t1))/60,1) AS mins_since_last_batch
FROM m ORDER BY t0 DESC LIMIT 10;

- **`fmv_yield`** = distinct editions that produced an FMV observation ÷ edition-writes. Post-regime-change walks sit in a tight **0.97–1.02** band (measured 09-20 over 6 walks). A walk can report hundreds of "productive" edition-writes and price almost nothing: PT 09-19 02:00 wrote **163 edition-writes and produced exactly ONE priced edition** (yield 0.01), and PT 09-18 22:00 read 195 / 3 (yield 0.02). **Both passed every gate the pre-09-20 version of this check had** — `extra.editions > 0` made them "productive", Case A counted them as walks, and the day's total looked fine. `panini_fmv_snapshots` is append-only (11.8 rows/edition back to 07-16), so this is a real measurement, NOT the last-write-wins artifact that afflicts `last_seen_at` day-bucketing. **Gate: `fmv_yield` < 0.80 on the most recent completed walk.**
- **`pct_of_median`** = this walk's edition-writes against the median of the 6 walks before it. Healthy walks read **94–106**; PT 09-20 10:00 read **43** and the old check reported ✅ over it. **Gate: < 60.**
- ⚠ A yield or median figure computed across the 09-19 regime change is pooled across a fix and means nothing — `prev_n` is the honesty check. If `prev_n` < 4, or the window still straddles 09-19 14:00 PT, report the raw per-walk series instead of the ratio.
- ⚠ The **newest** walk may still be running. `minutes` ≈ 50–63 AND `mins_since_last_batch` > 12 means it has stopped; otherwise it is mid-walk and its `pct_of_median` is meaningless — say so rather than gating on it.

Query 3 — MISSED-WALK GAPS (the zero-day detector), now recency-bounded. `pipeline_runs` retains only ~73h, but `pipeline_runs_daily` is indefinite and carries first/last run per UTC day, so inter-day gaps reconstruct outages far past the prune:

SELECT day AS day_utc, runs,
       to_char(first_run_at AT TIME ZONE 'America/Los_Angeles','MM-DD HH24:MI') AS first_pt,
       to_char(last_run_at  AT TIME ZONE 'America/Los_Angeles','MM-DD HH24:MI') AS last_pt,
       round(extract(epoch from (first_run_at - lag(last_run_at) OVER (ORDER BY day)))/3600,1) AS gap_h,
       round(extract(epoch from (now() - first_run_at))/3600,1) AS gap_ended_h_ago
FROM pipeline_runs_daily
WHERE pipeline='panini-ingest' AND day > current_date - 12
ORDER BY day DESC;

⚠ Do NOT try to detect a zero-day by grouping `panini_editions.last_seen_at` by day. That column is LAST-WRITE-WINS: an edition re-walked later vanishes from the earlier day's bucket, so the metric is "editions whose most recent walk was that day", NOT "editions walked that day". Measured 2026-08-15, UTC 08-13 read 22 editions against 497 actually written. It understates every day and its gaps are ambiguous. Gaps here are authoritative. A fully-missing day produces NO ROW, so the `lag()` correctly spans the hole.
⚠ **`gap_ended_h_ago` is what makes this alarm honest.** The gate is on the gap being NEW, not on it existing: a recovered outage inside the 12-day window would otherwise lead the report with a P0 every single morning for 12 days — the permanently-red-instrument failure. (Lived example: a 35.1h gap at PT 09-10 was still the loudest line in the 09-20 report, 9.7 days after it self-healed.)

Query 4 — THROUGHPUT (the volume gate). Walks can fire on schedule and be productive while doing a fraction of the work, so this is measured separately. Compares each COMPLETE day against the 7 days before it:

WITH d AS (
  SELECT (computed_at AT TIME ZONE 'America/Los_Angeles')::date AS day_pt,
         count(DISTINCT edition_id) AS editions
  FROM panini_fmv_snapshots
  WHERE computed_at > now() - interval '24 days'
  GROUP BY 1
)
SELECT day_pt, editions,
       round(avg(editions) OVER (ORDER BY day_pt ROWS BETWEEN 7 PRECEDING AND 1 PRECEDING)) AS trailing7,
       round(100.0 * editions / nullif(avg(editions) OVER (ORDER BY day_pt ROWS BETWEEN 7 PRECEDING AND 1 PRECEDING),0)) AS pct_of_trailing7
FROM d ORDER BY day_pt DESC LIMIT 12;

⚠ Judge on YESTERDAY, never today. This check runs at 11am PT, so today has only had its 02/06/10 walks — roughly half a day. Comparing a partial day against full-day averages would fire every single morning. Today's row is CONTEXT ONLY. Yesterday is complete, and since this runs daily a collapse is still caught within ~24h.
⚠ Never hardcode an absolute target here. The catalogue grows (4,149 on 08-02 → 4,586 on 08-15 → 5,075 on 09-20) and the rotation re-walks editions, so any fixed number goes stale — that is why the previous absolute gate was removed. The trailing-7 comparison is self-updating; keep it relative.

Query 4b — THE BACKSTOPS (run every time, alongside Query 4). Query 4 divides by a window the collapse itself drags down, so a persistent collapse eventually normalises its own baseline and the gate goes quiet with nothing fixed. Measured 2026-08-15 by projecting a 154/day flat collapse: `pct_of_trailing7` stopped firing after four days and read a reassuring 100% three days later. These two denominators do not erode the same way.

WITH cat AS (SELECT count(*)::numeric AS n FROM panini_editions),
d AS (
  SELECT (computed_at AT TIME ZONE 'America/Los_Angeles')::date AS day_pt,
         count(DISTINCT edition_id)::numeric AS editions
  FROM panini_fmv_snapshots
  WHERE computed_at > now() - interval '30 days'
  GROUP BY 1
), y AS (
  SELECT editions FROM d
   WHERE day_pt = (now() AT TIME ZONE 'America/Los_Angeles')::date - 1
)
SELECT
  coalesce((SELECT editions FROM y), 0)::int                       AS yesterday,
  (SELECT n FROM cat)::int                                         AS catalogue,
  round(100.0 * coalesce((SELECT editions FROM y), 0) / (SELECT n FROM cat), 1) AS pct_of_catalogue,
  round(avg(editions) FILTER (
    WHERE day_pt <= (now() AT TIME ZONE 'America/Los_Angeles')::date - 8))::int AS baseline_8_28d,
  count(*) FILTER (
    WHERE day_pt <= (now() AT TIME ZONE 'America/Los_Angeles')::date - 8) AS baseline_days,
  round(100.0 * coalesce((SELECT editions FROM y), 0)
        / nullif(avg(editions) FILTER (
            WHERE day_pt <= (now() AT TIME ZONE 'America/Los_Angeles')::date - 8),0)) AS pct_of_baseline
FROM d;

⚠ The `coalesce(..., 0)` on each numerator is LOAD-BEARING, not tidiness. A zero-day produces **no row at all** in `d`, so without it `yesterday` is NULL, both percentages are NULL, and `< 8` / `< 55` evaluate to **NULL rather than TRUE** — the check goes SILENT on the single worst input it can receive. Verified 2026-08-15 by simulating a run whose yesterday was a zero-day: before, the gate was `null`; after, `yesterday 0 · pct_of_catalogue 0.0 · gate TRUE`. ⚠ The reachable quiet path this closes is narrow but real: walker healthy and writing `panini_editions` while `panini_fmv_snapshots` gets nothing — Escalation 1 sees no cadence gap, Case A reports fresh, and that day is simply *absent* from Queries 4 and 4b rather than zero. ⚠ Report `yesterday = 0` as **"no editions priced at all yesterday"**, never as "0% of catalogue" — a total stop and a 0.1% day warrant different first moves.
- `pct_of_catalogue` — yesterday's editions as a share of the Panini catalogue. **This is the one denominator a throughput collapse cannot depress**, so it is the only gate here that never self-silences, and it is still self-updating as the catalogue grows (so it does not violate the no-absolutes rule above). Median over 29 observed days to 08-15 was 17.5%; 09-19 read 27.9%. **Under 8% is the gate.**
- `pct_of_baseline` — yesterday against days **8–28 back**, a window a recent collapse has not yet reached. Buys roughly **18 extra days** of detection over Query 4 and frames the loss against the healthy era rather than against the decline. **Under 55 is the gate.**
⚠ `baseline_days` is the honesty check on that second one. If it is small, or if the outage is older than ~4 weeks, the lagged window is itself mostly collapse and its ratio is meaningless. **When that happens report the RAW SERIES from Query 4, not a ratio**: a reassuring percentage computed from a depressed denominator is the exact failure this query exists to prevent. `pct_of_catalogue` stays valid in that case.

Query 5 — ENUMERATION + WALK-ORDER REGIME telemetry (pipeline `panini-ingest-enum`, a separate pipeline name from `panini-ingest`). `order_mode` / `known_complete` / `walking` are the regime discriminators added 09-19; `pskus_per_min` is the enumeration-efficiency gate; `wc_share_pct` is compared to its own trailing median, never to a remembered constant:

WITH e AS (
  SELECT started_at, extra->'enum' AS en
  FROM pipeline_runs
  WHERE pipeline='panini-ingest-enum'
    AND started_at > now() - interval '72 hours'
    AND coalesce(extra->'enum'->>'enum_stop','') NOT IN ('probe','postdeploy-probe')
), med AS (
  SELECT round((percentile_cont(0.5) WITHIN GROUP (ORDER BY (en->>'wc_share_pct')::numeric))::numeric,1) AS wc_share_median_72h,
         round((percentile_cont(0.5) WITHIN GROUP (
           ORDER BY (en->>'wc_pskus')::numeric / nullif((en->>'enum_ms')::numeric/60000,0)))::numeric,0) AS pskus_min_median_72h
  FROM e
)
SELECT to_char(e.started_at AT TIME ZONE 'America/Los_Angeles','MM-DD HH24:MI') AS pt,
       e.en->>'enum_stop'      AS enum_stop,
       e.en->>'order_mode'     AS order_mode,
       e.en->>'known_complete' AS known_complete,
       (e.en->>'known_order')::int AS known_order,
       (e.en->>'walking')::int AS walking,
       (e.en->>'wc_pskus')::int AS wc_pskus,
       (e.en->>'grid_pages')::int AS grid_pages,
       (e.en->>'wc_share_pct')::numeric AS wc_share_pct,
       round((e.en->>'enum_ms')::numeric/60000,1) AS enum_min,
       round((e.en->>'wc_pskus')::numeric / nullif((e.en->>'enum_ms')::numeric/60000,0),0) AS pskus_per_min,
       med.wc_share_median_72h, med.pskus_min_median_72h
FROM e CROSS JOIN med ORDER BY e.started_at DESC LIMIT 20;

⚠ **Do not "simplify" this into a single SELECT with `percentile_cont(...) OVER ()`.** Postgres rejects an ordered-set aggregate as a window function (`0A000: OVER is not supported for ordered-set aggregate`), and `percentile_cont` returns double precision so it needs the `::numeric` cast before `round(x,1)` (`42883`). Both were hit and fixed on 2026-09-20; the CROSS JOIN form is the working one.
⚠ Rows whose `enum_stop` is `probe`/`postdeploy-probe` are manual verification posts, not walks — the query already excludes them; keep that filter if you rewrite it.
⚠ **Do not compare `wc_share_pct` to "~48%".** That was a single 2026-08-15 page-1 sample (13 of 27 pskus on one page) and it never described the walk-wide figure. Measured walk-wide over 16 walks on 09-20: range **20.0–32.9%**, median **25.5%**. Use `wc_share_median_72h` from this query. The 48% figure is retired — do not reintroduce it.
- `pskus_per_min` measured over 16 walks on 09-20: **97–195** with a 72h median of **126**, except PT 09-20 10:12 at **33** — a 3.8x outlier that coincided with that walk's 43%-of-median throughput and an 11.0-min enumeration against a 10-min budget. **Gate: `pskus_per_min` < 50% of `pskus_min_median_72h` on the most recent walk** (self-updating; do not hardcode a floor). Report as a note unless a throughput gate also fired.
- `enum_stop` values: `max_iters` = hit the iteration cap (`PANINI_ENUM_MAX_ITERS`, default 200); `budget` = ran out of wall-clock (`PANINI_ENUM_BUDGET_MIN`, default 10 min against a ~50 min walk); `stable` = the grid stopped yielding new WC cards. ⚠ **Read `enum_min` BEFORE naming a lever** — comfortably under budget means the iteration cap bound the walk and the clock knob would buy nothing. All three are normal steady states post-09-19 and **none of them is a fault on its own**, because enumeration no longer sets walk length.

Query 6 — WRITE QUALITY + CONFIDENCE MIX. "Wrote 300 editions" is not "wrote 300 good editions". Every rate here is compared to its own trailing baseline, and the cohort split is what keeps the confidence reading honest:

WITH s24 AS (
  SELECT * FROM panini_fmv_snapshots WHERE computed_at > now() - interval '24 hours'
), base AS (
  SELECT * FROM panini_fmv_snapshots
   WHERE computed_at > now() - interval '15 days' AND computed_at <= now() - interval '24 hours'
), recent AS (
  SELECT DISTINCT edition_id, confidence FROM panini_fmv_snapshots
   WHERE computed_at > now() - interval '30 hours'
), seen_before AS (
  SELECT DISTINCT edition_id FROM panini_fmv_snapshots
   WHERE computed_at <= now() - interval '30 hours' AND computed_at > now() - interval '17 days'
)
SELECT
  (SELECT count(*) FROM s24)                                                   AS rows_24h,
  (SELECT count(DISTINCT edition_id) FROM s24)                                 AS eds_24h,
  (SELECT round(100.0*count(*) FILTER (WHERE fmv_usd IS NULL AND confidence <> 'NO_DATA')/nullif(count(*),0),1) FROM s24)  AS pct_null_fmv_24h,
  (SELECT round(100.0*count(*) FILTER (WHERE fmv_usd IS NULL AND confidence <> 'NO_DATA')/nullif(count(*),0),1) FROM base) AS pct_null_fmv_base,
  (SELECT count(*) FROM s24 WHERE confidence = 'NO_DATA')                      AS retired_no_data_24h,
  (SELECT count(*) FROM s24 WHERE fmv_usd IS NOT NULL AND fmv_usd <= 0)        AS nonpositive_24h,
  (SELECT count(*) FROM s24 WHERE fmv_usd > 100000 AND confidence NOT IN ('HIGH','MEDIUM','LOW')) AS absurd_24h,
  (SELECT count(*) FROM s24 WHERE fmv_usd > 100000 AND confidence IN ('HIGH','MEDIUM','LOW'))     AS big_sale_backed_24h,
  (SELECT string_agg(DISTINCT algo_version, ',') FROM s24)                      AS algo_list_24h,
  (SELECT round(100.0*count(*) FILTER (WHERE confidence IN ('HIGH','MEDIUM'))/nullif(count(*),0),1) FROM s24)  AS pct_hi_med_24h,
  (SELECT round(100.0*count(*) FILTER (WHERE confidence IN ('HIGH','MEDIUM'))/nullif(count(*),0),1) FROM base) AS pct_hi_med_base,
  (SELECT round(100.0*count(*) FILTER (WHERE r.confidence IN ('HIGH','MEDIUM'))/nullif(count(*),0),1)
     FROM recent r LEFT JOIN seen_before sb ON sb.edition_id=r.edition_id WHERE sb.edition_id IS NOT NULL) AS pct_hi_med_repeat,
  (SELECT round(100.0*count(*) FILTER (WHERE r.confidence IN ('HIGH','MEDIUM'))/nullif(count(*),0),1)
     FROM recent r LEFT JOIN seen_before sb ON sb.edition_id=r.edition_id WHERE sb.edition_id IS NULL)     AS pct_hi_med_newly_reached,
  (SELECT count(*) FROM recent r LEFT JOIN seen_before sb ON sb.edition_id=r.edition_id WHERE sb.edition_id IS NOT NULL) AS n_repeat,
  (SELECT count(*) FROM recent r LEFT JOIN seen_before sb ON sb.edition_id=r.edition_id WHERE sb.edition_id IS NULL)     AS n_newly_reached;

🚨 **THE CONFIDENCE STEP OF 2026-09-19 — do not misread it.** `pct_hi_med_24h` fell from an 83–93%/day plateau (09-04 → 09-18) to **62.6% on 09-19 and 60.7% on 09-20**, with ASK_ONLY doubling ~10% → ~22%. That is a dated step onto a new plateau at the regime change, NOT a pricing regression, and the cohort split proves it: measured 09-20, **repeat editions** (already in rotation) read **83.3% HIGH/MEDIUM** — statistically the old plateau, unmoved — while the **1,674 newly reached editions** the fix unlocked read **55.4%**. The repeat cohort is the no-change control the fix cannot move; the platform-wide number fell purely by composition, because 77% of what we now price is the illiquid tail that was never being priced before.
⚠ **The strategic consequence, which belongs in any report where this comes up:** the roadmap's launch gate is the share of prices at HIGH/MEDIUM confidence, and the old ~87.5% was measuring only the easy slice. The honest catalogue-wide number is ~61% and will keep drifting toward the tail's true rate as coverage completes. **Do not treat the pre-09-19 figure as the baseline to return to.**
- **Gate on the cohort, not the aggregate (RE-BASED 2026-09-30 for panini-1.1.0):** when `n_repeat` ≥ 300, fire only if `pct_hi_med_repeat` < **20** (under the 1.1.0 observed floor of 25.9; the old ~68 floor is retired — see the SECOND regime change), or if `pct_null_fmv_24h` exceeds `pct_null_fmv_base` by more than 5 points, or `nonpositive_24h`/`absurd_24h` > 0, or `algo_list_24h` shows more than one version outside a deploy window. A reading between 20 and ~30 on a single day is the documented low half of the 1.1.0 swing: report it as such, never as a regression. Two consecutive days under 20 on n_repeat ≥ 300 is the real signal.
- ⚠ **`absurd_24h` counts ONLY prices over $100k that NO sale anchors** (ASK_ONLY, i.e. 0.5× an ask). Re-scoped 2026-10-04: the old count fired on two real prices, a Lamine Yamal 1/1 last sold at $210,000 (06-25) and a Wembanyama Gold /10 whose recent non-special sales were $125k / $110k / $25k. `big_sale_backed_24h` and `retired_no_data_24h` are report-only. Never recommend capping a sale-backed FMV.
- ⚠ `n_repeat` / `n_newly_reached` are the honesty check on the cohort split (509 / 1,674 on 09-20). If `n_repeat` is under ~300 the repeat ratio is too thin to gate on (and during a product bootstrap it is often 0) — report both raw counts and skip the gate rather than firing on noise.
- ⚠ `serial_fmv` is 100% NULL for Panini in both the 24h window and the 15-day baseline — it is an unused column, not a regression. Compare any null rate to its own baseline before calling it a defect; a column that was always null beside a healthy `computed_at` is the defaulted-value shape, not evidence.
- `rows_24h` should equal `eds_24h` (one snapshot per edition per walk-day). A material divergence means duplication returned — corroborate with `fmv_yield` in Query 2. ⚠ A gap of 1–2 is a KNOWN minor defect (09-30 review: the same edition can appear twice in one insert chunk, writing two identical rows with the same `computed_at`); value-harmless, a route dedupe is queued. Mention it only if the gap exceeds ~5.

Query 6b — OLD-CATALOGUE AGE (new 2026-09-30; the counterweight to product bootstraps). "Old" = editions first priced more than 48 h ago:

WITH last AS (SELECT edition_id, max(computed_at) mx, min(computed_at) mn FROM panini_fmv_snapshots GROUP BY 1)
SELECT
  count(*) FILTER (WHERE mn <= now() - interval '48 hours')                                   AS old_eds,
  count(*) FILTER (WHERE mn >  now() - interval '48 hours')                                   AS new_eds_48h,
  count(*) FILTER (WHERE mn <= now() - interval '48 hours' AND mx > now() - interval '24 hours') AS old_repriced_24h,
  round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM now()-mx)/3600) FILTER (WHERE mn <= now() - interval '48 hours'))::numeric,1) AS old_median_age_h,
  round(max(extract(epoch FROM now()-mx)/3600) FILTER (WHERE mn <= now() - interval '48 hours'),1) AS old_max_age_h,
  count(*) FILTER (WHERE mn <= now() - interval '48 hours' AND mx < now() - interval '7 days') AS old_older_7d,
  count(*) FILTER (WHERE mn <= now() - interval '48 hours' AND mx < now() - interval '7 days' AND e.last_seen_at > now() - interval '24 hours') AS old_older_7d_walked_24h
FROM last LEFT JOIN panini_editions e ON e.id = last.edition_id;

Measured 2026-09-30 ~7 PM PT, mid-bootstrap: old_eds 5,124 · new_eds_48h 3,557 · old_median_age_h 64.2 · old_max_age_h 141.9 · old_older_7d 0. A full stalest-first pass takes ~5 days, so a max age up to ~144 h (6 d) is normal during a bootstrap.

STEP 2 — Context. The runner drives a real logged-in Chrome on Trevor's laptop (Panini bot-walls datacenter egress, so there is no server-side path). Windows Task Scheduler fires it every 4h at 02 / 06 / 10 / 14 / 18 / 22 Pacific, and each walk TIME-BOXES to ~50 min, then stops cleanly — with `stalest-first` ordering, successive runs now advance through the catalogue oldest-first rather than relying on a shuffle, so a partial walk is BY DESIGN and coverage is no longer luck-of-the-shuffle. This check runs at ~11:00 PT, deliberately just AFTER the 10:00 PT walk completes, so on a healthy day `hours_old` should be roughly 0–1h. (It used to run at 09:00 PT — inside the longest schedule gap and an hour BEFORE the first daytime wake-up — which made every overnight laptop sleep trip a false alarm that then self-healed unattended at 10:00. Do not move it back.)

MEASURED BASELINE (re-measure before quoting; these are dated samples, not constants):
- Per-walk, post-09-19 regime (6 walks, 09-20): 29–90 batches, 134–325 edition-writes, 54–63 minutes, `fmv_yield` 0.97–1.02, `pct_of_median` 43–106.
- Per-walk, pre-09-19 regime (for historical reading only): 45–312 batches, 122–700 edition-writes, 13.5–57.4 minutes, and `fmv_yield` anywhere from 0.01 to 1.00. **Do not pool the two regimes.**
- Daily editions priced: 272–1,416 over 09-04 → 09-19. Read the healthy figure live from `baseline_8_28d` (Query 4b), never from this file.
- Historical zero-days: PT 08-06, 08-12 (39.6h, 37.3h) and PT 09-10 (35.1h). A 25.1h gap into 09-16 sat below the warning floor.
- WALK SIGNATURE: a healthy walk writes (1) an auth-preflight row `extra = {"skip":"empty"}` at ~:00, then (2) an enum row to `panini-ingest-enum`, then (3) a pack-market row (`packs:N, editions:0`), then (4) the productive batches.

STEP 3 — Report. Evaluate ALL FIVE escalations first, then pick the FIRST matching primary case. Escalations prepend; they do not replace the primary case.

⚠ **COMPOSITE VERDICT — resolve this before writing a word.** A ✅ line and an escalation in the same report contradict each other. Case A means only "the runner is firing and authenticated"; it is NOT a health verdict. So: **if any escalation fired, lead with it and demote the primary case to a clause** ("the runner itself is firing and authenticated — 6 walks, last refresh 0.3h — but …"). Never let a bare ✅ stand above a warning. If nothing fired, the primary case is the whole report.

ESCALATION 1 — MISSED WALKS, split by recency.
- **NEW outage** — any `gap_h` > 30 whose `gap_ended_h_ago` < 36. Lead with:
  "🚨 Panini LOST A FULL DAY — a {gap_h}h gap with no walks (last walk {last_pt}, next {first_pt}). That is a total ingest outage, not light coverage: the laptop was off, asleep, or the scheduled task did not run. Coverage for that window is unrecoverable except by re-walking."
- `gap_h` 26–30 with `gap_ended_h_ago` < 36 → a missed-walk-CYCLE warning, not a lost day.
- **HISTORICAL** — `gap_h` > 26 but `gap_ended_h_ago` ≥ 36 → **do not lead with it and do not use 🚨.** One line at the end: "Historical: a {gap_h}h gap at {first_pt}, {N} days ago, since recovered." If two or more such gaps sit in the 12-day window, say the zero-days are recurring rather than occasional — a pattern is a different problem from a one-off sleep.

ESCALATION 2 — THROUGHPUT COLLAPSE. Fire if EITHER `pct_of_trailing7` < 55 (Query 4, YESTERDAY's row, never today's) OR `pct_of_catalogue` < 8 OR `pct_of_baseline` < 55 (Query 4b). Evaluate 4b even when 4 reads normal — a persistent collapse drags the trailing-7 window down to meet it and that gate goes quiet on its own.
- If Query 4 fired: "⚠️ Panini THROUGHPUT DOWN — yesterday walked {editions} editions vs a trailing-7 average of {trailing7} ({pct_of_trailing7}% of normal). Walks are firing; they are doing far less work each."
- If only 4b fired: "⚠️ Panini THROUGHPUT DOWN vs its pre-collapse baseline — yesterday walked {yesterday} editions, {pct_of_catalogue}% of the {catalogue}-edition catalogue, vs {baseline_8_28d}/day over days 8–28 back ({pct_of_baseline}%). The trailing-7 gate may read normal because the decline has eroded its own window."

Then find the reason **in this order**, which reflects the post-09-19 architecture:
1. **Escalation 3 fired?** Then the walk-order endpoint is the cause and enumeration is a red herring. Stop here.
2. **`fmv_yield` low (Query 2)?** The walks are writing editions that produce no price observation. The runner is walking; the FMV compute or the write path is the problem, not coverage.
3. **`pct_of_median` low across SEVERAL walks (Query 2)?** Genuine per-walk work reduction. Check `minutes` — short walks mean the runner is stopping early (laptop sleep mid-walk, Chrome crash); full-length walks with few batches mean each card is costing more (Panini slow, throttling, or `enum_min` eating the walk budget).
4. **`pskus_per_min` under half `pskus_min_median_72h`, or `enum_min` at/over budget?** Enumeration is consuming walk time. Post-09-19 this reduces DISCOVERY of new pskus and steals minutes from walking, but it does NOT cap the refresh queue. The lever is `PANINI_ENUM_BUDGET_MIN` *downward* (spend less on the grid) or the cardset filter — note that raising it trades directly against card-walking time.
5. **No rows in Query 5 at all while Query 2 shows walks?** The runner is not emitting enum telemetry; the runner half or the route half has regressed.
⚠ Never quote a healthy-era figure from memory or from this file — take it from `baseline_8_28d`, and if `baseline_days` is small or the outage predates that window, report the raw Query 4 series rather than any ratio.

ESCALATION 3 — WALK-ORDER REGRESSION (new 2026-09-20; detects the 09-19 defect returning). On the most recent enum row in Query 5, fire if ANY of: `walking` equals `wc_pskus`; `order_mode` IS NULL or contains "shuffled"; `known_complete` is not `true`; `known_order` is materially below the `editions` count from Query 1. Lead with:
"🚨 Panini WALK ORDER REGRESSED — the runner fell back to shuffling the grid enumeration ({walking} queued vs {wc_pskus} enumerated, order_mode `{order_mode}`). This is the defect fixed on 09-19: the walk can only reach what the grid surfaces, so the stale tail of the catalogue goes unrefreshed indefinitely while every cadence and throughput gate reads normal. The walk-order endpoint (`GET /api/cron/panini-ingest`) is the thing to check."
⚠ Pre-09-19 rows have NULL `order_mode`/`known_complete` legitimately. **Evaluate this on the most recent walk only** — a NULL there now means the script was rolled back or the endpoint failed; a NULL on a row older than PT 09-19 14:00 is just history. Do not fire on old rows.

ESCALATION 4 — BAD LAST WALK (new 2026-09-20). On the most recent COMPLETED walk in Query 2 (see the still-running caveat), fire if `fmv_yield` < 0.80 or `pct_of_median` < 60:
"⚠️ Panini last walk UNDERPERFORMED — the {start_pt} walk wrote {edition_writes} editions ({pct_of_median}% of the {median_prev_writes} median of the previous 6 walks) with an FMV yield of {fmv_yield}. {One line naming which of the two gates fired and what that distinguishes.}"
⚠ One low walk is a NOTE; two or more consecutive is a SIGNAL — say which you are looking at. A single time-boxed short walk is by design and should not be dressed up as a fault.

ESCALATION 5 — OLD CATALOGUE STARVING (new 2026-09-30). From Query 6b, fire if `old_older_7d` > 0 (some old edition has gone 7+ days without a re-price). Bootstraps and the held-edition queue are allowed to delay the old catalogue for days, never indefinitely; past 7 days a product expansion has displaced the refresh rotation (the class documented in memory `a-discovery-mechanism-must-not-double-as-the-refresh-list`):
"⚠️ Panini OLD CATALOGUE STARVING — {old_older_7d} editions first priced before the last 48 h have not been re-priced in 7+ days (oldest {old_max_age_h} h; {old_repriced_24h} old editions re-priced in the last 24 h vs {new_eds_48h} new editions priced in 48 h). New-product bootstrap / held-edition priority is displacing the stalest-first refresh."
⚠ `old_repriced_24h` = 0 for a day or two while `new_eds_48h` is large is the bootstrap working — a NOTE, not this escalation.
⚠ **Split it before firing (added 2026-10-04): `old_older_7d_walked_24h` counts editions the walk REACHED in the last 24 h whose price is still 7+ days old. Those are not starvation, so the message above would be wrong about them.** That is the 10-04 pricing defect returning: a walked card the engine wrote no snapshot for. If `old_older_7d_walked_24h` > 0, report instead: "⚠️ Panini PRICES NOT RETIRED — {old_older_7d_walked_24h} editions walked in the last 24 h still carry a 7+-day-old price. The walk reached them and the FMV writer wrote nothing (the class fixed in `d730717d6`; check those editions' `for_sale_count` and the latest snapshot's confidence)." Fire the STARVING message only for `old_older_7d − old_older_7d_walked_24h` > 0.

PRIMARY CASES — report ONLY the first that matches:

CASE B — `batches_24h` = 0 → the runner never fired at all in 24h, including this morning's 10am walk:
"⚠️ Panini STALE — the runner never fired in 24h (0 ingest batches; {hours_old}h since last refresh), including this morning's 10am walk. Most likely the laptop was off or asleep.
Fix: power the laptop on, confirm the dedicated debug Chrome is running and logged in, then from Git Bash: MSYS_NO_PATHCONV=1 schtasks /run /tn "RPC Panini Ingest""

CASE C — `batches_24h` > 0 AND `productive_batches_24h` = 0 → it fired but ingested nothing all day: either the debug Chrome wasn't open, or (most common) the Panini login expired:
"⚠️ Panini STALE — the runner FIRED ({batches_24h} attempts) but ingested 0 editions in 24h → it isn't authenticated.
Fix: open the dedicated debug Chrome (profile panini-cdp-profile, --remote-debugging-port=9222), sign back in at nft.paniniamerica.net, then: MSYS_NO_PATHCONV=1 schtasks /run /tn "RPC Panini Ingest""

CASE E — the most recent walk in Query 2 has `edition_writes` = 0 AND `mins_since_last_batch` > 20 → the last walk died before walking any cards. This outranks Cases A and D:
"⚠️ Panini last walk DEAD — the {start_pt} walk wrote no cards and has been silent {mins_since_last_batch}m. Our-API auth is fine (the preflight posted), so it died somewhere between there and the card walk.
Fix: File Explorer → Ctrl+L → C:\Users\TDill\rip-packs-city\scripts\panini-run.bat → Enter (the .bat relaunches Chrome with the debug flags). Or: MSYS_NO_PATHCONV=1 schtasks /run /tn "RPC Panini Ingest""
⚠ Do NOT diagnose this as "the CDP connect failed" without checking Query 5 first. That attribution was wrong on 2026-08-13: the PT 08-13 22:00 walk matched this signature having already enumerated 42 grid pages, so it was well past CDP. If Query 5 shows an enum row for that walk, the failure is AFTER enumeration; if there is no enum row, CDP/enumeration is the likelier point.

CASE A — `walks_24h` ≥ 3, every completed walk productive, and Case E did not match → the runner is firing and authenticated:
"✅ Panini fresh — {walks_24h} walks in 24h, {refreshed_24h} editions walked (last refresh {hours_old}h ago)."
⚠ Case A means "the runner is firing and authenticated". It does NOT mean throughput, per-walk work, walk order or write quality are healthy — those are Escalations 2, 4, 3, 5 and Query 6. This gate reported ✅ through a 6× collapse on 2026-08-13→15 because it only counted walks, and again on 2026-09-20 over a walk at 43% of median. **If any escalation fired, apply the composite-verdict rule above and do not let this line stand alone.**

CASE D — `walks_24h` is 1 or 2, all productive, and Case E did not match → the runner works and is authenticated but missed most of its wake-ups. Almost always the laptop asleep, not a mid-walk stall:
"⚠️ Panini partial day — runner healthy and authenticated, but only {walks_24h} of 6 scheduled walks fired in 24h ({refreshed_24h} editions walked; last refresh {hours_old}h ago). Usually the laptop slept through the overnight wake-ups.
Fix (optional, tops up coverage): MSYS_NO_PATHCONV=1 schtasks /run /tn "RPC Panini Ingest""

If any query errors (e.g. a table is gone), say so plainly instead of guessing. Do not modify anything and do not run the runner yourself — this is purely a read-only status check.

NOTE for a takeover session (i.e. Trevor asks you to actually fix it rather than report): Task Scheduler is UIPI-blocked to computer-use and terminals are click-tier, so the working manual kickoff is File Explorer → Ctrl+L → type C:\Users\TDill\rip-packs-city\scripts\panini-run.bat → Enter. That .bat self-launches the debug Chrome if port 9222 isn't listening. The console window is MASKED to computer-use, so do NOT try to read it — verify from `pipeline_runs` instead (Query 2, checking for a new walk at the kickoff time). A fresh kickoff writes its preflight immediately, then can look dead for 3–10 minutes during psku enumeration before productive batches flow; give it 10+ minutes before calling it failed. Healthy console output, if a human is watching, is "connected over CDP" → "auth preflight OK (202)" → an `[panini-runner][diag] enum_stop=... wc_pskus=...` line. ⚠ computer-use `request_access` has timed out (180s, twice) when nobody was at the machine to approve — if that happens, fall back to reporting rather than retrying. ⚠ Before forcing a kickoff, check whether the next scheduled walk is imminent: on 2026-08-13 a manual run looked warranted at 12:36 PT, but the 14:00 walk fired normally and topped coverage up on its own. ⚠ Do NOT hand-edit `scripts/ingest-panini-runner.mjs` without a way to syntax-check it (`node --check`); a syntax error there is total Panini ingest loss, and the Cowork sandbox is frequently down with the `/sessions` disk-full issue. The walk-order merge lives at `scripts/ingest-panini-runner.mjs:483-511` and its endpoint arm at `app/api/cron/panini-ingest/route.ts:276-323` — `__tests__/api-cron-panini-ingest-walk-order.test.ts` pins it, so run that test before and after any change there. ⚠ Crafted GraphQL against `/onepanini` returns HTTP 426 — a documented dead end in docs/handoff-2026-07-19-panini-catalog-and-candy-offers.md. Do not re-derive it.