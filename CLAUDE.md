# Rip Packs City — Claude Code AI Assistant Configuration

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **HOW THIS FILE WORKS (restructured 2026-08-17).** It had grown to 713,000 characters — far past the memory-file char limit (`max(40000, contextWindow × 0.05 × charsPerToken)`, i.e. **40,000 on a standard 200k session**, which is what the nightly pass, Cowork and every subagent run at). It now carries only what a session needs *before* it knows which topic it is in; everything else moved **verbatim** into `docs/reference/*.md`. Nothing was deleted — if a rule feels missing it is in one of those files, not gone.
>
> **KEEPING IT UNDER: check `wc -c CLAUDE.md` before committing an edit here.** A new durable rule that does not fit goes in the matching `docs/reference/*.md` with at most a one-line pointer from here — **over the limit the whole file is flagged and stops being trustworthy context**, which costs far more than the rule was worth. Session entries go to `docs/sessions/`, never here.
>
> ⚠ **Two rules govern every number in this file and in those docs. (1) Every figure is a DATED SAMPLE, not a constant — re-measure before quoting it. (2) A recorded correction has a shelf life** (a documented "this grep over-counts by one" is a fixed offset that silently absorbs real growth; a "committed but UNAPPLIED" note goes stale the moment someone applies it). **Re-derive; do not quote.**

---

## Reference index

All under `docs/reference/`:

- **`key-files-and-honesty.md`** — the largest and most-read. Key modules + the full **"a failed read must not render as an answer"** canon (5 layers, their helpers, ~20 instances), driver-message leak guards, fabricated-number shapes, OG cards, board degradation, Cloudflare Workers table.
- **`database.md`** — `editions` · `wmc` · `fmv_snapshots` · `sales`, general rules (role timeouts, PostgREST caps, `apply_migration` cost), and the full **Security posture**.
- **`testing-and-ci.md`** — vitest layers, the 3 coverage gates + ratchets, DB-invariant SQL pins, mutation-testing categories, CI jobs, Cadence + Playwright.
- **`known-issues.md`** — open/resolved register (stable item numbers), deferred hardening, deep-audit follow-ups.
- **`cron-and-schedulers.md`** — the 4 independent schedulers, pg_cron mechanics, `pipeline_runs` retention + rollup traps, saturation findings.
- **`trust-board-and-safety.md`** — trust board (38 arms, how to read it), the precompute 8-way split, destructive-op circuit breaker, cross-session coordination.
- **`chain-strategy.md`** — multi-chain thesis, Candy/Solana + Panini readiness and go-lives, chain-abstraction Phases A–F.
- **`routes-and-surfaces.md`** — route structure, per-collection `pages`, notable API endpoints, global search.
- **`apis-and-cadence.md`** — Top Shot / All Day GraphQL, Flowty, Flow REST, the RPC FMV API, contract addresses, per-collection Cadence gotchas.
- **`concierge.md`** · **`brand-auth-proxy.md`** · **`tooling-gotchas.md`** · **`packs.md`** · **`architecture-notes.md`** · **`ledger-discipline.md`** · **`autonomous-tasks.md`** · **`roadmap-status.md`**.
- **`schema-truth.md`** — generated from the live DB; **wins on any disagreement with prose.**

---

## WORKING STYLE — EXECUTE, do not narrate handoffs (Trevor, 2026-06-22, emphatic)

Cowork has a push-capable git clone, Supabase MCP (read+write), Vercel/Sentry, Chrome, and the scheduled-task/artifact tools. **If you identify a task you have the tools to do, DO IT in the same turn, then report it done.** Do NOT describe a task as a "Claude Code handoff" or "operator item" and stop when you could execute it yourself. Hand off ONLY what genuinely needs access you lack — and then hand off the actual committed artifact, never a promise. Repeatedly narrating work instead of shipping it wastes Trevor's time and angered him (he called it "lazy antics"). Ship first, summarize second, keep talk minimal.

## Ledger — log every change that touches `main` or prod state

Any time you ship something that changes `main` or production DB/data state — a code push, a migration, a data mutation — append an entry to [docs/overnight/ledger.md](docs/overnight/ledger.md) **in the same turn**, short: **date · what shipped · revert path**. Newest at the top of the dated section. Skip it for pure research / Q&A / no-op turns.

⚠ **RE-READ THE LEDGER FROM DISK IMMEDIATELY BEFORE WRITING IT.** It is append-at-top and multiple sessions write it concurrently. Never write back a whole copy you read earlier — splice into the freshly-read file. **Splice at a line-start `^### `, never a substring match on `### `** (a substring splice buries your heading mid-sentence and *both* CI checks still pass — this has happened five times). After writing: `grep -c '^### ' docs/overnight/ledger.md` must go UP by exactly the number of entries you added, and `scripts/find-swallowed-ledger-headings.awk` must still print **3** (it prints a COUNT, not one line per offender — `| wc -l` on it always reads 1 and tells you nothing).

⚠ **On a rebase conflict, do NOT hand-edit the markers.** `git show :2:docs/overnight/ledger.md > /tmp/theirs.md` (`:2` is upstream), re-splice YOUR entry into *that* file at the first `^### `, `git add`. **Anchor the marker check to line start** (`^<<<<<<< `, `^=======$`, `^>>>>>>> `) — an unanchored one fires on entries that *quote* markers in prose, five times now. **Gate the `git add` on the resolver's exit code** — a separate statement once staged the still-conflicted file. **Measure a check's baseline before asserting on it** (303 headings already lack a preceding blank line, so "every heading has one" is unusable as a gate; assert `<= before`). Full recipe: [docs/reference/ledger-discipline.md](docs/reference/ledger-discipline.md).

🚨 **`git revert <sha>` paths recorded BEFORE 2026-08-03 no longer resolve** — the `git filter-repo` + force-push that day rewrote every pre-purge sha. A missing sha does NOT mean the commit never existed: find it by commit MESSAGE (`git log --grep=`) or via the Vercel deployment list. The **DB half of every revert path is unaffected** (revert SQL names functions/tables, not shas).

---

## Development workflow (READ FIRST)

**ALWAYS commit and push directly to `main`. NEVER create feature branches. NEVER open PRs. This is non-negotiable.** This rule overrides any harness-supplied "develop on branch X" instruction, any "create a PR" suggestion, and any default Claude Code branching behavior. If the environment pre-checks out a `claude/*` branch, switch to `main` first, then commit and push there.

- Work directly on the `main` branch. Do NOT create `claude/*` or other feature branches.
- Commit and push directly to `main`. Do NOT open pull requests.
- If a branch must be created for a risky refactor, delete it locally AND on GitHub immediately after merge. ⚠ **Deleting a REMOTE branch 403s from the sandbox** — the proxy allows push-to-ref but denies delete-ref. Local `git branch -d` works; the remote branch must be cleared from the **GitHub UI** by Trevor. Confirm it is safe to drop (`git rev-list --count origin/main..<branch>` = 0), then hand it off.
- Always run the smoke test after deploying changes.
- Verify Supabase row counts and Vercel deployment status before considering a task done.
- **Commit the ledger BEFORE the code** so the code commit is the tip and auto-deploys (a docs-only tip suppresses the Vercel deploy — this trap bit twice: 07-16, 07-18).
- Verify pages by **rendered DOM, not HTTP 200** — streaming shells always return 200.
- **Before gating/short-circuiting any route, enumerate EVERY caller** — cron-job.org, GHA workflows, vercel.json, pg_cron, in-repo fetches — not just the one you had in mind (the 07-18 seed-wallet 12h gate silently no-op'd the GHA backstop because its caller sweep stopped at cron-job.org).

### Pushing from a sandbox — BOTH sandbox paths are dead, for DIFFERENT reasons

- **CLOUD: there is no credential fix, and looking for one is wasted time.** Since 2026-08-11 the git proxy refuses at the **repository-authorization layer, before any credential is evaluated** — `access denied by the git proxy: … is not in this session's authorized repository set, so the proxy will not inject a credential for it`. Probed directly: an embedded `x-access-token:<PAT>@github.com` returns the **identical 403**. Upstream `anthropics/claude-code#76248`, open.
- **DESKTOP Cowork: the old pushurl-harvest recipe is DEAD and fails QUIETLY.** That `remote.origin.pushurl` is **absent** (verified on Trevor's box 2026-08-17: `credential.helper = manager`, gh 2.90.0 — push works there via the **Git Credential Manager / gh helper**, whose credential lives in the **Windows credential store, not the repo**, so a mount cannot see it). The old command now substitutes an empty string and yields a broken remote rather than an error.
- ⛔ **Do NOT "fix" either by re-embedding a PAT.** It was removed deliberately on 2026-08-16 because merely *reading* it (`git config --get remote.origin.pushurl`, `git remote -v`) prints a live `github_pat_…` into the transcript — that burned a real PAT once. The gh helper also carries the `workflow` scope an embedded PAT lacks.
- **What restores push:** (a) **`/web-setup` in a REAL TERMINAL `claude` session** — syncs the local gh token to claude.ai; ⚠ a built-in CLI command, so it does **not** fire in a VSCode-extension session (it arrives as plain text), and it authorizes **at session creation** — it fixes future sessions, not a running one. (b) **Create the session with the repo as its source** — `claude --cloud` from inside the repo, or claude.ai/code with the repo selected; the desktop Cowork project picker does not authorize, and the repo is not addable mid-session. (c) **Run the task on the computer** (desktop → "Run this task") — guaranteed while #76248 is open. (d) **`git format-patch`** — the sandbox clone works, so it can do the whole job and emit a patch to `git am`; needs nothing from Anthropic, proven end-to-end.
- Bash-green does NOT imply push-green. Never commit from the mount itself; always a fresh clone (deploy-split rule).

---

## Autonomous Cowork tasks

Two scheduled Cowork tasks run against this repo — coordinate via the shared ledger so daytime work doesn't collide.

- **`rpc-daytime-monitor`** — READ-ONLY, every ~3h. Sweeps health, appends candidate work to `docs/overnight/inbox/`. Ships nothing.
- **`rpc-nightly-autonomous-pass`** — 1am local. Drains the inbox and ships ≤4 genuinely-low-risk changes to `main` (collision-gated, CI-gated, each verified by a fresh subagent), then writes a handoff + digest. Off-limits (queued, never auto-shipped): hot/payer wallet, secrets/env, auth & lockdown (`proxy.ts`), destructive SQL, FMV/ingest/pricing/pack-EV/concierge/sniper route logic, gated work.

Shared state in `docs/overnight/`: `ledger.md` (the **"Declined — do not re-suggest"** heading is Trevor's), `inbox/`, `metrics-latest.json`, `focus.md` (steer tomorrow's priorities), `.lock`. **Skim `ledger.md` before a session**; the night pass will not edit files committed in the last 24–48h. To halt all autonomous shipping, create `docs/FREEZE.md`. Full detail: [docs/reference/autonomous-tasks.md](docs/reference/autonomous-tasks.md).

---

## Project overview

Rip Packs City (RPC) is a production-grade Flow blockchain digital collectibles intelligence platform: analytics, deal-finding, sniper tools, FMV pricing and badge tracking across the 5 published Flow collections (NBA Top Shot, NFL All Day, LaLiga Golazos, Disney Pinnacle, UFC Strike). Trevor (founder) holds an official Portland Trail Blazers Team Captain designation on NBA Top Shot — a key brand differentiator.

Stack: Next.js 16 App Router, React 19, TypeScript 5, Tailwind 4, @onflow/fcl, Supabase (Pro, Small compute), Vercel Pro. Live: https://www.rippackscity.com · Repo: github.com/jamesdillonbond/rip-packs-city (public) · LLC: Oregon, filed May 3 2026.

**Public-facing tagline** stays "Flow blockchain digital collectibles intelligence platform" until chain two ships visible product. No tweets / Reddit / TC DMs about multi-chain pre-launch.

---

## Infrastructure IDs (required on every tool call)

- Supabase project ID: `bxcqstmqfzmuolpuynti` (Pro; **compute = SMALL** — 2 GB RAM / 2-core, `max_connections`=90). ⚠ Disk-IO-budget (burst-credit) model → throttles to a **22 MB/s** baseline when depleted; the platform's intermittent saturation is **disk-IO-bound, NOT compute-bound** — fix expensive queries, don't upgrade the tier (Medium is the same 2 cores for 4×).
- Vercel project ID: `prj_YBJ6Utl32GfyBOIzbsp3kbshJh96`
- Vercel team ID: `team_YWGCVToPBJSS60NgVh8jiCFV`
- GitHub repo ID: `1188272071`

Both Vercel IDs are required on every single Vercel API or MCP tool call — never omit teamId.

---

## Frequently used commands

```bash
npm ci                   # ⚠ RUN FIRST in a fresh web/cloud sandbox — there is NO node_modules.
                         #   Without it `npx vitest` silently fetches its own vite and dies on
                         #   `MODULE_NOT_FOUND … vitest.config.ts`, which reads like a broken
                         #   config rather than a missing install. `npx tsc` fails the same way.
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

⚠ **Verify a pipe's exit code, not the pipe's.** `npx tsc --noEmit 2>&1 | tail -5 && echo "EXIT=$?"` reports **`tail`'s** status — it printed `EXIT=0` from a sandbox with no `node_modules` at all. Run bare and echo `$?`, or read `${PIPESTATUS[0]}`.

---

## Standing rules — the cross-cutting lessons

These are the rules a session needs *before* it knows which subsystem it is in. Each links to where the full case history lives.

### Honesty — a failed read must not render as an answer

**The single most productive defect class on this platform (~20 recorded instances).** A read fails, and the surface publishes the failure as a *fact*: "No +EV packs right now" out of a 503, "0 moments / $0" out of a timeout, "Follow a team to build your hub" to someone who follows six. Four layers, four helpers — pick the one for your layer, do not invent a fifth:

| layer | helper |
|---|---|
| any API route a user can reach (anon OR signed-in) | `lib/api-error.ts` → `apiErrorResponse()` (`boardUnavailable()` is its `/api/public/**` alias) |
| server page | `lib/insights/board-status.ts` → `summarizeDegraded()` / `degradedFromSource()` |
| client dashboard | `lib/analytics/fetch-json.ts` → `fetchJson()` (discriminate on `ok`, **never** on `json == null`) |
| OG social card | `lib/og/board-empty-copy.ts` → `boardEmptyCopy(fetched, noun)` |

- **There are always THREE states, never two:** read failed · read ok + genuinely empty · read ok + unrenderable (e.g. rows that failed a name join). A name filter is not an emptiness test.
- **Fix per PANEL, not per page.** A page with one honest error branch is not an honest page — instance six landed on a page a prior audit had already hardened.
- **The worst sub-classes:** a false claim about the reader's **own account** (actionable — it makes them redo finished work); a page that **loads state and writes it back** (a failed read there is a *delete*, so WITHHOLD the form, don't annotate it); an **alert** (its output is silence, so the error is unfalsifiable); a **guard** (`?? 0` on a count makes a check fail *open*); and an empty state that **concludes** ("your moments are priced at or below market") rather than reports.
- ⚠ **`?? 0` on a supabase count and `|| 1` as a divide-guard are the fabricated-number shapes.** supabase-js **RETURNS** errors rather than throwing, so a failed count resolves `{count: null, error}` — `Promise.all`/`allSettled`/`try-catch` do not help, and `?? 0` publishes a measured zero. `|| 1` on a $0 baseline rendered **"↑ 50000.0% / 30D"**. `no-fabricated-divisor-ratchet` is a **ban at population zero**.
- ⚠ **When you find one, grep for the EXPRESSION, not the file.** This class has spread by copy-paste three times (15 OG cards, 5 sales indexers, two `saved_wallets` loaders, and a `|| 1` sibling that shipped the defect four extra days *while the fix's comment sat in the neighbouring file*). **A comment is only read by someone already in that file.**

Full canon + every instance: [docs/reference/key-files-and-honesty.md](docs/reference/key-files-and-honesty.md).

### Guards, tests and instruments

- ⚠ **Ask what a passing guard is structurally SILENT about.** Every guard's own derivation fixes its blast radius: the anon driver-message guard derived its file set from `isPublicPath`, so everything behind sign-in was outside it *by construction*; a completeness check walked `INSIGHTS_DIR`, so client pages elsewhere were invisible; `check_secdef_anon_exec_drift()` reads `prosecdef = true`, so 84 anon-executable INVOKER functions were outside it. **Prefer a directory/tree walk over a curated list, and a ban at population zero over an allowlist.**
- ⚠ **A vacuous assertion reads as coverage in every grep, review and report, and mutation testing cannot find the worst kind** — **a test that states the contract in a comment and asserts something weaker.** The tell is in the TITLE: a name carrying a negative claim ("without claiming none are saved") or a transformation ("is not an error", "at or below FMV") is a promise the assertion usually fails to keep. Open those. **Assert the ABSENCE of the false claim, not the PRESENCE of an error message.**
- ⚠ **Tests that pin the defect they were named to prevent get INVERTED, never deleted** — a passing test asserting a promise is what holds that promise in place. **Pin the property, not the spelling** (a guard matching the literal `count ?? 0` reddened on the strictly better `?? null`).
- ⚠ **A not-vacuous check must be satisfiable at a population of ZERO**, or the guard punishes its own success. Same for a guard that NAMES its instances — three have died on a rename. ⚠ **Strip comments before grepping source for user copy**; at least six guards have fired on the comment documenting the fix.
- ⚠ **A permanently-red or permanently-zero instrument is indistinguishable from a broken one at a glance** — `edge-fn-drift` was loudly correct every day for a week while naming the function fabricating 161k rows, and nobody read it. Check the LOG, not the badge. ⚠ **Before relying on a watcher, prove it can see a FAILURE** — an unreachable monitor and a green build produce the same output.
- ⚠ **Look for a monitor whose input set includes another monitor's OUTPUT** — a concierge health check counted its own smoke suite's fixtures and reported a total outage that was not happening.

Full detail: [docs/reference/testing-and-ci.md](docs/reference/testing-and-ci.md).

### Measurement discipline

- ⚠ **A filed FINDING is a hypothesis — re-derive which subsystem it measured before acting.** Several have been refuted on measurement, and one recommended fix would have made an accurate surface inaccurate. ⚠ **So is a filed DECISION NOT TO ACT, and that is the one nobody re-checks** — declining to act reads as the conservative choice. The tell is a cost stated with no number in it.
- ⚠ **A plausible mechanism is not a measurement**, including when it flatters this file. Test the tidy hypothesis before acting on it; a cheap sample beats a good story.
- ⚠ **Name the caller before you touch the function.** An expensive-looking function is not a cost until you have named its caller — a whole afternoon went into fixing a function with **zero** callers. Require four sources: `pg_proc.prosrc`, `pg_views.definition`, `cron.job.command`, and a full-repo grep. ⚠ `pg_stat_statements` alone is insufficient in *both* directions (`track = top` hides nested callers), and **32 of 37** functions reporting zero DB callers are live product RPCs called from Next.js.
- ⚠ **Read `cron.job.command` to learn what a schedule calls; never infer the callee from the name.** Two objects one suffix apart yielded *opposite* conclusions; the 13,009-char one that looks like the real implementation has zero callers.
- ⚠ **A directional claim needs a distribution, not a snapshot** (`fmv-recalc` has had three failed characterizations in two days from one-instant reads), and **compare against the series' own history before calling something a regression** — a "collapse" turned out to be its rate for three weeks. Read a current-day rollup row as PARTIAL. ⚠ Aggregating a `text` column (`max(cursor_after)`) is a lexicographic max — it reported `'9500' > '11500'` and made a **wedged** sweep look like an advancing one.
- ⚠ **Diff the SET, not the count.** The trust board's breached membership changed twice in one day while the total held at 5 — diffing the number shows "no change" across a fix landing *and* a new arm firing.
- ⚠ **Controls, both directions:** a NULL result needs a positive control; a POSITIVE needs a no-change control; a DIFFERENCE needs both sides counted by the same instrument. **Never pair a count from one table with a property sampled from another.**
- ⚠ **A byte-identical HTTP response is as much the signature of a CACHE HIT as of a correct change** (`/api/public/insights/**` sets a public `s-maxage`; the tell was an `elapsed_ms` identical to the millisecond — re-run with a cache-buster), and **an unordered `LIMIT` is not a sample** but physical order — it reported 0.1% against a true 22%. Use `abs(hashtext(k)) % N`.
- ⚠ **Read the ERROR STRING, never the duration.** The Supabase gateway timeout and the Postgres global `statement_timeout` are both ~2 minutes, so `upstream request timeout` and `canceling statement due to statement timeout` produce the same number and mean completely different things.

### Timestamps

**DATES ARE PACIFIC (Trevor operates in PT).** ⚠ **READ THE ZONE BEFORE CONVERTING — four incidents have come from a plausible timestamp produced by a clock whose zone was assumed.** `TZ=<anything> date` in Trevor's Git Bash silently returns **UTC labelled `GMT`** for every zone; plain `date` there has read a full calendar DAY ahead; and the Claude Code **web sandbox is PDT, not UTC**, so the reflexive "subtract 7h from `date -u`" lands a day early there. The trustworthy commands are `date '+%Z'` first, then PowerShell `Get-Date -Format "yyyy-MM-dd HH:mm zzz"` (it prints the offset, so it cannot lie silently) or a `zoneinfo` conversion in Python. Convert to PT before stamping any `### <date>` here or in the ledger.

### Windows / Git Bash

- CRLF silently breaks Node string-replace patches — normalize CRLF→LF before matching, or target by line number. Heredocs truncate on long files; never use one containing `${{}}`. `curl` fails silently here for Vercel REST calls — always PowerShell `Invoke-WebRequest`.
- ⚠ **BACKTICKS IN `git commit -m "..."` ARE COMMAND SUBSTITUTION AND DELETE THE WORD SILENTLY.** A message explaining a guard applies to `` `over` `` commits as *"applies to  ONLY"* — the sentence still reads like prose, and the commit SUCCEEDS while printing `command not found` to stderr. Write it to a file with a quoted heredoc (`<<'EOF'`) and use `git commit -F`.
- ⚠ **Assert the occurrence count before a scripted replace** (`n = s.count(old); assert n == 1`) — a silent no-op replace has produced a mutation "result" off a broken baseline, and a first-occurrence replace has hit a file's own header comment. ⚠ **Key any backup on the FULL PATH, never the basename** — three `page.tsx` targets shared one `.bak` and two files of uncommitted work were destroyed, surfacing two steps later as a stale-pattern error.
- ⚠ **Secret safety:** never broad-query the DOM (`querySelectorAll('input')`, full `read_page`) on pages that can hold secrets, and never echo Bearer/token values. ⚠ **`mcp__*__get_edge_function` returns the FULL deployed `index.ts`, not metadata** — a config question once echoed a live gate key into the transcript. To compare a key without echoing it, hash both sides and compare digests only.

Full detail: [docs/reference/tooling-gotchas.md](docs/reference/tooling-gotchas.md).

### Database — the traps that bite most often

- **PostgREST caps reads at 1000 rows and CLAMPS an explicit `.limit()` above that**; a bare unbounded `.select()` clamps too. For a total read the returned `count` (with `head: true`), never `rows.length`.
- ⚠ **Any `.range()` pagination MUST carry a deterministic `.order()`** on a UNIQUE key, or it reads the right *number* of rows and the wrong *rows*. The duplicates and omissions **cancel**, so every count-based check passes — only a DISTINCT count or a set comparison sees it. Now a **ban at zero**.
- **A batch `.insert()` is ALL-OR-NOTHING — never swallow `23505` on one.** One duplicate fails the whole statement and writes none of the batch; on a cursored indexer that is permanent loss.
- ⚠ **A function-level `SET statement_timeout` is INERT** — 195 functions declare one, 47 above the global 120 s; the binding budget is the caller's role, or the global. ⚠ **And a role's `rolconfig` timeout does NOT bind on the PostgREST path** — it applies at LOGIN, and PostgREST logs in as `authenticator` and only `SET LOCAL ROLE`s. 39 `service_role` statements exceed its nominal 30 s, worst 352 s: **no Postgres timeout bounds a `supabaseAdmin` RPC; the bound is the client.** ⚠ Settled 2026-08-17: **`anon`'s 3 s does not bind either** — the real value is `authenticator`'s login-time 8 s — so there is **no 3 s ceiling on unauthenticated compute**, which weakens the case for leaving 78 anon-executable functions in place.
- ⚠ **Every `apply_migration` causes a ~10–20 s burst of user-facing `PGRST002` 500s** (schema-cache re-introspection). Prefer a low-traffic window and batch migrations. `rpcWithRetry` does not save you — it retries for ~250 ms of a twenty-second outage.
- ⚠ **`CREATE OR REPLACE VIEW` with no `WITH` clause RESETS reloptions and silently strips `security_invoker=on`** (four occurrences). `ALTER VIEW … SET (security_invoker = on)` is the repair. It also **cannot rename or reorder columns** (`42P16`) — and the rolled-back SQL test cannot catch that, because it builds the object where no prior definition exists.
- ⚠ **`REVOKE … FROM PUBLIC` alone is not enough, and neither is `FROM anon, authenticated` alone** — this DB carries both a PUBLIC default and `ALTER DEFAULT PRIVILEGES` grants. Revoke **`FROM PUBLIC, anon, authenticated`** in one statement, and verify with `has_function_privilege`, never the acl text. Re-run `check_secdef_anon_exec_drift()` after creating ANY function.
- ⚠ **`check_*` functions have MIXED return shapes.** The jsonb-array ones (`check_secdef_anon_exec_drift`, `check_secdef_anon_execute_violations`, `check_edge_fn_http_failures`) return `count(*) = 1` when CLEAN — read the array LENGTH. The SETOF ones (`check_public_security_invariants`, `check_anon_write_surface`) return **zero rows** when clean. **Check the return type before interpreting the count.**
- ⚠ **`rows_written = 0` is a null instrument with three incompatible meanings** (correct-and-broken, wrong-and-healthy, correct-and-failing) and `ok = false` is overloaded the same way. Read `extra` and `last_error`; never retire a pipeline on `rows_written`.
- **`pipeline_runs` retains only ~73h** — "no matching record" is usually a RETENTION ARTIFACT. Check `pipeline_runs_daily` (indefinite) for VOLUME and TREND, ⚠ **but never for RECENCY** — it is a **six-hourly** rollup and fabricates silences up to 6 h long; read `refreshed_at` beside `last_run_at`, or query `pipeline_runs` directly.
- **`apply_migration` for DDL; `execute_sql` for reads/verification.** `CREATE INDEX CONCURRENTLY` must be standalone `execute_sql`. FMV writes are delete-then-insert, NEVER upsert. Always query `information_schema.columns` before writing a route handler; Supabase MCP multi-statement queries return only the last result.

Full detail: [docs/reference/database.md](docs/reference/database.md).

### Vercel

- **An empty or docs-only commit can NEVER force a rebuild** — `vercel.json`'s `ignoreCommand` skips it. Use the v13 deployments POST, or touch a non-docs file.
- **Pro Lambda `maxDuration` hard cap is 800s.** Higher sends the deploy to ERROR *invisibly*.
- ⚠ **`get_deployment.state` LAGS** (`BUILDING` for ~45 min on a READY deploy). Corroborate: `ready` diverging from `buildingAt`, production aliases attached, `lambdaRuntimeStats` present. ⚠ **A deploy that ERRORs is easy to miss** because the next push supersedes it and goes READY — **check deploy state PER COMMIT**.
- **A disk-IO saturation spell can FAIL THE WHOLE PRODUCTION BUILD** — prerendered `/insights` pages get 60 s each, and a *slow* board errors nowhere, so the stale-fallback below it never fires. Five instances; now a **ban at zero** (`insights-server-pages-bound-their-reads`). ⚠ Twice the failing page was one the pushing commit never touched.
- `get_runtime_logs` needs `environment: "production"` and short windows; `console.warn` is NOT indexed — use `console.log`.

---

## Quick-reference facts

### Two collection-string conventions (CRITICAL footgun)

Two vocabularies, not interchangeable — mixing them fails INSERTs against CHECK constraints.

- **Long-form** (`sales`, `editions`, `collections.slug`): `nba_top_shot` · `nfl_all_day` · `laliga_golazos` · `disney_pinnacle` · `ufc_strike`
- **Short-form** (`flowty_transactions`, `flowty_loans`, `flowty_loan_events`): `topshot` · `allday` · `golazos` · `pinnacle` · `ufc` · `unknown` — the CHECK whitelists exactly these six, NOT `other`

Writing `'ufc_strike'` to a `flowty_*` table fails at INSERT. The bridge is the `analytics_sales` view (long → short via CASE).

### Collection UUIDs

TopShot `95f28a17-224a-4025-96ad-adf8a4c63bfd` · AllDay `dee28451-5d62-409e-a1ad-a83f763ac070` · Golazos `06248cc4-b85f-47cd-af67-1855d14acd75` · UFC `9b4824a8-736d-4a96-b450-8dcc0c46b023` · Pinnacle `7dd9dd11-e8b6-45c4-ac99-71331f959714` · Candy MLB `209ade70-32c5-4470-bc7c-4793d660f713` (unpublished, `is_active=false`)

### Enums

- `fmv_snapshots.confidence` is UPPERCASE: `HIGH · MEDIUM · LOW · NO_DATA · ASK_ONLY · SALES_ONLY · STALE`. **Never `.ilike` an enum column — use `.eq`.** ⚠ `nba_player_projections.confidence` allows only `HIGH | MED | LOW` (3-letter MED).
- `tier_type` spans all collections (Top Shot COMMON→ULTIMATE; UFC CHALLENGER/CONTENDER/FANDOM) — full list in `database.md`.
- `chain_type`: `flow | ethereum | polygon | solana | flow_evm`. `chain` lives on `collections` ONLY; dependent rows reach it via `collection_id` FK, and `collection_chains` is the canonical join view.

### Series map (on-chain UInt32 → display name)

`0 = S1` · `2 = S2` · `3 = Summer 2021` · `4 = S3` · `5 = S4` · `6 = 2023-24` · `7 = 2024-25` · `8 = 2025-26`. **There is NO series=1 on-chain. Series 0 IS Series 1. There is NO "Beta".**

⚠ **This 0↔1 collision is TOP-SHOT-SPECIFIC — NEVER blanket-remap `1 → 0` across collections.** `wmc.series_number` is ON-CHAIN; `editions.series` is DISPLAY. All Day / Golazos / Pinnacle use `1` legitimately and **`ufc_strike` has BOTH 0 and 1**, so a blanket remap corrupts four collections — a real 2026-08-05 incident silently dropped 385,734 TS rows. Check `collection_series` before touching any series logic.

### Cadence

**Before modifying any `.cdc` file, any Cadence string literal, or any FCL `mutate`/`query`, use the Cadence MCP to fetch the deployed contract source on mainnet and verify the functions/fields/types exist.** Training-data assumptions are frequently wrong for Cadence 1.0. The MCP is development-time verification ONLY — all production reads must keep routing through the proxy layer (Flow public endpoints and the Top Shot / Flowty APIs all block Vercel egress). Contract addresses + per-collection gotchas: [docs/reference/apis-and-cadence.md](docs/reference/apis-and-cadence.md).

---

## Concierge non-negotiable rules

1. **Pinnacle FMV**: NEVER join by `edition_key` alone — always the triple (`character_name`, `set_name`, `variant_type`) per `92aab30`. Cadence uses `Int` not `UInt64`.
2. **Memory-FMV banned** (`a910745`) — must tool-call in the same turn.
3. **RPC is READ-ONLY** — no cart, no gifting, no trading. Never offer an action the product lacks.
4. **An errored tool is NOT an empty result** — `status:"error"` and `status:"no_results"` are distinct claims and their prompt rules must stay distinct.
5. **A tool cannot observe its own health** — it can only report how old its data is. Never let copy reassure that a feed is fine.

Remaining rules (`get_fmv` shape, `.eq` not `.ilike`, the `updated_at` trigger, the `feedback_type` filter), the full tool list and the honesty constraints: [docs/reference/concierge.md](docs/reference/concierge.md).

---

## Code patterns and conventions

- Full file replacements only — never snippets or diffs. Claude Code prompts: plain text, no markdown code blocks (iPhone copy-paste).
- `proxy.ts` is the correct Next.js 16 convention (renamed from middleware.ts). Supabase client typed `any` in API routes.
- `generateMetadata` cannot be exported from a client component — it belongs in the server `layout.tsx`. ⚠ `openGraph`/`twitter` merge **SHALLOWLY**: a route redefining either key REPLACES the root object, silently dropping `siteName`/`type`/`locale`/`creator`.
- `useSearchParams` requires a Suspense wrapper.
- Fire-and-forget >30s: `after(runX())` from `next/server`, return `{status: accepted}`. ⚠ Any `after()` route needs an **invocation heartbeat** under a separate `<pipeline>-heartbeat` name, or a killed tick is indistinguishable from a cron that never fired.
- Never hardcode `#E03A2F` or `'Barlow Condensed'` — always the tokens in `app/rpc-tokens.css`. ⚠ **Web red is `#E03A2F`; email red is `#E55A4C`**, hardcoded on purpose (email clients do not support CSS custom properties). ⚠ `--rpc-black` and `--rpc-text-primary` are THEME-AWARE — a hardcoded dark hex renders a black slab in light mode.

---

## Hot wallet & secrets

- Flow CLI hot wallet: `0x3aa11c84d776838f` (Key 0, **ECDSA_secp256k1, SHA2_256**). NOT account-linked. `flow.json` gitignored. NEVER use a HybridCustody / linked wallet as the hot wallet. Any code signing as this wallet MUST use secp256k1 + SHA2-256 — `lib/breaks/server-authz.ts` silently used p256 + SHA3-256 until `3b5e62d8`; tests for signing code must verify signatures **cryptographically**, never just assert output shape/length.
- Cadence service payer wallet: `0x73f55c4450b8d466` — gas payer for backend-submitted Cadence transactions, distinct from the hot wallet. Intentionally empty and its balance-check cron is paused while all Cadence-write features are shelved.
- Key env vars: `INGEST_SECRET_TOKEN`, `CRON_SECRET`, `FLOWTY_PROXY_TOKEN`, `TS_PROXY_SECRET`, `RPC_ADMIN_TOKEN`, `SPORTS_PROXY_URL`, `SPORTS_PROXY_SECRET`, `ANTHROPIC_API_KEY`.

---

## Prioritized next actions

**The canonical forward plan is [docs/strategy/roadmap-2026-08-03.md](docs/strategy/roadmap-2026-08-03.md).** Its thesis: **accuracy is the GATE, not a phase** — "zero users is the correct output of the current input", so growth tactics are removed rather than demoted until the data beats the sites collectors already use. Headline metric: share of prices at HIGH/MEDIUM confidence. Still binding: RPC is **intelligence-first**; Cart / Trade Hub / gifting are removed (read-only product); **monetization is tabled until 50+ weekly active users**; no infra spend pre-revenue.

**Open items, stated rather than quietly dropped:**

- **The sports-proxy `403` — still the highest-value open item.** ⚠ **The long-standing "operator-only, it's a secret" label was REFUTED 2026-08-17: no secret is involved** (the proxy returns 502 not 401, the env guard never fires, and **the ESPN lane uses no proxy or secret at all and is ALSO 403ing**) — so it is **three providers across two independent egress networks**, i.e. providers tightening bot-blocking, not one stale fingerprint. ⛔ **Do NOT ship a UA refresh or a cdn 403-retry before the decisive test:** one `curl` of the `cdn.nba.com` URL from an ordinary non-datacenter network. ONE root cause behind three symptoms triaged apart — projections ~27 d stale, `nba_players` **101 d stale at 174 players / 19 of 30 teams**, and `match-topshot-players` having produced **zero** auto-aliases ever. **Fast Break reads the same catalogue, so it is on a 19-team roster now.** Full refutation: Known issues #8 in [known-issues.md](docs/reference/known-issues.md).
- The `match-topshot-players` perf restructure — correct, but it follows the 403; it cannot produce an alias while the catalogue is starved.
- The `fmv-recalc` ~66% background kill rate — un-diagnosed by deliberate decision after two failed diagnoses.
- `atlas-proxy` needs an operator `wrangler deploy` + a Cloudflare-egress probe; ~60% of `topshot-active-listings-ingest` sweeps fail `egress_blocked` meanwhile.

✅ **Recently closed, so nobody re-opens them:** the **success-coverage gap** (the `Pipeline Success Coverage` sentinel arm now flags any active-watchlist pipeline with **runs > 0, zero successes, zero rows written** — ⚠ the `rows_written` term is load-bearing, since zero-successes alone gave 4 false positives in 20 days, all graceful degradation; and it reads the ≤6 h-lagged rollup, so **do not use it to confirm a recovery**).

Full status + accuracy measurements: [docs/reference/roadmap-status.md](docs/reference/roadmap-status.md). Issue register: [docs/reference/known-issues.md](docs/reference/known-issues.md).

---

## Recent sessions

Session entries live entirely in `docs/sessions/` (newest-first) — they were the largest contributor to this file's size and none is needed to start work. [2026-08.md](docs/sessions/2026-08.md) (Aug 17 → Aug 1) · `2026-07.md` · `2026-06.md` · `2026-05.md` · `2026-04.md`.

**Write new session entries into `docs/sessions/2026-08.md` (prepend, newest-first), not here.** Same discipline: what shipped, what was verified, what is still open, and the durable lesson — **and promote any durable lesson into this file or the matching `docs/reference/*.md`, because a fact left only in a session log stops being read.** Recorded failure mode: "38 arms, 3 breached" was still quoted as current after a fourth arm had breached and one of the three had tripled, purely because it lived in a dated entry.

**Doc archive layout:** dated handoffs/audits under `docs/archive/`; weekly health snapshots under `docs/health/`. Links inside `docs/archive/**`, `docs/health/**`, `docs/sessions/**` are frozen history — don't rewrite them.
