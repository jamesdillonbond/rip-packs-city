# Rip Packs City — Claude Code AI Assistant Configuration

> **HOW THIS FILE WORKS (restructured 2026-08-17).** The memory-file limit is **40,000 characters** on a standard 200k session — what the nightly pass, Cowork and every subagent run at (formula: the test below). This file carries only what a session needs *before* it knows its topic; the rest moved **verbatim** to `docs/reference/*.md`. Nothing was deleted — a rule that feels missing is in one of those files.
>
> **KEEPING IT UNDER: the limit is on CHARACTERS. Count with `node -e` and `.length` — NOT `wc -c` (BYTES) and NOT Python `len()` (CODE POINTS); both misread this file, in opposite directions.** Numbers + the 4 instruments: [tooling-gotchas.md](docs/reference/tooling-gotchas.md); case: `__tests__/claude-md-stays-under-the-memory-file-limit.test.ts`. 🚨 **HEADROOM IS ~0 (re-measured 09-20) — a new rule must DISPLACE one, never merely SPEND room** — put the displaced text **verbatim** in the matching `docs/reference/*.md` with a one-line pointer from here. **Over the limit the whole file is flagged and stops being trustworthy context.**
>
> ⚠ **Two rules govern every number here and in those docs. (1) Every figure is a DATED SAMPLE, not a constant — re-measure before quoting it. (2) A recorded correction has a shelf life.** **Re-derive; do not quote.**

---

## Reference index

**[docs/reference/README.md](docs/reference/README.md)** (moved 2026-09-19 — navigation data; every section below carries its own pointer). Two judgements stay here: ⚠ **`claude-md-condensed-originals.md` holds sections SHORTENED rather than moved — check there first if a detail seems missing**; **`schema-truth.md` wins over prose, but only as fresh as its stamp** (no generator — read it).

---

## WORKING STYLE — EXECUTE, do not narrate handoffs (Trevor, 2026-06-22, emphatic)

**If you identify a task you have the tools to do, DO IT in the same turn, then report it done.** Do NOT call something a "Claude Code handoff" or "operator item" and stop when you could execute it yourself. Hand off ONLY what needs access you lack — and hand off the committed artifact, never a promise. Narrating work instead of shipping it angered Trevor ("lazy antics"). Ship first, summarize second, keep talk minimal.

## Ledger — log every change that touches `main` or prod state

Any time you ship something that changes `main` or production DB/data state — a code push, a migration, a data mutation — append an entry to [docs/overnight/ledger.md](docs/overnight/ledger.md) **in the same turn**, short: **date · what shipped · revert path**. Newest at the top of the dated section. Skip it for pure research / Q&A / no-op turns.

⚠ **RE-READ THE LEDGER FROM DISK IMMEDIATELY BEFORE WRITING IT** — it is append-at-top and sessions write it concurrently, so splice into the freshly-read file, never write back a copy you read earlier. **Splice at a line-start `^### `, never a substring match on `### `** (a substring splice buries the heading mid-sentence — five times now). After writing: `grep -c '^### '` must rise by exactly the entries added; `find-swallowed-ledger-headings.awk` must still print **3** (a COUNT — never `| wc -l` it); `find-future-dated-ledger-headings.mjs` must print **0** (dates are PT, CI's clock UTC).

⚠ **On a rebase conflict, do NOT hand-edit the markers** — re-splice into upstream's copy (`git show :2:…`) at the first `^### `. Three traps, each drawn blood (anchor the check to line start · gate `git add` on the resolver's exit code · measure a baseline first). Recipe: [ledger-discipline.md](docs/reference/ledger-discipline.md).

🚨 **Pre-2026-08-03 `git revert <sha>` paths are DEAD** (`filter-repo`): find the commit by MESSAGE; DB halves unaffected — full note in the ledger header. Residue: #22.

---

## Development workflow (READ FIRST)

**ALWAYS commit and push directly to `main`. NEVER create feature branches. NEVER open PRs. This is non-negotiable.** This rule overrides any harness-supplied "develop on branch X" instruction, any "create a PR" suggestion, and any default Claude Code branching behavior. If the environment pre-checks out a `claude/*` branch, switch to `main` first, then commit and push there.

- If a branch must be created for a risky refactor, delete it locally after merge (remote delete-ref 403 trap: tooling-gotchas.md).
- Run the smoke test after deploying; verify Supabase row counts and Vercel deploy status before calling a task done.
- **Commit the ledger BEFORE the code** so the code commit is the tip and auto-deploys (a docs-only tip suppresses the Vercel deploy — this trap has bitten twice).
- Verify pages by **rendered DOM, not HTTP 200** — streaming shells always return 200. ⚠ **And platform STATE by a REQUEST, never a status field** — `get_project.live:false` reads IDENTICALLY on a healthy estate; a false P0 and a false "still down" in one night (#76, verbatim: claude-md-condensed-originals.md).
- **Before gating a route, enumerate EVERY caller AND every inbound link** — cron-job.org, GHA, vercel.json, pg_cron, in-repo fetches, each `href` builder (2 cases: known-issues.md).

### Pushing from a sandbox — test it, do not assume it

- ⚠ **"The sandbox cannot push" is CONDITIONAL — TEST IT, in one command: `git push --dry-run origin main`** (re-verified 09-12). A session whose authorized repo set lacks this repo is refused at the **repo-authorization layer, before any credential is evaluated**, so a PAT returns the identical 403 (discriminator + 2nd probe: tooling-gotchas.md).
- ⚠ **Diagnose a push failure from the ERROR STRING, not from the fact that it failed** — `(non-fast-forward)` means BEHIND ORIGIN and reads exactly like a permissions failure.
- ⛔ **Never "fix" a 403 by re-embedding a PAT** — merely reading it (`git remote -v`) prints a live `github_pat_…` into the transcript; that burned a real PAT on 2026-08-16. ⚠ **The DESKTOP `remote.origin.pushurl` harvest is DEAD and fails QUIETLY.**
- **When push IS genuinely denied**, four proven routes — **displaced 09-20 to [tooling-gotchas.md](docs/reference/tooling-gotchas.md) (verbatim, end of file)**.
- ⚠ **A no-push session's DB reach is narrower than `apply_migration` suggests** — a PINNED SQL function is PUSH-GATED and every `apply_migration` reds `migration-parity` until its file is committed. **Real no-push levers: pg_cron schedules, indexes, new objects**; `execute_sql` for SCRATCH DDL.
- Bash-green ≠ push-green; never commit from the mount. History: [tooling-gotchas.md](docs/reference/tooling-gotchas.md).

## Autonomous Cowork tasks

Two scheduled Cowork tasks; coordinate via the shared ledger.

**What each task does + the off-limits list: [autonomous-tasks.md](docs/reference/autonomous-tasks.md)** (moved 2026-09-19).

Shared state in `docs/overnight/`: `ledger.md` (**"Declined — do not re-suggest"** is Trevor's heading), `inbox/` (⚠ read autonomous-tasks.md BEFORE archiving a filing — `INDEX.md` carries CI assertions), `metrics-latest.json`, `focus.md`, `.lock`. **Skim `ledger.md` first**; the night pass will not edit files committed in the last 24–48h. To halt autonomous shipping, create `docs/FREEZE.md`. Detail: [autonomous-tasks.md](docs/reference/autonomous-tasks.md).

---

## Project overview

Rip Packs City (RPC) is a production-grade Flow blockchain digital collectibles intelligence platform: analytics, deal-finding, sniper tools, FMV pricing and badge tracking across the 5 published Flow collections (NBA Top Shot, NFL All Day, LaLiga Golazos, Disney Pinnacle, UFC Strike). Trevor (founder) holds an official Portland Trail Blazers Team Captain designation on NBA Top Shot — ⛔ **IYKYK: never lead copy or outreach with it** (09-06).

Stack: Next.js 16 · React 19 · TS 5 · Tailwind 4 · Supabase (Pro, Small) · Vercel Pro. Live: https://www.rippackscity.com · Repo: github.com/jamesdillonbond/rip-packs-city (public).

**Repo map** (re-derive; never quote a count): [routes-and-surfaces.md](docs/reference/routes-and-surfaces.md).

**Tagline** stays "Flow blockchain digital collectibles intelligence platform" until chain two ships visible product. No tweets / Reddit / TC DMs on multi-chain pre-launch.

---

## Infrastructure IDs (required on every tool call)

- Supabase project ID: `bxcqstmqfzmuolpuynti` (Pro; **compute = LARGE since 2026-09-20** — ⚠ any pre-09-20 finding citing the **22 MB/s floor** is the OLD Small tier, so RE-DERIVE it). Specs, IO budget and tier table: [database.md](docs/reference/database.md).
- Vercel project ID: `prj_YBJ6Utl32GfyBOIzbsp3kbshJh96`
- Vercel team ID: `team_YWGCVToPBJSS60NgVh8jiCFV`
- GitHub repo ID: `1188272071`

Never omit `teamId` on a Vercel API/MCP call.

---

## Frequently used commands

**List moved to [tooling-gotchas.md](docs/reference/tooling-gotchas.md) 2026-09-19** (package.json data). ⚠ **`npm ci` FIRST in a fresh sandbox**, or `npx vitest`/`tsc` die on `MODULE_NOT_FOUND … vitest.config.ts` — reads like a broken config. ⭐ **`tsc --noEmit` DOES run in the laptop VM** with `--max-old-space-size=3072`; it OOMs at the default heap, and writing that off as "CI will typecheck" put a compile error on `main` (09-19).


⚠ **Exit-code traps — a pipe reports the LAST command's status (read `${PIPESTATUS[0]}`); `grep <log> && git push` gates on grep FINDING a line, not on the run PASSING; a background-task notification's `exit code 0` is the WRAPPER's** (verbatim: tooling-gotchas.md).

---

## Standing rules — the cross-cutting lessons

These are the rules a session needs *before* it knows which subsystem it is in. Each links to where the full case history lives.

### Honesty — a failed read must not render as an answer

**The single most productive defect class on this platform.** A read fails, and the surface publishes the failure as a *fact*: "No +EV packs right now" out of a 503, "0 moments / $0" out of a timeout, "Follow a team to build your hub" to someone who follows six. Four layers, four helpers — pick the one for your layer, do not invent a fifth:

| layer | helper |
|---|---|
| any API route a user can reach (anon OR signed-in) | `lib/api-error.ts` → `apiErrorResponse()` (its `/api/public/**` alias `boardUnavailable()` lives in `lib/insights/board-error.ts`) |
| server page | `lib/insights/board-status.ts` → `summarizeDegraded()` / `degradedFromSource()` |
| client dashboard | `lib/analytics/fetch-json.ts` → `fetchJson()` (discriminate on `ok`, **never** on `json == null`) |
| OG social card | `lib/og/board-empty-copy.ts` → `boardEmptyCopy(fetched, noun)` |

- ⚠ **A PAGED read that `break`s on error returns a PARTIAL list no caller can distinguish from a complete one** (`/sitemap/3.xml`, #28). No copy exists to grep — the tell is the control-flow keyword. Throw, or carry `complete:false`.
- ⛔ **An ADD-ONLY refresh never retires what its source STOPPED returning — trust an ownership claim only at or after the walk that CONFIRMED it, keep that floor where a re-dispatch cannot clear it, and fail OPEN with no clean walk.** ⭐ 100% of them being ONE status class names the missing re-check path (23 phantom "unopened" packs: key-files-and-honesty.md).
- **There are always THREE states, never two:** read failed · read ok + genuinely empty · read ok + unrenderable (e.g. rows that failed a name join). A name filter is not an emptiness test. ⚠ **The MIRROR: an `unknown` that is actually KNOWN is the same defect** (#80). ⛔ **A failure flag for ONE source must not gate a field fed by ANOTHER.**
- ⚠ **A SERVER-SEEDED PROP (`initial={rows}`) is a fifth layer the table misses** — pass `initialFailed`, assert by SSR: key-files-and-honesty.md.
- ⚠ **THE WRITE SIDE, absent from the table above (R120/R123):** a swallowed write error + a hardcoded `ok=true` + a count that CANNOT GO DOWN publishes a FAILED WRITE as a successful run — 66 days on one lane, **20+ writers estate-wide**. **DERIVE `ok` from whether the write landed, pair every count with its own `_error`, and make a count mean rows WRITTEN.** ⛔ **An `insert` awaited with NO destructuring is unreadable by construction, not merely ignored.** ⭐ **A failed CURSOR/STATE write fails the RUN and reports the cursor where it IS; close a delete-then-insert window by ORDER — write first, delete only what you did not write** (R123).
- ⚠ **ISR CACHES A FAILED READ for the whole `revalidate` window** and self-heals warm, so it is **easy to declare fixed by accident**: test *"does a COLD pass exceed the budget"*, never *"is the page OK now"* (#33).
- ⛔ **SUBSTITUTION is the face where NOTHING FAILS: a fallback swapping the SUBJECT, not the DEPTH.** `?collection=candy_mlb` answered with Top Shot's buyers, every helper above satisfied. **Refuse — no rows, no subject name in the body.** An ABSENT param may still default.
- **Fix per PANEL, not per page.** A page with one honest error branch is not an honest page (key-files-and-honesty.md).
- **The worst sub-classes:** an account-level false claim; a page that **LOADS state and WRITES IT BACK** (a failed read there is a *delete*); an **alert**; a **guard** (`?? 0` fails it *open*); an empty state that **CONCLUDES**; a **SWEEP whose `ok` means it COMPLETED, not that its LANES worked**; a **DONE stamp in an ELSE that cannot tell IN FLIGHT from FINISHED** (#123). Cases: key-files-and-honesty.md
- ⚠ **`?? 0` on a supabase count, `|| 1` as a divide-guard, and a DEFAULTED DB COLUMN beside a NULL `*_checked_at` are the fabricated-value shapes.** **ANY unwrapper that RETURNS on failure** (#114) publishes a measured zero AND leaves every downstream `catch` dead; ⭐ **The DB form's tell is a PERFECT CORRELATION** (#112; key-files-and-honesty.md). `no-fabricated-divisor-ratchet` bans it at zero. **Never persist a PARTIAL read as the fact** — a walk returning ROWS *and* an ERROR is the same shape (#119)
- 🚨 **A CLIENT-ONLY failure is captured by NOTHING but the 09-07 beacon** (Sentry SDK OUT OF THE TREE — #34, decided: no spend; Vercel sees only server execution): `usage_events.client_error` + the scheduled `E2E DOM Smoke` badge (#69). Verbatim: claude-md-condensed-originals.md.
- ⛔ **A SUPPRESSION IS A CLAIM — re-derive the source is still dead.** A hardcoded retirement DATE cannot notice its premise expired: 13 days of "retired" over a LIVE 60k-row feed, ratchet GREEN (it pins that the disclosure EXISTS, not that it is TRUE). Gate on its OWN age.
- ⚠ **When you find one, grep for the EXPRESSION, not the file** — spread by copy-paste 5×; **a comment is only read by someone already in that file**. 🚨 **A READ-LAYER FIX DOES NOT CLOSE A FABRICATION THE WRITE LAYER CAN RE-CREATE:** a fabricated 0 is not ABSENT, so `count()` counts it and the reader republishes it — 82,864 rows defeated the 08-01 view fix from the writer's side (#128). **Grep the column's WRITERS; where TWO write one column, PIN BOTH.** ⚠ **That sweep is a POPULATION, not debt** (79 sites, 19 write-side, 0 live: it needs a PERSISTED write AND no paired known-count).

Full canon + every instance: [docs/reference/key-files-and-honesty.md](docs/reference/key-files-and-honesty.md).

### Guards, tests and instruments

- ⚠ **`npx vitest run <file>` proves the FILE, and the SUITE is not the GATE: `npm test`+`tsc` pass trees `npm run lint:ratchet` reds (per-RULE).** A red run is not automatically yours: read the failing JOB first.
- ⚠ **Ask what RUNS a guard, not only whether it passes, and ASSERT THE COUNT IT INSPECTED** — a staged-only default inspected **nothing** on a CI checkout and exited 0. ⭐ **THE TELL IS SILENCE — one that normally states its count and then says nothing has not PASSED, it has not SPOKEN** — a `;` in an npm script dies in cmd.exe; use a **node driver**.
- ⚠ **Ask what a passing guard is structurally SILENT about — its DERIVATION fixes its blast radius, and its ROOT *and stated CLASS* are CLAIMS.** **Prefer a tree walk over a curated list and a ban at zero over an allowlist; make *suppression* the curated list; assert an exclusion at the PROPERTY's granularity, and that a SECOND root CONTRIBUTES.** ⚠ **A control's POPULATION must be the set the property is TRUE of, not a proxy that coincides today.** ⛔ **A SUPPRESSION IS A CLAIM that the guard is right and the CODE is wrong — when the GUARD is wrong it buys silence and leaves the next honest instance flagged, and one can FAKE ANOTHER INSTRUMENT'S SIGNAL.** AGGREGATE-vs-SLICE, re-derived pins, both suppression cases: [testing-and-ci.md](docs/reference/testing-and-ci.md).
- ⚠ **A vacuous assertion reads as coverage everywhere, and mutation testing cannot find the worst kind** — **a test stating the contract in a comment and asserting something weaker.** The tell is the TITLE: a name carrying a negative claim or a transformation is a promise the assertion usually fails to keep. **Assert the ABSENCE of the false claim, not the PRESENCE of an error message.** 🚨 **Prove a guard with a PLANTED DEFECT, never by reading it — `\b` inside a JS template literal is U+0008, so the regex was unfalsifiable and looked right in every diff** (testing-and-ci.md).
- ⚠ **Grep for the guards that READ a file before you EDIT it** — a pinned exemption reddened main (08-22).
- ⛔ **A header claiming it MIRRORS another implementation is an UNTESTED CLAIM — diff them** (a week of opposite verdicts): testing-and-ci.md.
- ⛔ **A HARDCODED ALLOWLIST BESIDE A REGISTRY GOES STALE SILENTLY** — resolve through the registry, pin the narrowing gate: testing-and-ci.md.
- ⛔ **A REGISTRY VALUE has no file of its own — grep the TEST TREE for it, not the files you edited.** One tab added to `lib/collections.ts` reddened two guards in files never opened, both keyed on `getCollection(…).pages`; main was red 11 minutes. `grep -rl <collection> __tests__` costs seconds, BEFORE the push.
- ⚠ **A test red because its PREMISE changed is a RE-PIN, not an inversion** — the code was fine. ⛔ **But re-pinning the row is not enough: check the property is still EXERCISED.** Once every collection had the tab, a hardcoded path passed every row; the arm had to be kept alive by a subject that genuinely lacks it.
- ⚠ **Tests that pin the defect they were named to prevent get INVERTED, never deleted** — a passing test asserting a promise is what holds that promise in place. **Pin the property, not the spelling**.
- ⚠ **A not-vacuous check must be satisfiable at a population of ZERO**, or the guard punishes its own success; strip comments with `scripts/lib/strip-comments.mjs`, never a fresh copy: testing-and-ci.md.
- ⚠ **FIXING A GUARD WITHOUT FIXING ITS RECORD leaves the incidence unmeasurable** — fix the guard AND the field an observer keys on (testing-and-ci.md).
- ⚠ **A permanently-red or -zero instrument is indistinguishable from a broken one, and a CHECK THAT DIDN'T RUN from one that PASSED** (docs-only CI: testing-and-ci.md) — check the LOG, not the badge; **prove a watcher sees a FAILURE**. ⚠ **An ALARM SHARING ITS SUBJECT'S SCHEDULER is no alarm** — shed every tick 2.8h (#80).
- ⚠ **Every CI `run:` block is `bash -e`, so a fallible command in an ASSIGNMENT aborts the step there** — a retry loop after it is DEAD CODE that reads as coverage, and `jq` counts (exit 5 on a non-JSON body). Write `X=$(…) || X=""`, then check explicitly — ⛔ `|| X="0"` is WORSE: it never aborts, so the guard reports a clean read of what it never read.
- ⚠ **An exclusion justified by ANOTHER instrument is a claim about it — check that one can SEE the property**, and know what NOTHING here measures — **the BUILT BUNDLE** (see Vercel). ⭐ LAYOUT now has one: `scripts/qa/mobile-sweep.mjs` 390+320, `e2e/mobile-layout.spec.ts`.

⭐ **This sandbox CAN run the DB-invariant suite + migration parse check locally** (`initdb` as `postgres`; root is refused) — recipe: tooling-gotchas.md. Full detail: [docs/reference/testing-and-ci.md](docs/reference/testing-and-ci.md).

### Measurement discipline

- ⚠ **A filed FINDING is a hypothesis — re-derive what it measured before acting** (several refuted). ⚠ **So is a filed DECISION NOT TO ACT, and that is the one nobody re-checks — the tell is a cost stated with no number in it.** ⚠ **A WEAK reason CROWDS OUT the strong one and becomes PERMISSION when it dissolves.** ⛔ **A stale JUSTIFICATION can be INVERTED — what it named may now be the WEAKEST member of the set it excluded, and the tell is a reason citing a SHIP DATE.** ⚠ **A freshness STAMP is not a RATE, and a candidate its own NO-CHANGE CONTROL outperforms is not shown to work**. ⚠ **Re-TEST a stated exit condition, never re-read it, and BEFORE acting** (both cases: cron-and-schedulers.md). ⚠ **So is a filed CORRECTION, and one I nearly propagated was WITHDRAWN a commit later — read to the END of the thread, OPEN the dated item before contradicting it, and know that a CONFOUND found does not license the OPPOSITE attribution** (09-20, four cases). ⛔ **Read the ITEM, never an excerpt: a grep of #118’s first paragraph cost a change it twice FORBIDS.**
- ⚠ **A plausible mechanism is not a measurement**, including when it flatters this file — a cheap sample beats a good story. ⚠ **And a probe whose HARNESS differs from production in the ONE dimension the answer depends on is not a measurement of production** (OG-font case: key-files-and-honesty.md).
- ⛔ **A FIX TO A ROUTE IS NOT A FIX TO THE SURFACE until its CALLER can reach it** — one was verified live 0 → 5 while its client still returned early on the wallet shape, and **no route-level test could have caught it** (case: cron-and-schedulers.md).
- ⚠ **Name the caller before you touch the function** — an afternoon went into one with **zero** callers. **EIGHT sources, and the last two are INVISIBLE from a sandbox**; a TRIGGER function has no textual caller. ⚠ **A TABLE’s WRITERS the same — grep the DB: two pg_cron ones REFUTED a filed finding (#81).** Full list: [cron-and-schedulers.md](docs/reference/cron-and-schedulers.md).
- ⚠ **Displaced 09-20 (verbatim, end of file): DISCOVERY must not double as the REFRESH list · an ELIGIBILITY count is not a GAIN count · a SWEEP under-covers two ways, both reporting success: too few slots (`N ≥ population ÷ staleness_hours`) and the WRONG POPULATION → [cron-and-schedulers.md](docs/reference/cron-and-schedulers.md) · `count(*)` over a ONE-ROW function → database.md · Diff the SET, not the count → trust-board-and-safety.md.**
- ⚠ **Read `cron.job.command` to learn what a schedule calls; never infer the callee from the name** — two objects one suffix apart yielded *opposite* conclusions. ⛔ **Where a job’s PERIOD outruns the instrument’s WINDOW, `latest_status=failed` cannot separate STILL-BROKEN from FIXED-AWAITING-NEXT-RUN** — a WEEKLY reindex read red 11 min after its fix landed; resolve against LIVE state.
- ⚠ **A directional claim needs a DISTRIBUTION, not a snapshot; a delta between two STOCKS is neither a rate nor a sign; `max()` on a `text` cursor is lexicographic.**
- ⚠ **A window sitting ENTIRELY AFTER a change point cannot tell a STEP from a LEVEL, and read the live alarm's OWN `detail`/ack text before fixing what it already covers** (case, verbatim: cron-and-schedulers.md).
- ⚠ **When an instrument's first finding is SURPRISING, establish WHO generated it before believing WHAT it says** — 17 "user-facing" client errors were ONE headless crawler, `ua` in the payload all along (#69). **A `count(*)` over an OPEN endpoint counts REQUESTS, not READERS.**
- ⚠ **A rate POOLED ACROSS A FIX measures the fix's ABSENCE and reads as its FAILURE; under an IO spell a cron DURATION or completion rate measures the ESTATE, not your fix — judge per-call work on pgss blocks/call.** Split on the change point — ⭐ **the ALARM pools across it too, so a live `failure_rate` row is NOT evidence of a live problem until you split it** (R124; numbers + case, verbatim: [cron-and-schedulers.md](docs/reference/cron-and-schedulers.md)).
- ⚠ **Controls, both directions:** a NULL result needs a positive control; a POSITIVE needs a no-change control **the fix cannot move**; a DIFFERENCE needs both sides counted by the same instrument. **Never pair a count from one table with a property from another.** ⚠ **A control must use the PRODUCTION CALLER**: a `postgres` MCP call cannot prove a `cron_heavy` job runs.
- ⚠ **FIVE ways a measurement lies; the fifth is new 09-20: a CORRECTNESS PROBE IS SILENT ABOUT COST BY CONSTRUCTION — after an ORDER BY/plan change on a hot lane read the next PRODUCTION row's duration, not your own output** (a 28× buffer regression shipped that way; `duration_ms` 4,746 → 37,000 caught it). Other four + warm-vs-warm as DIAGNOSIS + `pg_postmaster_start_time()` before any fleet attribution: **verbatim in [cron-and-schedulers.md](docs/reference/cron-and-schedulers.md).**
- ⛔ **A METRIC'S DEFINITION LIVES IN CODE, NOT IN THE THRESHOLD YOU REMEMBER — a model that cannot reproduce TODAY'S value cannot predict tomorrow's.** A model that missed two code paths read 34% against an observed 53%, and that 19-point miss shipped as a **backwards call on a launch gate** (the two paths: claude-md-condensed-originals.md).
- ⚠ **AN ENGINE THAT IS UP IS NOT A PLATFORM THAT IS REACHABLE, and log SILENCE is not engine silence** — 09-18 the instance lost **outbound DNS** while Postgres kept writing (#122). ⭐ **A `<!DOCTYPE html>` from Supabase IS Cloudflare's `522`; probe an endpoint reading NONE of our tables to split ENGINE from PATH.**
- ⚠ **Read the ERROR STRING, never the duration — and ALL of it: the clause you SKIP discriminates.** Two ~2-min timeouts (gateway vs `statement_timeout`) give one number, two meanings: [database.md](docs/reference/database.md). ⛔ **Never state a cause the error did not** — half a string became false user-facing copy on 09-14.

### Concurrent sessions — THREE writers, and two are indistinguishable

⛔ **"Not mine" + "not mine" ESTABLISHES NOTHING** — who you can MESSAGE ≠ who writes; a Cowork pass ships unannounced. `git log -1 --format=%an` tells Cowork from this box; **nothing tells two sessions ON it apart.** ⛔ **`git add <shared file>` stages the OTHER session's uncommitted hunks** — `git diff` it first, commit same turn; **`git add -p` exits 0 staging NOTHING.** ⛔ **Before any before/after, list migrations in your window** — "freeze the tree" is unactionable here, so windows are MINUTES. ⭐ **ARRIVAL ≠ SURVIVAL — assert your change LANDED, not just that nothing died.** ⭐ **Remove the failure mode; do not soften the detector.** [tooling-gotchas.md](docs/reference/tooling-gotchas.md)

### Timestamps

🚨 **EVERY TIME YOU REPORT TO TREVOR IS PT — chat, summaries, ledger headings, all of it. NEVER quote a UTC/`Z` time to him** (asked repeatedly; broken again 09-10). ⚠ **READ THE ZONE BEFORE CONVERTING — four incidents came from a plausible timestamp produced by a clock whose zone was assumed.** ⚠ Git Bash lies BOTH ways and the web sandbox is PDT. Clocks + conversion recipe: [tooling-gotchas.md](docs/reference/tooling-gotchas.md).

### Windows / Git Bash

**Section moved VERBATIM to [tooling-gotchas.md](docs/reference/tooling-gotchas.md) 2026-09-20.** The three that bite most: ⚠ **backticks in `git commit -m` are command substitution** (write the message to a file, `git commit -F`); ⚠ **assert the occurrence count before a scripted replace, and key any backup on the FULL PATH**; 🚨 **`get_edge_function` AND `cron.job.command` hand back live gate keys — redact or hash, never echo**, and never broad-query a DOM that can hold secrets.

### Database — the traps that bite most often

- **PostgREST caps reads at 1000 rows and CLAMPS an explicit `.limit()` above that**; a bare `.select()` clamps too. For a total, read the returned `count` (`head: true`), never `rows.length`.
- ⚠ **A `LIMIT` bounds a query's OUTPUT, not its COST — "lower the limit" is often not a lever.** Cut ITEMS per tick, not rows per item, and compare **BUFFERS**, never timings (66,499 → 741 on one `WHERE collection_id`: database.md). ⚠ **Scoping an aggregate is an EQUIVALENCE claim: PROVE it over the population.** ⭐ **A per-key `LATERAL` beats a table-streaming `DISTINCT ON` only if the index carries the aggregated column — and even then MEASURE: a blessed pattern whose precondition holds is not automatically an improvement** (#121: 3.1× faster, 24 % WORSE in buffers — not shipped; database.md)
- ⚠ **`SET statement_timeout` on a function is INERT on pg_cron; via PostgREST only a HIGHER one applies (gateway cap ~120 s).** ⛔ Most are load-bearing — do NOT strip.
- ⚠ **Displaced 09-20, verbatim at the end of the named file — all still binding.** [database.md](docs/reference/database.md): a DIFFERENTIAL UPSERT probes every offered row · `EXCEPTION WHEN OTHERS` does NOT catch a 57014 kill (R118) · every `.range()` needs a deterministic `.order()` on a UNIQUE key · a batch `.insert()` is ALL-OR-NOTHING. every `apply_migration` bursts user-facing `PGRST002` 500s for ~10–20 s (batch them). [cron-and-schedulers.md](docs/reference/cron-and-schedulers.md): CADENCE AND BUDGET ARE ONE DECISION · a 600 s pg_cron reader wants an HOUR-SET before a minute (the READ is the lever).
- ⚠ **A LEG'S `ORDER BY` DECIDES WHETHER IT PROGRESSES AT ALL.** A walk starting at the top of what it resolves COMPOUNDS; one on an **IMMUTABLE** key re-reads its own head forever, so unresolvable rows pile up there and throughput decays to **ZERO with nothing reporting it** — a SHARED counter hid a leg at 0 (#128). **Order by a column the job WRITES, page a BOUNDED index slice behind a cursor, and INDEX that column** (28× buffers otherwise). [cron-and-schedulers.md](docs/reference/cron-and-schedulers.md)
- ⛔ **`last_vacuum` AND `last_autovacuum` both NULL = NEVER vacuumed** — heap fetches 46,674 → 19. ⚠ **A fresh stamp is not enough — read `relallvisible`/`relpages`:** a degraded visibility map turns an Index Only Scan into heap fetches, so *"not a missing index"* can be one word short (#121, 41× blocks/call). ⭐ **BLOCKS TOUCHED is the cache-independent discriminator.** ⭐ **SIZE an index build (640 kB = ms; 300 MB+ = spell).**
- ⛔ **`CREATE OR REPLACE` IS A FULL-BODY WRITE — RE-READ THE LIVE OBJECT IMMEDIATELY BEFORE ONE.** A draft off a stale dump silently reverts another session's guard (nothing reds — you rewrite its pin too). ⭐ **Verify the base on `prosrc` (stored VERBATIM) against the migration's BODY — `pg_get_functiondef` REFORMATS THE HEADER, so diffing THAT against the file reads as drift that is not there.** ⚠ On a VIEW it also RESETS reloptions, stripping `security_invoker=on` and cannot rename/reorder columns (`42P16`). [database.md](docs/reference/database.md)

- ⚠ **`rows_written = 0` is a null instrument with three incompatible meanings; `ok = false` and `extra.<step>=0` are the same trap.** Read `extra` + `last_error`, pair every count with an `_error` field, and **measure the OUTCOME table, not the self-report**. [cron-and-schedulers.md](docs/reference/cron-and-schedulers.md)
- ⚠ **A `*_at` name is not its contract — it is its WRITER's, so REPLACING a writer REDEFINES the column while the name holds** (4 surfaces, 1 PRICING). ⛔ **A CACHE keyed on one rots INVISIBLY — the tell is it disagreeing with the row it NAMES** (R107). `col_description()` first: [database.md](docs/reference/database.md).
- ⚠ **Displaced 09-20 to [database.md](docs/reference/database.md) (verbatim, end of file): REVOKE `FROM PUBLIC, anon, authenticated` in ONE statement ORPHANS a pg_cron caller — GRANT in the same migration · `check_*` MIXED return shapes — THREE, incl. a jsonb OBJECT; LENGTH ≠ SEVERITY · UNIQUE INDEX on a PARTITIONED table · `pipeline_runs` ~73h retention.**
- **`apply_migration` for DDL; `execute_sql` for reads/verification.** FMV writes are delete-then-insert, NEVER upsert. ⚠ **CIC needs `execute_sql` and dies at the 60 s cap leaving `indisvalid=false`; a `SET …;` prefix makes a pg_cron command a TRANSACTION BLOCK; ⛔ never `RESET ALL`** — [database.md](docs/reference/database.md). MCP + schema gotchas: [tooling-gotchas.md](docs/reference/tooling-gotchas.md).

Full detail: [docs/reference/database.md](docs/reference/database.md).

### Vercel

- 🚨 **A GREEN DEPLOY IS NOT PROOF A CSS CHANGE SHIPPED** — 3 of 6 CSS-only commits hit READY with the rule ABSENT from the served chunk (2 byte-identical; `Restored build cache`). **Grep the deployed chunk for the DECLARATION**; `@media` counts lie (Lightning CSS merges blocks): scripts/qa/README.md.
- **A docs-only TIP can NEVER force a rebuild** — `ignoreCommand` diffs `HEAD^..HEAD`; ⚠ the v13 POST does NOT override it. Touch a non-docs file.
- **Pro Lambda `maxDuration` hard cap is 800s.** Higher sends the deploy to ERROR *invisibly*.
- 🚨 **A GREEN SUITE IS NOT A DEPLOY GATE FOR SEGMENT SEMANTICS** — `DYNAMIC_SERVER_USAGE` lives only in a real render, so `tsc`/vitest/lint and even a guard pinning the CALL are blind; it 500'd a live route (09-20). **Verify `revalidate`/`connection()`/`dynamic` on a PREVIEW deploy.**
- ⚠ **`get_deployment.state` LAGS** — corroborate with `ready` vs `buildingAt`, `lambdaRuntimeStats`; **check state PER COMMIT** (an ERRORed deploy is superseded by the next push). 🚨 **After a ROLLBACK the alias fields LIE** — probe the public domain on a value the two builds DISAGREE on.
- ⚠ **A disk-IO spell can FAIL THE PRODUCTION BUILD** — displaced 09-20: [tooling-gotchas.md](docs/reference/tooling-gotchas.md).

---

## Quick-reference facts

### Two collection-string conventions (CRITICAL footgun)

Two vocabularies, not interchangeable — mixing them corrupts `flowty_*` writes.

**Long-form** (`sales`, `editions`, `collections.slug`) vs **short-form** (`flowty_*`, CHECK-whitelisted to six values, NOT `other`) — both lists: [schema-truth.md](docs/reference/schema-truth.md).

⚠ **That CHECK is on `flowty_transactions` ONLY** (verified live 08-22), so `'ufc_strike'` fails LOUDLY there and persists SILENTLY in the other two, where it never matches. Bridge: the `analytics_sales` view (long → short via CASE).

### Chain two — a Solana address is not a Flow address with different characters (CRITICAL footgun)

Flow/EVM: hex, `0x`-prefixed, case-INsensitive. Solana: **base58, un-prefixed, CASE-SENSITIVE**. This repo's two reflexes — `.toLowerCase()` and *prepend `0x` if missing* — do not normalise a Candy key, they **destroy** it. ⚠ **It fails SILENTLY IN THE WRONG DIRECTION: zero rows, rendered as "this wallet holds nothing"** — or a complete object of ZEROS echoing the mangled wallet back.

- **Use [lib/address.ts](lib/address.ts) — never a bare `.toLowerCase()`, never a fresh helper** (a grep found TEN already). Which function for which job: [chain-strategy.md](docs/reference/chain-strategy.md).
- ⛔ **NEVER NARROW THE INCUMBENT CHAIN WHILE WIDENING FOR A NEW ONE.** `isValidAddressForChain(k,"flow")` is **stricter** than the `startsWith("0x")` it resembles. **Pin the hex path as its own no-change arm**, or the Solana assertions pass against a function that changed every Flow label.
- ⛔ **Fold-and-prefix on a DISPLAYED address is a FABRICATION, not an absence** (4 were live HREFs: chain-strategy.md). ⚠ **A sweep is only as wide as its PATH ARGUMENT**, and `tsc` is a REACHABILITY instrument: delete the variable to find its other readers.
- ⚠ **A per-device identity key must be chain-scoped, and its sign-out / account-switch sweep by PREFIX** — an exact-name list left the other chain's key for the next collector.

### Collection UUIDs

All 7 live in the DB-derived table in [schema-truth.md](docs/reference/schema-truth.md) — ⚠ **09-08: Candy MLB (`solana`) is `is_active=true` (#63); Panini (`ethereum`) is the ONLY inactive row.**

### Enums

- **Never `.ilike` an enum column — use `.eq`**; `fmv_snapshots.confidence` is UPPERCASE. ⚠ Two confidence vocabularies — `nba_player_projections.confidence` allows only 3-letter `MED`. Value lists (`fmv_confidence`, `tier_type`): [database.md](docs/reference/database.md). `chain_type`, and why `chain` lives on `collections` ONLY: [chain-strategy.md](docs/reference/chain-strategy.md).

### Series map (on-chain UInt32 → display name)

⚠ **0↔1 is TOP-SHOT-SPECIFIC — NEVER blanket-remap `1 → 0` across collections** (dropped 385,734 TS rows). Full map + `collection_series` divergence: [database.md](docs/reference/database.md).

### Cadence

⚠ **MCP-verify deployed mainnet source before any `.cdc`, Cadence literal or FCL `mutate`/`query`** — [apis-and-cadence.md](docs/reference/apis-and-cadence.md).

---

## Concierge non-negotiable rules

1. **RPC is READ-ONLY** — no cart, no gifting, no trading. **Never offer an action the product lacks.** This binds every surface, not just the concierge.

The rest, incl. Pinnacle's FMV triple-join and DERIVE-don't-recite: [concierge.md](docs/reference/concierge.md).

---

## Code patterns and conventions

- Full file replacements only — never snippets or diffs. Claude Code prompts: normal markdown, desktop-read.
- `proxy.ts` is the correct Next.js 16 convention (renamed from middleware.ts). Supabase client typed `any` in API routes.
- `generateMetadata` cannot be exported from a client component — it belongs in the server `layout.tsx`. ⚠ `openGraph`/`twitter` merge **SHALLOWLY**: a route redefining either key REPLACES the root object, silently dropping `siteName`/`type`/`locale`/`creator`.
- `useSearchParams` requires a Suspense wrapper.
- Fire-and-forget >30s: `after(runX())` from `next/server`, return `{status: accepted}`. ⚠ **`try/catch` CANNOT catch a `maxDuration` kill and the kill is ABSENT from `pipeline_runs_daily`** — write a `<pipeline>-heartbeat` BEFORE the work (`rows_*` NULL), read kills by CORRELATION (`npm run pipelines:kills`), bound every `fetch`. Cases: [cron-and-schedulers.md](docs/reference/cron-and-schedulers.md)
- Never hardcode `#E03A2F` or `'Barlow Condensed'` — always the tokens in `app/rpc-tokens.css`. ⚠ **Web red is `#E03A2F`; email red is `#E55A4C`**, hardcoded on purpose (email clients lack CSS custom properties). ⚠ `--rpc-black` and `--rpc-text-primary` are THEME-AWARE — a hardcoded dark hex renders a black slab in light mode.

---

## Hot wallet & secrets

Flow CLI hot wallet `0x3aa11c84d776838f`. ⛔ **Signing MUST be ECDSA_secp256k1 + SHA2_256** (`server-authz.ts` used p256 + SHA3-256 for months) and signing tests must verify **cryptographically**, never assert output shape. Wallet rules, HybridCustody ban, the 8 key env vars: [tooling-gotchas.md](docs/reference/tooling-gotchas.md).

## Prioritized next actions

**The canonical forward plan is [docs/strategy/roadmap-2026-08-03.md](docs/strategy/roadmap-2026-08-03.md).** Thesis: **accuracy is the GATE, not a phase** — growth tactics stay removed until the data beats the sites collectors already use; headline metric is the share of prices at HIGH/MEDIUM confidence. Still binding: **intelligence-first**; Cart / Trade Hub / gifting removed (**read-only product**); **monetization tabled until 50+ weekly active users**; no infra spend pre-revenue.

**Open items** — dated snapshot moved to [roadmap-status.md](docs/reference/roadmap-status.md) 2026-09-19 (status data; goes stale by nature). ⚠ **Two need TREVOR, not code:** the credential-purge residue (#22) and both 2-hourly Routines still disabled (#55).

Full status + accuracy measurements: [docs/reference/roadmap-status.md](docs/reference/roadmap-status.md). Issue register: [docs/reference/known-issues.md](docs/reference/known-issues.md).

---

## Recent sessions

Session entries live in `docs/sessions/`, one per month; none is needed to start work. **Write into the CURRENT month's file (prepend, newest-first), never here**, and **promote every durable lesson into this file or the matching `docs/reference/*.md` — a fact left only in a session log stops being read.**

⚠ **`docs/archive/**`, `docs/health/**` and `docs/sessions/**` are frozen history — never rewrite their links.** Layout: [session-and-archive-conventions.md](docs/reference/session-and-archive-conventions.md).
