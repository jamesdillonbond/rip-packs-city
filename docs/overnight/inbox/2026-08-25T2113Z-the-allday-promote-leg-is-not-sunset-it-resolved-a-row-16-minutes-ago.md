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
