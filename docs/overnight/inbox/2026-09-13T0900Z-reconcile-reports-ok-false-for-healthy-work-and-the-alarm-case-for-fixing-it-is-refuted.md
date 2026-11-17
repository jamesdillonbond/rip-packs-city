# `reconcile-saved-wallet-stats` reports `ok = false` for its HEALTHY path — 41 of 41 "failures" are one benign string — but the alarm case for fixing it is REFUTED, and that is the useful half

*Claude Code (cloud), 2026-09-13 01:5x PT / 09:00Z. **READ-ONLY. Nothing shipped, deliberately — I was ~one step from a three-file change to a drift-pinned PROCEDURE on the strength of an alert I had inferred and never checked.***

---

## 1. The defect is real and is this repo's own named class

`reconcile_all_saved_wallet_stats` is a resumable, per-wallet-COMMITting sweep with a soft deadline. When it runs out of budget it **commits its partial work and stops**, which is the design. It then logs:

```sql
p_ok    := NOT v_truncated,
p_error := CASE WHEN v_truncated
                THEN 'soft_deadline_reached_partial_sweep_committed' ELSE NULL END
```

**So the healthy path reports a failure.** Measured over the full retained window (75 runs since 2026-09-10):

| | |
|---|---|
| runs | 75 |
| `ok = false` | **41 (55 %)** |
| of those, `soft_deadline_reached_partial_sweep_committed` | **41 — 100 %** |
| any other error string, ever | **0** |
| truncated runs that made progress | **38 of 41** (avg 1.9 wallets, max 15) |
| truncated runs with ZERO progress | **3** |

⭐ **CLAUDE.md names this exact shape — *"`ok = false` is overloaded the same way"* as `rows_written = 0`.** The serious consequence is not the 55 %: it is that **a genuine error on this lane would be one unfamiliar string among 41 identical benign ones**, and nobody reads a list that is 100 % noise.

⭐ **There is a clean fix and it is one expression:** `ok` should be false only for `v_truncated AND v_wallets = 0` — truncating having achieved *nothing* is a real failure; truncating having committed 15 wallets is progress. That takes the lane from **41 failures to 3** over 7 days and the 3 are the ones worth reading.

## 2. ⛔ THE REFUTATION — the reason I did not ship it

I built a justification and then tested it, in this order, and it did not survive:

1. The watchlist arms this lane at **`max_minutes_without_success = 360`** (6 h), `severity: medium`, `is_active`.
2. The longest consecutive `ok = false` streak in the window is **16 runs spanning 16.2 hours**, with **6 distinct streaks in 7 days**. On the face of it that is a ~10-hour false amber, several times a week.
3. ⛔ **It has never fired.** `max_minutes_without_success` is consumed by the **sentinel route** (the opt-in no-success arm added 2026-09-04), and across **all 8 sentinel runs in the last 73 h the lane is not named once** — `extra::text LIKE '%reconcile-saved-wallet-stats%'` is **false** on every one. Positive control: those same runs carry 7–9 warns each, and `get_pipeline_alerts()` currently returns **13** alerts across 5 types, so both instruments demonstrably speak.

**Why it does not fire is NOT established** — candidates are that the arm measures last-success over a window the streak does not exhaust, that `pipeline_runs` ~73 h retention truncates what the arm can see, or that its population differs from my streak query. ⚠ **That gap is itself worth someone's attention**: either the arm is correctly tolerant, or it is structurally unable to see a 16-hour no-success streak on a lane it is armed for — and those two have opposite implications for every other lane on that watchlist.

## 3. ⚠ AND THE CURRENT BEHAVIOUR IS LOAD-BEARING SOMEWHERE ELSE

`app/api/sentinel/route.ts` already compensates, deliberately and with its own measurement:

> *"zero-successes alone produced 4 false positives in 20 days, every one a pipeline degrading gracefully BY DESIGN: `reconcile-saved-wallet-stats` reports ok=false on a soft-deadline partial sweep whose work is committed … Adding the rows_written guard removed 4 of 4 of those and kept 5 of 5 genuine outages."*

So the zero-successes-AND-zero-rows arm was **calibrated against 20 days of history containing these rows**. Fixing the procedure would not break that arm (it would get quieter), but it **would make that comment's stated rationale stale**, and `candy-offers-indexer` is named in the same breath as having the same shape — so the fix wants to cover both or say why not.

## 4. Disposition

⛔ **Not shipped.** The defect is real, the fix is small, and the *urgency* rests on an alarm that measurement says does not fire. A three-file change to a drift-pinned PROCEDURE — migration + verbatim pin + the guard's `migration:` registration — with an inverted assertion in a test that needs its own throwaway database, is not something to do at 2 a.m. on a justification that just collapsed.

**For whoever picks it up, in order:**

1. **Settle §2 first** — why did a 16.2 h no-success streak not reach the sentinel's no-success arm? That answer decides whether this is a cosmetic wart or a hole in an arm that 136 watchlist rows rely on.
2. Then the one-expression fix (`ok := NOT (v_truncated AND v_wallets = 0)`), covering `candy-offers-indexer` too if it shares the shape.
3. Update the sentinel's calibration comment in the same commit — its "4 false positives" arithmetic is the record of why that arm looks the way it does.

⭐ **PROMOTE, because it nearly cost an hour tonight: an alarm you have not seen fire is a HYPOTHESIS, not a justification.** The watchlist row, the threshold and the streak length were all real and all pointed the same way; the alert still never happened. Check the instrument's own output before spending anything on the strength of it.

---

# ⛔⛔ SECOND CORRECTION, SAME SESSION (2026-09-13 ~02:2x PT) — **MY REFUTATION WAS ITSELF INVALID, AND THE INSTRUMENT THAT MADE IT INVALID IS NOW FIXED**

**§2 above says the alarm case is refuted because the lane is "not named once" in 21 sentinel runs. That query could not have matched for ANY pipeline.**

## What the zero actually measured

`pipeline_runs.extra` for the `sentinel` pipeline has exactly these keys — enumerated with `jsonb_object_keys` over every run in the window, not assumed:

```
checks_run · critical · duration_ms · http_code · marker ·
notifications · observed · run_attempt · run_id · source · status · warn
```

⛔ **`critical` and `warn` are arrays of check NAMES** (`checks.filter(...).map((c) => c.name)`), and `observed` is a single status string (`"route_unreachable"`). **No key has ever held a pipeline name.** The per-check `detail` — which pipeline, how many minutes, against which threshold — was built, sent to Telegram/email, and then dropped on the floor.

So `extra::text LIKE '%reconcile-saved-wallet-stats%'` returns 0 for every pipeline on every run, forever, whatever the arms did. **I ran it, got a clean zero, wrote "it has never fired", and supported it with a positive control that proved only that the sentinel writes `warn` entries — not that `extra` can contain a pipeline name.** The control was real and it tested the wrong proposition.

⭐ **This is the estate's own rule breaking on the instrument that exists to make other instruments checkable:** *a zero needs a positive control IN THE SAME INSTRUMENT*, and the control has to be for the thing you are claiming, not for the instrument being alive.

## Where that leaves the original question

🟡 **UNDETERMINED, not refuted.** The no-success arm (`detect_pipelines_without_success`) is correct on its face — `now() - max(started_at WHERE ok) > max_minutes_without_success`, with a grace window for young rows — and it returns **empty right now**, which is consistent with the lane having succeeded recently. Whether it fired during the 16.2 h streak **cannot be answered from the database at all**, and could not have been. Telegram history is the only record.

## ✅ Shipped, because the gap is worth more than the answer

`app/api/sentinel/route.ts` now persists `extra.findings` — `{name, status, detail}` for every **non-ok** check:

- **ok checks are excluded** (an all-clear has nothing to explain, and this row is joined by the alert views on every tick);
- **capped** at 25 findings × 400 chars, so a pathological arm cannot bloat every row;
- **redacted** through `redactSecrets`, which is load-bearing rather than tidy: a detail can quote an upstream URL and this estate keeps a **Telegram bot token in a URL path**, while `extra` is far more widely readable than a log line.

⭐ **The caps had to be extracted to `buildSentinelFindings()` to be testable at all** — and that is a second instance of tonight's lesson. Inlined, the cap assertion passed **whether or not the cap existed**, because no sentinel fixture produces a 400-character detail: measured by deleting the `.slice()` and watching the suite stay green. The pure function is unit-tested with synthetic inputs so the caps are actually exercised. **5 mutations, 5 caught** (cap removed ×2, redaction removed, ok-checks kept, findings not persisted).

⚠ **This does NOT answer the §2 question retroactively** — there is no history to recover. It means the same question asked in a week has an answer. **Re-check `extra.findings` after a few days of sentinel runs, and only then judge whether the reconcile `ok=false` wart is misfiring an arm.**

---

# ⭐ THIRD PASS (2026-09-13 ~01:5x PT) — the lane is ALREADY SUPPRESSED for exactly this reason, and that makes the honesty fix MORE valuable rather than less

Checked `pipeline_alert_suppression` before proposing anything further, and found a live row:

| pipeline | reason | expires |
|---|---|---|
| `reconcile-saved-wallet-stats` | *"Designed graceful degradation misread as failure — the ok=fa…"* | **2026-11-15** |

So someone reached this diagnosis already and applied the estate's curated, expiring mechanism. ⭐ **That retires the "false amber" argument completely** — it was never going to fire, and §2's question ("did the no-success arm ever breach?") is now doubly moot for alerting purposes.

🚨 **But it sharpens the ONE argument that always mattered, and turns it from a nuisance into a blind spot.** The filing's real point was that a genuine error would be one unfamiliar string among 41 identical benign ones. **With the lane suppressed, a genuine error now fires NOTHING AT ALL** — the `failure_rate` arm is off for it until 2026-11-15. So the estate has traded "55 % noise" for "no signal", on a lane that:

- has produced **zero** non-`soft_deadline` errors in the retained window, so nobody has seen what a real failure here even looks like;
- **does** have a real failure mode already visible in the data — **3 of 41 truncated runs made ZERO progress**, which is a sweep that could not complete a single wallet inside its budget.

⭐ **So the one-expression fix is now the thing that lets the suppression be LIFTED**, which is the outcome worth having: `ok := NOT (v_truncated AND v_wallets = 0)` makes `ok = false` mean something again (3 events in 7 days instead of 41), at which point the lane can go back to being watched instead of muted.

⚠ **Revised order for whoever picks this up** (supersedes §4):

1. Ship the one-expression fix (three files: migration + verbatim pin + the drift guard's `migration:` registration), covering `candy-offers-indexer` if it shares the shape — the sentinel names both.
2. Update `app/api/sentinel/route.ts`'s calibration comment, whose "4 false positives in 20 days" arithmetic is the record of why its zero-successes-AND-zero-rows arm looks the way it does.
3. **Then DELETE the suppression rather than letting it expire** — a suppression that outlives its cause is the same trained-to-ignore failure one level up, and this one runs to 2026-11-15.

⛔ **Still not shipped here**, for the reason §4 gives: it is a change to a drift-pinned PROCEDURE whose test needs its own throwaway database, and the urgency that would justify doing it at 2 a.m. is exactly what this filing spent three passes failing to establish.

---

# 🚨 FOURTH PASS (2026-09-13 ~02:4x PT) — **RETRACTED. DO NOT SHIP THE ONE-EXPRESSION FIX.** The operator record forbids it by name, and the coverage hole I inferred does not exist

**I set out to ship step 1 above and stopped after reading the two things I had not read: the pin's own rationale and the suppression row's full reason.** Both say, independently, that the behaviour is deliberate. This section supersedes the third pass, and the third pass's "revised order" is **withdrawn in full**.

## ⛔ The suppression row forbids exactly this change, in its own text

`pipeline_alert_suppression.reason` for `reconcile-saved-wallet-stats` ends:

> *"⚠ Do NOT \"fix\" this by making the procedure report ok=true — the ok=false is deliberate and is the only in-band signal that a sweep did not finish."*

And the pin (`supabase/tests/reconcile_all_saved_wallet_stats.sql:313`) argues the same property from the other side, calling it *"the property most worth protecting"*:

> *"A partial sweep that reported success would be a silently-sliced result: every wallet it did reach is correct, so nothing downstream looks wrong, and the wallets it never reached keep serving stale figures indefinitely."*

⭐ **That is CLAUDE.md's own paged-read rule** — *"a PAGED read that breaks on error returns a PARTIAL list no caller can distinguish from a complete one… Throw, or carry `complete:false`."* My proposed fix was to stop carrying `complete:false`.

⭐⭐ **And the pin had already considered my argument and rejected it** — the cry-wolf risk I was citing as new is named three lines above the assertion: *"an arm that is permanently red is its own kind of useless (the `ufc_fmv_stale_hours` cry-wolf cost this repo an operator who learned to skim a red board)."* **The author saw both horns and chose this one.** I re-derived one horn, did not read far enough to find the other, and mistook a considered trade-off for an oversight.

## ⛔ And the coverage hole that revived the urgency is REFUTED — measured, with a positive control

The third pass's case was *"with the lane suppressed, a genuine error fires nothing at all."* **Two arms were never suppressed, and I checked which by reading the function bodies rather than assuming:**

| arm | reads `pipeline_alert_suppression`? | covers this lane? |
|---|---|---|
| `get_pipeline_alerts_core` (failure_rate) | **yes** | suppressed — deliberately |
| `check_pipelines_running_but_not_succeeding` | **yes** | suppressed — *not* deliberately (see below) |
| `detect_stalled_pipelines` (silence) | **NO** | **live** |
| `check_pipeline_cadence_collapse` | **NO** | **live** |

⭐ **So the suppression's own "WHAT IS NOT LOST … a total stop is still caught" claim is TRUE, and is now verified rather than trusted.** A genuine stop still pages.

**Would the third arm have fired if it were not suppressed? No — measured, not assumed.** Replaying its exact predicate over every active watchlist lane in its own window: **0 lanes satisfy `ok_runs = 0 AND work_done = 0`**, this one included. ⭐ **Positive control in the same query, because a bare zero proves nothing:** the join produces **133** lanes with runs in-window, and **60** of them satisfy the `work_done = 0` half — so the predicate and the window both discriminate; what is absent is the conjunction. **`zero_ok_lanes = 0` fleet-wide**: nothing is failing-and-idle anywhere right now.

**So the suppression currently hides nothing.** The 3 zero-progress runs sit inside 150-minute windows that also contain productive runs, so the conjunction never holds — the arm would stay silent on this lane with or without the row.

## ⭐ What IS real, and it is LATENT, not active — filed as an observation, not a defect

`check_pipelines_running_but_not_succeeding` was created (migration `20260830165431`) precisely because *"NOTHING was alerting on it"* for the `ingest` lane — it is the last-resort arm. **It inherits the suppression meant for the noisy failure_rate arm**, via `w.pipeline NOT IN (SELECT pipeline FROM active_suppressions)`, for all ~20 actively-suppressed pipelines.

⚠ **The evidence that this is unintended is that the suppression reasons themselves do not mention it.** Several reason carefully about which arms survive — *"bounded by the expiry and by the cadence arm"*, *"the failure_rate arm keys on the HYPHENATED pipeline name and is unaffected"* — and **none of them says the running-but-not-succeeding arm is also switched off.** The record of what a suppression disables is incomplete, which is the thing to fix.

⛔ **Not shipped, and this time for a reason that is not fatigue:** suppression is currently pipeline-scoped by design, and making one arm exempt is a change to what "suppressed" MEANS across ~20 rows written by several people over two months. It hides nothing today (measured above), so there is no urgency to buy the risk with. **The honest options are per-arm suppression scoping, or simply amending the reason texts to state what is actually disabled** — a decision for Trevor, not a 3 a.m. edit.

## The one thing worth doing here, and it is not code

**Amend the `reconcile-saved-wallet-stats` suppression reason to note that `check_pipelines_running_but_not_succeeding` is disabled by it too**, so the next reader inherits a complete account instead of re-deriving it. Everything else on this item is **CLOSED as NOT A DEFECT**.

⚠ **The lesson, which is the durable part:** three passes over this item each re-derived the same half of the argument and got more confident. **The refutation was in two places I had not opened — the pin's own comment and the full `reason` text — and both were one query away the whole time.** A filed finding is a hypothesis; so is the third pass of one.
