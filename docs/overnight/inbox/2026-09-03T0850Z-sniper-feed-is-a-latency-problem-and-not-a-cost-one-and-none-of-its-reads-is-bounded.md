# `/api/sniper-feed` is a LATENCY problem and NOT a cost one — and none of its reads is bounded

**Filed 2026-09-03 ~01:50 PT (08:50Z) by Claude Code. NOTHING SHIPPED.** The route is 1,957 lines of
user-facing surface; the fix is a real change and the measurement should stand on its own first.

## 1. The user-visible failure

24 h to 2026-09-03 08:00Z, `/api/sniper-feed` by status code: **455 × 200, 12 × 204, 7 × 307, 3 × 504.**
The three 504s are `Vercel Runtime Timeout Error: Task timed out after 45 seconds` — the route's
`maxDuration`. Grouped by `requestPath`, it is the platform's **second** source of wall kills, behind
`wallet-backfill-golazos` (6, fixed tonight).

## 2. Where the time goes — `pg_stat_statements`, window **22.3 days** (reset 2026-08-12 01:33:59Z)

| function | calls | mean | max | total |
|---|---:|---:|---:|---:|
| `get_topshot_sniper_deals` | **6,746** | **6,898 ms** | **29,987 ms** | 12.9 h |
| `get_editions_for_sniper` | 3,464 | 824 ms | 27,544 ms | 47.6 min |
| `get_allday_sniper_deals` | 22 | **20,145 ms** | 29,466 ms | 7.4 min |

⚠ **The two maxima at ~29,99x ms are the 30 s `statement_timeout`, not a coincidence** — those calls
were killed. `[sniper-feed] get_allday_sniper_deals error: canceling statement due to statement timeout`
appears in the live error table, so the kill is observed from both sides.

## 3. ⛔ AND HERE IS THE PART I NEARLY GOT WRONG: 12.9 HOURS IS NOT A COST FINDING

Instance total `total_exec_time` over the same window is **1,942.8 hours**. So:

| function | share of instance DB time |
|---|---:|
| `get_topshot_sniper_deals` | **0.67%** |
| `get_editions_for_sniper` | 0.04% |
| `get_allday_sniper_deals` | 0.01% |

⭐ **"12.9 hours of database time" is a true number that means almost nothing here.** At 0.67% this is
nowhere near a saturation lever, and the repo's own rule — *rank by absolute inflation, and an
expensive-looking function is not a cost until you have named the caller* — says do not touch it for
cost.

⭐ **The latency question is separate and it does stand.** A **6.9 s mean** on a read a human is waiting
for, with a maximum pinned at the statement timeout, on a route whose whole budget is 45 s. **A function
can be a latency problem and not a cost problem. This one is.**

## 4. The structural half: the route bounds NOTHING

`app/api/sniper-feed/route.ts` (1,957 lines) calls `get_editions_for_sniper`, `get_allday_sniper_deals`,
`get_topshot_sniper_deals` and a `serial_fmv_estimate` inside a `Promise.all` — **with no
`withBoardBudget`, no `rpcWithRetry`, and no per-read timeout anywhere.** The single `AbortSignal` in
the file (line 550, 6,000 ms) bounds an HTTP call, not a database read.

So the failure mode is exactly the one `lib/pack-dist/fetchers.ts` was written to remove on the
pack-detail page: several unbounded reads in series, and when they add past the wall the user gets a
**504 instead of a partial answer**. The route already has `if (error)` branches on each RPC, so a
bound that RESOLVES with a synthetic error (the `withBoardBudget` pattern, never a rejection) would
route a slow read into a branch that already exists.

⚠ **This is very likely another instance of the guard-scope class** — `check-unbounded-server-reads.mjs`
walks `app/insights`, and its own header records that the fourth instance of ITS class was outside that
walk by construction. `/api/sniper-feed` is outside it too. **Not asserted: I did not re-run that guard
to confirm what it currently inspects.**

## 5. ⓘ An unexplained 300× that is worth one query before anyone acts

`get_topshot_sniper_deals` 6,746 calls against `get_allday_sniper_deals` **22**, over the same window.
Either the AllDay tab is barely used, or **the AllDay path short-circuits before reaching its RPC** —
and there is a candidate in the error table: `[sniper-feed] AD GQL FAILED: HTTP 403 <title>block</title>`
(5 users in 24 h). If the AllDay leg 403s upstream first, its RPC never runs, and a "fix" aimed at that
20 s mean would be tuning a function almost nobody reaches.

⛔ **Hypothesis, not a finding.** The discriminating measurement is a per-collection request count on the
route, which nothing currently records.

## 6. What NOT to do

- ⛔ **Do not sell this as a cost saving.** 0.67%.
- ⛔ **Do not raise `maxDuration` first.** The reads are unbounded; a bigger wall makes a slow page
  slower rather than turning it into an honest one, and the 30 s statement timeout still cuts the read.
- ⛔ **Do not tune `get_allday_sniper_deals` before §5 is answered.**

---

## ⓘ ADDENDUM, same session — I ran the guard, and §4's guess was the RIGHT ANSWER FOR THE WRONG REASON

§4 said `/api/sniper-feed` is *"very likely another instance of the guard-scope class"* and explicitly
did not assert it. Run:

```
[unbounded-server-reads] 183 page/layout file(s); 82 async server; 0 unbounded (ceiling 0)
[unbounded-server-reads] ok
```

⭐ **It walks PAGE and LAYOUT files — 183 of them — and no API routes at all.** So `/api/sniper-feed`
is outside it, but **not because a glob was drawn too narrowly**: the guard is about server *pages* by
design, and it is doing that job perfectly (ban at zero, holding).

⛔ **The real gap is bigger and simpler than the one I guessed: the same class has a ban at zero for
PAGES and NO INSTRUMENT AT ALL for API ROUTES.**

Sized, comment-stripped, 2026-09-03:

| | count |
|---|---:|
| `app/api/**/route.ts(x)` | **499** |
| …that read Supabase (`.rpc("…")` / `.from("…")`) | **359** |
| …with **no** budget primitive anywhere in the file (`withBoardBudget`, `withPagedBoardBudget`, `rpcWithRetry`, `AbortSignal`, `AbortController`) | **273** |

⚠ **273 is an UPPER BOUND on the population and NOT a defect count**, for two reasons stated so nobody
quotes it as one. (1) A cron/ingest route that hangs produces a loud, watched failure — an absent or
`ok:false` `pipeline_runs` row — which is a completely different blast radius from a user-facing 504.
(2) File-level presence is a coarse test in both directions: a route with one bounded read and six bare
ones passes, exactly the asymmetry `lib/pack-dist/fetchers.ts` records for itself (*"ONE read here was
already bounded and THIRTEEN were not"*).

⭐ **So the ratchet, if one is written, must be scoped by BLAST RADIUS rather than by count** — ban at
zero on the routes a human waits for, ratchet the rest — which is precisely the shape
`image-proxy-routes-bound-their-upstream` already uses. That is the same conclusion the guard-scope
lesson reaches from the other direction: *ask what the widest set is where the property is meaningful,
then split it by whether the failure answer is settled.*

ⓘ And CLAUDE.md already predicted this exact hole: *"an exclusion justified by ANOTHER instrument is a
claim about it — two guards skipped `app/api` as 'in the primary gate'; coverage sees whether lines RUN,
not whether `error` is handled."*
