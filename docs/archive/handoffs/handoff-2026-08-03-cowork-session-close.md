# Claude Code handoff — 2026-08-03 Cowork session close

**Context.** Cowork shipped everything it could ship live this session (migrations + edge fns via Supabase MCP, docs via git). This handoff covers only what needs a machine with CI: two real accuracy defects and one **alarm to re-key rather than a bug to fix**. HEAD at time of writing: `a1a9d91c` (docs-only correction of the classify-acquisitions misdiagnosis).

Every figure below was measured live, read-only, against `bxcqstmqfzmuolpuynti` on 2026-08-03. **Where a number contradicts the ledger or an earlier handoff, this doc's number is the re-measured one** and the older is wrong — each such correction is called out inline.

> **Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape.** Two premises in the 08-02 handoff did not survive re-measurement here; assume this one has its own.

---

## Item 1 — All Day FMV is still 1.42× its own realized median. Isolate the cause BEFORE touching the math.

**Priority: highest.** This is Gate-1 accuracy work per [docs/strategy/roadmap-2026-08-03.md](strategy/roadmap-2026-08-03.md).

**Files:** `app/api/fmv-recalc/route.ts` (sales fetch ~lines 294–340 and the extended-window refetch ~lines 610–645), `lib/fmv-recalc-math.ts`.

### What's wrong

The `$0.50` dust-floor removal (`3809425b`) worked for Top Shot but **did not fix All Day**. Published FMV ÷ the edition's own raw 30-day median, on editions with ≥4 raw sales, split by writer — the `cold-tail` writer is a natural control group because it has never had any filter:

| collection | writer | eds | median ratio | p90 ratio | over 2× |
|---|---|---|---|---|---|
| Top Shot | cold-tail (control) | 1,523 | 1.000 | 1.051 | 1 |
| Top Shot | fmv-recalc | 2,809 | 1.031 | 2.000 | 277 |
| **All Day** | cold-tail (control) | 987 | **1.000** | **1.020** | **0** |
| **All Day** | **fmv-recalc** | **570** | **1.421** | **6.800** | **206** |

Same collection, same window, two writers: the unfiltered one lands exactly on the market, the pipeline one is 42% high at the median and 6.8× at p90. So the residue is in `fmv-recalc`, not in the data.

It is concentrated entirely in the LOW-confidence bucket, and the count discrepancy points at the cause:

| confidence | eds | over 2× | median ratio | `sales_count_30d` (what fmv-recalc saw) | raw 30d sales (actual) |
|---|---|---|---|---|---|
| **LOW** | **318** | **180** | **2.29** | **2.5** | **9.1** |
| MEDIUM | 142 | 18 | 1.08 | 7.0 | 9.3 |
| HIGH | 47 | 2 | 1.06 | 11.0 | 10.8 |
| ASK_ONLY | 63 | 6 | 0.57 | 0.0 | 10.1 |

fmv-recalc is pricing off **2.5 of 9.1** available sales on the LOW rows, and those survivors sit at 2.29× the true median. MEDIUM and HIGH, where it sees nearly all the sales, are fine. This is the same *shape* as the dust filter — lose the bottom of the distribution, and what's left overstates.

### The discriminating test — do this first

There are two candidate causes and **they have completely different fixes**, so do not start editing:

- **(a) Input truncation.** The sales fetch is a chunked `.in()` with hand-rolled pagination (the comments at ~307 and ~314 flag both the PostgREST 1000-row cap and that `sold_at` ties are unsafe to paginate on). If pagination drops rows, fmv-recalc genuinely never sees them. This is the repo's most-repeated footgun class.
- **(b) A surviving filter** in `dampenGrailSpike` / `wapWithoutOutliers`.

**(a) is the leading hypothesis, on a structural argument:** every remaining step in `dampenGrailSpike` targets the **high** side (its own header comment says so), and removing high-side sales can only push FMV **down**. A 2.29× *over*statement cannot be produced by a high-side filter. The only low-side cut left is `wapWithoutOutliers`' `0.2 × median` band — and that runs *inside* the WAP, so it does not change `sales_count_30d`. Since `sales_count_30d` is itself already 2.5 vs 9.1, most of the loss happens **before** any of that. `dampenGrailSpike` step 1 is capped at 5 iterations, so it cannot take 9.1 down to 2.5 on its own.

Test it directly: pick ~20 All Day LOW-confidence edition ids from the query below, and log what the fetch actually returns for them versus a plain `count(*)` on `sales`. If the fetch returns fewer rows than the table holds, it's (a) and the fix is in the pagination, not the math.

```sql
with own as (
  select s.edition_id,
         percentile_cont(0.5) within group (order by s.price_usd) med,
         count(*) n
  from sales s
  where s.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
    and s.sold_at > now() - interval '30 days'
    and s.price_usd > 0
  group by 1
  having count(*) >= 4
)
select f.edition_id, own.n as raw_30d, f.sales_count_30d as seen_by_recalc,
       own.med as own_median, f.fmv_usd,
       round((f.fmv_usd / own.med)::numeric, 2) as ratio
from fmv_current f
join own on own.edition_id = f.edition_id
where f.algo_version not like 'cold-tail%'
  and f.confidence = 'LOW'
  and f.fmv_usd > own.med * 2
order by ratio desc
limit 20;
```

**Do not "fix" this by adding a filter, tightening the cap, or lowering the 3× clamp** — that treats the symptom and will bias the good MEDIUM/HIGH rows too.

**Revert path:** none needed yet (diagnosis only). If a fix lands, `git revert <sha>`; FMV is recomputed from `sales` on every run, so there is no data unwind — the next `fmv-recalc` tick republishes. The pre-removal baseline table `fmv_dust_removal_baseline_20260802` (26,802 rows) is still available for comparison.

**Verification:** `npx tsc --noEmit` clean; deploy READY; then re-run the two queries above and expect the All Day `fmv-recalc` row to converge on its `cold-tail` control (median ratio → ~1.0, p90 → ~1.1, over-2× → single digits). That convergence *is* the test — you have a control group, so use it.

---

## Item 2 — `classify-acquisitions-multicollection`: NOT a cron dropout, and the documented fix is disproved

**Files:** `app/api/cron/classify-acquisitions-multicollection/route.ts`, DB fn `backfill_acquisitions_for_collection`.

### Corrections to the existing docs

Two things currently written down are wrong, and both will waste a session:

1. **[docs/handoff-2026-08-02-open-items.md](handoff-2026-08-02-open-items.md) routes this to the operator as "a genuine cron-job.org dropout."** It isn't — **do not open the cron console.** The `nfl_all_day` leg began hard-failing 2026-08-01 with `canceling statement due to statement timeout`, and the 24/day → 8/day run drop is a *consequence*: route `maxDuration = 120` against the fn's `statement_timeout = 90s`, so when the AllDay leg burns its full 90s the 3-collection `after()` loop overruns and the lambda is killed **before `log_pipeline_run`**. The tick leaves no row and reads as a missing trigger. (A correction is already appended to that doc.)

2. **The route comment at lines 24–27 says "lower `p_limit` further."** That was correct in July and is not correct now. Measured from the `extra` payloads, `processed` per tick runs **0, 1, 3, 9, 20, 35** against `p_limit = 80` — the limit almost never binds, so the query scans the entire All Day priced-sales set every hour to return single digits. 80 → 40 changes nothing. Cost is now bound by the size of All Day `sales`, which only grows, so it degrades monotonically toward permanent failure.

### Measurements (all read-only, all timed out)

| probe | bound | result |
|---|---|---|
| `candidates` CTE at `LIMIT 80` | 120s | timeout |
| plain `count(*)` on the same predicate | 60s | timeout |
| inverted join, driving from `wallet_moments_cache` | 90s | timeout |

Both join directions are exhausted, so **reordering does not rescue it**. `idx_moment_acquisitions_nft_id` already exists — the anti-join probe is indexed and is not the problem.

### What an actual fix looks like

1. **Watermark** — a `last_scanned_sold_at` per collection so the hourly tick scans only new sales; drain the historic tail on a separate slow backstop. Restores freshness immediately and is the smallest correct change.
2. **Permanent-failure reason** — All Day sales for moments in nobody's tracked wallet can *never* satisfy the `EXISTS wmc` predicate, yet are re-scanned every hour forever. Structurally identical to the All Day `unmapped_sales` backlog; fix it the same way.
3. **Independently**, add a synchronous `phase:"invoked"` marker + fatal-catch so a killed `after()` is visible rather than silent — the same repair already applied to `allday-pack-listings` and `pinnacle-sync`.

**Do not** add a `sales(collection_id, nft_id)` composite (taxes the hot ingest path) and **do not** raise the fn `statement_timeout` — the lambda is already the binding budget, so raising it guarantees the silent kill.

**Impact:** `moment_acquisitions` is cost-basis / P&L enrichment behind sign-in — an accuracy gap, not an outage. All Day sits at 71,773 classified rows.

**Revert:** `git revert <sha>` for whatever lands. If a watermark table/column is added, the inverse is `ALTER TABLE ... DROP COLUMN` / `DROP TABLE` — include it in the migration comment.

**Verification:** `detect_stalled_pipelines()` stops listing it; `pipeline_runs` shows a row every hour at `:06`; `pipeline_runs_daily.runs` returns to ~24/day with `ok_count = runs`.

---

## Item 3 — `offer_fill` NULL serials: DOWNGRADE. It self-heals. Do not build a backfill.

**This corrects a Cowork ledger entry from earlier today** (`4432c549`, "the `offer_fill` sales writer drops serial_number on 36% of its rows"). That 36% was a **fresh-cohort snapshot misread as a permanent defect rate.** The serial-backfill crons drain it:

| age of row | rows | NULL serial |
|---|---|---|
| 0–6h | 271 | 10.0% |
| 6–24h | 580 | 26.7% |
| 1–3d | 987 | 8.0% |
| 3–10d | 3,870 | 1.1% |
| **10d+** | **33,937** | **0.8%** |

The permanent residue is **0.8%** (~272 of 33,937 rows), not 36%. `sales-serial-backfill` is running and writing (728 rows today, 1,529 on 08-02, `ok_count = runs`).

**What to do instead:** the sentinel arm is keyed on the *fresh* cohort, so it will keep flapping on a healthy system. Re-key it to measure rows **older than ~3 days** — that separates "backfill hasn't caught up yet" (expected, self-clearing) from "backfill is genuinely stuck" (real). Only if the aged rate climbs is there a defect.

**Do NOT backfill a guessed serial.** The open question — whether DapperOffersV2 fill events expose a serial at all — is now mostly moot, because whatever the backfill uses is evidently working. Leave the ~0.8% honest.

**Revert:** whatever `breach_at` / predicate change lands, revert with the inverse `UPDATE` on the watchlist row; put it in the migration comment.

---

## Not in scope / deliberately left

- **UFC in cross-collection wallet totals** — measured at 0.49% of all wallet FMV (worst single wallet 19.9%). The Flow UFC market is closed and that is disclosed; whether to exclude it from totals is a **product decision, Trevor's call**, not a bug.
- **`candy-editions-ingest`** shows an INFO stall at 32h against a 30h threshold. It is a healthy 1/day job (28,483 rows, `ok`) that missed one tick; the threshold is just sized so tightly that any single dropout trips it. Cosmetic — re-size only if it becomes noisy.
- **Dust-filter 24/48h watch** — superseded by Item 1, which is the real remaining measurement.

No `docs/FREEZE.md` needed; nothing here is launch-risky.

---

## Guardrails (repeat every time)

- **Direct to `main`. No branches, no PRs** (CLAUDE.md, non-negotiable). If a `claude/*` branch is pre-checked-out, switch to `main` first.
- **Commit the ledger BEFORE the code** so the code commit is the tip and auto-deploys — a docs-only tip suppresses the Vercel build.
- **Re-read `docs/overnight/ledger.md` from disk immediately before writing it.** It is append-at-top and concurrent. Splice your entry into the freshly-read file; never write back a copy read earlier. Sanity check: `grep -c '^### ' docs/overnight/ledger.md` must go **up** by exactly the number of entries you added.
- Commit via **PowerShell `git`** on Windows (Git Bash `git commit` can silently no-op). Verify the push with `git rev-list --count origin/main..HEAD` (expect `0`).
- `curl` **fails silently** in Git Bash for Vercel REST — use PowerShell `Invoke-WebRequest`.
- Vercel Pro `maxDuration` hard cap is **800s**; anything higher sends the deploy to ERROR invisibly.
- **CRLF:** don't string-replace-patch on Windows — full-file writes, or `findIndex` on split lines.
- Verify pages by **rendered DOM, not HTTP 200** — streaming shells always return 200.

---

## Expected end state

Item 1 root-caused (truncation vs filter) and All Day `fmv-recalc` converged on its `cold-tail` control; Item 2 fixed with a watermark so `classify-acquisitions` runs ~24/day green; Item 3 closed as an alarm re-key with no backfill written. All on `main`, CI green, deploy READY.
