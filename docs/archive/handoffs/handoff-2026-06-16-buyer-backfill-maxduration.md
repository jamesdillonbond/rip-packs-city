# Handoff 2026-06-16 — topshot-buyer-backfill: raise maxDuration to stop runs dying at the 300s line

Small, low-priority reliability fix for one route. Diagnosed from `pipeline_runs.extra` + the route source; **corrects an earlier mis-diagnosis** (see below). Not user-facing — this is the historical buyer-attribution backfill, and recent TS sales already get buyers at ingest (the `b7211fb` / 2026-06-09 ship). Do it when convenient.

## Symptom

`get_pipeline_alerts()` fires a recurring `cron_silent` (medium) for `topshot-buyer-backfill` — last run then ~3–4h ago, against a 90-min watchlist threshold. The cadence is bursty (clusters of runs, then multi-hour gaps).

## What it is NOT (corrected diagnosis)

I initially called this a CRON-30S case (route doing >30s sync work, tripping cron-job.org's 30s client cap). **That's wrong — I confirmed by reading the route.** `app/api/admin/backfill-topshot-buyers/route.ts` is **already `after()`-wrapped**: auth is synchronous, the work runs inside `after(async () => {…})`, and the handler returns `{ok:true, queued:true}` immediately (≈ line 182). So cron-job.org already gets a fast 200 — the 30s cap is not the problem.

## Root cause (real)

The route declares `export const maxDuration = 300` (line 29), but the **background `after()` work consistently runs ~300–323s** — every recent run's `extra.duration_ms` is 298855 / 310258 / 319257 / 321974 / 322383 / 323398. Each run does `BATCH = 300` sequential on-chain tx decodes (`decodeTopShotSaleTx`, + a 40ms inter-row delay = ~12s of pure delay) walking `sales` backward by `sold_at`.

So the work sits **right at / past the 300s function ceiling**. The runs that log (ok=true, full counts) are the ones that squeak through on Vercel Fluid grace; runs that hit the denser historical windows take the full ~323s and get **killed at the maxDuration ceiling before the `finally` block writes the `pipeline_runs` row (line ~150)** → an invisible no-log run → an apparent "silent" gap, even though the cron fired and the response was 200. Cursor doesn't advance on a killed run, so that window just retries next time (safe — every UPDATE is gated on `buyer_address IS NULL`).

Confirmed healthy when it does run: 300 buyers + 300 sellers + 300 exec-accounts resolved/run, `decode_failed:0`, cursor walking backward cleanly (currently ~Dec 2023; recent sales already resolved at ingest).

## Fix (one line; pick A, optionally add B)

File: `app/api/admin/backfill-topshot-buyers/route.ts`

**A (the fix) — give the work headroom above its real ~323s runtime:**
```
export const maxDuration = 600   // was 300; after() work runs ~300–323s and was dying at the ceiling
```
600 is safe (Pro Lambda hard cap is 800s — going over 800 silently ERRORs the deploy, per the b32102e incident; 600 leaves ~2x headroom over the observed 323s and margin for denser historical windows).

**B (optional, defense-in-depth) — shrink the batch so a run can't approach the ceiling even if decodes slow down:**
```
const BATCH = 200   // was 300; ~200 decodes × (~1s + 40ms) ≈ 210–230s, comfortably under maxDuration
```
Trade-off: ~⅓ fewer rows/run, but the backfill is a finite historical tail with no deadline, and reliable completion beats raw per-run throughput. A alone is sufficient; B just adds margin.

## Revert
`git revert` the commit, or set `maxDuration` back to `300` (and `BATCH` back to `300` if B was applied).

## Operator note (separate, optional)
The cron-job.org entry is job **7776255** (~10-min intent). Worth a glance at its execution history once A ships: if it's firing on schedule and runs now log reliably, the bursty cadence + the watchlist `cron_silent` noise should resolve on their own. If it's genuinely firing sparsely (not every ~10 min), that's a cron-job.org schedule issue independent of this route. **Do not widen the 90-min watchlist threshold to mask it** — fix the run reliability (A) first and re-measure; the daytime monitor keeps that threshold tight on purpose.

## Guardrails
Direct-to-`main`, PowerShell git, full-file write, `maxDuration ≤ 800`. No DB/migration changes. CC's direct inspection of the route wins over this doc.
