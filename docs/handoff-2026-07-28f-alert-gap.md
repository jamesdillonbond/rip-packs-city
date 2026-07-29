# Handoff — 2026-07-28 (round 6) · a 4-hour blind window in indexer alerting

## Context

Found while resolving the UFC unmapped backlog. **Already done in Cowork, needs nothing from you:** `pipeline_alert_suppression` row added for `unmapped-sales-ufc_strike` (bounded 180d, lapses 2027-01-25). Alert count 4 → 2; `unmapped-sales-nfl_all_day` correctly still fires. Verified I did not over-suppress — `ufc_sales` is not in the suppression table.

The item below is a DB change I deliberately did **not** make, because it alters alerting thresholds and I'd rather not do that at the end of a long session.

---

## 16. `cursor_stalled` is classified at 2h but alerted at 6h — 4 silent hours

Two thresholds in two places that don't agree, so a state falls between them.

**`silent_indexer_failures`** (view) assigns status in a `CASE`, first matching wins:

```sql
WHEN cursor_updated_at IS NULL                        THEN 'no_cursor'
WHEN cursor_updated_at < (now() - '02:00:00')         THEN 'cursor_stalled'   -- 2h
WHEN sales_written_24h > 0                            THEN 'ok'
WHEN unmapped_written_24h > 0                         THEN 'resolving_editions'
...
```

**`get_pipeline_alerts()`** has two branches that consume it:

```sql
-- reads the view, matches on status
FROM public.silent_indexer_failures WHERE status = 'resolving_editions' ...
FROM public.silent_indexer_failures WHERE status = 'silent_failure' ...

-- does NOT read the view; reads event_cursor directly, on a different threshold
FROM public.event_cursor WHERE updated_at < now() - interval '6 hours' ...   -- 6h
```

**The gap.** At 2h of cursor staleness the view flips an indexer to `cursor_stalled`. That immediately stops it matching `status = 'ok'`, `'resolving_editions'` or `'silent_failure'`, so every view-driven alert branch drops it. But the `cursor_stalled` alert branch reads `event_cursor` on its own 6-hour clock. **Between 2h and 6h the indexer emits no alert of any kind** — and the `cursor_stalled` status that caused it to vanish is itself never surfaced, because nothing alerts on that status.

**Observed live**, which is how it was found: `ufc_sales` — `cursor_updated_at` 2026-07-29 01:08:55Z, `unmapped_written_24h` 210, `status` `cursor_stalled`. It had been reporting `resolving_editions` earlier in the session and silently disappeared from `get_pipeline_alerts()` with its unmapped count having gone *up*, not down. On UFC this is harmless — the Flow market has been dead since 2026-05-13. On `topshot_sales` or `allday_sales` it would be four silent hours on a primary sales indexer.

**Two ways to close it, and I lean to the second:**

1. Lower the alert branch to 2h so it matches the view. Simple, but adds alert volume for any cursor legitimately idle 2–6h, and several watchlist entries tolerate gaps in that range (e.g. `topshot-active-listings-ingest` is max-governed at 900 min). Likely noisy.
2. **Raise the view's `cursor_stalled` cut to 6h so the two agree.** Between 2h and 6h an indexer then keeps its *prior* honest classification (`ok` / `resolving_editions`) and stays visible under it, until the real 6h alert fires. No new alert volume, no silent window.

Option 2 changes a view other things may read — check consumers of `silent_indexer_failures.status` before switching (the `rpc-qa-scorecard` artifact reads this family, and `refresh-error-triage` may too).

Whichever is chosen, add a regression assertion that the view's threshold and the alert branch's threshold are the same number, so they cannot drift apart again. That is the actual defect — not either value.

**Revert:** restore the prior threshold in whichever object is edited.

---

## Also worth knowing (no action)

`topshot_sales` currently shows `status = 'ok'` with `runs_1h = 0` and `last_run_at = NULL`, because `ok` is driven by `sales_written_24h > 0` (2,652) — a 24-hour window deciding the health of an hourly process. Defensible, unlike the gap above, but it means `ok` here asserts "wrote sales sometime today," not "is running now."

## Guardrails

Unchanged.

**Claude Code's direct file inspection wins over this doc on any disagreement.**

## Expected end state

One threshold, expressed once, asserted by a test — and no window in which a stalled indexer is invisible to every alert branch.
