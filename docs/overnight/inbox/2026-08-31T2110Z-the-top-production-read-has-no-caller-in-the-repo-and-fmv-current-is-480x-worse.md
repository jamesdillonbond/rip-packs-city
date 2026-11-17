> ⓘ **SUPERSEDED — filed late (2026-09-12) from the claude.ai Project archive; no action for the drain.** This filing was written by a Cowork cloud pass between 2026-08-29 and 2026-09-01 that could not push, so it never reached `docs/overnight/inbox/` at the time; its ledger entry DID land. It is committed now, unedited below the banner, so that citations by path resolve and the record is complete. **Read the ledger entry for that pass, not this body.**
>
> Recovered by the 2026-09-12 Cowork session that pruned the Project (`docs/overnight/ledger.md`, 2026-09-12 · "a third push path from Cowork").

# 2026-08-31T21:10Z — the #1 production read has no caller in the repo, and its obvious fix is 480x worse

> ⚠ **SCOPE.** The push blocker is specific to that **cloud session**. Trevor's machine and Claude Code
> push normally. **Commit this file as usual.**

**Status:** OPEN — needs an attribution, not a patch.

## What was measured

pgss diff, baseline `at` = 2026-08-31T20:19:28.554Z → 21:00:41.302Z (41.2 min; baseline age checked
before the window was called a window). Diffed on `(userid, dbid, toplevel, queryid)`, never queryid
alone.

Top production row, `queryid 1387451210050502049`:

```
SELECT edition_id, fmv_usd, confidence, sales_count_30d, computed_at
FROM public.fmv_snapshots
WHERE edition_id = ANY ($1)
ORDER BY computed_at DESC
LIMIT $2 OFFSET $3
```

| | window (41 min) | lifetime |
|---|---|---|
| calls | 60 | 2,819 |
| buffers | 13,530,075 | 120,419,556 |
| buffers/call | 225,501 | 42,717 |
| exec time | 522.1 s | 10,569.5 s |
| mean / max ms | — | 3,749 / **29,992** |

`max_exec_time` 29,992 ms is the **service_role 30 s statement_timeout**. Some fraction of these calls
are being killed.

## Why the known fix does not apply

This is the **D27 anti-pattern** (raw `fmv_snapshots` DESC + JS first-wins dedup), fixed before —
notably R3, which repointed `/api/fmv` to `fmv_current`. Measured here, same array / session / state:

| shape | buffers | ms |
|---|---|---|
| current (`fmv_snapshots` + ORDER BY + LIMIT 1000) | 2,711 | 399 |
| R3's repoint (`fmv_current` + LIMIT 1000) | **1,302,431** | **25,950** |

The plan shows why: `edition_id = ANY(...)` becomes a **Join Filter above the Unique**, so the view
materialises all 1,354,155 rows → 27,170 uniques and throws away 26,970. Quals do not push through
`DISTINCT ON`. This is the same mechanism behind the 08-30 batch that moved four RPCs *off*
`fmv_current`. R3 was safe because its call sites carry an extra pushable filter; a bare
`edition_id = ANY(...)` read does not.

`get_fmv_for_editions` is not a substitute: `TABLE(edition_id uuid, fmv_usd numeric)` only — no
`confidence`, no `sales_count_30d`, which both repo callers need for the $10 K outlier ceiling.

## The open question: who calls it?

Three hypotheses tested and **refuted** — do not re-run them:

1. **The two repo callers** (`supabase/functions/scan-ufc-wallet`, `enrich-ufc-wallet`) — both
   UFC-scoped, chunk at 200. **All 518 UFC editions hold 4,391 snapshot rows total**; a 200-slice
   measures **2,711 buffers**. They share the shape (so they land in this queryid) but cannot be the cost.
2. **Edge-function drift** — pulled the deployed `enrich-ufc-wallet` v46. Not drifted; matches the repo.
3. **Stale Vercel build predating the 2026-07-30 repoint `a85655f12`** — production is on today's
   `a6b3c4ab2` (READY `dpl_mVbsRVubjRB…`).

Grepped for the shape across `app/`, `lib/`, `workers/`, `scripts/`, `supabase/functions/`, both quote
styles. Only the two UFC callers match.

**The row math names the size of the caller:** nba_top_shot = 19,933 editions / 926,287 snapshots =
**46.5 snaps/edition**, so a 200-id slice needs ~9,300 rows — which at the measured ~1.4–4 buffers/row
reproduces the observed 42,717/call. Something is issuing this PostgREST shape with **Top-Shot-sized
arrays**. Candidates not yet checked: GitHub Actions workflows, cron-job.org entries pointed at
non-Vercel hosts, Cowork dashboard artifacts that re-query on open, and any local/ad-hoc script using
the service key.

## A correctness claim I formed and then killed

I expected the PostgREST 1,000-row cap to be silently dropping editions (the D27 correctness half —
cold editions resolve to `null`). **Measured across all 518 UFC editions in 3 slices of 200: 2 slices
exceed the cap, 0 editions are dropped.** UFC's snapshot cadence is uniform enough that the newest
1,000 rows still cover every edition in the slice. **Latent, not live.**

⭐ For the unidentified Top-Shot-sized caller the same arithmetic (~9,300 rows vs a 1,000 cap) says the
truncation **is** live there — a second reason to find it.

## Next action

Identify the client. Then decide between a new additive SECDEF RPC returning
`(edition_id, fmv_usd, confidence, sales_count_30d, computed_at)` via LATERAL-per-edition, versus
extending `get_fmv_for_editions`. **Do not ship either before the caller is named** — a fix aimed at
the wrong client is how this shape survives another week.
