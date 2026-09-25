# Focus — 2026-08-17, steers appended through 2026-09-05 (accuracy-gate phase; the June studio-platform program is HISTORY)

⚠ **This file was 54 days stale until 2026-08-17** (it was still the 2026-06-24 studio-platform post-ship watch). That is not merely untidy: three of its steers had gone **actively wrong**, and a night pass following them would have been misdirected. The obsolete steers are listed at the bottom under "RETIRED STEERS" with the reason each died, so nobody re-adds them from an old copy. The June program's detail is **not lost** — it lives in `docs/overnight/ledger.md` and `docs/handoff-2026-06-24-studio-platform-gql-deep-history.md`.

**Rewrite rule for whoever edits this next: a focus file STEERS the next night, it is not an archive.** If a section is describing something that shipped more than ~a week ago and is not still a live trap, move it to the ledger and delete it here. A stale steer is worse than no steer.

## STEER — added 2026-09-20 ~2:3x PM PT, refreshed ~4:3x PM PT, closed ~5:5x PM PT (Claude Code cloud; the pack-rip zero drain is CONFIRMED running in production — the clock-gated verification is DONE and green, nothing owed)

⭐ **`pack_rips.pull_value_usd` no longer fabricates zero (register #128), and the drain is CONFIRMED RUNNING IN PRODUCTION at the raised `p_limit`: the 22:53Z tick handled 300 zeros (205 repriced + 95 cleared) in 9,782 ms of a 50 s budget.** 79,234 left at ~7,200/day (**78,934** re-read 5:0x PM PT) → **~11 days** (re-derive; this is a dated sample). ✅ **The nine dists that read exactly USD 0.00 are ALREADY CLEARED** (365 rips; backdated stamps put them at the front of the shipped `zero_repair` leg rather than duplicating its logic — `8753` went from USD 0.00 to a **USD 80.19** mean). ⚠ **The DILUTION is what remains:** `mv_topshot_pack_realized_ev.realized_mean` stays understated on **162 of 295** Top Shot dists until the drain finishes, and **no surface says so**. Watch `pipeline_runs.extra.zero_repriced + zero_cleared` on `backfill-pack-rip-metadata` — those keys were shipped in the same pass and are the ONLY external view of the drain.

✅ **THAT VERIFICATION IS DONE AND GREEN — 2026-09-20 5:46 PM PT, nothing owed here.** pg_cron **208** ran 5:05:00 PM PT (succeeded) and **245** at 5:42:00 PM PT (`REFRESH MATERIALIZED VIEW`); all nine dists now carry a non-zero `realized_mean` in `mv_topshot_pack_realized_ev` — `1765` 0.24 · `7738` 0.74 · `8431` 1.27 · `7185` 1.85 · `6150` 2.87 · `7730` 3.02 · `5270` 5.47 · `8612` 16.26 · **`8753` 80.19** (median 51.00, calibrated EV 58.80), each equal to the live value computed off `pack_rips`. Confirmed on the **rendered public page**, not a 200: `/nba-top-shot/pack/dist/8753` prints *"Realized **$80.19** avg · 64 attributed opens"*. Neither refresh was forced.

🚨 **AND A POPULATION TRAP, for whoever re-checks this: `still_zero = 0 on all nine` is TRUE of the MV's population and FALSE of the dists.** Counting every `pack_rips` row per `dist_id` shows 31–1,313 still at zero and reads like the record is wrong. It is not — `mv_topshot_pack_rip_values` is `topshot_pack_rip_attribution ⋈ pack_rips WHERE pull_value_usd IS NOT NULL`, so the attributed set is the population, and over it the count is 0 with means 0.24–80.19. ⚠ **`7730` sits at exactly `n_opens = 10`, the MV's own floor** — one more row going NULL drops that dist off the board entirely. This is the *"a control's POPULATION must be the set the property is TRUE of"* rule with a live instance attached.

✅ **#128 residual (b) is CLOSED (2026-09-20, `20260920230950`)** — both All Day `pull_value_usd` writers gained the whole-pack check in ONE migration, measured free over the population (419,233/419,233). ⚠ **Residual (a) stays open and is small:** ~3.6 % of positive Top Shot rows keep a LEGACY PARTIAL SUM, preserved on purpose (a stored positive is never overwritten with NULL, because `fmv_snapshots` is delete-then-insert). It self-heals as FMV coverage completes; do not "fix" it with an unconditional overwrite.

⚠ **`zero_repriced + zero_cleared` reading 0 while `pack_rips.pull_value_usd = 0` still has rows means the leg STOPPED REACHING them** — a different failure from the drain finishing, and indistinguishable in `value_resolved`, which the stale leg also moves.

## ✅ THAT DECISION IS CLOSED — SHIPPED 2026-09-20 ~3:1x PM PT. `p_limit` is **2000**. Do not re-open it without a new measurement.

⛔ **The measurement this section said was "already done" was NOT done, and the number it led with points the WRONG WAY.** The wall-clock pair (**5.8 s vs 7.4 s**) reads as *"4× the rows for 1.28× the time, rows are nearly free"*. **They are not.** Wall time is not work, and the pgss figure beside it (**449,416 blocks / 9.1 MB WAL per call**) was pooled over 657 calls **across both compute tiers and four same-day body changes** — the live per-call cost is ~**49k**, an order of magnitude below the pooled number.

📏 **THE CLEAN PAIR, taken warm on LARGE 15:05–15:08 PT.** ⚠ `pg_stat_statements.track='top'` and **500/2000 jumble to the SAME queryid (`$1`)** — so it is not "the two normalized rows" this section asked for, it is **sequential before/after deltas on one row**. Run **500 → 2000 → 500** so the 500 arms straddle the comparison:

| p_limit | blks/call | disk reads/call | cache hit | zeros/tick | **blks per zero** |
|---|---|---|---|---|---|
| 500 (arm A) | 49,246 | — | — | 75 | 657 |
| 500 (arm C) | 49,211 | 1,780 | 96.4 % | 75 | 656 |
| **2000** | **~161,389** | **5,686** | **96.5 %** | **300** | **534** |

⭐ The two 500 arms agree to **0.07 %** (no order effect) and straddle an unrelated migration. **4× the rows for 3.26× the blocks — 19 % cheaper per zero, 20 % cheaper in real disk. Cache hit 96.5 % at BOTH limits ⇒ this lane is CACHE-bound, not IO-bound.** 👉 **The deciding frame is TOTAL, not per-day:** per day 2000 costs **3.3×**, but finishing costs **less** — ~42 M blocks over **~11 days** vs ~53 M over **~45**. Extra disk ≈ **750 MB/day**, ~0.01 % of the tier.

⚠ **This spends headroom that is currently MASKING #126 — see the correction below — and that was accepted deliberately** because the lane is cache-bound and the dilution window is itself the harm (`realized_mean` understated on **162 of 295** TS dists with no surface saying so). ⛔ **If #126 resurfaces, this is the first thing to back out:** one constant in `app/api/cron/backfill-pack-rip-metadata/route.ts`.

✅ **ON #126, DEFER TO ITS OWN ENTRY — I briefly recorded the opposite here and was wrong.** The escalation the 18:12Z filing saw ended at the **10:39:57 AM PT Small→LARGE resize**, not on its own — but that does NOT make #126 "merely outrun". [known-issues #126](../reference/known-issues.md) closes it as **RESOLVED — instance capacity** on a cleaner natural experiment than I ran: **ten clean hours AFTER the pg_net reclaim show no improvement (~34.5 s/job, no better than 09-19), while the single hour after the resize steps ~25× to 1.39 s/job** at flat run counts, with wall-kills 61→0. ⭐ It had already flagged the resize as the confound and independently promoted the same lesson (*check `pg_postmaster_start_time()` before attributing a fleet-wide change*). ⚠ **So the line above — "#126 was resolved hours before this was written" — is CORRECT** (closed ~11:5x AM PT, that steer written ~2:3x PM PT). 👉 **The live residual is not "is it fixed" but "does load grow back into the new tier"** — and ⛔ **every figure in #126's original filing was taken on Small; re-derive before reusing any of them.**

## STEER — added 2026-09-19 ~10:1x PM PT (Claude Code, Windows box; session close — THREE falsifiers owed on the clock, and the steer below this one is SPENT)

⛔ **THE 2026-09-18 STEER DIRECTLY BELOW IS SPENT — DO NOT ACT ON IT.** Its subject is the platform outage, and **#122 was RESOLVED 2026-09-18 12:0x PM PT**. Everything it says about probing `/auth/v1/health`, the 522s and the owed `pg_stat_activity` read is history. ⚠ Its one durable line is worth keeping in mind and nothing else: **ISR masks a dead database from a browser — probe the API routes, never a page.**

👉 **THE LIVE ITEM IS #126** — *the whole cron fleet is ~10× slower at constant work since 09-15*. Total busy-seconds per day at **flat ~9,300 runs**: 09-15 **34,236** → 09-19 **233,894**. ⛔ **Cause NOT established.** Ruled out by reading: bloat, schema change, and #73's worker-starvation mechanism. **R117 (wmc autovacuum, ~3.4 h/day of index-pass IO) is the leading candidate and is not proven.**

## ⏳ THREE FALSIFIERS OWED, each gated on a clock — do these FIRST, they are cheap and dated

1. **R115 is UNMEASURED and looks measured.** jobid **506** last ran 01:35Z and **succeeded in 12.3 s** (vs 124.1 s / 120.4 s failures before it) — but that tick **PREDATES R115 by 69 minutes** (applied 02:44Z). ⛔ **Do not credit R115 with the 12.3 s.** First genuine post-R115 run: **05:35Z** (`35 1,5,9,13`).
2. **The `candy_special_serials_board` −92 % prune is unverified.** `public_board_liveness_state` still holds the **pre-prune 00:28Z** sweep (**5,193 ms** vs a 4,100 ms budget). **Next sweep 06:28Z** (jobid 288). **Holds ⇒ that board leaves the over-budget set on its own; does not ⇒ the prune missed the path the probe exercises.**
3. **The vacuum-saturation falsifier wants its post-06:00Z series.** So far: **3** (04:18Z) · **2** (04:21Z) · **0** (04:37Z) · **0** (05:03Z). ⚠ **Only the last two are after the 04:25:28Z churn-table back-off.** **Persistently 3 ⇒ the 0.02 thresholds on 41 tables need sizing against a 22 MB/s budget; 0–1 ⇒ catch-up and that paragraph is spent.** ⚠ `pack_rips` is excluded until **08:12Z**, so an earlier sample is not the full set.

## ⛔ MEASUREMENT PRECONDITION THAT NOW BINDS EVERY READING HERE

🚨 **THE TREE CANNOT BE FROZEN — two to three sessions ship this estate unannounced.** Three separate readings on 2026-09-19 spanned an intervention the measurer did not know had landed. 👉 **Before interpreting ANY before/after, run `SELECT version, name FROM supabase_migrations.schema_migrations WHERE version >= '<your window start>'` and read what landed inside your own window.** One query, decisive, and it would have caught all three. **Windows are MINUTES, not hours.**

## 🟡 NEEDS TREVOR — two, and neither is code

- **`fast_break_runs.is_active` sits on the OLDER of two long-finished runs** (`Playoffs Run 1`, ended 2026-05-19) while the newer reads `false`. The surface is now honest either way (the badge compares the end date), so this is **not urgent** — but in the offseason arguably neither run should be active. **Product call.**
- **`CLAUDE.md` headroom.** ⚠ **Measure with Node `.length` and nothing else**: on the 09-19 file `wc -c` read **40,641** (would declare it 641 OVER) and Python `len()` **39,987** (5 more than exists — exactly 5 non-BMP 🚨 characters). **The two wrong tools fail in opposite directions on the real file.**

## STEER — added 2026-09-18 ~09:3x AM PT (Claude Code desktop; the DB event is PLATFORM-SIDE — do not chase our own load)

🚨 **IF THE DB IS STILL UNREACHABLE WHEN YOU RUN, THE CAUSE IS ALREADY SETTLED AND IT IS NOT OURS. Do not re-derive it, and do not act on the nightly pass's "first suspect".** That handoff names *"connection-pool/IO saturation from concurrent pipeline load on the SMALL tier (wallet-backfill fan-out back-pressure, inbox 09-13)"* as the leading candidate. **It is NOT SUPPORTED for this event.** ⛔ **Do NOT throttle a pipeline, pause an ingest lane, or re-tune `fmv-recalc` on account of it** — that is a fix aimed at a fault we do not own, and pausing an ingest lane creates real data gaps.

⭐ **THE CONTROL THAT SETTLED IT NEEDS NO DB CONNECTION, so you can re-take it in one minute:** `/auth/v1/health` and `/auth/v1/settings` on `bxcqstmqfzmuolpuynti.supabase.co` return **Cloudflare 522 after ~19.6 s**. GoTrue does not read our tables and holds its own pool, so **it cannot be starved by our query load**. Controls both directions: the edge answers `/rest/v1/` **401 in ~200 ms**, and `api.github.com` → **200** rules out your own network. ⛔ **A CF 522 means Cloudflare could not OPEN a connection to the origin; query-load exhaustion returns a JSON error from a REACHABLE PostgREST, never a 522.** The `<!DOCTYPE html>` bodies in the runtime errors are Cloudflare's page — `<title>supabase.co | 522: Connection timed out</title>`.

⚠ **What that does NOT establish:** Supabase's internal root cause (**not asserted**), and nothing about whether our load is healthy in general — the #42/#73/#84/M11 saturation class stands on its own evidence. Instance-wide starvation is not excluded by the probe alone; what argues against it is the nightly pass's postgres logs (pg_cron lanes completing normally through 14:30Z, only 2 statement cancels). **Two instruments, neither sufficient alone.**

👉 **STILL OWED, and it is the FIRST thing to do the moment a connection succeeds** — I re-attempted it at 09:2x PT and was still refused:
```sql
SELECT count(*) FILTER (WHERE wait_event_type='IO') AS io_wait,
       count(*) FILTER (WHERE state='active')       AS active,
       count(*)                                     AS total
FROM pg_stat_activity WHERE pid <> pg_backend_pid();
```
Then **record the true end of the window** (it ran at least **12:48Z → 16:2xZ**, ~3.5 h) and only then look for a pinning reader. ⚠ 🕐 **DURATION UPDATE 09:55 AM PT: STILL DOWN, ~4 h 07 m and counting** (12:48Z → 16:55Z+). 🕐 **11:4x AM PT (Claude Code cloud): STILL DOWN, ~5 h 55 m** — the MCP `pg_stat_activity` control refused again with the same `connection timeout` string; ⚠ this sandbox's egress proxy blocks BOTH Supabase hosts, production AND status.supabase.com, so the production side is **UNMEASURED from here, not recovered** — the last user-facing reading is #122's 10:19 AM PT one. MCP `select 1` and the `pg_stat_activity` control refused again at 09:2x and 09:5x PT. 🚨 **AND SUPABASE HAS POSTED NO INCIDENT FOR THIS SYMPTOM** — `status.supabase.com/history.atom` read live at 09:5x PT lists nothing for it; the only open item is the 09-17 *"401 errors due to JWT rejections"*. ⛔ **So the platform may not know, which makes reporting it the action rather than waiting.** ⚠ **ONE CORRELATION, RECORDED AS A LEAD AND EXPLICITLY NOT A CAUSE:** that same status entry says *"Fleet deployment process changes are being implemented this weekend **starting Friday, September 18**"* — and today **is** Friday 2026-09-18 (verified, not assumed). **A platform-wide deployment activity beginning the same day our origin became unreachable is worth putting in the support report; it is not evidence, and nothing here should be written up as though it were.** 📏 **BASELINE TAKEN 2026-09-18 ~10:0x AM PT — it needed no DB, and it SPLITS this item's question in two.** `get_runtime_errors`, both windows relative: **7d = 21,485 events / 50 groups; 24h = 13,038 / 50 groups** ⇒ prior six days ≈ **1,407/day** against **13,038 today**, so today is **~9×** and holds **61 % of the whole 7-day volume**. ✅ **The SHAPES are chronic exactly as this item says** — only **153** of the 7-day events sit in groups first seen today; **21,332** sit in groups first seen weeks ago (8,970 from 08-23, 3,503 from 06-16, 3,355 from 08-15). **Nothing new broke.** 🚨 **But the VOLUME is elevated by roughly an order of magnitude**, which this item could not yet claim — the same long-standing read-failure paths firing ~9× harder, which is what a gateway outage does: it amplifies existing failure paths rather than inventing new ones. ⚠ **INSTRUMENT LIMIT: both windows returned EXACTLY 50 groups, which is the CAP, not a count** — these are top-50 totals, the two top-50 sets need not be the same, and the subtraction assumes containment, so **do not quote 9.3× as a precise multiple**; the direction is safe because the 7-day window contains the 24-hour one. ⛔ **And this says nothing new about CAUSE** — elevated volume is a consequence of the outage, not evidence about its origin, and *9× errors* does **not** mean our load is 9× worse: the reads are failing, not multiplying. ⭐ **REFINEMENT, 20 min later, and it moves the number the RIGHT way — I checked my own denominator.** The top-50 includes **`DEP0169 DeprecationWarning: url.parse()`**, which is a WARNING, not an error (transitive `node-fetch@2` via `@onflow/fcl` → `cross-fetch`; not ours to remove, and memory records it fires on USE, not import). Exact counts: **7d 1,781 · 24h 92**. Strip it and the comparison becomes **7d 19,704 · 24h 12,946 ⇒ prior six days ≈ 1,126/day ⇒ ~11.5×**, not 9.3×. ⭐ **So the noise was DAMPENING the signal, not creating it** — it is 8.3 % of the 7-day volume but only 0.7 % of today's, exactly as a once-per-process warning should behave when the spike is failing REQUESTS rather than new processes. **Every duration read taken during the window is uninterpretable** — do not file a slow-query finding from it.

✅ **ALREADY DONE, do not redo:** #122 carries the addendum · the ledger has the measurement · `lib/api-error.ts` now classifies a 522 as **`upstream_unavailable` → 503 + `Retry-After`** instead of a permanent 500 (deployed and **verified live**, `dpl_24f5VuHkxCWjKtrqDL8SZKD9aTcD`) · the tree is caught up and the inbox INDEX is reconciled to 510.

⭐ **TWO THINGS THAT BEHAVED CORRECTLY UNDER A REAL OUTAGE, worth knowing before you "fix" them:** the honesty layer published *"PARTIAL DATA … not an empty result"* with **no fabricated zeros** anywhere, and the production build **succeeded while the DB was unreachable** (the `insights-server-pages-bound-their-reads` ban-at-zero doing its job). ⚠ **And ISR MASKS THIS FROM A BROWSER** — `/`, `/insights` and the overview pages serve 200 with real content off `x-vercel-cache: HIT` while every board API is 5xx underneath. **Probe the API routes; a 200 from a page is never evidence the DB is reachable.** 👉 **WHAT TO EXPECT ON RECOVERY, so nobody reads a lagging page as a still-broken one.** The `/insights` boards are ISR and will self-heal on their own revalidate, without a deploy: measured across all 30 pages — **10 at 300 s (5 min) · 3 at 600 s · 9 at 900 s · 3 at 1800 s · 2 at 3600 s (1 h)**, and **3 export no `revalidate` at all**. ⭐ **So the tail is an HOUR, not five minutes**, and a board still showing the degraded banner 20 minutes after the database returns is **expected**, not a second fault. ⚠ **The API routes are the live signal — they carry `Cache-Control: no-store` on failure, so they flip the instant the reads succeed.** Verify recovery against `/api/public/insights/*` and read the pages only afterwards; the reverse order will read as a partial recovery that is really just a warm cache. ⚠ **And the deploy that shipped mid-outage (`dpl_24f5VuHkxCWjKtrqDL8SZKD9aTcD`) PRERENDERED the degraded state into those pages** — honest, but it means the first post-recovery revalidate is what clears them, on the schedule above.

## ⏬ Older steers (dated 2026-09-14 and earlier) rolled to [focus-archive-2026-H2.md](focus-archive-2026-H2.md) on 2026-09-24. The persistent sections below (do-not-re-flag, inbox append-only, STANDING, sentinel queue, DECIDED, RETIRED STEERS) were kept.

## STEER — do NOT re-flag these (current)

- **The three standing trust breaches are all known-class.** `panini_sale_price_capture_dry_days` (an arm that is **crying wolf** — it counts dry days on a field deliberately abandoned and replaced on 08-08, while the replacement works at ~22%; the fix is to RE-POINT the arm, not to chase the capture), `unmapped_resolution_backlog_max` (AllDay permanent floor — its own text says do NOT raise `breach_at`), `public_board_slow_count` (saturation collateral; **do not characterize its direction from fewer than several days** — it has been called both "climbing" and "oscillating down" on ~1-day windows and both were fair).
- **Sentry issues titled `smoke check could not run: …` are the honest-degradation path WORKING**, not security failures. Verify against the live invariant (`check_public_security_invariants()`, `check_anon_write_surface()`) before treating one as a breach.
- **`rpc-topshot-pack-opens-history` returning `done: true` ~96×/day is a DELIBERATE STANDBY.** It looks like a dead cron on every instrument. Do not unschedule it.
- **SERIAL-FMV-MULT-CRON — BY DESIGN.** `serial_fmv_multipliers` and `serial_fmv_power_model` refresh **weekly** via pg_cron. Staleness ≤7d is expected; do not re-queue as an escalating cron-silent item.

## ⚠ DO NOT ARCHIVE `docs/overnight/inbox/` FILES (measured 2026-08-17 — a queued action that would have broken things)

The `inbox/` convention says files are "archived to `inbox/archive/` after draining", and the 08-17 handoff had ~40 Aug 9–14 files queued to archive "once push is restored". **Do not run that.** Those files have become **permanent citation targets**: they are referenced by exact path from `CLAUDE.md` (4), `docs/overnight/ledger.md` (many), a dozen handoffs, the roadmap, `docs/sessions/2026-08.md`, **four committed `supabase/migrations/*.sql` files**, and **`lib/analytics/rpc-with-retry.ts:268`** (live product source). Moving them breaks every one of those, and migrations are immutable history that must not be edited to chase a path.

Evidence this has already bitten: `inbox/archive/2026-08-10T0515Z-…md` cites `inbox/2026-08-09T1941Z.md` — an already-archived file pointing at a still-live inbox path.

**The convention and the citation practice are in conflict, and the citations win.** Treat `inbox/` as append-only. If the directory's size becomes a real problem, the fix is a redirect/stub or an index — not a `git mv`. ⚠ **THIS IS ENFORCED: `__tests__/inbox-is-append-only-since-the-rule.test.ts` bans any filing dated on or after the rule from sitting in `archive/`.** ⛔ **And the 2026-08-24 night-pass handoff queued the OPPOSITE** — *"a push-capable pass should archive resolved items"*, calling ~200 live filings *"the accrued cost of the long NO-PUSH streak"*. **They are not debt; they are the intended steady state.** A push-capable pass tried it on 2026-08-24 and the guard stopped it. **Retire a filing by annotating it in place with a ✅ RESOLVED section — never by moving it.**

## STANDING (added 2026-06-22 — do NOT drop on the next focus rewrite) — pg_cron failure check

Every monitor + night-pass health sweep, also run `SELECT * FROM check_pgcron_recent_failures();` — this surfaces the pg_cron-internal failure class that `detect_stalled_pipelines()` CANNOT see (it watches `pipeline_runs`, not `cron.job_run_details`). Empty array = all pg_cron healthy. A listed job is a real finding **only if its `last_run` is AFTER the relevant same-day fix landed**; a failure timestamp that predates a fix is a STALE pre-fix run that clears on the job's next tick — do NOT alarm on it. A genuinely-recent pg_cron failure = HIGH-PRIORITY inbox candidate. (Also permanent in both task SKILL.md health-sweep sections; this note is belt-and-suspenders.)

## SENTINEL DECISION-QUEUE (2026-08-17 PT) — dispositions, so nobody re-derives these

The queue's own warning was that **re-derivation is this project's recurring cost**, and three of its five
items had already been measured elsewhere. Current state:

- ✅ **Item 5 (`pinnacle-nft-resolver`, ~900 null-edition rows) is CLOSED — it is the 08-15 catalog gap.**
  `pinnacle_sales.edition_id` FKs to `pinnacle_editions` (551 rows); the editions live only in
  `pinnacle_catalog` (2,561). Re-measured 08-18T0112Z: `distinct_editions=161 · in_editions=0 ·
  in_catalog=161`, up from 114 on 08-15 (**+41 % in three days**). Filed:
  `inbox/2026-08-18T0112Z-pinnacle-null-edition-pool-is-the-catalog-gap-…md`.
  ⛔ **Do NOT "park the unresolvable rows"** — they are not permanently unresolvable, and parking them
  hides a widening gap. ⚠ The resolver's `failed: 0` means it **never reaches** these rows (946 of 954
  have `resolution_attempts = 0`), not that it declines them gracefully.
- ⏸ **Item 1 (pack-EV `fmv_current` JOIN) — mechanism CONFIRMED, still correctly unshipped.** Fully
  measured already in `inbox/2026-08-16T1829Z-fmv-current-does-not-push-down-through-distinct-on.md`
  (~3,100× — 335 buffers vs 1,046,192). ⚠ **The queue framed this as one coordinated migration because
  "the function is pinned AND two of three are unmeasured". Those two facts are DECOUPLED — verified
  08-18 — and splitting them makes the expensive half shippable on its own:**

  | function | pinned? | measured? |
  |---|---|---|
  | `compute_pack_ev_per_edition_weighted` | **YES** — `supabase/tests/compute_pack_ev_per_edition_weighted.sql`, PINS entry at `__tests__/db-invariants-drift-guard.test.ts:170` | **YES** — jobid 71's callee, confirmed by the timeout CONTEXT; ~100 min/week of `cron_heavy` for zero rows |
  | `compute_pack_ev_from_pool` | no pin file | no |
  | `compute_pack_ev_from_pool_tier_weighted` | no pin file | no |

  So the **pinned one is the measured one**, and it is the one actually burning the budget. It can ship
  alone (migration + pin `.sql` + repoint the PINS migration name); the two unpinned ones need
  measurement but **no pin work**, and must not gate it. ⛔ Never `CREATE OR REPLACE VIEW fmv_current`
  (resets `security_invoker`); fix the CALLERS via a lateral accessor. Measure in a quiet window —
  during a saturation spell no timing is interpretable.
- 🔑 **Item 2 (`wallet-username-resolver`) is OPERATOR-ONLY — it is not pg_cron.** Caller enumerated
  08-18: absent from `vercel.json` (36 crons), pg_cron (94 jobs), GHA and in-repo fetches. It is
  **cron-job.org**, firing `POST /api/cron/resolve-wallet-usernames` 2×/hour. Trevor chose lever (a),
  cut the cadence → **every 3 h**. Sizing: 72.3 % of runs fail, and the failures still pay the full
  21-day `sales` scan before `wallet_usernames_unresolved`'s `statement_timeout=60s` kills them, for
  ~31 usernames/day. ⚠ Cadence only — **do not narrow the 21-day window** (breaks the 14-day retry).
- 🔍 **Item 3's lever is NOT the index alone.** The cost is in `aggregate_saved_wallet_stats`, whose
  `top_tier` **correlated subquery re-scans `wallet_moments_cache` once per `collection_id`**, and no
  index carries `tier` (confirmed: 14 indexes, none include it; `idx_wmc_cohort_cover` is now **464 MB**,
  not 458). Fold the subquery into the existing `GROUP BY` before considering a wider index — a fold
  costs no write amplification on a 98 %-non-HOT table.

⚠ **Measurement hygiene, learned the hard way 08-18:** the Supabase MCP 60 s cap abandons the RESULT, not
the query — a "timed out" EXPLAIN keeps running (seen at 86 s) and retrying it stacks copies onto the
saturation being measured. Take a positive control first (`count(*) FILTER (WHERE wait_event_type='IO')`
over `pg_stat_activity`); if most active sessions are in IO wait, **every duration that hour is
uninterpretable** — compare Buffers, never wall time.

## STANDING — read the three daily instrument LOGS, not their badges (added 2026-08-22)

Three credentialed detectors run daily and are the only things that can see their rot classes:
`edge-fn-drift` (06:40Z) · `db-pin-staleness` (07:20Z) · `migration-parity` (07:40Z). **Measured 2026-08-22:
edge-fn-drift red 14 consecutive runs, db-pin-staleness red 13, migration-parity 14/14 green — and BOTH red
ones are LOUDLY CORRECT, not broken.** 25 edge functions are not running `main`; 6 of 187 DB pins no longer
match live. Details: known-issues **#23**, **#24**.

⚠ **Nothing surfaces them (#25).** The sentinel — the thing actually read — has no GitHub Actions arm, so a
correct detector can stay red indefinitely and nobody notices. Until that is fixed, **reading these three
logs is a MANUAL step in any health sweep**, and CLAUDE.md's rule applies literally: *check the LOG, not the
badge* — a permanently-red instrument and a broken one look identical.

✅ **#24 is RESOLVED as of 2026-08-22 — all six pins re-pinned, assertions reviewed, not merely repointed.**
The warning that stood here (repointing without reviewing the assertions converts a working alarm into a
silent green) was honoured: every pin got its own diff, and five gained mutation-tested assertions for the
behaviour that had drifted. ⚠ **VERIFY, do not assume:** the 07:20Z `db-pin-staleness` run should now report
**187 clean, 0 needing attention** — its first green since 2026-08-03. If it names a pin instead, read WHICH
before reopening. 🚨 **IT DID NAME PINS — this prediction was FALSIFIED on 08-23 and the reason is durable;
see the 2026-08-23 STEER above.** Closure is a moment, not a state: a same-day rewrite of a pinned function
re-opens the instrument within hours. Recipe + what the six taught: [database.md](../reference/database.md).

⚠ **#23 and #25 remain OPEN and are operator-blocked.** 25 edge functions are still not running `main`
(redeploy needs both `deno.json` in `files` AND `import_map_path`, or a stale-but-working function goes
hard-down — and the list includes off-limits `compute-*-pack-ev` / `ingest-*`). Nothing still reads the
daily detectors; that fix is a sentinel arm keyed on a failure STREAK, blocked on putting a GitHub token
with `actions: read` into Vercel env.

## DECIDED 2026-08-22 — two open decisions closed, so nobody re-opens them

- ✅ **pg_cron jobid 70 / the `cron_heavy` privilege question: do NOT grant, no grant is needed.**
  `postgres` IS a member of `cron_heavy`, and `cron_heavy` already holds EXECUTE on `cron.schedule` and
  `cron.unschedule` — only `cron.alter_job` is missing, and `cron.schedule` upserts on
  `(jobname, username)`, so rescheduling under the job's own role updates it in place. Granting
  `alter_job` would widen a privilege to buy a capability the role already has by another door.
  ⚠ **The blocker is the HARNESS, not the database** — the Claude Code auto-mode classifier denies
  `SET ROLE`. The two-line self-checking recipe (and what to do if it returns a jobid other than 70) is
  in **known-issues item 19**, which has been corrected: its old "NO session-reachable role can
  reschedule" headline was **REFUTED**. **Transferable:** *"the sandbox could not do it" is not evidence
  that the DATABASE forbids it* — that conflation turned a two-line fix into a privilege-grant proposal.
- ✅ **The FMV-confidence accuracy meter: the destination is a NIGHTLY MATERIALISED TALLY**, not a
  cheaper in-band query. Rationale in §7 of
  `inbox/2026-08-22T1745Z-the-headline-accuracy-metric-is-unreadable-20h-a-day-…md`. The short form: a
  3.3× cheaper query still runs in-band and can still be killed in a spell — it lowers the odds without
  removing the dependency; and **a GATE metric needs a SERIES, which the in-band rewrite does not
  provide at all**. ⚠ **The lateral rewrite is NOT the alternative — it is the tally's WRITER**, so the
  23:10Z measurement (`trig_01H3p6o5iB7yyjLVzrbbviaA`) keeps its full value and has been repointed at
  that question. ⚠ **The tie check is now BLOCKING**: a tally is computed once and read all day, so an
  arbitrary tie-break is frozen into the published number. ⚠ **New third state for the redesign:
  STALE** — a stored tally that silently ages is worse than a query that loudly times out, because a
  timeout is falsifiable. Nothing has shipped: no table, no writer, no migration.

## RETIRED STEERS — these were in this file and are now WRONG; do not re-add

- ⛔ **"TS on-chain unmapped spike — do NOT skip/retire this class."** `topshot-flowty-unmapped-drain` was **deliberately RETIRED 2026-08-16** (schedule removed from `vercel.json`, verified absent) because its queue reached **0 open** and proving emptiness cost a full backlog scan on ~73 ticks/day. The old steer now argues against a decision that was correctly made.
- ⛔ **"evm-transfers-ingest Base-429 — benign, don't chase."** That cron was **disabled 2026-08-02** as pure waste (`evm_nft_transfers` holds ZERO rows; absent from `vercel.json`, GHA and pg_cron). There is nothing left to not-chase.
- ⛔ **"`unmapped_resolution_backlog_max` self-clears <100 in ~1–2 days."** It did not. It is **291** and is now understood as an AllDay **permanent-class floor**, continuously replenished. Do not wait for it to clear and do not raise its threshold.
- **The whole 2026-06-24 studio-platform post-ship watch** (3 backfill routes, the watchlist follow-ups, the TS dead-media tail, the spork-proxy correction, the UFC studio resolver) — all shipped and long since folded into `CLAUDE.md` + the ledger. Kept out of this file to stop it decaying into an archive again.
