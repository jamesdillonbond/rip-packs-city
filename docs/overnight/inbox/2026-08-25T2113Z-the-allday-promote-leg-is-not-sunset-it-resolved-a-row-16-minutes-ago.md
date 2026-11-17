# The `nfl_all_day` promote leg is NOT dormant — it resolved a row 16 minutes before measurement, and the SUNSET label describes the COLLECTION, not this pipeline

- **When:** filed 2026-08-25 ~21:13Z (14:13 PT) by Claude Code, interactive.
- **Why:** the 08-25 handoff carried this as open item 3 — *"`nfl_all_day`'s promote leg — 7,606 s/day, 0.6% hit rate, ⚠ marked SUNSET while carrying a live 105k backlog and actively resolving. **Reconcile the label with the backlog before acting.**"* This is that reconciliation, and nothing else. **Nothing shipped, no DB write.**

## Measured — one grouped read of `unmapped_sales`, 2026-08-25 ~20:52Z

| collection | unresolved | `last_resolved_at` | resolved 24h | resolved 7d | added 7d (`ingested_at`) | newest `sold_at` |
|---|---|---|---|---|---|---|
| **nfl_all_day** | **105,027** | **2026-08-25 20:36Z** | **63** | **1,577** | 611 | **2026-08-25 12:30Z** |
| ufc_strike | 1,070 | **NULL — never** | 0 | 0 | 14 | 2026-04-18 |
| laliga_golazos | 9 | **NULL — never** | 0 | 0 | 1 | 2026-08-06 |
| nba_top_shot | **0** of 24,583 | 2026-08-04 | 0 | 0 | 0 | 2026-01-16 |

⭐ **The label is not reconcilable with the behaviour.** The AllDay leg resolved a row **16 minutes before the read** and **1,577 in the last 7 days**, against **611** newly ingested — it is **net-draining ~966/week**, and its newest unmapped sale is **from today**. A pipeline that is dormant does not do that.

⭐ **The contrast case is in the same table, and it is the strongest evidence here.** UFC and Golazos read `last_resolved_at = **NULL**` — they have **never resolved a single row, ever**. That is precisely the signature that made parking those two legs on 08-24 correct, and **AllDay does not share it**. Top Shot shows the third shape: **0 unresolved of 24,583**, a leg that genuinely finished. AllDay looks like neither.

👉 **"SUNSET" is a statement about All Day as a COLLECTION (product status), not about this pipeline's state. The two were conflated.** Retiring the leg on the strength of the word would stop a resolver that is actively working a live backlog.

## ⚠ What I could NOT measure, and why the disagreement is NOT the sweep being wrong

The same-day data-quality sweep reports AllDay inflow **decreasing** — *"58 added last 7d vs 137 prior 7d"*. I measure **611 vs 177 — increasing**. ⛔ **Do not treat this as a contradiction, and do not "correct" the sweep.** The two use **different clocks on the same rows**:

- `sold_at` = **business time** (when the sale happened)
- `ingested_at` = **record time** (when we wrote it down)

A backfill that ingests old sales inflates every `ingested_at` window while `sold_at` stays flat — this repo's own *"derived tables cannot key on business time; backfills mutate the past"* rule. **Both numbers can be true at once and mean different things.**

⛔ **I could not settle it.** The `sold_at` split timed out **twice** (`canceling statement due to statement timeout` — the Postgres bound, not the gateway; read the error string, not the duration). Two causes, and they compound: (a) my query spanned **resolved** rows, so the partial index `unmapped_sales_unresolved_idx (collection_id, sold_at DESC) WHERE resolved_at IS NULL` could not serve it and no full `(collection_id, sold_at)` index exists; and (b) **the instance was in a live saturation spell** — positive control `io_wait=**19**, active=**33**, total=**44**`. **A spell confounds every timing in both directions, so the timeout is evidence about neither the query nor the data.** The inflow-direction question is simply **open**, to be re-run in a quiet window with `resolved_at IS NULL` in the predicate.

⭐ **The reconciliation the handoff asked for does not depend on that number.** Whichever way inflow trends, the leg is demonstrably alive.

## ⓘ Corroborating observation for the 18:09Z golazos filing

That filing recorded its control as `io_wait=2 / active=2 / total=41` and concluded *"the skip is historical, not live."* **At 20:52Z the same instance read `io_wait=19 / active=33 / total=44` — a spell IS live at this hour.** That does not overturn the filing (it was accurate at its own instant, and correctly declined to assert a cause); it supports its instruction to **re-measure across the day rather than conclude from one snapshot**, and it means a quiet window is genuinely narrow right now.

## Suggested action — a DECISION, not a diagnosis

1. ⛔ **Do not retire the AllDay promote leg on the SUNSET label.** Reconciled above: the label is about the collection.
2. If the **7,606 s/day** is the real concern, treat it as a **cost** question with its own levers, separate from liveness. A **0.6% hit rate** points at a candidate predicate that is too wide — the same shape the UFC/Golazos parking fixed by using the function's own `promote_recheck_after` skip rather than a new gate. ⚠ **Re-measure cost and hit rate in a quiet window and compare BUFFERS, not wall-clock** — every timing taken during a spell is confounded.
3. Neither is urgent: the backlog is net-shrinking and `unmapped_resolution_backlog_max` (recent-30d, aged residual excluded by design) is the metric that actually pages.

---

## ⭐ ADDENDUM 2026-08-26 ~02:40Z — the open half is CLOSED, and it corrects MY number, not the sweep's

The quiet window arrived (`io_wait=0, active=1`) and the `sold_at` split ran. ⛔ **The answer is not the one I expected, and the framing I published above — *"different clocks, so neither is wrong"* — was too generous to my own figure.**

### The mechanism I had not read

`promote_unmapped_sales` ends with:

```sql
DELETE FROM public.unmapped_sales
WHERE resolved_at IS NOT NULL
  AND resolved_at < now() - interval '7 days'
```

👉 **`unmapped_sales` is a STAGING QUEUE, not a log.** Resolved rows are archived out **7 days after resolution**; unresolved rows are **never** deleted (`purge_old_unmapped_resolution_failures` targets a *different* table, `unmapped_sales_resolution_failures`). Two independent point-samples confirm the shrink: total **106,604 → 106,539**, resolved **1,577 → 1,524**, in ~5.7 h.

### What that does to each figure

| figure | sound? | why |
|---|---|---|
| **unresolved by `sold_at`** — the sweep's metric (58 v 137; mine 49 v 135) | ✅ **SOUND** | unresolved rows are never purged, so the cohort is complete and permanent |
| **all rows by `ingested_at`** — MY figure (611 v 177) | ⛔ **CONFOUNDED** | older windows have had their resolved members deleted, so the earlier bucket is **depleted by survivorship**, not smaller by inflow |
| **all rows by `sold_at`** (594 v 135) | ⛔ **CONFOUNDED** | same reason |
| **"net-draining ~966/week"** (1,577 − 611) | ⛔ **WITHDRAWN** | it subtracted a confounded count from a rolling one |

⭐ **So the sweep's reading was RIGHT and mine was the broken one.** *"Inflow decreasing"* was measuring the **durable residual generated per week**, which is the thing that actually matters, and it is genuinely falling: the settled 8–14 d cohort leaves **135** permanently unresolved, while the still-settling 0–7 d cohort is already down to **49**.

⚠ **And `resolved_ever == resolved_7d` is a RETENTION BOUNDARY, not a start date.** The oldest surviving resolution is exactly 7 days old **by construction of that DELETE**. I nearly published *"the resolver only started working 7 days ago"* — the same shape as this repo's `pipeline_runs` ~73 h rule, where a missing record is an artifact rather than an absence.

### What now stands, and it is STRONGER than before

- ✅ **105,027 unresolved is a complete, permanent residual** — unresolved rows never purge, so nothing is hidden behind the archive.
- ✅ **~1,524 resolutions per week is a sound rolling rate** (the 7-day archive window makes the retained count ≈ the weekly rate), and it is a **floor**, since rows promoted and archived mid-window are not counted.
- ✅ **~1,524/week of resolutions against ~135/week of new durable residual.** The leg is decisively net-draining, and **the reconciliation's conclusion is unchanged: this is not a dormant pipeline, and SUNSET describes the collection.**
- ⛔ **Total AllDay sale inflow is NOT measurable from `unmapped_sales` at all** — by either clock. The promoted rows land in `sales`; **that is where an inflow question has to be asked.**
