# Rip Packs City — Claude Code AI Assistant Configuration

> **HOW THIS FILE WORKS (restructured 2026-08-17).** The memory-file limit is **40,000 characters** on a standard 200k session — what the nightly pass, Cowork and every subagent run at (formula: the test below). This file carries only what a session needs *before* it knows its topic; the rest moved **verbatim** to `docs/reference/*.md`. Nothing was deleted — a rule that feels missing is in one of those files.
>
> **KEEPING IT UNDER: the limit is on CHARACTERS. Count with `node -e` and `.length` — NOT `wc -c` (BYTES) and NOT Python `len()` (CODE POINTS); both misread this file, in opposite directions.** Numbers + the 4 instruments: [tooling-gotchas.md](docs/reference/tooling-gotchas.md); case: `__tests__/claude-md-stays-under-the-memory-file-limit.test.ts`. 🚨 **HEADROOM IS ~0 (re-measured 09-18) — a new rule must DISPLACE one, never merely SPEND room** — put the displaced text **verbatim** in the matching `docs/reference/*.md` with a one-line pointer from here. **Over the limit the whole file is flagged and stops being trustworthy context.**
>
> ⚠ **Two rules govern every number here and in those docs. (1) Every figure is a DATED SAMPLE, not a constant — re-measure before quoting it. (2) A recorded correction has a shelf life.** **Re-derive; do not quote.**

---

## Reference index

All under `docs/reference/`:

- **`key-files-and-honesty.md`** — largest and most-read. Key modules + the full honesty canon, leak guards, fabricated-number shapes, OG cards, Workers.
- **`database.md`** — `editions` · `wmc` · `fmv_snapshots` · `sales`, role timeouts, PostgREST caps, `apply_migration` cost, security posture.
- **`testing-and-ci.md`** — vitest layers, the 3 coverage gates + ratchets, DB-invariant SQL pins, mutation categories, CI jobs, Playwright.
- **`known-issues.md`** — open/resolved register (stable item numbers), deferred hardening, deep-audit follow-ups.
- **`cron-and-schedulers.md`** — the 4 schedulers, pg_cron mechanics, `pipeline_runs` retention + rollup traps, fleet health, saturation.
- **`trust-board-and-safety.md`** — trust board (⚠ read its own "arm count drifts / 60 s timeout" caution first), precompute split, destructive-op breaker, cross-session coordination.
- **`chain-strategy.md`** — multi-chain thesis, Candy/Solana + Panini readiness, chain-abstraction Phases A–F.
- **`routes-and-surfaces.md`** — route structure, per-collection `pages`, API endpoints, search.
- **`apis-and-cadence.md`** — Top Shot / All Day GraphQL, Flowty, Flow REST, the RPC FMV API, contracts, Cadence gotchas.
- **`concierge.md`** · **`brand-auth-proxy.md`** · **`tooling-gotchas.md`** · **`packs.md`** · **`architecture-notes.md`** · **`ledger-discipline.md`** · **`autonomous-tasks.md`** · **`roadmap-status.md`** · **`session-and-archive-conventions.md`** · **`parallels-variants-data-model.md`** · **`revert-map-2026-07-25.md`**.
- **`claude-md-condensed-originals.md`** — verbatim pre-restructure text of sections **shortened rather than moved**. ⚠ **Check here first if a detail seems missing.**
- **`schema-truth.md`** — read from the live DB; **wins on any disagreement with prose — but only as fresh as its stamp** (no generator; read the stamp).

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
- **When push IS genuinely denied**, four proven routes (recipes: tooling-gotchas.md): repo-as-session-source · `/web-setup` (authorizes at CREATION — fixes the NEXT one) · desktop "Run this task" · `git format-patch` → VM `git am` + `.rpc-git-cred` (back 09-19; `am` rewrites the sha — the cloud clone then reads "unpushed") · the laptop `cowork-push` queue.
- ⚠ **A no-push session's DB reach is narrower than `apply_migration` suggests** — a PINNED SQL function is PUSH-GATED and every `apply_migration` reds `migration-parity` until its file is committed. **Real no-push levers: pg_cron schedules, indexes, new objects**; `execute_sql` for SCRATCH DDL.
- Bash-green ≠ push-green; never commit from the mount. History: [tooling-gotchas.md](docs/reference/tooling-gotchas.md).

## Autonomous Cowork tasks

Two scheduled Cowork tasks run here — coordinate via the shared ledger so work doesn't collide.

- **`rpc-daytime-monitor`** — READ-ONLY, ~3-hourly. Sweeps health, files candidates to `docs/overnight/inbox/`. Ships nothing.
- **`rpc-nightly-autonomous-pass`** — 1am local. Drains the inbox, ships ≤4 low-risk changes to `main` (collision- and CI-gated, each verified by a fresh subagent), writes a handoff + digest. Off-limits (queued, never auto-shipped): hot/payer wallet, secrets/env, auth (`proxy.ts`), destructive SQL, **metered SPEND** — full list in [autonomous-tasks.md](docs/reference/autonomous-tasks.md).

Shared state in `docs/overnight/`: `ledger.md` (**"Declined — do not re-suggest"** is Trevor's heading), `inbox/` (⚠ read autonomous-tasks.md BEFORE archiving a filing — `INDEX.md` carries CI assertions), `metrics-latest.json`, `focus.md`, `.lock`. **Skim `ledger.md` first**; the night pass will not edit files committed in the last 24–48h. To halt autonomous shipping, create `docs/FREEZE.md`. Detail: [autonomous-tasks.md](docs/reference/autonomous-tasks.md).

---

## Project overview

Rip Packs City (RPC) is a production-grade Flow blockchain digital collectibles intelligence platform: analytics, deal-finding, sniper tools, FMV pricing and badge tracking across the 5 published Flow collections (NBA Top Shot, NFL All Day, LaLiga Golazos, Disney Pinnacle, UFC Strike). Trevor (founder) holds an official Portland Trail Blazers Team Captain designation on NBA Top Shot — ⛔ **IYKYK: never lead copy or outreach with it** (09-06).

Stack: Next.js 16 App Router, React 19, TS 5, Tailwind 4, @onflow/fcl, Supabase (Pro, Small compute), Vercel Pro. Live: https://www.rippackscity.com · Repo: github.com/jamesdillonbond/rip-packs-city (public).

**Repo map** (re-derive; never quote a count): [routes-and-surfaces.md](docs/reference/routes-and-surfaces.md).

**Tagline** stays "Flow blockchain digital collectibles intelligence platform" until chain two ships visible product. No tweets / Reddit / TC DMs on multi-chain pre-launch.

---

## Infrastructure IDs (required on every tool call)

- Supabase project ID: `bxcqstmqfzmuolpuynti` (Pro; **compute = SMALL** — 2 GB RAM / 2-core, `max_connections`=90). ⚠ The **22 MB/s** burst floor is the COMPUTE TIER's IO budget, NOT the disk. Saturation is **IO-, not CPU-bound** — fix expensive queries, don't upgrade (Medium/Large tier numbers: database.md).
- Vercel project ID: `prj_YBJ6Utl32GfyBOIzbsp3kbshJh96`
- Vercel team ID: `team_YWGCVToPBJSS60NgVh8jiCFV`
- GitHub repo ID: `1188272071`

Never omit `teamId` on a Vercel API/MCP call.

---

## Frequently used commands

```bash
npm ci                   # ⚠ RUN FIRST in a fresh sandbox — without it `npx vitest`/`tsc` die on
                         #   `MODULE_NOT_FOUND … vitest.config.ts`, which reads like a broken config.
npm run dev
npx tsc --noEmit         # before deploying, esp. when Vercel is rate-limited
npm test                 # vitest run — route + lib suites (single file: npx vitest run <path>)
npm run test:coverage    # primary gate (what CI ratchets on)
npm run test:coverage:components   # component gate
npm run test:coverage:workers      # workers gate
npm run db:pins:check    # live DB-invariant pin drift (needs service-role key)
npm run test:cadence     # extract inline Cadence + `flow cadence lint`
git add -A && git commit -m "feat: ..." && git push origin main   # Git Bash (MINGW64) on Windows
# Vercel redeploy / env writes — PowerShell Invoke-WebRequest ONLY; see tooling-gotchas.md
```

⚠ **A pipe reports the LAST command's exit code** (`… | tail -5 && echo $?` printed `EXIT=0` with no `node_modules`) — read `${PIPESTATUS[0]}`. ⚠ **`grep <log> && git push` gates on grep FINDING a line, not on the run PASSING** (pushed a red suite 09-04). Branch on the EXIT value.

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
- **There are always THREE states, never two:** read failed · read ok + genuinely empty · read ok + unrenderable (e.g. rows that failed a name join). A name filter is not an emptiness test. ⚠ **The MIRROR: an `unknown` that is actually KNOWN is the same defect** (#80). ⛔ **A failure flag for ONE source must not gate a field fed by ANOTHER.**
- ⚠ **A SERVER-SEEDED PROP is a fifth layer the table does not cover:** `initial={rows}` arrives as `[]` with **no provenance**, so a component that distinguishes failure for its OWN fetch still concludes on the seed (7 by 08-24). Pass `initialFailed`, and **assert it by SSR (`renderToString`)** — a mount effect corrects the state before jsdom looks, so two OPPOSITE mutations pass every client test.
- ⚠ **ISR CACHES A FAILED READ for the whole `revalidate` window** and self-heals warm, so it is **easy to declare fixed by accident**: test *"does a COLD pass exceed the budget"*, never *"is the page OK now"* (#33).
- **Fix per PANEL, not per page.** A page with one honest error branch is not an honest page (key-files-and-honesty.md).
- **The worst sub-classes:** an account-level false claim; a page that **LOADS state and WRITES IT BACK** (a failed read there is a *delete*); an **alert**; a **guard** (`?? 0` fails it *open*); an empty state that **CONCLUDES**; a **SWEEP whose `ok` means it COMPLETED, not that its LANES worked**; a **DONE stamp in an ELSE that cannot tell IN FLIGHT from FINISHED** (#123). Cases: key-files-and-honesty.md
- ⚠ **`?? 0` on a supabase count, `|| 1` as a divide-guard, and a DEFAULTED DB COLUMN beside a NULL `*_checked_at` are the fabricated-value shapes.** **ANY unwrapper that RETURNS on failure** (#114) publishes a measured zero AND leaves every downstream `catch` dead; ⭐ **The DB form's tell is a PERFECT CORRELATION: `never_checked AND value=true` EXACTLY 0 means the value is the DEFAULT** (#112). ⛔ **A function projecting such a value must project its PROVENANCE too.** `no-fabricated-divisor-ratchet` bans it at zero. **Never persist a PARTIAL read as the fact** — a walk returning ROWS *and* an ERROR is the same shape (#119)
- 🚨 **A CLIENT-ONLY failure is captured by NOTHING but the 09-07 beacon** (Sentry SDK OUT OF THE TREE — #34, decided: no spend; Vercel sees only server execution): `usage_events.client_error` + the scheduled `E2E DOM Smoke` badge (#69). Verbatim: claude-md-condensed-originals.md.
- ⚠ **When you find one, grep for the EXPRESSION, not the file** — it has spread by copy-paste five times now; **a comment is only read by someone already in that file**.

Full canon + every instance: [docs/reference/key-files-and-honesty.md](docs/reference/key-files-and-honesty.md).

### Guards, tests and instruments

- ⚠ **`npx vitest run <file>` proves the FILE, and the SUITE is not the GATE: `npm test`+`tsc` pass trees `npm run lint:ratchet` reds (per-RULE).** A red run is not automatically yours: read the failing JOB first.
- ⚠ **Ask what RUNS a guard, not only whether it passes, and ASSERT THE COUNT IT INSPECTED** — a staged-only default inspected **nothing** on a CI checkout and exited 0. ⭐ **THE TELL IS SILENCE — one that normally states its count and then says nothing has not PASSED, it has not SPOKEN** — a `;` in an npm script dies in cmd.exe; use a **node driver**.
- ⚠ **Ask what a passing guard is structurally SILENT about — its DERIVATION fixes its blast radius, and its ROOT *and stated CLASS* are CLAIMS** (see testing-and-ci.md). **Prefer a tree walk over a curated list and a ban at zero over an allowlist; make *suppression* the curated list; assert an exclusion at the PROPERTY's granularity — and assert that a SECOND root CONTRIBUTES.** ⚠ **A control's POPULATION must be the set the property is TRUE of, not a proxy that coincides today** — a proxy expires silently. ⛔ **An AGGREGATE is never a proxy for the SLICE you measured** (98.1% all-visible, yet 42% heap fetches on the index’s first 0.23% — R109). ⛔ **A pin RE-DERIVED FROM THE OBSERVED STATE can never disagree with reality**: assert the DELTA it stood in for.
- ⚠ **A vacuous assertion reads as coverage everywhere, and mutation testing cannot find the worst kind** — **a test stating the contract in a comment and asserting something weaker.** The tell is the TITLE: a name carrying a negative claim or a transformation is a promise the assertion usually fails to keep. **Assert the ABSENCE of the false claim, not the PRESENCE of an error message.**
- ⚠ **Grep for the guards that READ a file before you EDIT it** — a pinned exemption reddened main (08-22).
- ⚠ **Tests that pin the defect they were named to prevent get INVERTED, never deleted** — a passing test asserting a promise is what holds that promise in place. **Pin the property, not the spelling**.
- ⚠ **A not-vacuous check must be satisfiable at a population of ZERO**, or the guard punishes its own success. Same for a guard that NAMES its instances — three have died on a rename. ⚠ **Strip comments before grepping source — with `scripts/lib/strip-comments.mjs`, NEVER a fresh copy.** **Still prefer a check that does not NEED it right** (`copyOf`).
- ⚠ **FIXING A GUARD WITHOUT FIXING ITS RECORD leaves the incidence unmeasurable** — fix the guard AND the field an observer keys on (testing-and-ci.md).
- ⚠ **A permanently-red or -zero instrument is indistinguishable from a broken one, and a CHECK THAT DIDN'T RUN from one that PASSED** (docs-only CI: testing-and-ci.md) — check the LOG, not the badge; **prove a watcher sees a FAILURE**. ⚠ **An ALARM SHARING ITS SUBJECT'S SCHEDULER is no alarm** — shed every tick 2.8h (#80).
- ⚠ **Every CI `run:` block is `bash -e`, so a fallible command in an ASSIGNMENT aborts the step there** — a retry loop after it is DEAD CODE that reads as coverage, and `jq` counts (exit 5 on a non-JSON body). Write `X=$(…) || X=""`, then check explicitly — ⛔ `|| X="0"` is WORSE: it never aborts, so the guard reports a clean read of what it never read.
- ⚠ **An exclusion justified by ANOTHER instrument is a claim about it — check that one can SEE the property**, and know what NOTHING here measures (LAYOUT, the BUILT BUNDLE).

Full detail: [docs/reference/testing-and-ci.md](docs/reference/testing-and-ci.md).

### Measurement discipline

- ⚠ **A filed FINDING is a hypothesis — re-derive what it measured before acting** (several refuted). ⚠ **So is a filed DECISION NOT TO ACT, and that is the one nobody re-checks — the tell is a cost stated with no number in it.** ⚠ **A WEAK reason CROWDS OUT the strong one and becomes PERMISSION when it dissolves.** ⚠ **A freshness STAMP is not a RATE, and a candidate its own NO-CHANGE CONTROL outperforms is not shown to work** — a stale `max(ingested_at)` read as “zero output” shipped a cadence change reverted 6 h later. ⚠ **Re-TEST a stated exit condition, never re-read it** — a "once cleared" 114 was 5.
- ⚠ **A plausible mechanism is not a measurement**, including when it flatters this file — a cheap sample beats a good story. ⚠ **And a probe whose HARNESS differs from production in the ONE dimension the answer depends on is not a measurement of production**: with **no `fonts`** supplied, `→` cost no fetch; production always passes `brandFonts()`, where it does.
- ⚠ **Name the caller before you touch the function** — an afternoon went into one with **zero** callers. **EIGHT sources, and the last two are INVISIBLE from a sandbox**; a TRIGGER function has no textual caller. ⚠ **A TABLE’s WRITERS the same — grep the DB: two pg_cron ones REFUTED a filed finding (#81).** Full list: [cron-and-schedulers.md](docs/reference/cron-and-schedulers.md).
- ⚠ **Read `cron.job.command` to learn what a schedule calls; never infer the callee from the name** — two objects one suffix apart yielded *opposite* conclusions.
- ⚠ **A directional claim needs a DISTRIBUTION, not a snapshot; a delta between two STOCKS is neither a rate nor a sign; `max()` on a `text` cursor is lexicographic.**
- ⚠ **When an instrument's first finding is SURPRISING, establish WHO generated it before believing WHAT it says** — 17 "user-facing" client errors were ONE headless crawler, `ua` in the payload all along (#69). **A `count(*)` over an OPEN endpoint counts REQUESTS, not READERS.**
- ⚠ **A rate POOLED ACROSS A FIX measures the fix's ABSENCE and reads as its FAILURE** — a kill rate was 87.5% pre-deploy, 0% post, **56% pooled**. ⛔ **Under an IO spell a cron DURATION or completion rate measures the ESTATE, not your fix — judge per-call work on pgss blocks/call** (R101 v1: reverted on durations, exonerated 26 min later). Split on the change point: [cron-and-schedulers.md](docs/reference/cron-and-schedulers.md).
- ⛔ **A DISCOVERY mechanism must never double as the REFRESH list.** Panini's scroll was also its refresh list: **1,265 of 5,072 editions went 45+ days unwalked under 2,103 runs, 0 fails.** Refresh reads your OWN catalogue: [panini](docs/strategy/panini-go-live-2026-09-19.md).
- ⚠ **Diff the SET, not the count** — a total can hold while membership turns over twice, so the number reads "no change" across a fix landing *and* a new arm firing. Case: [trust-board-and-safety.md](docs/reference/trust-board-and-safety.md).
- ⚠ **Controls, both directions:** a NULL result needs a positive control; a POSITIVE needs a no-change control **the fix cannot move**; a DIFFERENCE needs both sides counted by the same instrument. **Never pair a count from one table with a property from another.** ⚠ **A control must use the PRODUCTION CALLER**: a `postgres` MCP call cannot prove a `cron_heavy` job runs.
- ⚠ **FOUR ways a measurement lies about a change: a byte-identical HTTP response is as much a CACHE HIT as a fix; a DB A/B must be WARM-vs-WARM; an unordered `LIMIT` is physical order, not a sample** (use `abs(hashtext(k)) % N`); **and a reading taken while its SUBJECT CHANGED is not a reading** — ⛔ **and your OWN PROBE is the load here**. **Freeze the tree, then measure.** ⭐ **Warm-vs-warm also DIAGNOSES: expensive WARM = COMPUTE-bound (precompute it); cheap warm + expensive COLD = IO-bound (no index helps).**
- ⛔ **A METRIC'S DEFINITION LIVES IN CODE, NOT IN THE THRESHOLD YOU REMEMBER — a model that cannot reproduce TODAY'S value cannot predict tomorrow's.** A model that missed two code paths read 34% against an observed 53%, and that 19-point miss shipped as a **backwards call on a launch gate** (the two paths: claude-md-condensed-originals.md).
- ⚠ **An ELIGIBILITY count is not a GAIN count** — they differ by the share ALREADY in the target state: a lever sized at 173 rows moved **54** — 119 were already MEDIUM (+2.8 pts → +0.9). **Ask what would CHANGE, not what the rule would fire on.**
- ⚠ **AN ENGINE THAT IS UP IS NOT A PLATFORM THAT IS REACHABLE, and log SILENCE is not engine silence** — 09-18 the instance lost **outbound DNS** while Postgres kept writing (#122). ⭐ **A `<!DOCTYPE html>` from Supabase IS Cloudflare's `522`; probe an endpoint reading NONE of our tables to split ENGINE from PATH.**
- ⚠ **Read the ERROR STRING, never the duration — and ALL of it: the clause you SKIP discriminates.** Two ~2-min timeouts (gateway vs `statement_timeout`) give one number, two meanings: [database.md](docs/reference/database.md). ⛔ **Never state a cause the error did not** — half a string became false user-facing copy on 09-14.

### Timestamps

🚨 **EVERY TIME YOU REPORT TO TREVOR IS PT — chat, summaries, ledger headings, all of it. NEVER quote a UTC/`Z` time to him** (asked repeatedly; broken again 09-10). ⚠ **READ THE ZONE BEFORE CONVERTING — four incidents came from a plausible timestamp produced by a clock whose zone was assumed.** ⚠ Git Bash lies BOTH ways and the **web sandbox is PDT, not UTC**, so "subtract 7h from `date -u`" lands a day early. Trustworthy clocks + the conversion recipe: [tooling-gotchas.md](docs/reference/tooling-gotchas.md).

### Windows / Git Bash

- CRLF silently breaks Node string-replace patches — normalize CRLF→LF before matching, or target by line number. Heredocs truncate on long files; never use one containing `${{}}`. `curl` fails silently here for Vercel REST calls — always PowerShell `Invoke-WebRequest`.
- ⚠ **BACKTICKS IN `git commit -m "..."` ARE COMMAND SUBSTITUTION AND DELETE THE WORD SILENTLY** — the commit SUCCEEDS and the message still reads like prose. Write it to a file with a quoted heredoc (`<<'EOF'`) and use `git commit -F`.
- ⚠ **Assert the occurrence count before a scripted replace** (`n = s.count(old); assert n == 1`) — a silent no-op replace has produced a mutation "result" off a broken baseline, and a first-occurrence replace has hit a file's own header comment. ⚠ **Key any backup on the FULL PATH, never the basename** — three `page.tsx` targets shared one `.bak` and two files of uncommitted work were destroyed.
- ⚠ **Secret safety:** never broad-query the DOM (`querySelectorAll('input')`, full `read_page`) on pages that can hold secrets, and never echo Bearer/token values. ⚠ **`get_edge_function` AND `cron.job.command` BOTH hand back live gate keys** — each has burned one into a transcript (09-12). Redact or hash; never echo. Recipes: [tooling-gotchas.md](docs/reference/tooling-gotchas.md).

Full detail: [docs/reference/tooling-gotchas.md](docs/reference/tooling-gotchas.md).

### Database — the traps that bite most often

- **PostgREST caps reads at 1000 rows and CLAMPS an explicit `.limit()` above that**; a bare `.select()` clamps too. For a total, read the returned `count` (`head: true`), never `rows.length`.
- ⚠ **Any `.range()` pagination MUST carry a deterministic `.order()`** on a UNIQUE key, or it reads the right *number* of rows and the wrong *rows*. The duplicates and omissions **cancel**, so every count-based check passes — only a DISTINCT count or a set comparison sees it. Now a **ban at zero**.
- **A batch `.insert()` is ALL-OR-NOTHING — never swallow `23505` on one.** One duplicate fails the whole statement and writes none of the batch; on a cursored indexer that is permanent loss.
- ⚠ **A `LIMIT` bounds a query's OUTPUT, not its COST — "lower the limit" is often not a lever.** Cut ITEMS per tick, not rows per item, and compare **BUFFERS**, never timings — one `WHERE collection_id` took `drain_fmv_cold_tail` from 66,499 buffers to 741. ⚠ **Scoping an aggregate is an EQUIVALENCE claim: PROVE it over the population.**
- ⚠ **A differential upsert (`ON CONFLICT DO UPDATE … WHERE row IS DISTINCT FROM EXCLUDED`) WRITES the delta but PROBES every offered row** — 55k probes to write ~60 were ~700k of a tick's 927k buffers. LEFT JOIN the target first (cast to ITS types) and offer only the delta: −79 %/call (R101 v2, database.md).
- ⚠ **`SET statement_timeout` on a function is INERT on pg_cron; via PostgREST only a HIGHER one applies (gateway cap ~120 s).** ⛔ Most are load-bearing — do NOT strip.
- ⚠ **A queue walk that starts at the top of what it resolves COMPOUNDS** (three in one day, 09-07): page a BOUNDED slice of the INDEX behind a cursor, filter the page, walk a temp-table page row-by-row (no stats → every filter on every row before its LIMIT). Wire a new pg_net lane into the 4xx arm in its creating migration. [cron-and-schedulers.md](docs/reference/cron-and-schedulers.md)
- ⚠ **Every `apply_migration` causes a ~10–20 s burst of user-facing `PGRST002` 500s** (schema-cache re-introspection). Prefer a low-traffic window and batch migrations. `rpcWithRetry` does not save you — it retries for ~250 ms of a twenty-second outage.
- ⛔ **`CREATE OR REPLACE` IS A FULL-BODY WRITE — RE-READ THE LIVE OBJECT IMMEDIATELY BEFORE ONE.** A draft off a 40-min-old dump would have reverted another session's guard silently — you rewrite its pin too, so nothing reds; `pg_get_functiondef` LENGTH caught it. ⚠ On a VIEW it also RESETS reloptions, stripping `security_invoker=on` (4×) and cannot rename/reorder columns (`42P16`). [database.md](docs/reference/database.md)

- ⚠ **Revoke `FROM PUBLIC, anon, authenticated` in ONE statement** — either half alone leaves a grant (PUBLIC default AND `ALTER DEFAULT PRIVILEGES`). 🚨 **That REVOKE ORPHANS a pg_cron caller holding no explicit grant — `GRANT` to the job's role in the SAME migration (SECDEF is what it RUNS AS, not who may CALL it), and it fails as SILENCE: `cron.job_run_details` shows it, `pipeline_runs` never does.** Verify with `has_function_privilege`, never acl text; re-run `check_secdef_anon_exec_drift()` after creating ANY function.
- ⚠ **`check_*` return shapes are MIXED: a jsonb-array one reads CLEAN as `count(*) = 1` (read the LENGTH), a SETOF one as ZERO rows. Check the return type before interpreting a count** (which is which: database.md).
- ⚠ **`rows_written = 0` is a null instrument with three incompatible meanings, `ok = false` is overloaded the same way, and `extra.<step>=0` is the same trap one level down.** Read `extra` and `last_error`, pair every per-step count with an `_error` field, and **measure the OUTCOME table, not the self-report** — never retire a pipeline on `rows_written`. Cases: [cron-and-schedulers.md](docs/reference/cron-and-schedulers.md)
- ⛔ **A UNIQUE INDEX ON A PARTITIONED TABLE MUST CONTAIN THE PARTITION KEY — one that omits it is IMPOSSIBLE at the parent, so index the PARTITIONS.** ⭐ **The tell was EXACTLY zero violations** (#68: database.md). [database.md](docs/reference/database.md)
- ⚠ **A `*_at` name is not its contract — it is its WRITER's, so REPLACING a writer REDEFINES the column while the name holds** (4 surfaces, 1 PRICING). ⛔ **A CACHE keyed on one rots INVISIBLY — the tell is it disagreeing with the row it NAMES** (R107). `col_description()` first: [database.md](docs/reference/database.md).
- **`pipeline_runs` retains ~73h** — a missing record is usually a RETENTION ARTIFACT; `pipeline_runs_daily` is indefinite but **six-hourly**: never for RECENCY, the only long BASELINE. ⭐ **`rows_found` vs `rows_written` there splits *writer broke* from *upstream gives less*** (#70).
- **`apply_migration` for DDL; `execute_sql` for reads/verification.** ⚠ `CREATE INDEX CONCURRENTLY` needs `execute_sql` and runs **only if it FINISHES inside the 60 s client cap** — a timeout ABORTS it, leaving an `indisvalid=false` index. Record it with an `IF NOT EXISTS` migration so it is not fileless. ⚠ **A `SET …;` prefix puts a pg_cron command in a TRANSACTION BLOCK — CIC cannot: budget it as a TEMPORARY role default + a ONE-statement job, then `RESET statement_timeout`, ⛔ never `RESET ALL` (drops `search_path`).** FMV writes are delete-then-insert, NEVER upsert. MCP + schema gotchas: [tooling-gotchas.md](docs/reference/tooling-gotchas.md).

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

⚠ **That CHECK is on `flowty_transactions` ONLY** (verified live 08-22), so `'ufc_strike'` fails LOUDLY there and persists SILENTLY in `flowty_loans`/`flowty_loan_events`, where it simply never matches. Bridge: the `analytics_sales` view (long → short via CASE).

### Collection UUIDs

All 7 live in the DB-derived table in [schema-truth.md](docs/reference/schema-truth.md) — ⚠ **09-08: Candy MLB (`solana`) is `is_active=true` (#63); Panini (`ethereum`) is the ONLY inactive row.**

### Enums

- **Never `.ilike` an enum column — use `.eq`**; `fmv_snapshots.confidence` is UPPERCASE. ⚠ Two confidence vocabularies — `nba_player_projections.confidence` allows only 3-letter `MED`. Value lists (`fmv_confidence`, `tier_type`): [database.md](docs/reference/database.md). `chain_type`, and why `chain` lives on `collections` ONLY: [chain-strategy.md](docs/reference/chain-strategy.md).

### Series map (on-chain UInt32 → display name)

`0 = S1` · `2 = S2` · `3 = Summer 2021` · `4 = S3` · `5 = S4` · `6 = 2023-24` · `7 = 2024-25` · `8 = 2025-26`. **There is NO series=1 on-chain. Series 0 IS Series 1. There is NO "Beta".** ⚠ **These are the REPO's names; the live `collection_series.display_label` reads `Series 5/6/7` for 6/7/8 (re-verified 08-24) and drives the Collection tab filter via `/api/collection-series`** — check which convention your surface parses. `lib/collection/series-param.ts` now resolves BOTH (`fdf84ee4`); which label WINS is still open.

⚠ **This 0↔1 collision is TOP-SHOT-SPECIFIC — NEVER blanket-remap `1 → 0` across collections.** `wmc.series_number` is ON-CHAIN; `editions.series` is DISPLAY. All Day / Golazos / Pinnacle use `1` legitimately and **`ufc_strike` has BOTH 0 and 1**, so a blanket remap corrupts four collections — a 2026-08-05 incident dropped 385,734 TS rows. Check `collection_series` before touching any series logic.

### Cadence

⚠ **MCP-verify deployed mainnet source before any `.cdc`, Cadence literal or FCL `mutate`/`query`** — [apis-and-cadence.md](docs/reference/apis-and-cadence.md).

---

## Concierge non-negotiable rules

1. **RPC is READ-ONLY** — no cart, no gifting, no trading. **Never offer an action the product lacks.** This binds every surface, not just the concierge.
2. **Pinnacle FMV**: NEVER join by `edition_key` alone — always the triple (`character_name`, `set_name`, `variant_type`) per `92aab30`.
3. **The prompt RECITES the data layer — DERIVE it**: thresholds interpolate `lib/fmv-confidence.ts`, coverage read live, never hand-typed.

The rest: [concierge.md](docs/reference/concierge.md).

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

- Flow CLI hot wallet: `0x3aa11c84d776838f` (Key 0, **ECDSA_secp256k1, SHA2_256**). NOT account-linked. `flow.json` gitignored. NEVER use a HybridCustody / linked wallet as the hot wallet. Code signing as this wallet MUST use secp256k1 + SHA2-256 (`server-authz.ts` used p256 + SHA3-256 for months); tests for signing code must verify signatures **cryptographically**, never assert output shape/length.
- Key env vars (8, incl. 3 absent from `.env.example`): [tooling-gotchas.md](docs/reference/tooling-gotchas.md).

---

## Prioritized next actions

**The canonical forward plan is [docs/strategy/roadmap-2026-08-03.md](docs/strategy/roadmap-2026-08-03.md).** Thesis: **accuracy is the GATE, not a phase** — growth tactics stay removed until the data beats the sites collectors already use; headline metric is the share of prices at HIGH/MEDIUM confidence. Still binding: **intelligence-first**; Cart / Trade Hub / gifting removed (**read-only product**); **monetization tabled until 50+ weekly active users**; no infra spend pre-revenue.

**Open items, stated rather than quietly dropped:**

- **sports-proxy `403` — ⛔ "PROXY ESPN" IS MEASURED DEAD** (#8).
- `fmv-recalc` — wasteful, NOT broken, SIZED (it owns the DB's #1 reader): roadmap-status.md.
- 🚨 **Needs TREVOR, not code — two:** the **credential-purge residue** (branch deleted 09-07; ask GitHub to **GC** the unreachable objects, **rotate regardless** — #22) · ⛔ **both 2-hourly Routines STILL DISABLED, no approval card — re-verified live 09-18, last fire 09-01, 17 days dead** (#55).
- **GO-LIVE bars + blockers: [go-live-2026-09.md](docs/strategy/go-live-2026-09.md)** — verification gate DROPPED (#59), beacon LIVE (its "first real finding" was RETRACTED — a crawler, #69), **M1 53.1 / M2 28.7 mean, 27 legs to 09-18 (23/27 ≥50 · 6/27 ≥30) — READ THE SERIES (`rpc_trust_health_history`), NEVER A LEG; M2's blocker RELAXED (NFL season)** (#63, #64).

Full status + accuracy measurements: [docs/reference/roadmap-status.md](docs/reference/roadmap-status.md). Issue register: [docs/reference/known-issues.md](docs/reference/known-issues.md).

---

## Recent sessions

Session entries live in `docs/sessions/`, one per month; none is needed to start work. **Write into the CURRENT month's file (prepend, newest-first), never here**, and **promote every durable lesson into this file or the matching `docs/reference/*.md` — a fact left only in a session log stops being read.**

⚠ **`docs/archive/**`, `docs/health/**` and `docs/sessions/**` are frozen history — never rewrite their links.** Layout: [session-and-archive-conventions.md](docs/reference/session-and-archive-conventions.md).
