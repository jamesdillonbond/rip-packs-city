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

⚠ **AND IT IS NOT ONLY WATCHERS.** `rpc-pipeline.yml` is a **DATA** lane at 3/h → 0.290/h, receiving **8 of 72**. 🚨 **AND `offer-fill-backfill.yml` ASKS FOR 96/DAY AND RECEIVES 8 — a 12× shortfall on the lane #70 identifies as the largest measured code-side M2 lever.** The go-live gate's biggest available lever is running at a twelfth of its intended rate, and the register discusses its SIZING without anywhere noting that its DELIVERY is capped. `topshot-sales-history-backfill.yml` is in the same position (7 of 96). Its own header says partial failure *"self-heals on the next tick"* — **a load-bearing assumption that the ceiling breaks: the next tick is a median 3.39 h away, not 20 minutes.**

## 4 · What this kills, and what it does not

⛔ **IT KILLS "RUN IT MORE OFTEN" AS A FIX, ESTATE-WIDE.** Tightening a GHA cron on this repo cannot raise delivery above ~0.3/h. Any past or future remedy of the form *"move it to every 15 minutes"* is void, and a workflow already at ≥1/h cannot be improved by re-timing it.

✅ **IT CONFIRMS #100's DECISION AND GENERALISES IT.** That item rejected pg_cron + pg_net for the sentinel (119–162 s against pg_net's 90 s wall) and named **the cron-job.org console** as the correct driver. **That conclusion now applies to the whole alarm estate, not just the sentinel** — and cron-job.org is already demonstrated at a 5-minute cadence without drift on the counterparty lane.

⛔ **IT DOES NOT ESTABLISH WHY.** GitHub documents scheduled workflows as best-effort and load-dependent; whether this ceiling is account-level throttling, repo-level, or queue-depth behaviour is **not decidable from the run list**, and I am not inferring it. **The number is the actionable part; the mechanism is not needed to act on it.**

⚠ **ONE OBSERVATION WINDOW, ONE REPO.** Spans are 73–388 h ending 2026-09-14. Re-derive before quoting; a platform-side change would move all five rows together.

## 5 · The cheapest next step, stated so it is not re-derived

**Pick the alarms that must not be blind for hours — `site-availability-alarm` first — and move them to cron-job.org**, which needs the console and therefore Trevor. ⭐ **Do not re-time them on GHA first to "see if it helps": this measurement is that experiment, already run across five workflows and 24× of cadence.**

⚠ **And whatever drives them, the green-badge problem is separate and survives the move:** an alarm that reports `success` on every tick it manages to run says nothing about the ticks it did not. **A liveness check on the alarms themselves — one that fires on SILENCE — is a different instrument from any of the five above**, and `scheduler-liveness.yml` (`17 8 * * *`, daily, comfortably under the ceiling) is where it would belong.
