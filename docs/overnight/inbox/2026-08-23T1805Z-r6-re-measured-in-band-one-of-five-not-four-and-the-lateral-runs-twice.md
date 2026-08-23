# R6 re-measured in-band: 1 of 5, not 4 of 5 — and the expensive lateral runs TWICE per request

**Filed:** 2026-08-23 ~11:05 PT (18:05Z) · **By:** Claude Code, interactive · **Status:** MEASURED, nothing shipped

R6 has carried *"a degraded-band re-measure is still owed before closing"* since 08-22. This is that
measurement, plus one structural finding that needed no timing at all.

## 1. ⚠ The "degraded band" is a CLOCK window, not a saturation guarantee

Taken at **17:55–17:58Z, inside the 16:20–18:05Z band the register names.** But the database was **NOT
saturated**: `4 active · 1 IO waiter · longest active query 1.9 s`, against the audit's degraded reading of
*31 active / 30 IO waiters*.

🚨 **So this does NOT discharge the owed measurement, and the exit condition as written is under-specified.**
"Re-measure in-band" and "re-measure during saturation" are different asks, and only the second one tests
what R6 is about. The band is a time-of-day *correlation*; today it did not hold. **Whoever closes R6 should
re-word the exit condition to name saturation, not the clock** — otherwise someone will discharge it with a
reading like this one and close a P1 on a quiet database.

## 2. The result: 1 of 5 fails, and it is the biggest collection

Production caller, same three minutes, `/api/collection-stats?collection=…`:

| collection | result |
|---|---|
| **nba-top-shot** | **503 · `{"code":"timeout","retryable":true}` · `Retry-After: 30` · `Cache-Control: no-store`** |
| nfl-all-day | 200, full payload (`fmv_high_medium_count: 1351`) |
| disney-pinnacle | 200, full payload (1088) |
| laliga-golazos | 200, full payload |
| ufc | 200, full payload |

**R6's "4 of 5" does not reproduce at this sample.** ✅ And the 503 is the *honest* degraded shape — a typed,
retryable error with `no-store`, not a hang and not a fabricated zero. Combined with the already-refuted
render half (the KPI band renders 10 skeletons), the user impact is **"Top Shot's landing KPIs never fill"**,
not a lie.

## 3. The structural finding — no timing needed, so no confound

**The same per-edition lateral is computed TWICE for every request**, concurrently, in a `Promise.all`:

- inside `get_collection_stats` (for `fmv_pct`) — confirmed from a live error CONTEXT naming
  `PL/pgSQL function get_collection_stats(text) line 63`
- again in `app/api/collection-stats/route.ts::computeHighMediumPct` (for `fmv_high_medium_pct`)

Both are the identical shape over the identical rows, differing only in the FILTER
(`confidence <> 'NO_DATA'` vs `confidence IN ('HIGH','MEDIUM')`):

```sql
FROM editions e CROSS JOIN LATERAL (
  SELECT fs.confidence FROM fmv_snapshots fs
  WHERE fs.collection_id = … AND fs.edition_id = e.id
  ORDER BY fs.computed_at DESC LIMIT 1) latest
WHERE e.collection_id = …
```

Scale: **`fmv_snapshots` = 1,230,231 rows**; editions per collection **TS 19,838 · AD 6,190 · Golazos 575 ·
UFC 518**. The cost tracks edition count, which is exactly why Top Shot is the one that fails.

**Top Shot's leg exceeded 25 s as `postgres` on the quiet database above** — and the production caller's
ceiling is `authenticator`'s **8 s**, so it cannot complete there under any load.

### The cheap lever this exposes, NOT shipped

Both numbers come from the same scan, so **one pass could produce both** — halving the work per request
across all five collections. That is directly on R46's critical path (disk IO is the binding constraint).

⛔ **Not shipped, deliberately.** It would need a migration to `get_collection_stats` (≈10–20 s of
user-facing `PGRST002` 500s from schema-cache re-introspection), **and it would NOT fix Top Shot** — one pass
is already over the ceiling. R52 has a standing decision that the real fix (the precomputed
latest-FMV-per-edition object) is Trevor's call because the binding constraint is the disk. **This belongs
in that same decision, not ahead of it.**

## 4. ⚠ A number I am NOT reporting, and why

I timed the AllDay lateral directly and got **40,229 ms** — which would look like a headline. **It is
confounded and I am discarding it.** The AllDay HTTP call had returned **200 with real data two minutes
earlier**, so the two cannot both be the cost: my SQL ran cold while the request ran warm.
**A DB A/B must be WARM-vs-WARM**, and at ~74 ms per disk read a cold run measures the buffer cache, not the
query. The sound numbers here are the **HTTP outcomes** (production caller, same window) and the
**structural duplication** (code, no timing). Recorded so nobody re-derives the 40 s and believes it.
