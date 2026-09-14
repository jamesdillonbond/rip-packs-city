# GitHub delivers this repo's scheduled workflows at a CEILING of ~0.3 ticks/hour each — so a tighter cron buys NOTHING, and the site-down alarm runs at 7.8 % of its schedule

**Filed 2026-09-14 ~7:0x AM PT (14:0xZ), Claude Code cloud. READ-ONLY — nothing shipped.**
Found while re-deriving **#100**'s "27 % of hourly" claim before citing it. The claim is confirmed — and it is not a sentinel problem.

## 0 · ⛔ THIS IS AN UPDATE, NOT A DISCOVERY — and checking first is the only reason it is

**`.github/workflows/scheduler-liveness.yml`'s own header already records the ceiling, from 2026-08-29**: *"observed is not a constant FRACTION of expected, it is approximately `min(expected, 5)`"*, and *"⛔ SO ANY CRON ABOVE ~5/DAY HERE IS FICTION, and raising a cadence buys nothing"*. **I did not find that; I re-measured it.** Everything below is either a refinement of that estimate, an instance that postdates it, or a question it explicitly left open. **Read that header first — it also explains why the liveness check is daily (an hourly one would be shed by the thing it watches) and why it deliberately does NOT fail on the shedding.**

**What is actually new here, stated so the overlap is not passed off as news:**
1. **A far better estimate of the cap.** The header's `~5/day` is a point estimate from **one 24 h window, n = 17**, and says *"re-derive from this check's own output before quoting it"*. This is that re-derivation, over **73–388 h per workflow**: **0.257–0.312 ticks/hour, i.e. ~6.2–7.5/day**, not ~5.
2. ✅ **THE HEADER'S OWN OPEN DISCRIMINATOR, ANSWERED — and without the experiment it proposed.** It asks: *"Discriminator between a per-WORKFLOW cap and a per-REPO budget, which this window cannot separate: disable a few high-frequency workflows and see whether the others' counts RISE (budget) or hold (per-workflow cap)."* **No workflow needs disabling: the four ≥1/h workflows below each receive ~0.3/h and therefore ~1.17/h between them, which a single shared ~0.3/h budget cannot produce. It is PER WORKFLOW.** ⭐ **And the header's own 08-29 cross-section already settled it** — *"Eight workflows … all received 4-6 (mean 5.0)"* is 8 × 5 ≈ 40/day in total, which no single ~5/day repo budget could supply. **The answer was in the evidence that raised the question.**
3. **An instance that postdates the header:** `site-availability-alarm.yml` did not exist on 08-29 — it was created 2026-09-10, in response to the ~10 h outage — and it is the worst-affected workflow in the estate.
4. **A second defect the header does not name:** both 4/h alarms report 100 % `success`, so their badges are green while ~92 % of their ticks never happen.


## 1 · ⭐⭐ THE BEST INSTRUMENT IS THE CHECK'S OWN OUTPUT, AND IT TIES NINE WORKFLOWS AT 7–8

The header says *"re-derive from this check's own output before quoting it"*. **That output is in every daily run's log and nobody had read it.** From the 2026-09-13 run (24 h window, 20 scheduled workflows):

| workflow | observed / expected per 24 h |
|---|---:|
| `topshot-sales-history-backfill.yml` | **7** / 96 (7 %) |
| `site-availability-alarm.yml` | **7** / 96 (7 %) |
| `offer-fill-backfill.yml` | **8** / 96 (8 %) |
| `dead-lane-backstop.yml` | **8** / 96 (8 %) |
| `pinnacle-owner-discovery.yml` | **8** / 72 (11 %) |
| `rpc-pipeline.yml` | **8** / 72 (11 %) |
| `ops-monitor.yml` | **8** / 49 (16 %) |
| `sales-indexers-backstop.yml` | **8** / 48 (17 %) |
| `pipeline-sentinel.yml` | **7** / 24 (29 %) |
| `topshot-active-listings-ingest.yml` | 5 / 8 (63 %) |
| `wallet-backfill-backstop.yml` | 3 / 4 (75 %) |
| `badge-sync.yml` | 7 / 8 (88 %) |
| `e2e-smoke.yml` · `migration-parity` · `migration-autorecover` | 4/4 · 3/3 · 3/3 (**100 %**) |
| the six daily workflows | 1/1 (**100 %**) |

🚨 **NINE WORKFLOWS ASKING FOR 24, 48, 49, 72, 72, 96, 96, 96 AND 96 RUNS A DAY ALL RECEIVED 7 OR 8.** A **4× range of requested cadence collapsing onto a two-value outcome** is not shedding proportional to load — it is a **hard per-workflow ceiling of ~8 runs/day**. Everything asking **≤ 8/day is delivered at 63–100 %**.

⭐ **This SUPERSEDES the 08-29 header's own `min(expected, 5)`** — the rule shape is confirmed and the constant is **~8, not ~5**. That earlier figure was a point estimate from one 24 h window (n = 17) and the header flagged it as such.

⚠ **State the ceiling in RUNS/DAY, not runs/hour** — that is the unit in which it ties.

## 2 · Corroboration from a longer window, and a control in both directions

My own independent measurement from the run list, over **73–388 h per workflow** rather than one day, agrees and adds the long-run view:



Every figure below is from GitHub's own `schedule`-event run list, counting **actual starts** over the span each workflow has runs for.

| workflow | cron | requested/h | **delivered/h** | % of schedule | median gap | worst gap |
|---|---|---:|---:|---:|---:|---:|
| E2E DOM Smoke | `51 */6 * * *` | 0.167 | **0.159** | **95.7 %** | 6.38 h | 14.46 h |
| Pipeline Sentinel | `34 * * * *` | 1.0 | **0.257** | **25.7 %** | — | 8.36 h |
| RPC Data Pipeline | `5,25,45 * * * *` | 3.0 | **0.290** | **9.7 %** | 3.39 h | 6.79 h |
| Dead Lane Backstop | `12,27,42,57 * * * *` | 4.0 | **0.308** | **7.7 %** | 2.70 h | 6.72 h |
| Site Availability Alarm | `4,19,33,49 * * * *` | 4.0 | **0.312** | **7.8 %** | ~3 h | 5.58 h |

⭐⭐ **THE DELIVERED COLUMN IS FLAT AT 0.257–0.312/h ACROSS A 24× RANGE OF REQUESTED CADENCE.** Every workflow asking for **≥ 1/h** receives about **one tick every 3.3 hours**. The one asking for **less** than that ceiling is delivered at **95.7 %**.

⛔ **SO THE PERCENTAGE COLUMN IS NOT FIVE SEPARATE PROBLEMS — IT IS ONE CEILING, DIVIDED BY WHAT EACH WORKFLOW ASKED FOR.** 7.7 % and 7.8 % are not "the alarms are worse than the sentinel"; they are the same ~0.3/h expressed against a 4×/hour ask instead of an hourly one.

⭐ **The ceiling is PER WORKFLOW, not a shared repo budget** — established from the same data rather than assumed: these four ≥1/h workflows deliver **0.257 + 0.290 + 0.308 + 0.312 ≈ 1.17/h between them**, which a single ~0.3/h repo-wide cap could not produce.

## 3 · 🚨 What is sitting under the ceiling

**`site-availability-alarm.yml` — the alarm that exists to notice the site is DOWN — fires 23 times in 73.8 hours.** It was created **2026-09-10 21:38 PT**, hours after the Vercel spend-cap pause that took the site and ~20 HTTP lanes down for **~10 hours** (#76). Its blind windows since: **5.58 h · 5.12 h · 4.99 h · 4.61 h · 4.46 h**. ⛔ **An outage shorter than ~3 hours is more likely than not to end before this alarm looks.**

🚨 **AND IT HAS NEVER FAILED — 23 of 23 `success`.** Dead Lane Backstop: **24 of 24 `success`.** **Both badges are green while ~92 % of their ticks never happen.** That is this estate's own lesson — *a check that did not run is indistinguishable from one that passed*, the exact defect `inherited-status` was built for on 09-13 — **applied to alarms rather than to CI, where nothing is watching for it.**

⚠ **AND IT IS NOT ONLY WATCHERS.** `rpc-pipeline.yml` is a **DATA** lane at 3/h → 0.290/h, receiving **8 of 72**. ~~🚨 AND `offer-fill-backfill.yml` ASKS FOR 96/DAY AND RECEIVES 8 — a 12× shortfall on the lane #70 identifies as the largest measured code-side M2 lever.~~

⛔ **CORRECTION, ~10 MINUTES AFTER I WROTE IT: `offer-fill-backfill.yml` IS NOT #70's M2 LEVER, AND ITS CAP COSTS NOTHING TODAY.** I connected a capped lane to the go-live gate **on a name match** — "offer-fill" appears in #70 — **without reading the lane.** Read: `app/api/admin/backfill-offer-fill-sales/route.ts` is **Top Shot only** (`p_collection_slug: "nba_top_shot"`, `nftType = TopShot`, cursor `topshot_offer_fill_backfill`) and is a **historical** drain. **#70's lever is WIDENING offer-fill to ALL DAY, which this lane does not do.** ⭐ **And it has caught up:** its cursor sits at block **164,510,306** (updated 13:05Z) against a live head of **164,513,793** — **~3,487 blocks behind**, i.e. at the present. **A cap on a backfill that has finished costs nothing**, the same shape as this morning's pack-sales reading. ⚠ **The general point survives and is unchanged — the ceiling applies to DATA lanes, not only watchers** (`rpc-pipeline` 8/72 is still a live instance, and its header still assumes a next tick 20 minutes away) — **but the go-live connection is withdrawn.** ⭐ Third time this session a plausible name produced a plausible answer from the wrong source; the rule is *name the caller before you touch the function*, and a workflow filename is not a caller. Its own header says partial failure *"self-heals on the next tick"* — **a load-bearing assumption that the ceiling breaks: the next tick is a median 3.39 h away, not 20 minutes.**



### ⭐ SCOPING: THE WORST PERCENTAGES BELONG TO THE LANES IT MATTERS LEAST FOR

**Measured before leaving the reader to chase the 7 % rows.** Every `*-sales-history-backfill` lane and the offer-fill drain ran **7–9 times in 24 h and wrote effectively nothing**: `topshot` 8 runs / **0 rows** · `allday` 8 / 0 · `allday-studio` 8 / 0 · `golazos` 8 / 0 · `golazos-studio` 8 / 0 · `pinnacle` 8 / 0 · `pinnacle-studio` 7 / 0 · `backfill-offer-fill-sales` 9 / **7**. **They are drained.** A ceiling on a backfill that has caught up costs approximately nothing — the same shape as this morning's pack-sales reading.

🚨 **SO THE CEILING'S LIVE COST CONCENTRATES ON THE WATCHERS**, which are exactly the rows a percentage ranking buries:
- `site-availability-alarm` **7/96** — the site-down alarm, blind 4.5–5.6 h at a time.
- `dead-lane-backstop` **8/96** · `pipeline-sentinel` **7/24** — the backstop and the master alarm.
- `rpc-pipeline` **8/72** · `ops-monitor` **8/49** · `sales-indexers-backstop` **8/48** · `pinnacle-owner-discovery` **8/72** — live monitor and data lanes, not drained backfills.

⭐ **THE LESSON FOR RANKING: `topshot-sales-history-backfill` (7 %) and `site-availability-alarm` (7 %) are indistinguishable in the percentage column and could hardly matter more differently.** **Rank by what the lane still DOES, not by how far short of its schedule it falls** — the same error as ranking `pg_stat_statements` by a cumulative column, one layer up.

## 4 · What this kills, and what it does not

⛔ **IT KILLS "RUN IT MORE OFTEN" AS A FIX, ESTATE-WIDE.** Tightening a GHA cron on this repo cannot raise delivery above ~0.3/h. Any past or future remedy of the form *"move it to every 15 minutes"* is void, and a workflow already at ≥1/h cannot be improved by re-timing it.

✅ **IT CONFIRMS #100's DECISION AND GENERALISES IT.** That item rejected pg_cron + pg_net for the sentinel (119–162 s against pg_net's 90 s wall) and named **the cron-job.org console** as the correct driver. **That conclusion now applies to the whole alarm estate, not just the sentinel** — and cron-job.org is already demonstrated at a 5-minute cadence without drift on the counterparty lane.

⛔ **IT DOES NOT ESTABLISH WHY.** GitHub documents scheduled workflows as best-effort and load-dependent; whether this ceiling is account-level throttling, repo-level, or queue-depth behaviour is **not decidable from the run list**, and I am not inferring it. **The number is the actionable part; the mechanism is not needed to act on it.**

⚠ **ONE OBSERVATION WINDOW, ONE REPO.** Spans are 73–388 h ending 2026-09-14. Re-derive before quoting; a platform-side change would move all five rows together.

## 5 · The cheapest next step, stated so it is not re-derived

**Pick the alarms that must not be blind for hours — `site-availability-alarm` first — and move them to cron-job.org**, which needs the console and therefore Trevor. ⭐ **Do not re-time them on GHA first to "see if it helps": this measurement is that experiment, already run across five workflows and 24× of cadence.**

⚠ **And whatever drives them, the green-badge problem is separate and survives the move:** an alarm that reports `success` on every tick it manages to run says nothing about the ticks it did not. **A liveness check on the alarms themselves — one that fires on SILENCE — is a different instrument from any of the five above**, and `scheduler-liveness.yml` (`17 8 * * *`, daily, comfortably under the ceiling) is where it would belong.

## 6 · ✅ WHAT THE CEILING ALREADY BROKE, FIXED THE SAME DAY

**`site-availability-alarm.yml` had its window sized against its CRON (96/day → a 2 h window is generous) while its DELIVERY is ~8/day (median gap 3.2 h, worst 5.58 h).** So probe history between runs was examined by nothing, and its only failure condition — `consecutive_fails` — is 0 by definition once an outage ends. **A site that went down and recovered between two alarm runs was invisible although `site_probe` recorded every failed probe.** ✅ Fixed workflow-only (the window is already an RPC parameter): `WINDOW: 08:00:00` and a second branch `FAIL_IN_WINDOW: 3`, sized on the real series (949 probes / 2 failures in the retained 3 d 10 h; worst 8 h window holds 1). 4 mutations, each caught by one test; suite 12 → 17.


⭐⭐ **THE SWEEP FOR THE SAME DEFECT ELSEWHERE IS COMPLETE, AND IT FOUND EXACTLY ONE INSTANCE — which is worth writing down so nobody "fixes" the other four.** Every windowed check in `public` (`pg_proc` where the arguments carry an `interval`): `check_site_availability` **2 h** · `check_edge_fn_http_failures` **2 h** · `check_pgcron_failure_rate` **6 h** · `check_pgcron_recent_failures` **24 h** · `check_wall_kills` **24 h**. ⛔ **A SHORT WINDOW IS NOT THE DEFECT. The defect is a window sized against a cron that is not DELIVERED.** `check_edge_fn_http_failures`' 2 h window looks identical to the broken one and is fine: its caller is `check-alerts`, which ran **72 times in 24 h at a 20-minute average gap** — the window is **6× its caller's interval**, because pg_cron and cron-job.org actually deliver. `check_pgcron_failure_rate` is called by the sentinel with an explicit **6 h** against a ~3.4 h median delivery, so consecutive runs overlap; only the worst **8.36 h** sentinel gap leaves a hole, and it is a RATE check against a measured baseline rather than an event detector. The two 24 h windows are safe by a wide margin. ⭐ **So the rule is: `window > worst delivery gap of its CALLER`, and only GHA-driven checks are exposed — because only they are subject to the ceiling.** The one GHA-driven windowed check was the site-down alarm.
