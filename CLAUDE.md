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

🚨 **`git revert <sha>` paths recorded BEFORE 2026-08-03 no longer resolve** — that day's `filter-repo` rewrote every pre-purge sha; find the commit by MESSAGE (`git log --grep=`). The **DB half of every revert path is unaffected**. Purge residue: #22.

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

- Supabase project ID: `bxcqstmqfzmuolpuynti` (Pro; **compute = LARGE** since 2026-09-20 — 8 GB RAM / 2 dedicated vCPU, `max_connections`=160, `shared_buffers`=2 GB, `work_mem`=12 MB). Sustained disk **79 MB/s / 3,600 IOPS**. ⚠ Pre-09-20 findings citing the **22 MB/s floor** are the OLD Small tier — re-measure. Tiers: database.md.
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
- ⚠ **A SERVER-SEEDED PROP (`initial={rows}`) is a fifth layer the table does not cover** — `[]` with no provenance, and a mount effect hides it from every client test. Pass `initialFailed`, assert by SSR: key-files-and-honesty.md.
- ⚠ **THE WRITE SIDE, absent from the table above (R120/R123):** a swallowed write error + a hardcoded `ok=true` + a count that CANNOT GO DOWN publishes a FAILED WRITE as a successful run — 66 days on one lane, **20+ writers estate-wide**. **DERIVE `ok` from whether the write landed, pair every count with its own `_error`, and make a count mean rows WRITTEN.** ⛔ **An `insert` awaited with NO destructuring is unreadable by construction, not merely ignored.**
- ⚠ **ISR CACHES A FAILED READ for the whole `revalidate` window** and self-heals warm, so it is **easy to declare fixed by accident**: test *"does a COLD pass exceed the budget"*, never *"is the page OK now"* (#33).
- **Fix per PANEL, not per page.** A page with one honest error branch is not an honest page (key-files-and-honesty.md).
- **The worst sub-classes:** an account-level false claim; a page that **LOADS state and WRITES IT BACK** (a failed read there is a *delete*); an **alert**; a **guard** (`?? 0` fails it *open*); an empty state that **CONCLUDES**; a **SWEEP whose `ok` means it COMPLETED, not that its LANES worked**; a **DONE stamp in an ELSE that cannot tell IN FLIGHT from FINISHED** (#123). Cases: key-files-and-honesty.md
- ⚠ **`?? 0` on a supabase count, `|| 1` as a divide-guard, and a DEFAULTED DB COLUMN beside a NULL `*_checked_at` are the fabricated-value shapes.** **ANY unwrapper that RETURNS on failure** (#114) publishes a measured zero AND leaves every downstream `catch` dead; ⭐ **The DB form's tell is a PERFECT CORRELATION: `never_checked AND value=true` EXACTLY 0 means the value is the DEFAULT** (#112). ⛔ **A function projecting such a value must project its PROVENANCE too.** `no-fabricated-divisor-ratchet` bans it at zero. **Never persist a PARTIAL read as the fact** — a walk returning ROWS *and* an ERROR is the same shape (#119)
- 🚨 **A CLIENT-ONLY failure is captured by NOTHING but the 09-07 beacon** (Sentry SDK OUT OF THE TREE — #34, decided: no spend; Vercel sees only server execution): `usage_events.client_error` + the scheduled `E2E DOM Smoke` badge (#69). Verbatim: claude-md-condensed-originals.md.
- ⛔ **A SUPPRESSION IS A CLAIM — re-derive the source is still dead.** A hardcoded retirement DATE cannot notice its premise expired: 13 days of "retired" over a LIVE 60k-row feed, ratchet GREEN (it pins that the disclosure EXISTS, not that it is TRUE). Gate on its OWN age.
- ⚠ **When you find one, grep for the EXPRESSION, not the file** — it has spread by copy-paste five times now; **a comment is only read by someone already in that file**.

Full canon + every instance: [docs/reference/key-files-and-honesty.md](docs/reference/key-files-and-honesty.md).

### Guards, tests and instruments

- ⚠ **`npx vitest run <file>` proves the FILE, and the SUITE is not the GATE: `npm test`+`tsc` pass trees `npm run lint:ratchet` reds (per-RULE).** A red run is not automatically yours: read the failing JOB first.
- ⚠ **Ask what RUNS a guard, not only whether it passes, and ASSERT THE COUNT IT INSPECTED** — a staged-only default inspected **nothing** on a CI checkout and exited 0. ⭐ **THE TELL IS SILENCE — one that normally states its count and then says nothing has not PASSED, it has not SPOKEN** — a `;` in an npm script dies in cmd.exe; use a **node driver**.
- ⚠ **Ask what a passing guard is structurally SILENT about — its DERIVATION fixes its blast radius, and its ROOT *and stated CLASS* are CLAIMS** (see testing-and-ci.md). **Prefer a tree walk over a curated list and a ban at zero over an allowlist; make *suppression* the curated list; assert an exclusion at the PROPERTY's granularity — and assert that a SECOND root CONTRIBUTES.** ⚠ **A control's POPULATION must be the set the property is TRUE of, not a proxy that coincides today** — a proxy expires silently. ⛔ **An AGGREGATE is never a proxy for the SLICE you measured** (98.1% all-visible, yet 42% heap fetches on the index’s first 0.23% — R109). ⛔ **A pin RE-DERIVED FROM THE OBSERVED STATE can never disagree with reality**: assert the DELTA it stood in for.
- ⚠ **A vacuous assertion reads as coverage everywhere, and mutation testing cannot find the worst kind** — **a test stating the contract in a comment and asserting something weaker.** The tell is the TITLE: a name carrying a negative claim or a transformation is a promise the assertion usually fails to keep. **Assert the ABSENCE of the false claim, not the PRESENCE of an error message.**
- ⚠ **Grep for the guards that READ a file before you EDIT it** — a pinned exemption reddened main (08-22).
- ⛔ **A header saying it MIRRORS another implementation is a CLAIM WITH NO TEST — diff them.** `check_wall_kills()` and `correlateRuns()` read the same rows and gave OPPOSITE verdicts for a week (one rule added to the SQL side only); the divergent one was the CLI, pinned at exit 1 forever on a healthy lane.
- ⛔ **A HARDCODED ALLOWLIST BESIDE A REGISTRY GOES STALE SILENTLY** — a four-slug map 400'd UFC and Candy from a button the reader can see. Resolve through the registry, and **pin the narrowing gate too**, or the swap widens to unpublished collections.
- ⛔ **A REGISTRY VALUE has no file of its own — grep the TEST TREE for it, not the files you edited.** One tab added to `lib/collections.ts` reddened two guards in files never opened, both keyed on `getCollection(…).pages`; main was red 11 minutes. `grep -rl <collection> __tests__` costs seconds, BEFORE the push.
- ⚠ **A test red because its PREMISE changed is a RE-PIN, not an inversion** — the code was fine. ⛔ **But re-pinning the row is not enough: check the property is still EXERCISED.** Once every collection had the tab, a hardcoded path passed every row; the arm had to be kept alive by a subject that genuinely lacks it.
- ⚠ **Tests that pin the defect they were named to prevent get INVERTED, never deleted** — a passing test asserting a promise is what holds that promise in place. **Pin the property, not the spelling**.
- ⚠ **A not-vacuous check must be satisfiable at a population of ZERO**, or the guard punishes its own success. Same for a guard that NAMES its instances — three have died on a rename. ⚠ **Strip comments before grepping source — with `scripts/lib/strip-comments.mjs`, NEVER a fresh copy.** **Still prefer a check that does not NEED it right** (`copyOf`).
- ⚠ **FIXING A GUARD WITHOUT FIXING ITS RECORD leaves the incidence unmeasurable** — fix the guard AND the field an observer keys on (testing-and-ci.md).
- ⚠ **A permanently-red or -zero instrument is indistinguishable from a broken one, and a CHECK THAT DIDN'T RUN from one that PASSED** (docs-only CI: testing-and-ci.md) — check the LOG, not the badge; **prove a watcher sees a FAILURE**. ⚠ **An ALARM SHARING ITS SUBJECT'S SCHEDULER is no alarm** — shed every tick 2.8h (#80).
- ⚠ **Every CI `run:` block is `bash -e`, so a fallible command in an ASSIGNMENT aborts the step there** — a retry loop after it is DEAD CODE that reads as coverage, and `jq` counts (exit 5 on a non-JSON body). Write `X=$(…) || X=""`, then check explicitly — ⛔ `|| X="0"` is WORSE: it never aborts, so the guard reports a clean read of what it never read.
- ⚠ **An exclusion justified by ANOTHER instrument is a claim about it — check that one can SEE the property**, and know what NOTHING here measures (LAYOUT, the BUILT BUNDLE).

⭐ **This sandbox CAN run the DB-invariant suite + migration parse check locally** (`initdb` as `postgres`; root is refused) — recipe: tooling-gotchas.md. Full detail: [docs/reference/testing-and-ci.md](docs/reference/testing-and-ci.md).

### Measurement discipline

- ⚠ **A filed FINDING is a hypothesis — re-derive what it measured before acting** (several refuted). ⚠ **So is a filed DECISION NOT TO ACT, and that is the one nobody re-checks — the tell is a cost stated with no number in it.** ⚠ **A WEAK reason CROWDS OUT the strong one and becomes PERMISSION when it dissolves.** ⚠ **A freshness STAMP is not a RATE, and a candidate its own NO-CHANGE CONTROL outperforms is not shown to work** — a stale `max(ingested_at)` read as “zero output” shipped a cadence change reverted 6 h later. ⚠ **Re-TEST a stated exit condition, never re-read it** — a "once cleared" 114 was 5. ⚠ **RE-TEST it BEFORE acting** — a 36 % kill rate was 100 % by ship.
- ⚠ **A plausible mechanism is not a measurement**, including when it flatters this file — a cheap sample beats a good story. ⚠ **And a probe whose HARNESS differs from production in the ONE dimension the answer depends on is not a measurement of production** (OG-font case: key-files-and-honesty.md).
- ⛔ **A FIX TO A ROUTE IS NOT A FIX TO THE SURFACE until its CALLER can reach it.** `/api/wallet/edition-counts` was repaired and **verified live (0 → 5)** while the client that renders it still returned early on `!ownerKey.startsWith("0x")` — the column stayed empty all day and **no route-level test could have caught it**.
- ⚠ **Name the caller before you touch the function** — an afternoon went into one with **zero** callers. **EIGHT sources, and the last two are INVISIBLE from a sandbox**; a TRIGGER function has no textual caller. ⚠ **A TABLE’s WRITERS the same — grep the DB: two pg_cron ones REFUTED a filed finding (#81).** Full list: [cron-and-schedulers.md](docs/reference/cron-and-schedulers.md).
- ⚠ **Displaced 09-20 to [cron-and-schedulers.md](docs/reference/cron-and-schedulers.md) (verbatim, end of file): DISCOVERY must not double as the REFRESH list · an ELIGIBILITY count is not a GAIN count · a SWEEP under-covers two ways, both reporting success: too few slots (`N ≥ population ÷ staleness_hours`) and the WRONG POPULATION.**
- ⚠ **Read `cron.job.command` to learn what a schedule calls; never infer the callee from the name** — two objects one suffix apart yielded *opposite* conclusions.
- ⛔ **`count(*)` OVER A FUNCTION THAT RETURNS ONE ROW IS NOT A MEASUREMENT** — most RPCs here return ONE row whose VALUE is the result, so every variant answers `1` and a live defect reads as "no difference" (3× in one pass, 09-19). **Read the payload.** Same shape: `prosrc ILIKE '%lower(%'` said a function folded its wallet; the matching LINES showed `player_name` and `tier`. **Print the lines, not the predicate.**
- ⚠ **A directional claim needs a DISTRIBUTION, not a snapshot; a delta between two STOCKS is neither a rate nor a sign; `max()` on a `text` cursor is lexicographic.**
- ⚠ **A window sitting ENTIRELY AFTER a change point cannot tell a STEP from a LEVEL, and read the live alarm's OWN `detail`/ack text before fixing what it already covers** (case, verbatim: cron-and-schedulers.md).
- ⚠ **When an instrument's first finding is SURPRISING, establish WHO generated it before believing WHAT it says** — 17 "user-facing" client errors were ONE headless crawler, `ua` in the payload all along (#69). **A `count(*)` over an OPEN endpoint counts REQUESTS, not READERS.**
- ⚠ **A rate POOLED ACROSS A FIX measures the fix's ABSENCE and reads as its FAILURE; under an IO spell a cron DURATION or completion rate measures the ESTATE, not your fix — judge per-call work on pgss blocks/call.** Split on the change point (numbers, verbatim: [cron-and-schedulers.md](docs/reference/cron-and-schedulers.md)).
- ⚠ **Diff the SET, not the count** — a total can hold while membership turns over twice, so the number reads "no change" across a fix landing *and* a new arm firing. Case: [trust-board-and-safety.md](docs/reference/trust-board-and-safety.md).
- ⚠ **Controls, both directions:** a NULL result needs a positive control; a POSITIVE needs a no-change control **the fix cannot move**; a DIFFERENCE needs both sides counted by the same instrument. **Never pair a count from one table with a property from another.** ⚠ **A control must use the PRODUCTION CALLER**: a `postgres` MCP call cannot prove a `cron_heavy` job runs.
- ⚠ **FOUR ways a measurement lies about a change: a byte-identical HTTP response is as much a CACHE HIT as a fix; a DB A/B must be WARM-vs-WARM; an unordered `LIMIT` is physical order, not a sample** (use `abs(hashtext(k)) % N`); **and a reading taken while its SUBJECT CHANGED is not a reading** — ⛔ **and your OWN PROBE is the load here**. **Freeze the tree, then measure.** 🚨 **A CALM box and the SAME box are different claims: read `pg_postmaster_start_time()` before attributing ANY fleet-wide performance change** — a resize restarts Postgres, and on 09-20 three entries blamed IO settling for a Small→Large step 27 min earlier (#126). ⭐ **Warm-vs-warm also DIAGNOSES: expensive WARM = COMPUTE-bound (precompute it); cheap warm + expensive COLD = IO-bound (no index helps).**
- ⛔ **A METRIC'S DEFINITION LIVES IN CODE, NOT IN THE THRESHOLD YOU REMEMBER — a model that cannot reproduce TODAY'S value cannot predict tomorrow's.** A model that missed two code paths read 34% against an observed 53%, and that 19-point miss shipped as a **backwards call on a launch gate** (the two paths: claude-md-condensed-originals.md).
- ⚠ **AN ENGINE THAT IS UP IS NOT A PLATFORM THAT IS REACHABLE, and log SILENCE is not engine silence** — 09-18 the instance lost **outbound DNS** while Postgres kept writing (#122). ⭐ **A `<!DOCTYPE html>` from Supabase IS Cloudflare's `522`; probe an endpoint reading NONE of our tables to split ENGINE from PATH.**
- ⚠ **Read the ERROR STRING, never the duration — and ALL of it: the clause you SKIP discriminates.** Two ~2-min timeouts (gateway vs `statement_timeout`) give one number, two meanings: [database.md](docs/reference/database.md). ⛔ **Never state a cause the error did not** — half a string became false user-facing copy on 09-14.

### Concurrent sessions — THREE writers, and two are indistinguishable

⛔ **"Not mine" + "not mine" ESTABLISHES NOTHING** — who you can MESSAGE ≠ who writes; a Cowork pass ships unannounced. `git log -1 --format=%an` tells Cowork from this box; **nothing tells two sessions ON it apart.** ⛔ **`git add <shared file>` stages the OTHER session's uncommitted hunks** — `git diff` it first, commit same turn; **`git add -p` exits 0 staging NOTHING.** ⛔ **Before any before/after, list migrations in your window** — "freeze the tree" is unactionable here, so windows are MINUTES. ⭐ **ARRIVAL ≠ SURVIVAL — assert your change LANDED, not just that nothing died.** ⭐ **Remove the failure mode; do not soften the detector.** [tooling-gotchas.md](docs/reference/tooling-gotchas.md)

### Timestamps

🚨 **EVERY TIME YOU REPORT TO TREVOR IS PT — chat, summaries, ledger headings, all of it. NEVER quote a UTC/`Z` time to him** (asked repeatedly; broken again 09-10). ⚠ **READ THE ZONE BEFORE CONVERTING — four incidents came from a plausible timestamp produced by a clock whose zone was assumed.** ⚠ Git Bash lies BOTH ways and the **web sandbox is PDT, not UTC**, so "subtract 7h from `date -u`" lands a day early. Trustworthy clocks + the conversion recipe: [tooling-gotchas.md](docs/reference/tooling-gotchas.md).

### Windows / Git Bash

**Section moved VERBATIM to [tooling-gotchas.md](docs/reference/tooling-gotchas.md) 2026-09-20.** The three that bite most: ⚠ **backticks in `git commit -m` are command substitution** (write the message to a file, `git commit -F`); ⚠ **assert the occurrence count before a scripted replace, and key any backup on the FULL PATH**; 🚨 **`get_edge_function` AND `cron.job.command` hand back live gate keys — redact or hash, never echo**, and never broad-query a DOM that can hold secrets.

### Database — the traps that bite most often

- **PostgREST caps reads at 1000 rows and CLAMPS an explicit `.limit()` above that**; a bare `.select()` clamps too. For a total, read the returned `count` (`head: true`), never `rows.length`.
- ⚠ **Any `.range()` pagination MUST carry a deterministic `.order()`** on a UNIQUE key, or it reads the right *number* of rows and the wrong *rows*. The duplicates and omissions **cancel**, so every count-based check passes — only a DISTINCT count or a set comparison sees it. Now a **ban at zero**.
- **A batch `.insert()` is ALL-OR-NOTHING — never swallow `23505` on one.** One duplicate fails the whole statement and writes none of the batch; on a cursored indexer that is permanent loss.
- ⚠ **A `LIMIT` bounds a query's OUTPUT, not its COST — "lower the limit" is often not a lever.** Cut ITEMS per tick, not rows per item, and compare **BUFFERS**, never timings (66,499 → 741 on one `WHERE collection_id`: database.md). ⚠ **Scoping an aggregate is an EQUIVALENCE claim: PROVE it over the population.** ⭐ **For an id list, one `LATERAL … ORDER BY ts DESC LIMIT 1` probe per key beats a table-streaming `DISTINCT ON` (5 instances; 40 ms vs 22–41 s) — and only a COLD A/B shows it. ⛔ ONLY IF THE INDEX CARRIES THE AGGREGATED COLUMN** — else it heap-fetches per key and **LOSES** (15,814 vs 22,095 buffers, 4× slower; database.md).
- ⚠ **A differential upsert WRITES the delta but PROBES every offered row** — 55k probes to write ~60 were ~700k of a tick's 927k buffers. LEFT JOIN the target first (cast to ITS types), offer only the delta: −79 %/call (R101 v2, database.md).
- ⚠ **`SET statement_timeout` on a function is INERT on pg_cron; via PostgREST only a HIGHER one applies (gateway cap ~120 s).** ⛔ Most are load-bearing — do NOT strip.
- 🚨 **`EXCEPTION WHEN OTHERS` DOES NOT CATCH A 57014 KILL (R118, 35 handlers were blind).** A record-and-exit handler says `WHEN query_canceled OR OTHERS` — and ONLY where its tail is bounded: the timer is NOT re-armed after the catch. Loop handlers stay bare. `check_when_others_timeout_blind()` → `[]`; a forward-only migration guard (database.md).
- ⛔ **A 600 s pg_cron reader wants an HOUR-SET before a minute, and the READ is the lever, not the slot** (leg 324: cron-and-schedulers.md).
- ⚠ **CADENCE AND BUDGET ARE ONE DECISION** — nothing fixes a tick that cannot FINISH; its killed delta rolls back, then GROWS against the frozen table. ⚠ **≡0 mod 5 minutes blackout worst (9.15/5.72%); a slot move can kill in-job clock SAMPLING.**
- ⚠ **A queue walk that starts at the top of what it resolves COMPOUNDS** (three in one day, 09-07) — page a BOUNDED slice of the INDEX behind a cursor. Wire a new pg_net lane into the 4xx arm in its creating migration. [cron-and-schedulers.md](docs/reference/cron-and-schedulers.md)
- ⛔ **`last_vacuum` AND `last_autovacuum` both NULL = NEVER vacuumed** — heap fetches 46,674 → 19. ⭐ **SIZE an index build (640 kB = ms; 300 MB+ = spell).**
- ⚠ **Every `apply_migration` causes a ~10–20 s burst of user-facing `PGRST002` 500s** (schema-cache re-introspection) — batch them, prefer a low-traffic window, and `rpcWithRetry` does NOT save you (database.md).
- ⛔ **`CREATE OR REPLACE` IS A FULL-BODY WRITE — RE-READ THE LIVE OBJECT IMMEDIATELY BEFORE ONE.** A draft off a 40-min-old dump would have reverted another session's guard silently — you rewrite its pin too, so nothing reds; `pg_get_functiondef` LENGTH caught it. ⚠ On a VIEW it also RESETS reloptions, stripping `security_invoker=on` (4×) and cannot rename/reorder columns (`42P16`). [database.md](docs/reference/database.md)

- ⚠ **Displaced 09-20 to [database.md](docs/reference/database.md) (verbatim, end of file): REVOKE `FROM PUBLIC, anon, authenticated` in ONE statement, and it ORPHANS a pg_cron caller — GRANT in the same migration.**
- ⚠ **`rows_written = 0` is a null instrument with three incompatible meanings; `ok = false` and `extra.<step>=0` are the same trap.** Read `extra` + `last_error`, pair every count with an `_error` field, and **measure the OUTCOME table, not the self-report**. [cron-and-schedulers.md](docs/reference/cron-and-schedulers.md)
- ⚠ **A `*_at` name is not its contract — it is its WRITER's, so REPLACING a writer REDEFINES the column while the name holds** (4 surfaces, 1 PRICING). ⛔ **A CACHE keyed on one rots INVISIBLY — the tell is it disagreeing with the row it NAMES** (R107). `col_description()` first: [database.md](docs/reference/database.md).
- ⚠ **Displaced 09-20 to [database.md](docs/reference/database.md) (verbatim, end of file): `check_*` MIXED return shapes — THREE, incl. a jsonb OBJECT; LENGTH ≠ SEVERITY · UNIQUE INDEX on a PARTITIONED table · `pipeline_runs` ~73h retention.**
- **`apply_migration` for DDL; `execute_sql` for reads/verification.** FMV writes are delete-then-insert, NEVER upsert. ⚠ **CIC needs `execute_sql` and dies at the 60 s cap leaving `indisvalid=false`; a `SET …;` prefix makes a pg_cron command a TRANSACTION BLOCK; ⛔ never `RESET ALL`** — [database.md](docs/reference/database.md). MCP + schema gotchas: [tooling-gotchas.md](docs/reference/tooling-gotchas.md).

Full detail: [docs/reference/database.md](docs/reference/database.md).

### Vercel

- **A docs-only TIP can NEVER force a rebuild** — `ignoreCommand` diffs `HEAD^..HEAD`; ⚠ the v13 POST does NOT override it. Touch a non-docs file.
- **Pro Lambda `maxDuration` hard cap is 800s.** Higher sends the deploy to ERROR *invisibly*.
- ⚠ **`get_deployment.state` LAGS** — corroborate with `ready` vs `buildingAt`, aliases attached, `lambdaRuntimeStats` present; and **check deploy state PER COMMIT**, because an ERRORed deploy is superseded by the next push.
- **A disk-IO saturation spell can FAIL THE WHOLE PRODUCTION BUILD** (prerendered `/insights` pages get 60 s each) — now a ban at zero, `insights-server-pages-bound-their-reads`; ⚠ twice the failing page was one the pushing commit never touched. Log traps: tooling-gotchas.md.

---

## Quick-reference facts

### Two collection-string conventions (CRITICAL footgun)

Two vocabularies, not interchangeable — mixing them corrupts `flowty_*` writes.

- **Long-form** (`sales`, `editions`, `collections.slug`): `nba_top_shot` · `nfl_all_day` · `laliga_golazos` · `disney_pinnacle` · `ufc_strike`
- **Short-form** (`flowty_transactions`, `flowty_loans`, `flowty_loan_events`): `topshot` · `allday` · `golazos` · `pinnacle` · `ufc` · `unknown` — the CHECK whitelists exactly these six, NOT `other`

⚠ **That CHECK is on `flowty_transactions` ONLY** (verified live 08-22), so `'ufc_strike'` fails LOUDLY there and persists SILENTLY in the other two, where it never matches. Bridge: the `analytics_sales` view (long → short via CASE).

### Chain two — a Solana address is not a Flow address with different characters (CRITICAL footgun)

Flow/EVM: hex, `0x`-prefixed, case-INsensitive. Solana: **base58, un-prefixed, CASE-SENSITIVE**. This repo's two reflexes — `.toLowerCase()` and *prepend `0x` if missing* — do not normalise a Candy key, they **destroy** it. ⚠ **It fails SILENTLY IN THE WRONG DIRECTION: zero rows, rendered as "this wallet holds nothing"** — or a complete object of ZEROS echoing the mangled wallet back.

- **Use [lib/address.ts](lib/address.ts) — never a bare `.toLowerCase()`, never a fresh helper** (a grep found TEN already). Which function for which job: [chain-strategy.md](docs/reference/chain-strategy.md).
- ⛔ **NEVER NARROW THE INCUMBENT CHAIN WHILE WIDENING FOR A NEW ONE.** `isValidAddressForChain(k,"flow")` is **stricter** than the `startsWith("0x")` it resembles. **Pin the hex path as its own no-change arm**, or the Solana assertions pass against a function that changed every Flow label.
- ⛔ **Fold-and-prefix on a DISPLAYED address is a FABRICATION, not an absence** — 4 were **HREFs** on live pages, sending readers to an analyzer that resolved nothing. ⚠ **A sweep is only as wide as its PATH ARGUMENT**, and `tsc` is a REACHABILITY instrument: delete the variable to find its other readers.
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
