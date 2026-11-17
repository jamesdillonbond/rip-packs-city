> ⓘ **SUPERSEDED — filed late (2026-09-12) from the claude.ai Project archive; no action for the drain.** This filing was written by a Cowork cloud pass between 2026-08-29 and 2026-09-01 that could not push, so it never reached `docs/overnight/inbox/` at the time; its ledger entry DID land. It is committed now, unedited below the banner, so that citations by path resolve and the record is complete. **Read the ledger entry for that pass, not this body.**
>
> Recovered by the 2026-09-12 Cowork session that pruned the Project (`docs/overnight/ledger.md`, 2026-09-12 · "a third push path from Cowork").

# The 08-30 "it is winning" verdict on `refresh_wmc_fmv_drift_active` is REFUTED by its own falsifier: the cutoff advanced 0.51 seconds in 5 minutes 47

**Filed 2026-08-31 07:1xZ (2026-08-31 00:1x PT), cloud pass.** Every timestamp below is DB `now()`, never the container clock —
that distinction is the reason last night's reading was wrong, so it is the reason this one is worth trusting.
**Repo read at `origin/main` `a1e0fd0a`, cloned 06:58Z.** Live `prosrc` read from `pg_proc`, not from a handoff.

> ⚠ **This pass could not push** (cloud git-proxy repo-set 403 — session-scoped, operator-only). Trevor's machine and Claude
> Code push normally. **Commit these files as usual.**

---

## What the ledger says, and what it told me to check

The 2026-08-30 entry concluded: *"📏 `refresh_wmc_fmv_drift_active` is NOT a defect — it is duty-cycle-limited, and it is
winning … one run advances the cutoff **+7.66 minutes** of backlog (23:28:13 → 23:35:54) in ~65 s … each cycle drains ~468
editions against ~354 arriving — **net positive, ~1.3×**."* ⛔ **Not changed there on purpose**, with the trade assigned to
Trevor.

It also wrote its own falsifier, and that is the one good thing to come out of this: *"read `rwfd_state.last_cutoff` twice
against `now()` from the DB, never a container clock, and compare the advance to the gap between calls."*

## Running it

| DB `now()` | `rwfd_state.last_cutoff` | backlog |
|---|---|---|
| 2026-08-31 **07:01:10.322** | 2026-08-31 03:28:11.871023 | 212.97 min |
| 2026-08-31 **07:06:57.327** | 2026-08-31 03:28:12.381402 | **218.14 min** |

**Advance: 0.510 s of cutoff against 347 s of wall clock — 0.15 % of real time.** The claim under test was 130 %.
The backlog did not shrink; it **grew by 5.2 minutes in under 6.** It is pinned at ~3.6 h and widening.

## The mechanism, from the live body — and it is a feedback loop, not a duty cycle

`prosrc` (public.refresh_wmc_fmv_drift_active(numeric, integer)), the three lines that matter:

```
v_chunk    constant integer  := 25;
v_budget   constant interval := interval '15 seconds';
...
CREATE TEMP TABLE _rwfd_changed AS
  WITH changed AS MATERIALIZED (
    SELECT fs.edition_id, fs.fmv_usd, fs.computed_at
    FROM public.fmv_snapshots fs
    WHERE fs.computed_at > v_cutoff            -- ⚠ the window is now 3.6 HOURS wide
      AND fs.fmv_usd IS NOT NULL )
  SELECT DISTINCT ON (c.edition_id) ... ;
...
SELECT MIN(computed_at) - interval '1 microsecond' INTO v_new_cutoff FROM _rwfd_changed;
```

1. **The window is `computed_at > v_cutoff` with no upper bound.** At the current lag it scans 3.6 h of `fmv_snapshots` —
   **2,929 distinct editions in the first hour past the cutoff alone; 394 in the first minute.**
2. **The build is charged against the same 15-second budget as the drain.** Every observed run exits on the deadline, never
   on an empty queue — twelve consecutive ticks at **15,156 / 15,270 / 15,459 / 15,462 / 15,580 / 15,694 / 15,949 / 16,062 /
   16,118 / 16,381 / 16,531 / 16,769 ms**. A duration distribution that tight *is* the deadline.
3. **So a wider window buys a slower build, which leaves less budget for the loop, which advances the cutoff less, which
   widens the window.** That is a positive feedback loop, and the 0.51 s reading is it running.
4. **The new cutoff is `MIN(computed_at)` over the UNDRAINED RESIDUE.** It is therefore hostage to the single oldest
   straggler: thousands of newer editions can drain and the cutoff still will not move past one leftover row.

⚠ **`v_chunk = 25` is not incidental** — `20260812233257_audit_20260812_drift_active_chunk_sized_for_saturation` sized it
for saturation conditions. Draining ~11,000 queued editions at 25 per pop needs ~440 iterations, and it gets whatever is
left of 15 s after the build. The instance right now is **0 active / 0 `DataFileRead`** — the condition that constant was
chosen for is not the condition it is running in.

## What it costs, and what it produces

- **pg_stat_statements, diffed on `(userid, dbid, toplevel, queryid)` against the `audit_20260830_pgss_snap` row at
  05:06:44Z, window ending 07:01Z: 23 calls, 363.5 s, 722,011 blocks read (5.6 GB), 31,392 blocks/call — the instance's
  #1 disk-read consumer in that window.**
- **`pipeline_runs`, the twelve ticks 06:08 → 07:03Z: rows written on 2 of 12** — 172 and 5 — **and zero on the other ten**,
  each still paying its full ~15 s.

⚠ **Zero is not by itself a defect, and this filing does not claim it is.** `p_deviation_pct = 25` means the function only
writes where a cached holder row is >25 % off the current FMV, and the 2026-08-16 ledger entry establishes the scope as the
**`allow_list` active wallets** — a small set. Mostly-zero is what a healthy catch-all looks like. **The finding is the
cutoff, not the row count:** the sweep is examining snapshots from 03:28Z, so drift arriving in the last 3.6 hours is
*unexamined*, and at 0.15 % it never will be. Price-change propagation is the twin's job (`refresh_wmc_fmv_changed`,
jobid 303, its own cursor, healthy) — this is the safety net, and the safety net is running 3.6 h in the past.

## ⛔ Nothing shipped, and each tempting fix is named with why

1. **Cap the window** (`v_cutoff := GREATEST(v_cutoff, now() - '2 hours')`) — bounds the build immediately and is a
   four-word change. ⛔ **It silently abandons every edition older than the cap**, which is the exact silent scope change
   this repo forbids, and the same objection the 05:10Z pass raised against time-bounding the AllDay drain. Not clearly-safe.
2. **Raise `v_budget`** — this is the freshness-vs-instance-load trade the 08-30 entry already assigned to Trevor, and
   assigning it there was right.
3. **Raise `v_chunk` off its saturation sizing** — same trade, plus it re-opens a constant chosen under a condition that
   has since changed. Wants a measurement under load, not a quiet night's edit.

⭐ **The fix that is neither of those, and the one worth Trevor's attention:** the build is re-derived from scratch every
five minutes over an ever-widening window, to drain a set it then mostly throws away. **Give the drain a bounded upper edge
per run** (`computed_at > v_cutoff AND computed_at <= v_cutoff + interval 'N minutes'`) so the build cost is constant and
the cutoff advances by a *known* amount each tick, abandoning nothing. That is a real design change with a real test, not a
constant tweak — which is why it is filed rather than applied.

**Falsifier for this filing:** take the two readings again against DB `now()` over ≥ 30 minutes. If the cutoff advance
exceeds the elapsed time, the 08-30 entry was right and I sampled a stall.
**Positive control already in hand:** the 08-30 reading (+7.66 min in one run) and mine (+0.51 s in ~1 run) are both real —
the rate is set by the density of the region being walked, and the 03:28Z region is dense (394 editions/min). That
variability is itself the argument against sizing this on any single run, **mine included.**
