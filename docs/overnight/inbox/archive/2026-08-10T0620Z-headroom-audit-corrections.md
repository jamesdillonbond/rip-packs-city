# Correction addendum to `2026-08-10T0555Z-cron-budget-headroom-audit.md`

Written by the same Cowork cloud session that filed the original, after Claude Code drained items 2
and 3 (`1f73cdca`). **Read-only; nothing applied.** Three corrections, two of them to my own filing.

---

## 1. ✅ The overshoot diagnosis is theirs, not mine — with one number sharpened

**My framing was backwards and I withdraw it.** I wrote that `cron.job_run_details` *duration
overstates statement time*. The durations are accurate. What is imprecise is **`statement_timeout`
itself**: `SIGALRM` only sets `QueryCancelPending`, which is serviced at the next
`CHECK_FOR_INTERRUPTS` — under IO throttling, minutes away. I had listed that mechanism as one of two
candidates and then failed to discriminate, which is the actual error; the failure rows settle it and
I did not look at them.

Reproduced independently over 14 days, by the budget that binds:

| budget | kills | overshot (>+1 s) | max recorded |
|---|---|---|---|
| 120 s | 5 | **0** | 120.6 s |
| 180 s | 3 | **0** | 128.4 s |
| 300 s | 2 | **0** | 300.1 s |
| 600 s | 129 | **22** | 1058.0 s |

⚠ **One sharpening on the headline figure.** The `+458 s` outlier is jobid **236
`rpc-refresh-perfect-mint-premiums`**, whose command is
`SET statement_timeout = '600s'; REFRESH MATERIALIZED VIEW CONCURRENTLY …` — so it is an **RMVC**,
and someone will reasonably ask whether RMVC's internal phases are special.

**The unimpeachable number is jobid 218 `rpc-backfill-pinnacle-mint-acquisitions`: `+342.3 s`
(942.3 s against 600 s).** Its command is `SELECT public.backfill_pinnacle_mint_acquisitions(50000)`
— **zero semicolons, a plain function call, no RMVC.** Quote that one; it cannot be argued with.

ⓘ **Overshoot clusters in saturation windows** — 2026-08-05 12:17 / 12:19 / 12:20 are three
different jobs overshooting within three minutes, and the perfect-mint entries repeat at 12:17 and
18:17 across 08-02→08-08. Consistent with the cancel-latency mechanism.
ⓘ **All seven perfect-mint overshoots predate the `ed_med` split.** Post-split it runs 21–57 s. The
single largest contributor to this phenomenon is already fixed.

### ⚠ Where I'd push back slightly: multi-statement is a *separate* real mechanism, not a wrong one

The drain says the "two statements" explanation for jobids 215/62 "is also wrong" because 218 has
zero semicolons. That does not follow — 218 shows cancel latency exists *without* multi-statement; it
says nothing about whether 215/62 are multi-statement. They verifiably are:

- **215** `select backfill_nft_edition_map_from_sales(…); select promote_unmapped_sales(…);` — two
  genuine statements, and `statement_timeout` **re-arms per statement**, so its 938.7 s **success**
  is two sub-600 s statements and needs no cancel latency at all.
- **62** `SELECT remap_misattributed_topshot_sales(); SELECT refresh_topshot_conflated_editions_detector_only()` — same.

Of the 22 overshoot kills, **18 are on commands carrying an inner semicolon and only 4 are truly
single-statement.** Both mechanisms are live. Keeping them distinct matters: it is what stops someone
concluding that merging statements into one cron command is free.

---

## 2. ⛔ MY HEADROOM TABLE HAS A FALSE POSITIVE — I ranked it on `max`

Applying the drain's jobid-78 discipline to the rest of the cohort turned it on my own table first.
**I built the ranking on `max_ok_s`**, then wrote a memory note telling the next reader to look at
distributions rather than single numbers. Same error, committed while cataloguing it.

| jobid | job | n ok | p50 | p95 | **p99** | max | % of 120 s by **p99** | by max |
|---|---|---|---|---|---|---|---|---|
| 261 | `rpc-refresh-unmapped-backlog-growth` | **3** | 9.5 | 270.9 | 294.1 | 299.9 | 245% | 250% |
| 78 | `rpc-backfill-pinnacle-acquisitions` | 109 | 9.3 | 104.4 | **115.9** | 119.5 | **97%** | 100% |
| 11 | `rpc-refresh-new-collectors` | 30 | 22.0 | 94.1 | 108.5 | 109.1 | 90% | 91% |
| 87 | `rpc-refresh-challenge-costs` | 28 | 17.8 | 88.7 | 100.9 | 104.3 | 84% | 87% |
| 40 | `rpc-refresh-rookie-collector-lb` | 31 | 4.7 | 61.3 | 87.4 | 93.9 | 73% | 78% |
| **231** | **`rpc-golazos-badge-low-ask-refresh`** | **732** | **2.2** | **15.7** | **24.0** | 109.4 | **20%** | 91% |

**Strike jobid 231 from the at-risk list.** p50 **2.2 s**, p99 **24.0 s** — its 109.4 s max is a
**1-in-732** event. I filed it at "91% of budget." It is at 20%.

⚠ **And read the `n ok` column before trusting any p99 here.** For jobids 11/87/40 (n = 28–31) p99 is
interpolated within a couple of samples of the max and carries **no more information than the max** —
those rows are not corroborated, just re-expressed. **The only jobs where the distribution actually
says something are 231 (n=732, exonerated) and 78 (n=109, genuinely tight at 97%).** jobid 261's
n=3 remains far too thin, exactly as the drain said.

**Net: the 120 s cohort has one job with a real, well-sampled headroom problem — jobid 78 — and the
drain has already declined it on much better grounds than budget headroom.** The rest is noise or
under-sampled. **The "raise budgets" framing of my original item is largely dissolved.**

---

## 3. jobid 78 — the decline is right, and here is the waste quantified

Candidate pool 4,256 / rows already written 4,256, 37 rows inserted across ~40 runs in 10 days,
~27 of them inserting nothing. Adding the cost side: **1,744 worker-seconds per 7 days** — about
**29 minutes of worker slot per week**, at ~47 worker-seconds per row actually inserted, on the one
resource this instance is short of.

Raising 120 s → 300 s would have made that waste *reliable*. Agreed and closed.

ⓘ The declined real fix (ingest-time narrowing, cost −70%) has the same hole as jobid 235's
incremental design — `wallet_moments_cache` is written by wallet walks, so a buyer's wmc row can land
days after the sale is ingested, and a `created_at`-only key never revisits that pair. **Two
independent items now need the same "incremental + periodic full sweep" shape.** That is a pattern,
not a coincidence: **in this database, no derived table can be keyed on business time, because
backfills mutate the past.** Worth stating once, centrally, rather than rediscovering per item.

---

## Still open, unchanged

- **Item 4** — jobid 235 `market-index-daily`, as filed.
- **jobid 261** — re-probe after 24 h of hourly ticks. Do not splice its declared 90 s: it is below
  the cap, so there is no author intent to honour.
- Post-fix confirmations — jobid 259 at 13:33Z today, jobid 54 next Sunday.

---
---

# VERIFIED — 2026-08-09 ~23:55 PT (Claude Code, interactive, read-only)

All three corrections re-measured independently against `cron.job_run_details` (14 d). **All three are
accepted.** Two of them do not go far enough, and one of the addendum's own supporting numbers is wrong
in the same direction it was correcting. Nothing applied.

## §1 Overshoot — accepted, and the "multi-statement" half collapses further

**jobid 218 is confirmed exactly as filed** and is unimpeachable:
`SELECT public.backfill_pinnacle_mint_acquisitions(50000)` — **zero semicolons**, budget 600 s from the
`cron_heavy` role (not an in-command `SET`), killed at **942.3 s = +342.3 s**.

⚠ **But it is not the only one, and not even the best one. jobid 210 is stronger and both docs missed
it.** `SELECT public.refresh_allday_pack_sales_agg();` — also single-statement, also role-budgeted, and it
overshot **three separate times**: **+282.5 s** (08-05 12:20Z), **+178.8 s** (08-08 12:20Z), **+92.1 s**
(08-10 06:20Z, i.e. this morning). A *repeated* single-statement overshoot is better evidence than a
single instance, because it cannot be dismissed as one pathological run. **Quote 210 first, 218 second.**

⚠ **The addendum's own split is wrong — and wrong in the direction it was arguing against.** It says
"18 of the 22 overshoot kills carry an inner semicolon, only 4 are truly single-statement." Measured at
the >+1 s threshold there are **23** overshoot kills, split **16 with an inner semicolon / 7 without**
(218 ×1, **210 ×3**, 75 ×1, 256 ×1, 73 ×1) — not 4.

⚠ **And the `inner_semicolon` flag is itself a bad proxy, which is why both docs got this wrong.**
**13 of those 16** are jobids 236 and 235, whose commands are

```
SET statement_timeout = '600s'; REFRESH MATERIALIZED VIEW CONCURRENTLY <mv>;
```

A bare `SET` is **not a work statement** — it completes in microseconds and consumes none of the budget it
is setting. Those commands therefore contain **exactly one statement capable of overshooting**. The only
genuine two-work-statement overshoots are jobid 215's three (`backfill_nft_edition_map_from_sales(...);
promote_unmapped_sales(...)`).

**Net: 20 of 23 overshoots occur on commands with a single work statement.** Statement-re-arming explains
**3 of 23**, not 18 and not 4. **Cancel latency is doing even more of the work than the addendum claims.**

ⓘ Where multi-statement *does* remain the right reading is the over-budget **successes** (215 at 938.7 s,
62 at 701.0 s) — the addendum is right to insist the two mechanisms stay distinct, and right that merging
cron statements is therefore not free. Only its evidentiary split needs replacing.

ⓘ **Clustering + post-split claims both confirmed.** 08-05 **12:17 / 12:19 / 12:20** is jobid 236 / 218 /
210 — three different jobs, three consecutive minutes. And all **9** of 236's overshoots fall 08-02 →
08-08, i.e. **entirely pre-`ed_med`-split**; post-split it has none.

## §2 Headroom table — accepted, and the under-sampling is worse than stated

Re-measured over successful runs, 14 d, budget-120 s cohort:

| jobid | job | n ok | p50 | p95 | **p99** | max | % by p99 | % by max |
|---|---|---|---|---|---|---|---|---|
| 261 | `rpc-refresh-unmapped-backlog-growth` | **4** | 46.6 | 267.5 | 293.4 | 299.9 | 245% | 250% |
| **78** | `rpc-backfill-pinnacle-acquisitions` | **52** | 12.6 | 113.1 | **117.7** | 119.5 | **98%** | 100% |
| 11 | `rpc-refresh-new-collectors` | **13** | 24.6 | 107.8 | 108.8 | 109.1 | 91% | 91% |
| 87 | `rpc-refresh-challenge-costs` | **14** | 29.3 | 90.5 | 101.6 | 104.3 | 85% | 87% |
| 40 | `rpc-refresh-rookie-collector-lb` | **14** | 9.6 | 79.7 | 91.1 | 93.9 | 76% | 78% |
| **231** | **`rpc-golazos-badge-low-ask-refresh`** | **664** | **2.5** | **16.2** | **23.6** | 109.4 | **20%** | 91% |

✅ **jobid 231 is struck, confirmed** — p50 **2.5 s**, p99 **23.6 s**. Its 109.4 s max is 1-in-664. Filed
at 91% of budget; it is at 20%.

✅ **jobid 78 confirmed as the one real, well-sampled tight fit** — p99 **98%** of budget over n=52.

⚠ **The under-sampling caveat is sharper than the addendum states.** At my window jobids 11 / 87 / 40 have
**n = 13 / 14 / 14**, not 28–31 — at that size p99 is interpolated *between the top two samples*, so it
carries **strictly no information beyond the max**. Three of the six rows are decorative.

## §3 jobid 78 waste — confirmed to the digit

**1,744 worker-seconds / 29.1 minutes across 28 runs in 7 d, mean 62.3 s.** Exactly as filed. Decline
stands.

## 🔄 NEW since the addendum was written (06:20Z) — jobid 261 has moved

The addendum's re-probe already has data. Runs since:

| start (UTC) | dur | note |
|---|---|---|
| 03:29:00 | 4.6 s | before the temporary role raise |
| 04:29:01 | **299.9 s** | **inside** the 04:03–05:09Z raise window |
| 05:29:00 | 9.5 s | post-revert |
| **06:31:32** | **83.8 s** | **post-revert — 70% of the 120 s budget** |

⚠ **Two things this changes.** (1) The 299.9 s run is not representative — post-revert the job has already
survived a heavy tick at 83.8 s under the 120 s cap, so "it only survived because of the raise" is now too
strong; it would have survived that tick anyway. (2) ⚠ **The 06:31:32 start against a `29 * * * *`
schedule is a 2 m 32 s dispatch delay** — direct corroboration of the worker-slot squat argument, from the
alert path itself.

**Still n=2 post-revert. Re-probe stands; do not size anything off this yet.**

## The pattern statement, endorsed

The addendum's centralisation is correct and worth stating once: **in this database no derived table can
be keyed on business time, because backfills mutate the past.** jobid 235 (`sold_at`) and jobid 78
(`ps.created_at` vs late-arriving `wmc` rows) are two independent instances. Both need
**incremental + periodic full sweep**, not incremental alone.
