# 🚨 The fleet's top-level alarm went **permanently CRITICAL** tonight — and its clearing condition is OUTSIDE the estate

> ⛔ **THIS FILING CARRIES A SELF-CORRECTION — READ IT BEFORE §2, §3 OR §5.** My original diagnosis ("the arm conflates found-something with could-not-run" / "it reproduces the defect it was written to prevent") is **WRONG**: known-issues #25 commissioned this arm specifically to page on a detector that is **correct and red unread**, so it is working as designed, and §5's recommended fix is the wrong fix. The part that survives — and the only part that should drive action — is that **this red can never be cleared by engineering work**, because 6 of the 25 need an operator to set secrets. See the correction at the foot of this file.

**Filed:** 2026-08-31 ~00:55 PT (07:00Z) · **By:** Claude Code, Trevor's box, overnight pass
**Class:** alarm whose clearing condition is outside the estate · **Status:** ⚠ **PARTLY RETRACTED 2026-08-31 — see the SELF-CORRECTION at the foot.** ⛔ Not fixed here.
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

---

## ⛔ SELF-CORRECTION — 2026-08-31 ~03:20 PT (10:20Z), by the session that filed this

**§2 and §3 are WRONG about the arm's intent, and I found it by reading the arm's own test header and
known-issues #25 — which I should have read BEFORE filing, not after.**

**What #25 says, twice, in the entry that commissioned this arm:**

> *"A streak, not a single red — one red run is a detector doing its job; **the defect is a red that
> PERSISTS unread**."* … *"Both red ones are **LOUDLY CORRECT** — the state CLAUDE.md warns is
> indistinguishable from a broken instrument at a glance."*

⭐ **So the arm was built ON PURPOSE to page on a detector that is CORRECT and has stayed red unread.**
That is its entire thesis: #23 and #24 both sat unnoticed for two weeks because nothing read the
GitHub Actions instruments. It is not confusing "found something" with "could not run" — **it never
claimed to measure brokenness.** It measures *unread persistence*, and on that measure it is working
exactly as specified.

**Retracted:**
- ⛔ *"The arm reproduces the exact defect it was written to prevent"* — it does not. It was written to
  surface persistent unread reds, and it is surfacing one.
- ⛔ *"It treats a working detector as broken"* — it makes no brokenness claim.
- ⛔ **§5's recommended fix (read the report artifact) is the WRONG FIX**, and it also does not
  generalise: of the three watched workflows, **only `edge-fn-drift` uploads an artifact at all.**

**What SURVIVES, and it is the part worth keeping:**
1. **GitHub Actions really does collapse `exit 1` and `exit 2` into `conclusion: "failure"`.** True as a
   general fact about the platform — it is just not this arm's defect.
2. **The masking cost is real.** A permanently-red sentinel desensitises every other arm, which the
   arm's own author accepted for the not-configured branch.
3. ⭐ **THE GENUINELY NEW POINT, and the only one that should drive action: this red can never be
   cleared by engineering work.** The arm's design assumes a persistent red means *"read it and act"* —
   here it HAS been read and acted on repeatedly, and **6 of the 25 are correctly immovable** until an
   operator sets `*_GATE_KEY` secrets. **An alarm whose clearing condition is outside the estate will
   stay red forever**, which is the one case #25's design did not anticipate.

👉 **REVISED RECOMMENDATION — not a semantics change, an ACKNOWLEDGEMENT with an expiry.** This
codebase already has the right pattern for "known, owned, not actionable now": `pipeline_alert_suppression`
(`reason` + `expires_at`), which the sentinel already honours for pipelines. Give the Detector Health
arm the same: an ack carrying **who owns it, why it cannot clear, and a date it re-surfaces**. ⛔ Still
NOT `crit_at`, still NOT dropping it from `WATCHED` — an expiring, reasoned ack is the opposite of
silencing, because it comes back.

⭐ **The lesson for me, plainly: I diagnosed an instrument's intent from its behaviour instead of
reading the register entry that commissioned it.** CLAUDE.md's *"a filed FINDING is a hypothesis"*
applies to findings I file too, and #25 was one grep away the whole time.
