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

## 🚨 D. There is no notification channel. At all.

Grepped all 20 workflows for `slack|webhook|notify|resend|discord|pagerduty|issue.*create`: **zero hits.** The entire alerting surface is (a) GitHub's default email to the actor on a failed scheduled run and (b) a red badge someone chooses to look at.

**That channel is null under finding A** — a tick that never fires sends no email. So the two failures are multiplicative, not additive.

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

## ⚠ H. Two guards exist with no caller

`scripts/detect-duplicate-cron-pipelines.mjs` and `scripts/detect-jsx-space-drop.js` are referenced by no workflow, no npm script and no test. Written, never run.

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
