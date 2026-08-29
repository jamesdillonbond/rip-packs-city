# CI & testing audit — the GATES are strong, the DETECTORS are not firing

**2026-08-29T17:41Z · full sweep of 20 workflows, 3 coverage gates, 1,392 vitest files, 181 SQL invariant files, 8 e2e specs.**

The pre-merge side of this repo is in good shape. The **post-merge detection side is degraded in four independent ways, all of them silent**, and three of the four are invisible precisely because nothing turns red.

---

## 🚨 A. The scheduled monitors fire at ~8% of their cron cadence, and a tick that never fires produces no signal at all

Measured per UTC day from `actions/runs`, three independent workflows:

| workflow | cron | expected/day | 08-23 | 08-24 | 08-25 | 08-26 | 08-27 | 08-28 | 08-29¹ |
|---|---|---|---|---|---|---|---|---|---|
| `pipeline-sentinel` | `34 * * * *` | 24 | 22 | 22 | 23 | 15 | **3** | **2** | **3** |
| `ops-monitor` | `13,43 * * * *` | 48 | — | — | — | 19 | **4** | **3** | **4** |
| `rpc-pipeline` | `5,25,45 * * * *` | 72 | — | — | 3 | 19 | **2** | **3** | **3** |

¹ partial day (through ~15:00Z).

⭐ **Corroborated from the database, not only from GitHub:** `pipeline_runs` shows `stale-fmv-monitor` at **8 rows in 24 h against 48 scheduled** (`d0=8, d1=3, d2=4`). Two instruments, same answer.

⛔ **Checked, not assumed — it is not repo config.** `get_workflow` returns `state: "active"` for `pipeline-sentinel` (not `disabled_inactivity`). The firing MINUTES are the tell: a `5,25,45` cron fired at 15:08, 10:18, 03:22, 21:31, 11:36, 00:21. That is GitHub delaying and then **dropping** scheduled runs, which it does under scheduler load — this repo asks for **~250 scheduled jobs a day** across 14 schedule-driven workflows.

⭐ **Two controls, both directions.** *Positive:* push-triggered work is completely unaffected — `smoke-tests` has 5,418 runs and fires on every push. *Negative:* low-frequency schedules mostly survive — `db-pin-staleness` (daily) ran today and its log reads `checked 189 pins — 189 clean`. **The shedding is proportional to requested frequency.**

⛔ **The blast radius is DETECTION, not data — do not escalate this as "the pipelines stopped".** Production ingest is overwhelmingly on cron-job.org and pg_cron, and is healthy: `fmv-recalc` 57–72 runs/day, `ingest-pinnacle-mints-backfill` 692/day, `pack-events-ingest` 92/day, all with `last_run` inside the last 15 minutes. What IS starved is exactly the watching layer: the fleet **sentinel**, the **FMV-staleness monitor**, the **DOM smoke**, and every GHA ingest **backstop** (`sales-indexers-backstop`, `wallet-backfill-backstop`, `allday-ingest`, `badge-sync`, `topshot-active-listings-ingest` — the last one visible in `pipeline_runs` at 5/day against 8 scheduled).

👉 **This is the repo's own "a permanently-zero instrument is indistinguishable from a broken one", one level up: an instrument that never RUNS is indistinguishable from one that ran and found nothing.** A dropped tick emits no run, no badge, no email.

**Fix direction (not shipped — it is a cadence decision):** GitHub will not honour ~250 scheduled runs/day here. Either (1) move the sentinel and the FMV-staleness monitor onto cron-job.org, which already drives the real pipelines reliably and is not subject to this shedding, or (2) collapse the high-frequency GHA schedules so the total request drops below whatever this repo's shed threshold is — ⚠ **that threshold is not measured, so (2) is a guess and (1) is not.**

---

## 🚨 B. Three "monitors" cannot go red on the condition they exist to detect

- **`rpc-pipeline.yml`** — all six steps carry `continue-on-error: true`, and a non-200 emits `::warning::` only. **30 of 30 recent runs are `success` by construction.** The job cannot fail.
- **`ops-monitor.yml` → `fmv-staleness`** — `status == "stale"` emits `::warning::` and then `exit 0`. **"FMV data is stale" never reddens the badge.** Only a non-200 after 3 attempts fails the job.
- **`ops-monitor.yml` → `data-integrity`** — `issue_count > 0` emits `::warning::` and falls through; only a non-200 fails.

Fleet-wide: **30 `::warning::` against 18 `::error::`** across the workflows. `pipeline-sentinel` is the honourable exception — it exits 1 on `CRITICAL`.

⚠ A `::warning::` is visible only to someone already reading that run's log. On a workflow whose whole purpose is to be read *only* when it is red, a warning is silence.

---

## 🚨 C. `edge-fn-drift` has been red on 21 of its 22 runs since 2026-08-09 — and there are TWO facts inside that one red

**It is a TRUE positive, so "it's just broken" is the wrong read:** 19 edge functions are proven drifted (repo needs an import map, deployed built without one) — `compute-*-pack-ev` ×3, `ingest-pinnacle-mints`, `ingest-topshot-atlas-pool`, `pinnacle-owner-discovery{,-forward}`, `sales-serial-backfill`, `scan-{pinnacle,ufc}-wallet`, `seed-{allday,topshot}-pack-distributions`, and 8 more.

⭐ **The part the red hides — tier 2 has NEVER run.** Every run logs:

```
edge-fn drift TIER 2 DID NOT RUN — 38 body read(s) attempted, 0 succeeded.
body read failed — <fn>: Unexpected token 'E', "ESZIP2.3\0\0"... is not valid JSON
content census: 0 body/bodies read, 38 failed  ← CENSUS DID NOT RUN
```

The Supabase Management API returns the **eszip bundle**, not JSON, so the content census is dark. **A function whose imports happen to match but whose BODY drifted is invisible to this check, and has been for 20 days.** The workflow's own header says so; nobody has read it, because the badge was already red for the other reason.

⭐ **Its own stated falsifier is unmet and undischarged.** The workflow header pins a baseline: *"if the first armed run reports anything other than 31, debug the DETECTOR before believing the finding."* It reports **19**. Either 12 were fixed or tier 1 regressed — **not established either way**, and that is exactly the check the baseline exists to force.

---

## ⛔ D. CORRECTION (same session) — "there is no notification channel" was WRONG, and the way it was wrong is the reusable part

**What I filed:** *"Grepped all 20 workflows for `slack|webhook|notify|resend|discord|pagerduty`: zero hits. There is no notification channel. At all."*

**What is true:** there is a Telegram + Resend email alerting path, and it is live. `lib/ops-alert.ts` sends to both channels behind a 3-hour dedup (`ops_alert_should_send`), and `/api/sentinel` carries its own inline copies of both. Callers: `stale-fmv-monitor`, `data-integrity`, `smoke-test`, and the sentinel. **`alert_notifications_sent` holds 193 `high` and 20 `critical` rows, the most recent at 08-29 16:55Z** — an hour before I filed the claim.

⭐ **The error is one this file already names: an exclusion justified by ANOTHER instrument is a claim about that instrument.** I scoped the grep to `.github/workflows/` because that is where CI alerting *would* live, and then reported the absence as a property of the system rather than of my search. The alerting lives one layer down, in the application, on purpose — and two of the routes say so in their headers.

**What survives, and it is sharper than what I filed:**

- ⚠ **The delivery OUTCOME was not durable anywhere.** The sentinel computes `telegram` / `telegram-FAILED` and `email` / `email-FAILED` — the silent-alert-failure guard working exactly as designed — and then puts it in the HTTP response body and a `console.log`. Nothing stored it. `alert_notifications_sent` records the **decision to send**, not the send: its columns are `alert_hash, sent_at, severity, pipeline_count, body_preview`, with no delivery field, and `sendOpsAlert` writes that row *before* both channels are attempted. So "did the alarm reach a human?" was unanswerable from any durable store. ✅ **FIXED this turn** — see the new finding J.
- ⚠ **Finding A still bites the same way**, just via a different mechanism than I said: these alerts fire only when the route is INVOKED, and the sentinel is invoked by GHA alone. At 3 firings a day instead of 24, the fleet alarm's worst-case detection latency went from ~1 hour to ~8, with nothing anywhere turning red.

## ⛔ B. PARTIAL CORRECTION — for two of the three, the badge was never meant to be the alarm

`stale-fmv-monitor` and `data-integrity` both call `sendOpsAlert` themselves. The `::warning::`-then-`exit 0` shape is therefore **deliberate**, and `stale-fmv-monitor`'s header says so outright: *"Pass/fail for the GHA only depends on HTTP 200 + `status`."* The email is the alarm; the badge reports whether the check could run. That is a defensible split and I filed it as a defect.

**What survives:** `rpc-pipeline.yml` is still 6/6 `continue-on-error` with no alerting of any kind behind it, so 30 of 30 runs are green by construction and nothing else is watching — that one stands as filed.

🚨 **And the one place where the badge genuinely WAS the only alarm, it was broken.** `pipeline-sentinel.yml` captured `HTTP_CODE`, echoed it, and **never tested it**. The only failing branch was `STATUS = "CRITICAL"`, so a 500, a 504, or a 401 from a rotated token all left `STATUS` as `PARSE_ERROR` — not "CRITICAL" — and the step exited **0**. A sentinel that was completely down reported green. The route has 504'd under disk-IO saturation before (its own header records the 60 → 180 s `maxDuration` raise for exactly that), so this state was reachable, not hypothetical. ✅ **FIXED this turn.**

---

## ⚠ E. The one client-side detector throws its evidence away on every failure — ✅ FIXED THIS TURN

CLAUDE.md: *"The scheduled `E2E DOM Smoke` badge is the ENTIRE detection surface"* for client-only failures (Sentry has been dropping events since 08-18, #34).

`playwright.config.ts` declared `reporter: [["list"], ["json", …]]` — **no `html` reporter**, so `playwright-report/` was never created, and every failing run ended with `##[warning]No files were found with the provided path: playwright-report/`. No `trace` either.

⭐ **It cost a real detection.** Run 111 (08-26T21:09Z) was a genuine find: `/insights/underpriced-serials` failed `assertHealthyPage`'s console-failure assertion **through two retries** — a live React #418 hydration mismatch, exactly the class that assertion was written for. 95 passed, 1 failed, **0 bytes of diagnostics retained.**

⚠ **And the noise is real: 8 failures in the last 30 runs (27%).** A detector that reds a quarter of the time and hands back nothing to look at is trained out of.

---

## ⚠ F. What the three coverage gates structurally cannot see

Coverage `include` globs, counted against the tree:

| surface | files | in a gate |
|---|---|---|
| `app/**/route.ts` | 456 | ✅ primary |
| `lib/**` | 313 | ✅ primary |
| `components/**/*.tsx` | 153 | ✅ components |
| `app/**/*Client.tsx` | 61 | ✅ components |
| **`app/**/page.tsx` (server pages)** | **119** | **3** |
| **`app/**/layout.tsx`** | **63** | **0** |
| **other `app/**/*.tsx`** | **58** | **0** |
| **`supabase/functions/*/index.ts`** | **38** | **0** |
| **`scripts/**`** | **93** | **0** |

⛔ **Not "untested" — unmeasured.** 23 test files import an edge-function `index.ts` and 24 import a `scripts/` module, so tests exist. What does not exist is any number saying how much of those 131 files is exercised, or any ratchet stopping it from falling. Only **5** test files import an `app/**/page.tsx`.

⚠ **Only 4 test files use `renderToString`** — against CLAUDE.md's own rule that the server-seeded-prop class (`initial={rows}` arriving `[]` with no provenance, 7 instances by 08-24) **must** be asserted by SSR, because a mount effect corrects the state before jsdom looks.

⚠ **The components gate's `include` is a curated list of 21 directories.** Today every `components/*` subdir happens to be listed, so it is not currently lying — but the repo's own standing rule is *prefer a tree walk over a curated list*, and this is the shape that fails on the day a 22nd directory lands, silently.

---

## ⚠ G. Three checks that are not in CI at all

- **`npm run lint` (eslint) never runs.** ci.yml says so in a comment: *"this repo does NOT run eslint in CI at all — do not cite it as coverage anywhere."* Honest, and still a gap.
- **`next build` never runs in CI.** Only `tsc --noEmit`. The BUILT BUNDLE is exercised for the first time on Vercel, after the push — and CLAUDE.md already records turbopack dropping a quasi from a `+`-joined template with every gate green.
- **No `npm audit` gate.** `npm ci` reports **29 vulnerabilities (2 low, 15 moderate, 12 high)** on every CI run and nothing reads it.

## ⛔ H. CORRECTION — the two "orphan" guards are deliberately unwired, and each says so in its own header

I reported `scripts/detect-duplicate-cron-pipelines.mjs` and `scripts/detect-jsx-space-drop.js` as "written, never run". Reading them first would have prevented that:

- `detect-duplicate-cron-pipelines.mjs`: *"Diagnostic one-shot … Does NOT mutate anything. Output-only. Trevor reviews the markdown table and decides what to disable in cron-job.org."* It is a tool, not a gate, and correctly has no caller.
- `detect-jsx-space-drop.js`: *"STATUS: USEFUL BUT NOT SOUND — it OVER-REPORTS. Do not treat its output as a defect list, and do not wire it into CI as a hard gate until the gap below is closed."* Spot-checking 5 of its 32 hits found 1 real and 4 false.

**A recorded decision not to wire something is not an orphan.** This is the file's own rule about re-deriving a filed finding, and I broke it by grepping for callers instead of reading the two files.

⭐ **What is worth keeping:** `detect-jsx-space-drop.js` targets a class CLAUDE.md says **nothing else here measures** — the build transform eating a space between JSX children, invisible to vitest because esbuild preserves what SWC drops. Six such defects shipped on public pages on 2026-07-27 with all 7,162 tests green. Its remaining gap is **diagnosed in its own header** (*"parse the emitted children sequence … rather than the flat set of string literals, and flag a text child only when its immediately-preceding sibling is an element call with no `\" \"` child between them"*) and nobody has taken it. That is a stated, bounded piece of work — not a wiring job — and it is the only route to a real gate on that class. ⛔ Not attempted here: it needs the reported-vs-real split re-measured against the live pages before anyone can tell whether the finished detector is sound.

## ✅ J. The fleet sentinel had no durable run record — FIXED this turn

`/api/sentinel` wrote **nothing** to `pipeline_runs`. Its status, its per-check verdicts and its alert-delivery outcomes existed only in the HTTP response body and a `console.log`. Its own sibling had the identical gap until deep-audit D7, whose fix comment states the rule:

> *"A monitor whose own run history is invisible cannot be checked for having run, which is the one thing you need from a monitor."*

The sentinel is the more important of the two and was missed. It now writes a `pipeline` = `sentinel` row carrying `status`, `checks_run`, the **breaching check NAMES** (a set, not a count — a count reads "no change" across a fix landing and a new arm firing the same day) and `notifications`, so a dead Telegram bot is now queryable rather than inferable.

⭐ **This is also the cheapest partial answer to finding A:** the sentinel's true invocation cadence is now visible to any observer with one query, instead of only to whoever opens a GitHub Actions run that mostly does not exist. Independent corroboration that the row was needed: `stale-fmv-monitor`, which already had one, shows **11 rows in 48 h against 96 scheduled**.

⛔ **Deliberately NOT paired with a `pipeline_cadence_watchlist` row.** The sentinel is the thing that reads that table, so an entry for itself is a guard that cannot fire exactly when it is needed — the tick that would notice the silence is the tick that did not happen.

## ✅ K. POST-SHIP VERIFICATION — and the new row found something on its first use

Verified against the outcome table, not the self-report. Deployment `dpl_8pPUjix…` READY with aliases attached and `lambdaRuntimeStats` present; sentinel dispatched at 18:42:06Z; run 1732 **succeeded on attempt 1** (step 18:42:13 → 18:44:57Z). Two `pipeline_runs` rows landed where there had never been one:

```
18:42:15  ok=t  161,776ms  0/0/0  status=WARN  checks_run=15
          notifications=["telegram","github-actions-native"]
          critical=[]  warn=["Sales Ingest (2h)","FMV Confidence (canonical TS)",
                             "Edition Coverage","Pipeline Silence","Trust Health","Sniper Feed"]
18:45:52  ok=t  134,211ms  0/0/0  status=WARN  checks_run=15   (same shape)
```

🚨 **THE EMAIL CHANNEL DID NOT RUN.** `notifications` carries `telegram` and neither `email` nor `email-FAILED`. Those two are pushed from inside `if (RESEND_API_KEY && ALERT_EMAIL)`, so the absence of BOTH means the branch never executed — **one of those two env vars is unset in production**, and the same two consts gate `sendEmail` in `lib/ops-alert.ts`, so `stale-fmv-monitor` and `data-integrity` are almost certainly in the same state.

⭐ **This is the whole argument for the row, demonstrated on its first use.** The delivery outcome was always computed; it just went to a response body nobody stored. It is now one query. ⛔ **NOT established: which of the two vars is missing, or why.** Reading them is a secret-safety hazard and is Trevor's call — the observable is only that the guarded branch did not execute. ⚠ **Consequence worth stating plainly: every ops alert on this platform currently rests on a single Telegram bot token, with no second channel and nothing watching the first.**

⚠ **Second thing the rows show, and it is a real risk from my own change.** The sentinel takes **134–162 s against its own `maxDuration = 180`** — 75–90% of budget, and its header already records 504s under disk-IO saturation. Before today a 504 exited 0; now it reds after 3 attempts. That is the correct semantics, but it means **this badge will start going red on slow days, not only broken ones**, and the first such red will look like a regression from this change. It is not — it is the state that was previously hidden. 👉 The right response is to cut the route's cost (15 checks, several of them heavy reads) rather than to widen the timeout, and ⛔ **not** to revert the guard. **Falsifier:** if reds appear on runs whose `pipeline_runs` row shows `ok=true` with a normal `status`, the retry/timeout budget is wrong rather than the route being slow.

---

## 🚨 L. WALL-CLOCK-DEPENDENT TESTS — a class the suite cannot currently see, found TWICE today by two authors

Two independent instances surfaced on 2026-08-29: `analytics-rpc-with-retry`'s budget-crumb block (another session), and the sentinel durability block **that I added during this audit** — which reddened CI 4197 at 19:05Z **on someone else's commit**. Same root: *a test that reads real time and asserts an exact outcome.*

The sentinel case is the instructive one because of how it passed review:

- The route notifies only when `hasCritical || hasWarn || (UTC hour % 6 === 0)`, so green-fixture notification assertions hold in **4 hours of 24**.
- It was written and mutation-checked at **18:xx UTC** — one of those four. **All four mutation controls passed.**
- ⭐ **A MUTATION CONTROL INHERITS EVERY HIDDEN DEPENDENCE OF THE TEST IT VALIDATES.** Proving a test reds when the code is broken says nothing about whether it is green for the *right reason*. When an assertion could depend on ambient state — clock, timezone, network, row counts, physical row order — the control has to vary **that**, not only the code under test. This is the ambient-state sibling of the rule this repo already records for a vacuous assertion, and it is the reusable part.

**What exists now:** `d1a221a76` pins the clock for the notifying case; on top of it a `atUtcHour()` counterpart, an off-hour row test, and a **24-hour sweep** asserting the row is unconditional and notification is non-empty **iff** `hour % 6 === 0`. That is the per-test fix.

⛔ **There is still no SUITE-LEVEL detector for the class, and a grep cannot be one.** `new Date()` / `Date.now()` appear in hundreds of legitimate fixtures here (freshness fixtures are built from real `now` on purpose), so a source scan over-reports the way `detect-jsx-space-drop.js` already does — and this file's own rule is to prefer a check that does not need a fragile matcher to be right.

👉 **The sound version is to vary the ambient state, not to grep for it: a scheduled CI job that runs the unit suite with the runner's clock moved.** GHA ubuntu runners have passwordless sudo, so `sudo date -s` at a few UTC hours (say 01, 07, 13, 19 — one from each `% 6` residue class) turns "green for the right reason" into something measurable. ⚠ **Note TZ alone will NOT catch this instance:** the predicate is `getUTCHours()`, which `TZ` does not move — so a timezone matrix would have read clean through both of today's defects. ⛔ **Not shipped: `sudo date -s` on a GHA runner is unverified from this sandbox, and a clock-shifting job that fails for its own reasons is a new permanently-red instrument, which is the thing this audit is about.** Cost is one extra suite run per shifted hour (~7 min each).

⚠ **And a caution about the fix I nearly shipped:** my first correction switched two tests to a CRITICAL fixture, which passes at every hour **by testing a different thing** — it drops coverage of the scheduled GREEN report, the one path where nobody is already looking at a page. `d1a221a76`'s comment says exactly that and it is right. *Passing at every hour is not the goal; asserting the same contract at every hour is.*

---

---

## ⚠ I. Naming what CI structurally is here

All 4,182 `ci.yml` runs are `event: "push"` — the repo pushes straight to `main` by policy. **CI is a detector, not a gate:** when it reds, `main` is already broken and Vercel is already deploying it. That is a deliberate trade, not a defect; it just means every finding above about post-merge detection is load-bearing in a way it would not be behind a PR gate.

---

## ✅ What is genuinely strong (so nobody re-audits it)

- **1,392 vitest files / 15,292 tests** across three ratcheted gates (primary 91.8/79.4/93.6/93.85 · components 90.85/81.95/89.3/93.75 · workers 88.15/76.15/89.6/91.1).
- **181 SQL invariant files** run against a throwaway Postgres provisioned from the runner's own binaries, `ON_ERROR_STOP=1`, aggregated exit code.
- **189 live DB pins** compared against `pg_proc` daily — **verified actually running today**, not inferred from the badge: `checked 189 pins — 189 clean, 0 needing attention`.
- `migration-parity` 3×/day (the 14-hour blind window was already closed on 08-24), `cadence-lint`, `cadence-escrow-tests`, `tree-corruption`, `edge-deno`, the ledger clobber/future-date guards.
- The six source guards in `typecheck` now carry `if: ${{ !cancelled() }}`, so a tsc error no longer switches all six off — the 08-28 fix holds.
- **CI on `main` is green:** 27 of the last 30 runs. The three reds (08-29T04:14–04:22Z) were fixed by 04:25Z.

---

## Ranked next actions

1. **A** — get the sentinel and the FMV-staleness monitor off GitHub's scheduler. This is the only finding where the platform is actively dropping the alarm.
2. **B** — make the three monitors able to fail: `stale` and `issue_count > 0` should `exit 1`.
3. **C** — fix the tier-2 body read (the Management API now serves eszip), then reconcile 19 against the pinned baseline of 31 before believing either number.
4. **D** — one webhook, anywhere, so a red badge reaches a human who is not reading Actions.
5. **F** — put `app/**/page.tsx`, `supabase/functions/*/index.ts` and `scripts/**` into a gate, even at a low seeded threshold, so the number exists and can only go up.
6. **G/H** — wire `next build` into CI; delete or wire the two orphan guards.

⚠ **Every count above is a dated sample.** The per-day run counts especially: re-derive before quoting, and split on any change to the schedule set.
