# Rip Packs City — Claude Code AI Assistant Configuration

> **HOW THIS FILE WORKS (restructured 2026-08-17).** The memory-file limit is `max(40000, contextWindow × 0.05 × charsPerToken)` — **40,000 on a standard 200k session**, which is what the nightly pass, Cowork and every subagent run at. This file carries only what a session needs *before* it knows its topic; the rest moved **verbatim** to `docs/reference/*.md`. Nothing was deleted — a rule that feels missing is in one of those files.
>
> **KEEPING IT UNDER: the limit is on CHARACTERS; `wc -c` counts BYTES and this file lives inside that gap** (it once read 40,086 on a true 39,610). **Count with `node -e`, not `wc`** — `.length` is what the harness and CI's guard both measure (4 instruments: [tooling-gotchas.md](docs/reference/tooling-gotchas.md); full case: `__tests__/claude-md-stays-under-the-memory-file-limit.test.ts`). ⚠ **The file is at its size EQUILIBRIUM, so a new durable rule must DISPLACE one** — put the displaced text **verbatim** in the matching `docs/reference/*.md` with a one-line pointer from here. **Over the limit the whole file is flagged and stops being trustworthy context.**
>
> ⚠ **Two rules govern every number here and in those docs. (1) Every figure is a DATED SAMPLE, not a constant — re-measure before quoting it. (2) A recorded correction has a shelf life** (examples: [claude-md-condensed-originals.md](docs/reference/claude-md-condensed-originals.md)). **Re-derive; do not quote.**

---

## Reference index

All under `docs/reference/`:

- **`key-files-and-honesty.md`** — largest and most-read. Key modules + the full **"a failed read must not render as an answer"** canon, leak guards, fabricated-number shapes, OG cards, Workers.
- **`database.md`** — `editions` · `wmc` · `fmv_snapshots` · `sales`, role timeouts, PostgREST caps, `apply_migration` cost, **Security posture**.
- **`testing-and-ci.md`** — vitest layers, the 3 coverage gates + ratchets, DB-invariant SQL pins, mutation categories, CI jobs (incl. the `bash -e` abort class), Playwright.
- **`known-issues.md`** — open/resolved register (stable item numbers), deferred hardening, deep-audit follow-ups.
- **`cron-and-schedulers.md`** — the 4 schedulers, pg_cron mechanics, `pipeline_runs` retention + rollup traps, fleet health, saturation findings.
- **`trust-board-and-safety.md`** — trust board (⚠ the arm count drifts and the view CAN time out at 60 s — prefer the sentinel's `Trust Health` check to any number in that file), precompute split, destructive-op breaker, cross-session coordination.
- **`chain-strategy.md`** — multi-chain thesis, Candy/Solana + Panini readiness, chain-abstraction Phases A–F.
- **`routes-and-surfaces.md`** — route structure, per-collection `pages`, API endpoints, search.
- **`apis-and-cadence.md`** — Top Shot / All Day GraphQL, Flowty, Flow REST, the RPC FMV API, contract addresses, Cadence gotchas.
- **`concierge.md`** · **`brand-auth-proxy.md`** · **`tooling-gotchas.md`** · **`packs.md`** · **`architecture-notes.md`** · **`ledger-discipline.md`** · **`autonomous-tasks.md`** · **`roadmap-status.md`** · **`session-and-archive-conventions.md`** · **`parallels-variants-data-model.md`** · **`revert-map-2026-07-25.md`**.
- **`claude-md-condensed-originals.md`** — verbatim pre-restructure text of sections **shortened rather than moved**. ⚠ **Check here first if a detail seems missing.**
- **`schema-truth.md`** — read from the live DB; **wins on any disagreement with prose — but only as fresh as its stamp** (no generator script; it once sat 25 days stale outranking a correct doc).

---

## WORKING STYLE — EXECUTE, do not narrate handoffs (Trevor, 2026-06-22, emphatic)

Cowork has a push-capable clone, Supabase MCP (read+write), Vercel/Sentry, Chrome and scheduled-task/artifact tools. **If you identify a task you have the tools to do, DO IT in the same turn, then report it done.** Do NOT call something a "Claude Code handoff" or "operator item" and stop when you could execute it yourself. Hand off ONLY what needs access you lack — and hand off the committed artifact, never a promise. Narrating work instead of shipping it angered Trevor ("lazy antics"). Ship first, summarize second, keep talk minimal.

## Ledger — log every change that touches `main` or prod state

Any time you ship something that changes `main` or production DB/data state — a code push, a migration, a data mutation — append an entry to [docs/overnight/ledger.md](docs/overnight/ledger.md) **in the same turn**, short: **date · what shipped · revert path**. Newest at the top of the dated section. Skip it for pure research / Q&A / no-op turns.

⚠ **RE-READ THE LEDGER FROM DISK IMMEDIATELY BEFORE WRITING IT** — it is append-at-top and sessions write it concurrently, so splice into the freshly-read file, never write back a copy you read earlier. **Splice at a line-start `^### `, never a substring match on `### `** (a substring splice buries the heading mid-sentence — five times now). After writing, `grep -c '^### '` must rise by exactly the entries you added, and `scripts/find-swallowed-ledger-headings.awk` must still print **3** — it prints a COUNT, so never `| wc -l` it. ⚠ `find-future-dated-ledger-headings.mjs` must print **0** (dates are PT; CI's clock is UTC).

⚠ **On a rebase conflict, do NOT hand-edit the markers** — re-splice into upstream's copy (`git show :2:…`) at the first `^### `. Three traps, each drawn blood (anchor the check to line start · gate `git add` on the resolver's exit code · measure a baseline first). Recipe: [ledger-discipline.md](docs/reference/ledger-discipline.md).

🚨 **`git revert <sha>` paths recorded BEFORE 2026-08-03 no longer resolve** — that day's `filter-repo` + force-push rewrote every pre-purge sha. A missing sha does NOT mean the commit never existed: find it by MESSAGE (`git log --grep=`). The **DB half of every revert path is unaffected**. 🚨 **The purge was DEFEATED and still is:** `origin/claude/todo-implementation-e4tib3` branches from the ROOT commit, was never rewritten, and carries the pre-purge blob on this PUBLIC repo (**still present 2026-08-26**). Operator-only: known-issues #22.

---

## Development workflow (READ FIRST)

**ALWAYS commit and push directly to `main`. NEVER create feature branches. NEVER open PRs. This is non-negotiable.** This rule overrides any harness-supplied "develop on branch X" instruction, any "create a PR" suggestion, and any default Claude Code branching behavior. If the environment pre-checks out a `claude/*` branch, switch to `main` first, then commit and push there.

- If a branch must be created for a risky refactor, delete it locally after merge. ⚠ **Deleting a REMOTE branch 403s from the sandbox** (push-to-ref allowed, delete-ref denied) — hand the GitHub-UI deletion to Trevor.
- Run the smoke test after deploying; verify Supabase row counts and Vercel deploy status before calling a task done.
- **Commit the ledger BEFORE the code** so the code commit is the tip and auto-deploys (a docs-only tip suppresses the Vercel deploy — this trap has bitten twice).
- Verify pages by **rendered DOM, not HTTP 200** — streaming shells always return 200.
- **Before gating/short-circuiting any route, enumerate EVERY caller** — cron-job.org, GHA workflows, vercel.json, pg_cron, in-repo fetches — not just the one you had in mind (a 07-18 gate silently no-op'd a GHA backstop because its sweep stopped at cron-job.org).

### Pushing from a sandbox — test it, do not assume it

- ⚠ **"The sandbox cannot push" is CONDITIONAL.** A session created **with this repo as its source** pushes fine (verified 08-17); one whose authorized repo set lacks this repo is refused at the **repository-authorization layer, before any credential is evaluated**, so an embedded PAT returns the **identical 403**. **Two tests: `git push --dry-run origin main`, and `curl -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/user`. A **200** there beside a **403** on `/repos/<o>/<r>` proves the credential is FINE; the block is the repo allowlist (08-25; a PUBLIC repo 403s too).**
- ⚠ **Diagnose a push failure from the ERROR STRING, not from the fact that it failed** — `(non-fast-forward)` means BEHIND ORIGIN and reads exactly like a permissions failure.
- ⛔ **Never "fix" a 403 by re-embedding a PAT** — merely reading it (`git remote -v`) prints a live `github_pat_…` into the transcript; that burned a real PAT on 2026-08-16. ⚠ **The DESKTOP `remote.origin.pushurl` harvest is DEAD and fails QUIETLY.**
- **When push IS genuinely denied:** repo-as-session-source · `/web-setup` in a REAL TERMINAL session (authorizes at CREATION, so it fixes the NEXT one) · desktop "Run this task" · or **`git format-patch`**, proven end-to-end.
- ⚠ **A no-push session's DB reach is narrower than `apply_migration` suggests** — a PINNED SQL function is PUSH-GATED and every `apply_migration` reds `migration-parity` until its file is committed. **Real no-push levers: pg_cron schedules, indexes, new objects**; `execute_sql` for SCRATCH DDL.
- Bash-green ≠ push-green; never commit from the mount. Full history: [tooling-gotchas.md](docs/reference/tooling-gotchas.md).

## Autonomous Cowork tasks

Two scheduled Cowork tasks run here — coordinate via the shared ledger so work doesn't collide.

- **`rpc-daytime-monitor`** — READ-ONLY, ~3-hourly. Sweeps health, files candidates to `docs/overnight/inbox/`. Ships nothing.
- **`rpc-nightly-autonomous-pass`** — 1am local. Drains the inbox, ships ≤4 low-risk changes to `main` (collision- and CI-gated, each verified by a fresh subagent), writes a handoff + digest. Off-limits (queued, never auto-shipped): hot/payer wallet, secrets/env, auth (`proxy.ts`), destructive SQL — full list in [autonomous-tasks.md](docs/reference/autonomous-tasks.md).

Shared state in `docs/overnight/`: `ledger.md` (**"Declined — do not re-suggest"** is Trevor's heading), `inbox/` (⚠ `INDEX.md` carries **4 CI assertions, TWO of them COUNTS** — archiving one deletes its entry too), `metrics-latest.json`, `focus.md`, `.lock`. **Skim `ledger.md` first**; the night pass will not edit files committed in the last 24–48h. To halt autonomous shipping, create `docs/FREEZE.md`. Detail: [autonomous-tasks.md](docs/reference/autonomous-tasks.md).

---

## Project overview

Rip Packs City (RPC) is a production-grade Flow blockchain digital collectibles intelligence platform: analytics, deal-finding, sniper tools, FMV pricing and badge tracking across the 5 published Flow collections (NBA Top Shot, NFL All Day, LaLiga Golazos, Disney Pinnacle, UFC Strike). Trevor (founder) holds an official Portland Trail Blazers Team Captain designation on NBA Top Shot — a key brand differentiator.

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

⚠ **A pipe reports the LAST command's exit code.** `npx tsc --noEmit 2>&1 | tail -5 && echo "EXIT=$?"` reports **`tail`'s** status — it printed `EXIT=0` from a sandbox with no `node_modules`. Run bare and echo `$?`, or read `${PIPESTATUS[0]}`.

---

## Standing rules — the cross-cutting lessons

These are the rules a session needs *before* it knows which subsystem it is in. Each links to where the full case history lives.

### Honesty — a failed read must not render as an answer

**The single most productive defect class on this platform (~24 by 08-17, ≥13 more by 08-24 — a count, so already stale).** A read fails, and the surface publishes the failure as a *fact*: "No +EV packs right now" out of a 503, "0 moments / $0" out of a timeout, "Follow a team to build your hub" to someone who follows six. Four layers, four helpers — pick the one for your layer, do not invent a fifth:

| layer | helper |
|---|---|
| any API route a user can reach (anon OR signed-in) | `lib/api-error.ts` → `apiErrorResponse()` (its `/api/public/**` alias `boardUnavailable()` lives in `lib/insights/board-error.ts`) |
| server page | `lib/insights/board-status.ts` → `summarizeDegraded()` / `degradedFromSource()` |
| client dashboard | `lib/analytics/fetch-json.ts` → `fetchJson()` (discriminate on `ok`, **never** on `json == null`) |
| OG social card | `lib/og/board-empty-copy.ts` → `boardEmptyCopy(fetched, noun)` |

- ⚠ **A PAGED read that `break`s on error returns a PARTIAL list no caller can distinguish from a complete one** (`/sitemap/3.xml`, 24k of 27.2k under a **200** — FIXED #28). No copy exists to grep — the tell is the control-flow keyword. Throw, or carry `complete:false`.
- **There are always THREE states, never two:** read failed · read ok + genuinely empty · read ok + unrenderable (e.g. rows that failed a name join). A name filter is not an emptiness test.
- ⚠ **A SERVER-SEEDED PROP is a fifth layer the table does not cover:** `initial={rows}` arrives as `[]` with **no provenance**, so a component that distinguishes failure for its OWN fetch still concludes on the seed (7 by 08-24). Pass `initialFailed`, and **assert it by SSR (`renderToString`)** — a mount effect corrects the state before jsdom looks, so two OPPOSITE mutations pass every client test.
- ⚠ **ISR CACHES A FAILED READ for the whole `revalidate` window** — a COLD regeneration over the 8 s `BOARD_LIVE_TIMEOUT_MS` served `/insights/pack-drops` degraded **15 min** at `x-vercel-cache: HIT` while the API answered in 1.2 s. It self-heals warm, so it is **easy to declare fixed by accident**: test *"does a COLD pass exceed the budget"*, never *"is the page OK now"*.
- **Fix per PANEL, not per page.** A page with one honest error branch is not an honest page — instance six landed on a page a prior audit had already hardened.
- **The worst sub-classes:** a false claim about the reader's **own account** (actionable — it makes them redo finished work); a page that **loads state and writes it back** (a failed read there is a *delete*, so WITHHOLD the form, don't annotate it); an **alert** (its output is silence, so the error is unfalsifiable); a **guard** (`?? 0` on a count makes a check fail *open*); and an empty state that **concludes** ("your moments are priced at or below market") rather than reports.
- ⚠ **`?? 0` on a supabase count and `|| 1` as a divide-guard are the fabricated-number shapes.** supabase-js **RETURNS** errors rather than throwing, so a failed count resolves `{count: null, error}` — `Promise.all`/`allSettled`/`try-catch` do not help, and `?? 0` publishes a measured zero. `|| 1` on a $0 baseline rendered **"↑ 50000.0% / 30D"**. `no-fabricated-divisor-ratchet` is a **ban at population zero**.
- 🚨 **A CLIENT-ONLY failure is captured by NOTHING** — Sentry has dropped every event since 08-18 (#34; not paying is Trevor's call), Vercel sees only server execution, no `window.onerror` exists. **The scheduled `E2E DOM Smoke` badge is the ENTIRE detection surface** (live React #418: #37).
- ⚠ **When you find one, grep for the EXPRESSION, not the file** — it has spread by copy-paste five times now; **a comment is only read by someone already in that file** (instances: [key-files-and-honesty.md](docs/reference/key-files-and-honesty.md)).

Full canon + every instance: [docs/reference/key-files-and-honesty.md](docs/reference/key-files-and-honesty.md).

### Guards, tests and instruments

- ⚠ **`npx vitest run <file>` proves the FILE, not the tree — run the full suite before pushing.** A red run is not automatically yours: read the failing JOB first.
- ⚠ **Ask what RUNS a guard, not only whether it passes, and ASSERT THE COUNT IT INSPECTED** — a staged-only default inspected **nothing** on a CI checkout and exited 0.
- ⚠ **Ask what a passing guard is structurally SILENT about — its DERIVATION fixes its blast radius, and its ROOT is a CLAIM** (one walked `app/api/cron` while the tenth copy sat in the `lib/` module two routes delegate to). **Prefer a tree walk over a curated list and a ban at zero over an allowlist; make *suppression* the curated list; assert an exclusion at the PROPERTY's granularity — and assert that a SECOND root CONTRIBUTES.** Cases: [testing-and-ci.md](docs/reference/testing-and-ci.md).
- ⚠ **A vacuous assertion reads as coverage everywhere, and mutation testing cannot find the worst kind** — **a test stating the contract in a comment and asserting something weaker.** The tell is the TITLE: a name carrying a negative claim or a transformation is a promise the assertion usually fails to keep. **Assert the ABSENCE of the false claim, not the PRESENCE of an error message.**
- ⚠ **Grep for the guards that READ a file before you EDIT it** — a pinned exemption reddened main (08-22).
- ⚠ **Tests that pin the defect they were named to prevent get INVERTED, never deleted** — a passing test asserting a promise is what holds that promise in place. **Pin the property, not the spelling** (twice: a literal `count ?? 0`; a comment's line WRAPPING).
- ⚠ **A not-vacuous check must be satisfiable at a population of ZERO**, or the guard punishes its own success. Same for a guard that NAMES its instances — three have died on a rename. ⚠ **Strip comments before grepping source for user copy — with `scripts/lib/strip-comments.mjs`, NEVER a fresh copy** (a copy-pasted stripper blanked 100k+ chars of real source and hid a live P0; **49** files import the shared one, `MAX_LOCAL_STRIPPERS` ratchets at **2**, down only); at least six guards have fired on the comment documenting the fix.
- ⚠ **FIXING A GUARD WITHOUT FIXING ITS RECORD leaves the incidence unmeasurable** — 8 of 10 saturation breakers logged `extra: {}`, so the obvious query saw **1** event and a shape-independent one saw **3**. Fix the guard AND the field an observer keys on.
- ⚠ **A permanently-red or permanently-zero instrument is indistinguishable from a broken one at a glance** — check the LOG, not the badge, and **prove a watcher can see a FAILURE** before relying on it ([testing-and-ci.md](docs/reference/testing-and-ci.md)).
- ⚠ **Every CI `run:` block is `bash -e`, so a fallible command in an ASSIGNMENT aborts the step there** — a retry loop after it is DEAD CODE that reads as coverage, and `jq` counts (exit 5 on a non-JSON body). Write `X=$(…) || X=""`, then check explicitly.
- ⚠ **An exclusion justified by ANOTHER instrument is a claim about it — check that one can SEE the property.** Two guards skipped `app/api` as "in the primary gate"; coverage sees whether lines RUN, not whether `error` is handled — 7 defects, 259 unlooked reads. ⚠ **NOTHING here measures LAYOUT** (jsdom boxes are ZERO; only the real browser in `e2e/mobile-layout.spec.ts` sees it) **nor the BUILT BUNDLE** (turbopack dropped a quasi from a `+`-joined template). Both shipped WRONG for weeks with every gate green — full cases: [testing-and-ci.md](docs/reference/testing-and-ci.md).

Full detail: [docs/reference/testing-and-ci.md](docs/reference/testing-and-ci.md).

### Measurement discipline

- ⚠ **A filed FINDING is a hypothesis — re-derive which subsystem it measured before acting.** Several have been refuted; one "fix" would have made an accurate surface inaccurate. ⚠ **So is a filed DECISION NOT TO ACT, and that is the one nobody re-checks** — declining to act reads as the conservative choice. The tell is a cost stated with no number in it. ⚠ **A number is no immunity: re-TEST a stated exit condition, never re-read it** — a "once cleared" 114 was 5.
- ⚠ **A plausible mechanism is not a measurement**, including when it flatters this file. Test the tidy hypothesis before acting on it; a cheap sample beats a good story.
- ⚠ **Name the caller before you touch the function** — an expensive-looking function is not a cost until you have; an afternoon went into one with **zero** callers. Require SIX sources: `pg_proc.prosrc`, `pg_views.definition`, `cron.job.command`, `pg_trigger`, a full-repo grep — ⚠ **and the Cowork artifacts' HTML, outside BOTH repo and catalogue**. ⚠ **A TRIGGER function has no textual caller, and `pg_stat_statements` misleads BOTH ways** ([database.md](docs/reference/database.md)). ⚠ **SEVENTH: cron-job.org; EIGHTH: this box's Task Scheduler (4 prod ingests)** — both invisible to all six.
- ⚠ **Read `cron.job.command` to learn what a schedule calls; never infer the callee from the name** — two objects one suffix apart yielded *opposite* conclusions.
- ⚠ **A directional claim needs a distribution, not a snapshot** (`fmv-recalc`: 3 failed characterizations in 2 days off one-instant reads), and **compare against the series' own history before calling something a regression** — a "collapse" turned out to be its rate for three weeks. Read a current-day rollup row as PARTIAL. ⚠ **A delta between two STOCKS across an unknown interval is neither a rate nor a sign** — a burst read as a trend, retracted at the third reading; measure the FLOW (`created_at` on the same predicate). ⚠ Aggregating a `text` column (`max(cursor_after)`) is a lexicographic max — it reported `'9500' > '11500'` and made a **wedged** sweep look like an advancing one.
- ⚠ **Diff the SET, not the count.** The trust board's breached membership changed twice in one day while the total held at 5 — diffing the number shows "no change" across a fix landing *and* a new arm firing.
- ⚠ **Controls, both directions:** a NULL result needs a positive control; a POSITIVE needs a no-change control; a DIFFERENCE needs both sides counted by the same instrument. **Never pair a count from one table with a property sampled from another.** ⚠ **A control must use the PRODUCTION CALLER**: a `postgres` MCP call cannot prove a `cron_heavy` job runs ([database.md](docs/reference/database.md)).
- ⚠ **Three ways a measurement lies about a change: a byte-identical HTTP response is as much a CACHE HIT as a fix; a DB A/B must be WARM-vs-WARM; an unordered `LIMIT` is physical order, not a sample** (use `abs(hashtext(k)) % N`). Each cost a wrong conclusion — cases: [database.md](docs/reference/database.md).
- ⚠ **Read the ERROR STRING, never the duration.** The Supabase gateway timeout and the Postgres global `statement_timeout` are both ~2 minutes, so `upstream request timeout` and `canceling statement due to statement timeout` produce the same number and mean completely different things.

### Timestamps

**DATES ARE PACIFIC (Trevor operates in PT).** ⚠ **READ THE ZONE BEFORE CONVERTING — four incidents came from a plausible timestamp produced by a clock whose zone was assumed.** Git Bash lies both ways (`TZ=` returns **UTC labelled `GMT`**; bare `date` has read a calendar DAY ahead) and the **web sandbox is PDT, not UTC**, so "subtract 7h from `date -u`" lands a day early. Trustworthy: `date '+%Z'` first, then PowerShell `Get-Date -Format "yyyy-MM-dd HH:mm zzz"` (it prints the offset, so it cannot lie silently). Convert to PT before stamping any `### <date>` here or in the ledger.

### Windows / Git Bash

- CRLF silently breaks Node string-replace patches — normalize CRLF→LF before matching, or target by line number. Heredocs truncate on long files; never use one containing `${{}}`. `curl` fails silently here for Vercel REST calls — always PowerShell `Invoke-WebRequest`.
- ⚠ **BACKTICKS IN `git commit -m "..."` ARE COMMAND SUBSTITUTION AND DELETE THE WORD SILENTLY.** A message about `` `over` `` commits as *"applies to  ONLY"* — still reads like prose, and the commit SUCCEEDS while printing `command not found` to stderr. Write it to a file with a quoted heredoc (`<<'EOF'`) and use `git commit -F`.
- ⚠ **Assert the occurrence count before a scripted replace** (`n = s.count(old); assert n == 1`) — a silent no-op replace has produced a mutation "result" off a broken baseline, and a first-occurrence replace has hit a file's own header comment. ⚠ **Key any backup on the FULL PATH, never the basename** — three `page.tsx` targets shared one `.bak` and two files of uncommitted work were destroyed.
- ⚠ **Secret safety:** never broad-query the DOM (`querySelectorAll('input')`, full `read_page`) on pages that can hold secrets, and never echo Bearer/token values. ⚠ **`mcp__*__get_edge_function` returns the FULL deployed `index.ts`, not metadata** — a config question once echoed a live gate key into the transcript. To compare a key without echoing it, hash both sides and compare digests only.

Full detail: [docs/reference/tooling-gotchas.md](docs/reference/tooling-gotchas.md).

### Database — the traps that bite most often

- **PostgREST caps reads at 1000 rows and CLAMPS an explicit `.limit()` above that**; a bare `.select()` clamps too. For a total, read the returned `count` (`head: true`), never `rows.length`.
- ⚠ **Any `.range()` pagination MUST carry a deterministic `.order()`** on a UNIQUE key, or it reads the right *number* of rows and the wrong *rows*. The duplicates and omissions **cancel**, so every count-based check passes — only a DISTINCT count or a set comparison sees it. Now a **ban at zero**.
- **A batch `.insert()` is ALL-OR-NOTHING — never swallow `23505` on one.** One duplicate fails the whole statement and writes none of the batch; on a cursored indexer that is permanent loss.
- ⚠ **A `LIMIT` bounds a query's OUTPUT, not its COST — "lower the limit" is often not a lever.** `drain_fmv_cold_tail` grouped the WHOLE of `fmv_snapshots` to answer a question about one collection's 518 editions — **66,499 buffers / 38.6 s → 741 / 0.17 s** off one `WHERE collection_id`, identical result (**FIXED 08-25**). Cut ITEMS per tick, not rows per item, and compare **BUFFERS** — a saturation spell confounds every timing, both ways. ⚠ **Scoping an aggregate is an EQUIVALENCE claim: PROVE it over the population** (0 of 1,281,003 rows disagreed); a plan comparison only shows *faster*.
- ⚠ **A function's `SET statement_timeout` is PATH- AND DIRECTION-dependent (A/B 08-27): inert on pg_cron (44/248 overrun, worst 596 s), but via PostgREST a HIGHER one RAISES the ceiling** (30→60 s; lower stays inert), so **a `supabaseAdmin` RPC is bounded by its CALLEE's declaration** — the old "unbounded 352 s". ⛔ **122 of 195 exceed 30 s: load-bearing, do NOT strip as no-ops.** ⚠ `anon`/`auth` not re-probed; `authenticator`'s 8 s stands (**no 3 s bound on anon compute**). [database.md](docs/reference/database.md).
- ⚠ **Every `apply_migration` causes a ~10–20 s burst of user-facing `PGRST002` 500s** (schema-cache re-introspection). Prefer a low-traffic window and batch migrations. `rpcWithRetry` does not save you — it retries for ~250 ms of a twenty-second outage.
- ⚠ **`CREATE OR REPLACE VIEW` with no `WITH` clause RESETS reloptions and silently strips `security_invoker=on`** (four occurrences). `ALTER VIEW … SET (security_invoker = on)` is the repair. It also **cannot rename or reorder columns** (`42P16`) — and the rolled-back SQL test cannot catch that, because it builds the object where no prior definition exists.
- ⚠ **`REVOKE … FROM PUBLIC` alone is not enough, and neither is `FROM anon, authenticated` alone** — this DB carries both a PUBLIC default and `ALTER DEFAULT PRIVILEGES` grants. Revoke **`FROM PUBLIC, anon, authenticated`** in one statement, and verify with `has_function_privilege`, never the acl text. Re-run `check_secdef_anon_exec_drift()` after creating ANY function.
- ⚠ **`check_*` functions have MIXED return shapes.** A jsonb-array one returns `count(*) = 1` when CLEAN — read the array LENGTH; a SETOF one returns **zero rows** when clean. **Check the return type before interpreting the count** (which is which: [database.md](docs/reference/database.md)).
- ⚠ **`rows_written = 0` is a null instrument with three incompatible meanings** (correct-and-broken, wrong-and-healthy, correct-and-failing) and `ok = false` is overloaded the same way. Read `extra` and `last_error`; never retire a pipeline on `rows_written`. ⚠ **An IDENTICAL `rows_written` across a success and a failure is a stale cache being rewritten, not health** (`ownership-sync-dune`, [cron-and-schedulers.md](docs/reference/cron-and-schedulers.md)). Measure the OUTCOME table, not the self-report.
- **`pipeline_runs` retains ~73h** — a missing record is usually a RETENTION ARTIFACT; `pipeline_runs_daily` is indefinite but **six-hourly**, so never read it for RECENCY. ⚠ **For a pg_cron `net.http_get` pipeline, `net._http_response` splits dispatched / killed / answered with NO deploy.**
- **`apply_migration` for DDL; `execute_sql` for reads/verification.** ⚠ `CREATE INDEX CONCURRENTLY` is reachable ONLY via a **one-statement pg_cron job** (libpq), never `execute_sql`. FMV writes are delete-then-insert, NEVER upsert. Always query `information_schema.columns` before writing a route handler; Supabase MCP multi-statement queries return only the last result.

Full detail: [docs/reference/database.md](docs/reference/database.md).

### Vercel

- **A docs-only TIP can NEVER force a rebuild** — `ignoreCommand` diffs `HEAD^..HEAD`; ⚠ the v13 POST does NOT override it. Touch a non-docs file.
- **Pro Lambda `maxDuration` hard cap is 800s.** Higher sends the deploy to ERROR *invisibly*.
- ⚠ **`get_deployment.state` LAGS** — corroborate with `ready` vs `buildingAt`, aliases attached, `lambdaRuntimeStats` present; and **check deploy state PER COMMIT**, because an ERRORed deploy is superseded by the next push.
- **A disk-IO saturation spell can FAIL THE WHOLE PRODUCTION BUILD** (prerendered `/insights` pages get 60 s each) — now a ban at zero, `insights-server-pages-bound-their-reads`; ⚠ twice the failing page was one the pushing commit never touched.
- ⚠ Both log tools mislead: `level:["warning"]` reads ZERO (the value is `warn`; warn IS indexed), and `get_runtime_errors` attribution is SMEARED. Re-group on `requestPath`.

---

## Quick-reference facts

### Two collection-string conventions (CRITICAL footgun)

Two vocabularies, not interchangeable — mixing them corrupts `flowty_*` writes.

- **Long-form** (`sales`, `editions`, `collections.slug`): `nba_top_shot` · `nfl_all_day` · `laliga_golazos` · `disney_pinnacle` · `ufc_strike`
- **Short-form** (`flowty_transactions`, `flowty_loans`, `flowty_loan_events`): `topshot` · `allday` · `golazos` · `pinnacle` · `ufc` · `unknown` — the CHECK whitelists exactly these six, NOT `other`

⚠ **That CHECK is on `flowty_transactions` ONLY** (verified live 08-22; the other two carry no `collection` CHECK), so `'ufc_strike'` fails LOUDLY there and persists SILENTLY in `flowty_loans`/`flowty_loan_events`, where it simply never matches. Bridge: the `analytics_sales` view (long → short via CASE).

### Collection UUIDs

All 7 live in the DB-derived table in [schema-truth.md](docs/reference/schema-truth.md) — **re-verified against `public.collections` 2026-08-24, zero drift.** Candy MLB is `solana` and Panini `ethereum`; both are the `is_active=false` rows.

### Enums

- `fmv_snapshots.confidence` is UPPERCASE: `HIGH · MEDIUM · LOW · NO_DATA · ASK_ONLY · SALES_ONLY · STALE`. **Never `.ilike` an enum column — use `.eq`.** ⚠ `nba_player_projections.confidence` allows only `HIGH | MED | LOW` (3-letter MED).
- `tier_type` spans all collections (Top Shot COMMON→ULTIMATE; UFC CHALLENGER/CONTENDER/FANDOM) — full list in `database.md`.
- `chain_type`: `flow | ethereum | polygon | solana | flow_evm`. `chain` lives on `collections` ONLY; dependent rows reach it via `collection_id` FK, and `collection_chains` is the canonical join view.

### Series map (on-chain UInt32 → display name)

`0 = S1` · `2 = S2` · `3 = Summer 2021` · `4 = S3` · `5 = S4` · `6 = 2023-24` · `7 = 2024-25` · `8 = 2025-26`. **There is NO series=1 on-chain. Series 0 IS Series 1. There is NO "Beta".** ⚠ **These are the REPO's names; the live `collection_series.display_label` reads `Series 5/6/7` for 6/7/8 (re-verified 08-24) and drives the Collection tab filter via `/api/collection-series`** — check which convention your surface parses. `lib/collection/series-param.ts` now resolves BOTH (`fdf84ee4`); which label WINS is still open.

⚠ **This 0↔1 collision is TOP-SHOT-SPECIFIC — NEVER blanket-remap `1 → 0` across collections.** `wmc.series_number` is ON-CHAIN; `editions.series` is DISPLAY. All Day / Golazos / Pinnacle use `1` legitimately and **`ufc_strike` has BOTH 0 and 1**, so a blanket remap corrupts four collections — a real 2026-08-05 incident silently dropped 385,734 TS rows. Check `collection_series` before touching any series logic.

### Cadence

**Before modifying any `.cdc` file, Cadence string literal, or FCL `mutate`/`query`, fetch the deployed mainnet source via the Cadence MCP and verify the functions/fields/types exist** — training-data assumptions are frequently wrong for Cadence 1.0. MCP is development-time verification ONLY; production reads keep routing through the proxy layer (egress is blocked). Addresses (incl. the Cadence service payer wallet) + per-collection gotchas: [apis-and-cadence.md](docs/reference/apis-and-cadence.md).

---

## Concierge non-negotiable rules

1. **RPC is READ-ONLY** — no cart, no gifting, no trading. **Never offer an action the product lacks.** This binds every surface, not just the concierge.
2. **Pinnacle FMV**: NEVER join by `edition_key` alone — always the triple (`character_name`, `set_name`, `variant_type`) per `92aab30`.

The rest — memory-FMV banned (`a910745`, must tool-call in the same turn), **an errored tool is NOT an empty result**, **a tool cannot observe its own health**, `get_fmv` shape, the `updated_at` trigger, the `feedback_type` filter — plus the tool list: [concierge.md](docs/reference/concierge.md).

---

## Code patterns and conventions

- Full file replacements only — never snippets or diffs. Claude Code prompts: normal markdown, desktop-read (the iPhone rule was RETIRED 07-25).
- `proxy.ts` is the correct Next.js 16 convention (renamed from middleware.ts). Supabase client typed `any` in API routes.
- `generateMetadata` cannot be exported from a client component — it belongs in the server `layout.tsx`. ⚠ `openGraph`/`twitter` merge **SHALLOWLY**: a route redefining either key REPLACES the root object, silently dropping `siteName`/`type`/`locale`/`creator`.
- `useSearchParams` requires a Suspense wrapper.
- Fire-and-forget >30s: `after(runX())` from `next/server`, return `{status: accepted}`. ⚠ Any `after()` route needs an **invocation heartbeat written BEFORE the work** (separate `<pipeline>-heartbeat` name), because **`try/catch` CANNOT catch a `maxDuration` kill** — without it a killed tick is indistinguishable from a cron that never fired. Read kills by CORRELATION (heartbeat, no terminal row), never a `finally`; a marker row's `rows_*` must be **NULL, not 0**. ⚠ **Bound every `fetch` inside one** — no default timeout.
- Never hardcode `#E03A2F` or `'Barlow Condensed'` — always the tokens in `app/rpc-tokens.css`. ⚠ **Web red is `#E03A2F`; email red is `#E55A4C`**, hardcoded on purpose (email clients lack CSS custom properties). ⚠ `--rpc-black` and `--rpc-text-primary` are THEME-AWARE — a hardcoded dark hex renders a black slab in light mode.

---

## Hot wallet & secrets

- Flow CLI hot wallet: `0x3aa11c84d776838f` (Key 0, **ECDSA_secp256k1, SHA2_256**). NOT account-linked. `flow.json` gitignored. NEVER use a HybridCustody / linked wallet as the hot wallet. Code signing as this wallet MUST use secp256k1 + SHA2-256 — `lib/breaks/server-authz.ts` silently used p256 + SHA3-256 for months; tests for signing code must verify signatures **cryptographically**, never assert output shape/length.
- Key env vars (8, incl. 3 absent from `.env.example`): [tooling-gotchas.md](docs/reference/tooling-gotchas.md).

---

## Prioritized next actions

**The canonical forward plan is [docs/strategy/roadmap-2026-08-03.md](docs/strategy/roadmap-2026-08-03.md).** Thesis: **accuracy is the GATE, not a phase** — growth tactics stay removed until the data beats the sites collectors already use; headline metric is the share of prices at HIGH/MEDIUM confidence. Still binding: **intelligence-first**; Cart / Trade Hub / gifting removed (**read-only product**); **monetization tabled until 50+ weekly active users**; no infra spend pre-revenue.

**Open items, stated rather than quietly dropped:**

- **The sports-proxy `403` — ⛔ "PROXY ESPN" IS MEASURED DEAD** (ESPN 403s residentially too; the "no alert" gap is a MYTH — deliberately suppressed). Still dead 08-26: `sync-nba-projections` **0 ok / 8**, `all_upstreams_failed`. Bullet + discriminator: #8 in [known-issues.md](docs/reference/known-issues.md).
- `fmv-recalc` — **RE-CHARACTERIZED 2026-08-17: wasteful, NOT broken** (64–73% wall-kills, ~14k editions/day, 08-26). [cron-and-schedulers.md](docs/reference/cron-and-schedulers.md)
- 🚨 **Needs TREVOR, not code — three:** the **DEFEATED credential purge** (public branch `claude/todo-implementation-e4tib3` still carries the pre-purge blob, re-verified 08-26 — triage `ee94c8a2a`, delete via the GitHub UI, GC, **rotate regardless**, #22) · the three board-MV cron jobs' 600 s timeout (#27) · `atlas-proxy` (#20) — ⚠ **now the BINDING half**: #30's DB timeouts are fixed (index, 08-26) and the residual fails are **4/9 `egress_blocked`**.
- **ONE measured-but-unshipped DB fix left, blocked on a DECISION not a diagnosis:** `compute_pack_ev_per_edition_weighted`'s `fmv_current` leg (**18,766 vs 1,046,192 buffers**, re-seeds a pinned fixture — Trevor's call; still unshipped in live `prosrc` 08-26). ⭐ A sibling's stated blocker turned out to be a MEASUREMENT, not a decision — **re-read a "blocked" item's blocker before inheriting it.**

Full status + accuracy measurements: [docs/reference/roadmap-status.md](docs/reference/roadmap-status.md). Issue register: [docs/reference/known-issues.md](docs/reference/known-issues.md).

---

## Recent sessions

Session entries live in `docs/sessions/`, one per month; none is needed to start work. **Write new ones into [2026-08.md](docs/sessions/2026-08.md) (prepend, newest-first), never here**, and **promote every durable lesson into this file or the matching `docs/reference/*.md` — a fact left only in a session log stops being read.**

**Links inside `docs/archive/**`, `docs/health/**`, `docs/sessions/**` are frozen history — never rewrite them.** Layout: [session-and-archive-conventions.md](docs/reference/session-and-archive-conventions.md).
