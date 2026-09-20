# The "22 MB/s floor" is not folklore — it is Supabase Small's PUBLISHED baseline, and we are sitting on it at 93%

**Filed:** 2026-09-20 ~10:30 AM PT (Cowork cloud, Trevor-directed). **READ-ONLY. Nothing shipped.**
**Why this matters to every other session:** several weeks of lane work has been buying back
milliseconds against a ceiling that is a line item on an invoice. This note names the ceiling, shows
we are on it, and gives the exit condition that would prove or refute the fix.

## 1. The measurement (60.7 s window, during a live spell)

Two `pg_stat_database` samples in SEPARATE transactions, 17:23:27Z → 17:24:28Z.
⚠ **Instrument trap first:** a single statement that reads `pg_stat_database` twice returns the SAME
row both times — stats snapshots are transaction-stable, so the delta reads 0. My first attempt
reported `0 blks_read` over 20 s during a spell with `io_wait 14`. **Sample across two calls.**

| quantity | measured | Supabase **Small** published baseline |
|---|---:|---:|
| disk read throughput | **20.4 MB/s** | **22 MB/s** |
| read IOPS | **2,607** | **1,000** |
| live cache hit | **83.3 %** | (lifetime: 96.1 %) |
| `io_wait` / `active` backends | **16 / 16** | healthy is ≤3 / ≤4 |

**Every active backend was waiting on disk.** Throughput is at **93 % of the documented sustained
ceiling**, and IOPS is **2.6× the sustained baseline** — i.e. continuously drawing down burst credit,
which is precisely why the instance collapses to the floor and stays there. The "22 MB/s" figure
carried in the memory notes is not an estimate: it is the vendor's published number for this tier,
matched to within 7 % by direct measurement.

Source: https://supabase.com/docs/guides/platform/compute-and-disk

| size | baseline MB/s | baseline IOPS | $/mo |
|---|---:|---:|---:|
| **Small (current)** | **22** | **1,000** | 15 |
| Medium | 39 | 2,000 | 60 |
| Large | 79 | 3,600 | 110 |
| XL | 149 | 6,000 | 210 |

⛔ **Medium is not a fix.** Today's *measured* read IOPS (2,607) already exceeds Medium's 2,000
baseline, so Medium would burst-exhaust too. Anyone proposing Medium as the cheap option should read
this line first.
⛔ **Provisioning extra disk IOPS/throughput without upgrading compute is NOT available to us** — the
doc states it "requires Large compute size or above." So the disk add-on is not a cheaper alternative
to the compute upgrade; it is unlocked *by* it.

## 2. Why no amount of query work closes this

`pg_statio_user_tables`, lifetime, top consumers by blocks read from disk:

| table | size | hit % | GB read from disk |
|---|---:|---:|---:|
| `wallet_moments_cache` | 2,663 MB | **78.2** | 13,445 |
| `fmv_snapshots_2026` | 1,018 MB | 99.3 | 5,649 |
| `sales_2026` | 1,479 MB | 84.7 | 5,264 |
| `topshot_atlas_market_events` | 1,232 MB | 86.6 | 2,803 |
| `net._http_response` | 701 MB | 64.7 | 1,680 |
| `pack_rips` | 2,051 MB | 64.6 | 922 |

`shared_buffers` is **512 MB**; `work_mem` **5 MB**; `effective_cache_size` **1.5 GB**;
`max_parallel_workers` **2**. The top four hot tables alone are **6.4 GB** — 12.5× `shared_buffers`.
`wallet_moments_cache` by itself is **5.2×** it. **A 2.66 GB table cannot be cached in 512 MB no
matter how the query is written**, which is why R117's "pass count is the lever" and the repeated
visibility-map work keep re-converging on the same wall.

📏 Also: **1,072 GB of temp files across 214,370 temp events** lifetime — `work_mem = 5 MB` spilling
sorts and hashes to the very disk that is saturated. That is a second, independent RAM→IO channel.

⚠ **Honest limits of this note.** The `pg_statio` figures are LIFETIME (stats were never reset), so
they pool several months of differing workloads and are not a statement about today's mix. The
60.7 s throughput sample is one window during one spell — it establishes that we *reach* the ceiling,
not the duty cycle at which we sit there. Anyone wanting the duty cycle should sample across a day.

## 3. What this does NOT claim

It does not claim the estate has no software problems, and it is not an argument against the lane
work — the R101/R108/R117/R118 fixes are all real and all reduce demand. It claims that **demand has
been pinned against a fixed supply for long enough that supply is now the cheaper variable**, and that
the two are separable by a dated test.

## 4. The falsifiable test, if the upgrade is taken

**Exit (one month on Large):** 6-hour `cron.job_run_details` failure rate **under 3 %** (it was
**393 / 2,446 = 16 %** at 09:14 AM PT today), and the 06Z/12Z/18Z band gone from `job startup timeout`.
**Falsifier:** the band survives 8 GB and 79 MB/s ⇒ the cause is not IO supply, this note is wrong,
and the finding is that the estate's demand is structurally larger than the tier — which points at XL
or at shedding lanes, not at more index work.

📌 **Re-measure §1 the same way after any resize** — two samples, separate transactions, during a
spell, against the published baseline for the new tier. That single number tells you whether the
ceiling moved.
