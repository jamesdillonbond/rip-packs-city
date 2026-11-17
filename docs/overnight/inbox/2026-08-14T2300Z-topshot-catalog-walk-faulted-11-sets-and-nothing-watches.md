# The Top Shot catalog walk faulted 11 of 258 sets and nothing watches that counter

**Filed** 2026-08-14 23:00Z by Claude Code (interactive), noticed while checking whether the
player-bio columns had populated. **Read-only. Nothing shipped.** One data point, deliberately
filed rather than acted on.

## What the run says

`pipeline_runs`, `topshot-catalog-backfill`, 2026-08-14 02:12Z — the first tick since the daily
Vercel cron was wired up:

```
ok: true            editions_upserted: 9396     sets_processed: 258
gql_calls: 541      sets_faulted: 11            terminated_reason: no_more_sets
errors_sample: [ { "reason": "page 1: gql: error with searchSetPlays", "set_id": "…" } × 5 ]
```

**11 sets faulted on page 1**, meaning they contributed ZERO editions to that sweep. `ok` stays
`true` by design — `9909f27d` deliberately does not redden on partial faults, because a
chronically-red pipeline trains the operator to skim past it (the cost already paid for with
`ufc_fmv_stale_hours`). That decision is right. The consequence is that **no instrument reads
`sets_faulted` at all**, so a fault rate can drift from 4% to 100% and only the `editions_upserted`
tell would catch it.

## What faulted

⚠ The `set_id` in `errors_sample` is our internal `sets.id` (PK), **not** `sets.external_id` — a
join on `external_id` returns nothing and reads as "unknown sets". The five sampled:

| set | canonical editions | with description |
|---|---|---|
| 2025 Rookie Ultimates | 26 | 24 |
| WNBA Holo Icon | 25 | 24 |
| 2024 Rookie Ultimates | 14 | **9** |
| Skyline | 30 | 30 |
| Heroes of the Game: Diamond Edition | 20 | 20 |

So the immediate damage is small — these sets are already largely indexed, and a fault only skips
that set for that sweep. `2024 Rookie Ultimates` at 9/14 is the one visibly short.

## What is NOT known

**Whether the fault set is stable or random.** `sets_faulted` is new (shipped 2026-08-13), so
2026-08-14 02:12Z is the only run that carries it, and the two 08-13 runs recorded
`errors_sample: []`. If the same 11 sets fault every night, that is a systematic hole in catalog
and description coverage; if it rotates, it is Top Shot GQL flakiness that the next sweep repairs.
**One run cannot distinguish these**, and guessing is how the last three narrative-search
diagnoses went wrong.

## Suggested next step (cheap, and it answers the question)

After a few more nightly ticks, compare the `errors_sample` set ids across runs:

```sql
SELECT started_at,
       extra->>'sets_faulted' AS faulted,
       jsonb_agg(e->>'set_id') AS ids
FROM public.pipeline_runs, LATERAL jsonb_array_elements(extra->'errors_sample') e
WHERE pipeline = 'topshot-catalog-backfill'
GROUP BY 1, 2 ORDER BY 1 DESC;
```

⚠ Mind the retention: `pipeline_runs` keeps only ~73h, so this must be sampled within three days
of the runs it compares, or read `pipeline_runs_daily` — which rolls up counts but **not** the
`errors_sample` payload, so the set ids are gone after the prune either way.

- **Stable set** → a per-set problem worth chasing upstream (retry, or a different page size).
- **Rotating** → transient; the cheap remedy is one retry on a faulted page before giving up,
  which would also stop `editions_upserted` sagging on flaky nights.

## Related, and not a defect

The same run shows the descriptor backfill working: description coverage moved **44.6% → 69.1%**
on canonical Top Shot editions. The player bio columns (`player_birthdate` / `player_birthplace` /
`player_draft_year`, added 2026-08-14) read **0** because the capture code landed *after* the
02:12Z tick — the next one is the first that can fill them. ⚠ If they are still 0 after that run,
check `editions_upserted` and `gql_calls` FIRST: an invalid field makes the whole GraphQL query
422 and the walker completes reporting `ok: true` having written nothing, and the tell is
`gql_calls` exactly equalling `sets_processed`.
