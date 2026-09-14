# GitHub delivers this repo's scheduled workflows at a CEILING of ~0.3 ticks/hour each — so a tighter cron buys NOTHING, and the site-down alarm runs at 7.8 % of its schedule

**Filed 2026-09-14 ~7:0x AM PT (14:0xZ), Claude Code cloud. READ-ONLY — nothing shipped.**
Found while re-deriving **#100**'s "27 % of hourly" claim before citing it. The claim is confirmed — and it is not a sentinel problem. It is a **ceiling that applies to every scheduled workflow in this repo**, and two of the alarms sitting under it were created in direct response to a 10-hour outage.

## 1 · The measurement, with a control in both directions

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

## 2 · 🚨 What is sitting under the ceiling

**`site-availability-alarm.yml` — the alarm that exists to notice the site is DOWN — fires 23 times in 73.8 hours.** It was created **2026-09-10 21:38 PT**, hours after the Vercel spend-cap pause that took the site and ~20 HTTP lanes down for **~10 hours** (#76). Its blind windows since: **5.58 h · 5.12 h · 4.99 h · 4.61 h · 4.46 h**. ⛔ **An outage shorter than ~3 hours is more likely than not to end before this alarm looks.**

🚨 **AND IT HAS NEVER FAILED — 23 of 23 `success`.** Dead Lane Backstop: **24 of 24 `success`.** **Both badges are green while ~92 % of their ticks never happen.** That is this estate's own lesson — *a check that did not run is indistinguishable from one that passed*, the exact defect `inherited-status` was built for on 09-13 — **applied to alarms rather than to CI, where nothing is watching for it.**

⚠ **AND IT IS NOT ONLY WATCHERS.** `rpc-pipeline.yml` is a **DATA** lane at 3/h → 0.290/h. Its own header says partial failure *"self-heals on the next tick"* — **a load-bearing assumption that the ceiling breaks: the next tick is a median 3.39 h away, not 20 minutes.**

## 3 · What this kills, and what it does not

⛔ **IT KILLS "RUN IT MORE OFTEN" AS A FIX, ESTATE-WIDE.** Tightening a GHA cron on this repo cannot raise delivery above ~0.3/h. Any past or future remedy of the form *"move it to every 15 minutes"* is void, and a workflow already at ≥1/h cannot be improved by re-timing it.

✅ **IT CONFIRMS #100's DECISION AND GENERALISES IT.** That item rejected pg_cron + pg_net for the sentinel (119–162 s against pg_net's 90 s wall) and named **the cron-job.org console** as the correct driver. **That conclusion now applies to the whole alarm estate, not just the sentinel** — and cron-job.org is already demonstrated at a 5-minute cadence without drift on the counterparty lane.

⛔ **IT DOES NOT ESTABLISH WHY.** GitHub documents scheduled workflows as best-effort and load-dependent; whether this ceiling is account-level throttling, repo-level, or queue-depth behaviour is **not decidable from the run list**, and I am not inferring it. **The number is the actionable part; the mechanism is not needed to act on it.**

⚠ **ONE OBSERVATION WINDOW, ONE REPO.** Spans are 73–388 h ending 2026-09-14. Re-derive before quoting; a platform-side change would move all five rows together.

## 4 · The cheapest next step, stated so it is not re-derived

**Pick the alarms that must not be blind for hours — `site-availability-alarm` first — and move them to cron-job.org**, which needs the console and therefore Trevor. ⭐ **Do not re-time them on GHA first to "see if it helps": this measurement is that experiment, already run across five workflows and 24× of cadence.**

⚠ **And whatever drives them, the green-badge problem is separate and survives the move:** an alarm that reports `success` on every tick it manages to run says nothing about the ticks it did not. **A liveness check on the alarms themselves — one that fires on SILENCE — is a different instrument from any of the five above**, and `scheduler-liveness.yml` (`17 8 * * *`, daily, comfortably under the ceiling) is where it would belong.
