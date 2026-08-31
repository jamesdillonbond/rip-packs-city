# 🚨 The fleet's top-level alarm went **permanently CRITICAL** tonight — because a detector that is **working correctly** is red, and GitHub reports "found something" and "could not run" identically

**Filed:** 2026-08-31 ~00:55 PT (07:00Z) · **By:** Claude Code, Trevor's box, overnight pass
**Class:** honesty / instrument desensitisation · **Status:** DIAGNOSED TO THE MINUTE. ⛔ **NOT fixed here** — see §5.
**Urgency:** the sentinel is red *now* and will mask any NEW critical until this is resolved.

---

## 1. What happened, dated to the change

`Pipeline Sentinel` succeeded at **13:10Z** and **17:42Z** on 08-30, then failed at **19:54Z, 21:23Z,
23:43Z and 05:56Z** — 4 consecutive, still failing.

**The trigger is confirmed, not inferred.** The last successful run's own payload reads:

```
"Detector Health (GitHub Actions)","status":"ok",
"detail":"[NOT CONFIGURED] set GITHUB_ACTIONS_READ_TOKEN (a token with actions:read) in Vercel env…"
```

So between 17:42Z and 19:54Z somebody set `GITHUB_ACTIONS_READ_TOKEN` in Vercel. The arm went live,
took its **first real reading**, found `edge-fn-drift` at a **12× consecutive-failure streak**, and
escalated straight to `critical` (crit threshold 7). It has been CRITICAL on every run since.

⭐ **Nothing broke. An arm was switched on and immediately reported a condition that had already been
true for over a week.** The 12× streak is real — `edge-fn-drift.yml` on `main` is failure on all 12
runs the API returns, back to 08-23.

## 2. 🚨 But the detector is not broken — it is WORKING, and its "failure" IS its finding

Reading the log rather than the badge, exactly as the arm's own message instructs:

```
edge-fn drift: 38 repo functions, 67 deployed
PROVEN drifted (repo needs an import map, deployed built without one) — 19
CONTENT drift (deployed body != repo source) — 25
DRIFT: 25 function(s). 19 SAFE to redeploy … ⛔ DO NOT REDEPLOY 6 …
##[error]Process completed with exit code 1
```

**`exit 1` is documented in that workflow as "drift found".** (`exit 2` is config error / rejected
token — i.e. actually broken.) The detector ran, parsed 38 bundles, and reported a real, registered
condition (known-issues **#23**).

🚨 **THE DEFECT: GitHub Actions collapses `exit 1` and `exit 2` into the same `conclusion: "failure"`.**
The arm counts `conclusion === "failure"` runs and cannot tell:

| what happened | exit | GitHub `conclusion` | what it means |
|---|---|---|---|
| detector ran, **found drift** | 1 | `failure` | ✅ the detector is **working** |
| detector **could not run** (bad token, config) | 2 | `failure` | 🚨 the detector is **blind** |

**Those want opposite responses, and the arm cannot distinguish them.** It is this repo's standing
"there are always THREE states, never two" — *ran and clean · ran and found something · could not run*
— with the middle state collapsed into the third.

## 3. ⭐ The sharpest part: the arm reproduces the exact defect it was written to prevent

Its own comment, on the not-configured branch:

> *"CLAUDE.md records that a permanently-red instrument is indistinguishable from a broken one at a
> glance — it would desensitise every OTHER arm in this report."*

That reasoning was applied to the **unconfigured** case (forced to `ok`, visible, annotated). It was
**not** applied to the case where a *watched* detector is correctly and permanently red. The arm's
own detail string even says *"A detector red for many days running is usually CORRECT and unread —
read the LOG, not the badge"* — **it knows, and escalates to `critical` anyway, on streak length alone.**

## 4. Why this matters more than the drift it is reporting

The sentinel is the fleet's top-level alarm. It is now **permanently CRITICAL for a condition that
cannot be cleared**:

- 19 of the 25 drifted functions are safe to redeploy — real work, not a night-pass job.
- ⛔ **6 must NOT be redeployed**: `backfill-allday-pack-supply`, `backfill-pack-opens-api`,
  `compute-golazos-pack-ev`, `ingest-allday-pack-opens`, `ingest-pinnacle-mints`,
  `ingest-topshot-pack-opens-history` — their `*_GATE_KEY` secrets are UNSET, so deploying makes the
  gate fail CLOSED and 403 every tick (the 2026-08-11 outage mechanism). **They are drifted BECAUSE
  they were correctly never redeployed.**

**So the streak can never reach 0 without an operator setting six secrets.** Meanwhile the same run
already carries two live `warn`s — `match-topshot-players 0/1 ok` (#54) and
`unmapped_resolution_backlog_max=275` (D37) — and **every future critical now lands in an
already-red alarm.** That is the desensitisation the arm was built to avoid, arriving through the arm
itself.

## 5. ⛔ Why I did not fix it, and what the fix is

**This is the fleet alarm, and the fix is a design choice with alerting consequences.** ⛔ **And the
wrong fix is obvious and tempting: raise `crit_at`, or drop `edge-fn-drift` from `WATCHED`.** Both
silence a true signal, and this repo's own 08-29 precedent was explicit — *"all four WARN arms
addressed at the mechanism, not the threshold."*

👉 **The mechanism fix is to stop reading the BADGE and read the FINDING.** Three options, cheapest
first:

1. ⭐ **Read the detector's own report, not its conclusion.** `edge-fn-drift.yml` already uploads
   `edge-fn-drift-report.json` as an artifact on every run. An arm that reads *"did the detector
   produce a report?"* answers the question actually being asked — **is the instrument alive** — and
   is immune to whether the report's contents are clean. A detector that fails to run produces no
   artifact; that is the true `critical`.
2. **Split the state explicitly.** Treat *ran-and-reported* as `warn` with the finding in the detail
   (visible, not paging) and reserve `critical` for *could-not-run* / *no completed runs* / *unreadable*
   — the states the arm already tracks separately in `unreadable[]`.
3. **Have the detector distinguish itself**: exit 0 on "drift found" while writing the count to a place
   the sentinel reads, keeping `exit 1` for genuine breakage. ⚠ **Weakest option** — it turns the
   drift detector's badge green and makes the drift itself unread, which is how #23 got old.

⚠ **Whichever is chosen, keep the count visible.** The goal is not to make the sentinel green; it is
to make `critical` mean *"an instrument stopped working"* again.

## 6. ⓘ Two things that are NOT wrong, recorded so nobody chases them

- **Setting `GITHUB_ACTIONS_READ_TOKEN` was correct.** The arm was designed to be configured, and its
  first reading was accurate. The problem is what it does with an accurate reading.
- **`edge-fn-drift`'s red is correct and should stay red** until the drift is resolved — it was blind
  until the 08-30 tier-2 parse fix (`7743d0180`, closing #53) and is now finally reporting a real
  census. ⛔ **Do not "fix" the streak by breaking the detector again.**
