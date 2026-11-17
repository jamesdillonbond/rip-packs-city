> ⓘ **SUPERSEDED — filed late (2026-09-12) from the claude.ai Project archive; no action for the drain.** This filing was written by a Cowork cloud pass between 2026-08-29 and 2026-09-01 that could not push, so it never reached `docs/overnight/inbox/` at the time; its ledger entry DID land. It is committed now, unedited below the banner, so that citations by path resolve and the record is complete. **Read the ledger entry for that pass, not this body.**
>
> Recovered by the 2026-09-12 Cowork session that pruned the Project (`docs/overnight/ledger.md`, 2026-09-12 · "a third push path from Cowork").

# 2026-08-31T01:10Z — Top Shot player matching is a no-op because the roster holds 174 of 1,432 names

⚠ **Committing this file requires adding its entry to `docs/overnight/inbox/INDEX.md` in the SAME
commit and bumping the header count** — `__tests__/inbox-index-lists-every-filing.test.ts` asserts the
directory against that listing on every CI run.

Filed by the cloud autonomous pass, 2026-08-31 01:10Z (2026-08-30 ~18:10 PT). Nothing shipped.

## What the alert says

`get_pipeline_alerts()` carries `match-topshot-players` as `running_but_not_succeeding`:
*"1 run(s) in the last 1800 min, ZERO ok and ZERO rows written."* That arm is doing its job — the
pipeline runs daily at 08:00Z, so a 30 h window legitimately holds one run.

## What is actually true

`pipeline_runs_daily`, 14 consecutive days **2026-08-17 → 2026-08-30**: `runs` 1, `rows_written` **0**,
every day. `ok_count` is 0 on six of them (the 08-30 failure is `rpc_failed: upstream request timeout`).

Then the tables, read directly:

| | |
|---|---:|
| `nba_players` rows | **174** |
| distinct `player_name` in `wallet_moments_cache` for `nba_top_shot` | **1,432** |
| `nba_player_aliases` rows | 7 |
| …of which `source = 'auto'` | **0** |

The roster sample (`order by id limit 6`) is *Caris LeVert, Adem Bona, Thomas Sorber, Dalton Knecht,
Jaylon Tyson, Ariel Hukporti* — a current-season slice. Top Shot's catalogue is historical NBA plus
WNBA, and almost none of it is in there. **The auto-aliaser has never inserted a row.**

## Why this is NOT a broken matcher — the payload proves it

`match_topshot_players_run()` computes, per unresolved name:

```sql
candidate_count := (SELECT count(*) FROM nba_players
                     WHERE similarity(p.full_name, u.player_name) >= 0.85)
best_sim        := (SELECT max(similarity(p.full_name, u.player_name)) FROM nba_players)  -- NO threshold
```

The 08-29 payload reports `skipped` 166, `total_unresolved` 1,266, `needs_review_count` 1,247, and
`candidate_count: 0` on **every single entry** — including exact names, e.g. *Ja Morant* at
`best_sim` 0.15, *Bam Adebayo* 0.22, *LaMelo Ball` 0.13.

At first read that looks self-contradictory (a real name scoring 0.15). It is not: `best_sim` is an
**unthresholded** max over the roster, so *"the closest full_name we hold is 15 % similar to Ja Morant"*
is the literal, honest statement that **Ja Morant is not in the table at all**. 166 names resolve
because those 166 *are* in it. The matcher, the alert and the payload all agree with each other.

## The cost of the no-op

Each nightly run scans wmc for the name set, then runs **three independent correlated subqueries over
`nba_players` per unresolved name** (count, argmax, unthresholded max) — 51–126 s of DB work — and
writes a **~1,247-object array into `pipeline_runs.extra`**, daily, to restate one fact.

## 👉 Decision for Trevor — it is a data-source question, not an engineering one

1. **Where does a complete NBA + WNBA roster come from?** Nothing in the repo appears to load
   `nba_players` beyond the 174 rows present; that source needs naming before anything else moves.
2. **Or: should Top Shot's own `player_name` be canonical?** If wmc's names are the trustworthy
   spelling, the alias table is solving a problem we do not have, and the honest move is to retire the
   pipeline rather than feed it.

⛔ **Do not "fix" the matcher** — it is behaving correctly against the data it has.
⛔ **Do not cap or drop `needs_review` before (1)/(2) are settled** — that array is currently the only
visible evidence of the gap, and truncating it would make a real hole invisible. This is the same
shape as the `compute-topshot-pack-ev` `ok:true` defect, one layer up: a pipeline reporting
successfully on work it cannot possibly do.

## Reproduce

```sql
select (select count(*) from public.nba_players)                                as roster_rows,
       (select count(*) from public.nba_player_aliases where source='auto')     as auto_aliases,
       (select count(distinct player_name) from public.wallet_moments_cache
         where collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
           and player_name is not null and length(trim(player_name))>0)         as ts_distinct_names;

select day, runs, ok_count, rows_written
  from public.pipeline_runs_daily
 where pipeline='match-topshot-players' order by day desc limit 14;
```

⚠ **Do not `select extra` from `pipeline_runs` for this pipeline without a projection** — each row
carries the 1,247-object review array.
