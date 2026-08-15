# `pinnacle_fmv_history` silently drops the ASK_ONLY revision — 776 renders currently show a history value the catalog never published

**Filed** 2026-08-15 06:20Z by Claude Code (interactive), found while deciding whether to
re-point or retire the Pinnacle FMV drift guard. **Read-only. Nothing shipped** — the fix is a
prod change to Pinnacle FMV capture, which is off-limits for autonomous shipping.

## The claim

`public.pinnacle_fmv_history` is not an independent FMV source. It is written by two triggers on
`public.pinnacle_catalog`:

```
pinnacle_catalog_fmv_history_ins_trg  AFTER INSERT ... WHEN (new.fmv_usd IS NOT NULL)
pinnacle_catalog_fmv_history_upd_trg  AFTER UPDATE ... WHEN (new.fmv_usd IS NOT NULL
                                        AND (new.fmv_usd IS DISTINCT FROM old.fmv_usd
                                             OR new.fmv_confidence IS DISTINCT FROM old.fmv_confidence))
```

both running `pinnacle_catalog_fmv_history_capture()`:

```sql
INSERT INTO public.pinnacle_fmv_history (render_id, fmv_usd, fmv_confidence, fmv_sales_count_30d, computed_at)
VALUES (NEW.render_id, NEW.fmv_usd, NEW.fmv_confidence, NEW.fmv_sales_count_30d, COALESCE(NEW.fmv_computed_at, now()))
ON CONFLICT (render_id, computed_at) DO NOTHING;
```

`pinnacle_fmv_recalc_render_all()` writes each render **twice in one transaction**:

1. the sales loop — `UPDATE pinnacle_catalog SET fmv_usd = <wap>, fmv_confidence = <HIGH|MEDIUM|LOW|STALE>, fmv_computed_at = NOW()`
2. the ASK_ONLY pass — `UPDATE pinnacle_catalog SET fmv_usd = ROUND(floor_ask*0.90,2), fmv_confidence='ASK_ONLY', fmv_computed_at = NOW()`
   for any render whose confidence is in `('STALE','NO_DATA','ASK_ONLY')` or NULL and that has a live floor.

⚠ **`NOW()` is transaction-stable.** Both UPDATEs stamp the *same* `fmv_computed_at`, so the
second trigger firing collides on the `(render_id, computed_at)` unique key and
**`DO NOTHING` discards the ASK_ONLY value**. History keeps step 1's sales-derived value;
the catalog — and every surface that reads it — publishes step 2's floor-derived value.

## Measured live 2026-08-15

| | |
|---|---|
| priced catalog rows | 2,354 of 2,561 |
| catalog value = latest history value | 1,578 |
| **catalog value ≠ latest history value** | **776** |
| of those, whose same-timestamp history row holds a different value | **776 / 776** |
| …and carries a different confidence label | **776 / 776** |
| catalog value appears at *no* history timestamp for that render | 629 |
| max absolute divergence | **$2,974.47** |

Split by label — the pattern is exact, not noisy:

| `fmv_confidence` | priced rows | match latest history | differ |
|---|---|---|---|
| HIGH | 236 | 236 | **0** |
| MEDIUM | 494 | 494 | **0** |
| LOW | 549 | 549 | **0** |
| STALE | 22 | 22 | **0** |
| **ASK_ONLY** | **1,053** | 277 | **776** |

Every sales-derived row agrees. Every disagreement is ASK_ONLY. Sample:

```
render LEEV1-D23-SORC-E6  catalog $117.00 ASK_ONLY   history $75.3903 STALE   (same computed_at)
render LEEV1-D23-WOOD-E6  catalog  $76.50 ASK_ONLY   history $59.7392 STALE   (same computed_at)
```

## Why it matters

`get_edition_fmv_history` reads `pinnacle_fmv_history`, so the FMV chart on a Pinnacle edition
page plots a series whose most recent point **is not the FMV shown on the same page**, and the
published value appears nowhere in the chart. That is the failed-read-renders-as-an-answer family
seen from a new angle: nothing failed, a row was dropped by a conflict clause doing exactly what
it was written to do.

## Fix options (each needs a migration — not taken)

1. **Make the key unique per revision.** Stamp step 2 with `clock_timestamp()` instead of `NOW()`
   so the two writes land distinct `computed_at` values. Smallest change; ⚠ it makes history
   rows-per-render grow (currently 4.74 per render per 3 days) and the two revisions land
   milliseconds apart, which a chart will render as a vertical jump on the same day.
2. **`ON CONFLICT … DO UPDATE`** so the later write wins the timestamp. Keeps one row per
   `(render, computed_at)` and makes history agree with the catalog by construction. ⚠ Loses the
   intermediate sales-derived value entirely — which is arguably correct, since it was never
   published, but it is a deliberate information choice, not a bug fix.
3. **Do not write history from the sales loop at all** when the ASK_ONLY pass will overwrite it.
   Cleanest semantically, largest change to the recalc.

⚠ **Do NOT "fix" this by asserting catalog = history in a guard.** That is what this
investigation was originally for, and the guard would fire on all 776 rows while still saying
nothing about actual FMV drift. The retired drift guard's replacement is a source guard
(`__tests__/pinnacle-router-fmv-same-row-guard.test.ts`), not a data comparison.

## Related, and NOT a defect

- **21 ASK_ONLY rows carry an FMV with `floor_ask IS NULL`** ($328.50 total, $0.90–$99.00) — the
  state the recalc's own self-correct pass exists to prevent ("an ASK_ONLY render whose floor
  disappeared reverts to NO_DATA — never a stale floor"). All 21 share one timestamp pair: FMV
  stamped 2026-08-14 10:07:12Z, floors cleared 2026-08-15 01:45:36Z. It is a **transient window**
  between the floor refresh and the next recalc, self-healing on the next successful run, and
  `searchPinnacleDeals` filters `floor_ask IS NOT NULL` so the concierge never surfaces them.
  Bounded and expected — recorded so nobody re-derives it as a leak.
- **78 more ASK_ONLY rows where `fmv_usd <> round(floor_ask*0.90,2)`**: **78 of 78** have
  `floor_ask_updated_at > fmv_computed_at`. Entirely explained by the floor moving after the FMV
  was stamped. The ASK_ONLY identity is therefore **not assertable** as an invariant.
- **The window is open right now because the 2026-08-14 22:37Z recalc FAILED**, not because it
  was missed: `cron.job_run_details` jobid 200 (`rpc-pinnacle-fmv-recalc-backstop`) shows
  `status=failed`, `canceling statement due to statement timeout`, after five consecutive
  successes at 46–72 s. ⚠ It writes **no `pipeline_runs` row** — `log_pipeline_run` is at the end
  of the function — so it is invisible to every `pipeline_runs`-based instrument, and
  `pinnacle-fmv-recalc` is **not** on `pipeline_cadence_watchlist` (16 other Pinnacle pipelines
  are). It IS correctly reported by `check_pgcron_recent_failures()`, alongside six other
  statement-timeout casualties in the same window — i.e. the known disk-IO saturation class, and
  the monitoring worked. No action proposed here beyond noting the coverage asymmetry.
