# 2026-08-16T16:40Z — `fmv_sweep_wedge_hours` is diagnosed: the sweep FINISHED its catalogue pass, then died on the next pass's first page. Its dedicated stall arm reads **49.0 against breach 50.**

Cowork **cloud** session, 09:40 PT. Measured live. **Nothing shipped.** This supersedes my own 16:15Z filing, which called this arm "undiagnosed, trend observation only."

> ⚠ **Scope line.** NO-PUSH is specific to **this cloud Cowork session**. Trevor's machine and Claude Code push normally via the PAT in `remote.origin.pushurl`. **Commit these files as usual.**

## 1. ✅ First, the good news that nobody has recorded: the 08-03 page-zero fix went all the way through

`fmv-recalc` advanced cleanly overnight — cursor **9500 → 10000 → 10500 → 11000 → 11500**, every run `ok`, ~495 rows each. Then at **06:48:06Z** it returned a **99-row partial page with `cursor_after = NULL`** — the legitimate end-of-catalogue signal — and wrapped.

**That is a completed full catalogue pass.** The confirmation is `topshot_fmv_pct_stale_30d`, which memory records at **32.2** on 08-03 with a standing "re-baseline after the first full pass" action. It now reads **0.0**. ⚠ **That open recommendation can be closed as satisfied by measurement**, and its `breach_at` of 50 is now sitting 50 points above a floor of zero.

## 2. ⛔ The problem: since 09:20Z the sweep has written NOTHING, and it is not the old bug

**13 of 13 runs in the last 8 hours failed. `rows_written` over 8 hours: 0.** Every one starts at `cursor_before='0'` and ends at `cursor_after='0'`, so the new pass has never cleared its first page.

| | 08-03 regression (memory: `fmv-sweep-stuck-at-page-zero`) | **today** |
|---|---|---|
| `ok` | **true** — silent | **false** — loud |
| `cursor_after` | `NULL` | `'0'` |
| `rows_written` | pinned ~997 | **0** |
| error | none | explicit |

⛔ **Do not reach for the 08-03 fix.** Page size 500 and the `>=` comparison are in place and working — §1 proves it by completing a pass. The failures are downstream:

- **10 × `sales_refetch_failed: 1 chunk fetch errors (saturation-class)`**
- **3 × `edition_page_fetch: Timed out acquiring connection from connection pool.`**

Same disk-IO saturation wave as everything else today. The sweep is a **casualty**, not a defect.

## 3. ⛔⛔ THE HEADLINE — the arm built for exactly this reads GREEN by one point

`fmv_sweep_stall_pct_24h` = share of 24 h `fmv-recalc` runs starting at `cursor_before='0'`.

| | |
|---|---|
| value | **49.0** |
| `breach_at` | **50** |
| status | **ok** |

Measured directly: 51 runs in 24 h, **25 start at zero** = 49.0%. The arm is **1.0 point** from firing on an outage that has been total for **eight hours**, and it will cross 50 only as the *successful* pre-06:48Z runs age out of the trailing window — i.e. **it fires late by construction, and the lateness is proportional to how well the sweep was working before it broke.**

⚠ **Every other FMV arm is green, exactly as the memory predicted.** `topshot_fmv_stale_hours` **0.1** (reads only the freshest row) · `topshot_fmv_pct_stale_30d` **0.0** · `fmv_sweep_stall_pct_24h` **49.0**. **`fmv_sweep_wedge_hours` (9.82 vs 3) is the only instrument on the board that can see this**, and it has been correctly screaming since ~09:48Z while three passes — the overnight one, this morning's monitor, and my own 16:15Z filing — classified it as "known-class" or "trend observation only."

**The arm is not noise. It is the only witness.**

## 4. Severity, scoped honestly — this is a COVERAGE outage, not an FMV outage

FMV writing is **not** dead. Over the same 8 hours:

| pipeline | runs | ok | rows written |
|---|---:|---:|---:|
| `refresh_wmc_fmv_changed` | 85 | 68 | **14,789** |
| `wmc-fmv-populate` | 626 | 625 | 1,894 |
| `pinnacle-fmv-recalc` | 1 | 1 | 2,222 |
| **`fmv-recalc` (the sweep)** | **13** | **0** | **0** |

`fmv_snapshots` took **1,235 rows in 8 h, 902 in the last 2 h**, newest **16:31:55Z**. So the event-driven path is alive and anything that trades keeps getting repriced.

**What stops is the systematic pass over editions that DON'T trade — the cold tail.** That is precisely the selective-writer stall the freshness arms are structurally blind to, and it degrades quietly rather than breaking a page. **Real, not urgent. Do not page on it; do not dismiss it either.**

## 5. Two adjacent pipelines are failing hard and are not on the board

- **`refresh_wmc_fmv_drift_active` — 84 runs, 20 ok, `rows_written` 1 over 8 hours.** ~76% failure with essentially no output.
- **`populate-pinnacle-wmc-fmv` — 6 runs, 1 ok.**

Neither appears in `detect_stalled_pipelines()` (they are not silent — they run and fail, which is the documented blind spot of a cadence watchlist).

## 6. Recommended, in order — none of it shipped from here

1. **Nothing structural until the saturation wave passes.** Every failure this session is saturation-class; a fix judged in this window will be judged against noise.
2. ⚠ **Re-derive `fmv_sweep_stall_pct_24h`'s `breach_at` from first principles, not from an observed baseline** — the memory's own durable rule, and the reason the 08-03 bug survived so long. Documented floor is **~4%** (24 pages/day). A breach at 50 tolerates **half the daily sweep dying silently**. ~1.5× the floor would be **6–10**. ⛔ **Trevor's call and NOT shipped here** — it is a threshold change on a monitored arm during an active incident, which is the one condition under which such a change cannot be evaluated.
3. **Close the standing "re-baseline `topshot_fmv_pct_stale_30d`" item** — the first full pass completed, it reads 0.0, and its `breach_at` of 50 is now meaningless.
4. **Page size is not the lever here** and neither is the clock — the sweep is losing on connection-pool acquisition and chunk fetches, not on rows or start minutes.
