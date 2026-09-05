<!-- Extracted from CLAUDE.md on 2026-08-17 to bring that file under the memory-file
char limit. Content is VERBATIM; CLAUDE.md carries a one-line pointer to this file.
Same rules apply: every number here is a dated sample - re-measure before quoting. -->

## ⛔ 2026-09-04 — the pipe-exit trap in a NEW COSTUME: `grep <log> && git push` gates on grep, not on the run

The known rule is *"a pipe reports the LAST command's exit code"*. The variant that actually cost
something: the full suite was run in the background with `echo "EXIT=$?" >> log`, and the push was
written as

```bash
grep -E "Tests |EXIT=" "$LOG" | tail -3 && git add … && git commit … && git push   # ⛔ WRONG
```

The suite had **one** failing test. `grep` FOUND its lines, exited 0, and the push went out red.
**`&&` after a search gates on the search succeeding, never on what it found.** Read the value and
branch on it:

```bash
rc=$(grep -o 'EXIT=[0-9]*' "$LOG" | tail -1 | cut -d= -f2)
[ "$rc" = "0" ] && git push origin main || echo "NOT PUSHED"
```

⚠ The same shape hides in `npx tsc --noEmit > log 2>&1; echo "TSC_EXIT=$?"; grep -c "error TS" log` —
that reports **grep's** zero-match exit, which reads as a failure when the file is clean. Either run the
gating command in the FOREGROUND and capture `$?` immediately, or write the value to the log and parse it.


## Key env vars (displaced VERBATIM from CLAUDE.md 2026-08-25 to restore memory-file headroom)

CLAUDE.md was at **39,996 of 40,000 characters — four characters of headroom** — which is one edit away from
silently losing the whole memory file. This list is pure lookup DATA, so it is the correct thing to move; the
rules stayed.

- Key env vars: `INGEST_SECRET_TOKEN`, `CRON_SECRET`, `FLOWTY_PROXY_TOKEN`, `TS_PROXY_SECRET`,
  `RPC_ADMIN_TOKEN`, `SPORTS_PROXY_URL`, `SPORTS_PROXY_SECRET`, `ANTHROPIC_API_KEY`.

⚠ **`.env.example` is NOT a complete substitute for this list — measured 2026-08-24, only 5 of the 8 appear
there** (`FLOWTY_PROXY_TOKEN`, `SPORTS_PROXY_URL` and `SPORTS_PROXY_SECRET` are absent). That is why the list
was moved here rather than deleted in favour of a pointer at `.env.example`.

Rotation surfaces and which worker carries which secret: see the three-rotation-surfaces section of
[brand-auth-proxy.md](brand-auth-proxy.md) and `RPC_DESIGN_SYSTEM.md` §11.

## Windows / Git Bash patching rules (CRITICAL)

- Dev environment: Windows, Git Bash (MINGW64), VS Code.
- CRLF line endings silently break Node.js string-replace patches — use `findIndex` on split line arrays, or sed line-number targeting.
- Heredocs truncate on long files — use Claude file output tool + PowerShell `cp` or `Set-Content -Encoding UTF8`.
- Never use heredoc with `${{}}` characters in Git Bash.
- For multiline replacements: write a `.js` patch script that normalizes CRLF→LF before matching.
- `sed` with `1i\` insert syntax works in Git Bash but not PowerShell.
- ⚠ **A Git Bash `/tmp/x` path handed to `node -e` resolves to `C:\tmp\x` and ENOENTs** (measured 2026-08-17). Git Bash mounts `/tmp` at the MSYS root; Node is a native Windows binary and never reads that mount, so the two-step recipe "write it with a heredoc to `/tmp`, then read it back from `node`" fails at the READ — and it fails as a *path* error, which reads like a missing file rather than a path-translation problem. Hand Node an absolute `C:/...` path (the session scratchpad), or `cp` the file there first. Same trap for any native-Windows exe called from Git Bash. ⚠ Passing the text as an argv instead does not dodge it: `node -e '...' "- ⚠ ..."` makes Node read the leading `- ` as an option and die with `bad option`.
- Multi-line Python in GitHub Actions YAML `run:` steps causes YAML parse errors — use single-line one-liners.
- `curl` fails silently in Git Bash for Vercel REST calls — always use PowerShell `Invoke-WebRequest`.
- 🚨 **`$` AND BACKTICK ARE INTERPRETED BY MORE LAYERS THAN YOU ARE THINKING ABOUT — three DIFFERENT ones bit in a single session (2026-08-26), each in a different tool, each silent.**
  1. **A JS regex through bash.** `ddl.replace(/\s+\$/, '\$')` in a `node -e "..."` string mangled a pin file's `$function$;` terminator into `$function$;$`. psql then rejected the WHOLE file (`syntax error at or near "$"`) and **`main` was red for 35 minutes** — while `npm test` and the drift guard both passed, because the guard stops comparing at the first `;` after the terminator.
  2. **A fenced code block through bash.** A ``` fence inside a double-quoted `node -e` script is command substitution: the block was silently eaten and the ledger entry rendered with three blank lines where the terminal output should have been. The script still printed its success message.
  3. ⭐ **`String.replace` interprets `$` in the REPLACEMENT even when the PATTERN is a plain string.** `s.replace(anchor, add + anchor)` where the anchor contained a backticked `$` produced `$` + backtick = **"everything before the match"**, splicing the entire file prefix into the middle of `ledger.md` — **80 insertions and a phantom `### ` heading**. There is no regex anywhere in that call; a literal string is *not* literal on the replacement side.

  **The rules that actually hold:**
  - **Never build a replacement with `String.replace` when the replacement text is not under your control.** Use a **replacement FUNCTION** (`s.replace(a, () => text)`, whose return is taken literally) or plain **`slice()`** index splicing. The `$&`, ``$` ``, `$'` and `$n` forms are all live in the replacement string.
  - **Put script bodies in a FILE and run `node script.mjs`** rather than `node -e "..."`. Every one of the three above needed a `$` or a backtick to survive a shell, and the file path avoids the shell entirely. Same rule this file already gives for commit messages.
  - **Build backticks as `String.fromCharCode(96)`** when a JS string must contain them and the script is going through a shell.
  - ⭐ **What CAUGHT all three was a post-write COUNT, not a review**: the heading count (`grep -c '^### '`) for (3), and CI's psql for (1). **A scripted edit is not done until its count assertion has run** — this repo's existing rule ("assert the occurrence count before a scripted replace") is necessary but not sufficient, because these three edits all applied *successfully* and were wrong anyway.
- ⚠ **BACKTICKS IN A `git commit -m "..."` MESSAGE ARE COMMAND SUBSTITUTION, AND THEY DELETE THE WORD SILENTLY.** Bash expands `` `over` `` inside a DOUBLE-quoted string, so a message explaining that a guard "applies to `over` ONLY" commits as *"applies to  ONLY"* — the sentence still reads like prose, so nothing looks wrong until someone greps the history for the identifier that is no longer there. It also prints `command not found` to stderr while the commit SUCCEEDS, which is easy to skim past. Bit on 2026-08-15; repaired with `--amend -F` seconds later. **Write any message containing backticks (or `$`) to a file with a quoted heredoc (`<<'EOF'`) and use `git commit -F`** — the same rule this file already gives for SQL and patch scripts, which is why the ledger entries written through python heredocs were unaffected.
- **Web/console automation secret-safety:** never broad-query the DOM (`querySelectorAll('input')`, full `read_page`, `get_page_text`) on pages that can hold secrets (admin consoles, cron-job.org job-edit pages, env/secret settings, any auth-header surface). Scope reads to the specific target control; use the find tool for one element; never echo Bearer/token/key/secret values. Secret-bearing config edits are operator-only. (A Cowork session leaked `INGEST_SECRET_TOKEN` by broad-reading a cron-job.org job-edit page — the Advanced-tab Authorization header is in the DOM even when that tab isn't open.)
- ⚠ **THE SAME RULE BINDS `mcp__*__get_edge_function` — it returns the FULL deployed `index.ts`, not deploy metadata (verified 2026-08-11).** A session asked it for the deploy config to check `import_map` and got the entire source back, including the hard-coded `const GATE = "<live literal>"` — i.e. **a metadata request echoed a live gate key into the transcript**, with no way to un-see it. This is the same failure shape as the cron-job.org Advanced-tab leak: the secret rides along in a payload you did not ask for. **Before calling it, decide whether you need SOURCE or a FACT about the source, and prefer the fact.** To compare a key without ever echoing it, use the **md5-fingerprint method**: hash the candidate literal and the live `cron.job` `?key=` value and compare digests only — that is how the 6 exposed keys were confirmed during the D2 rotation, and it should be the default for any key-equality question. The 8 `*_GATE_KEY` edge fns are the acute case, but the rule is general: **any tool that can return deployed source can return a secret embedded in it.**
- 🚨 **THIRD INSTANCE, 2026-08-29 — `net.http_request_queue.url`, and it is the one nobody would guess.** pg_net is now this repo's general egress path for schema probes, and a session checking QUEUE DEPTH selected `url` and printed a live pg_cron gate key (`…/functions/v1/backfill-topshot-pack-sales?key=…`) into its transcript. **The query was about a COUNT; the secret rode along in a column it did not need.** ⭐ Same shape as the cron-job.org Advanced tab and `get_edge_function`: *the secret is in a payload you did not ask for*. **Select `id` and `count(*)`, or mask with `split_part(url, '?', 1)` — never bare `url`.** ⚠ The affected key **still needs rotating** (operator; the value is deliberately not repeated anywhere in this repo).
- ⭐ **The generalisation now that there are three: before selecting a column, or calling a tool, ask what the WIDEST thing it can return is — not what you intend to use.** All three leaks were reads whose INTENT was innocuous (a tab that was not open, deploy config, a queue depth) and whose PAYLOAD carried a credential. A read is scoped by what it RETURNS, not by why you ran it.
- 🚨 **`execSync("grep …")` FROM A TEST OR SCRIPT RUNS THROUGH `cmd.exe` HERE, AND IT FAILS THREE WAYS — one loud, one quiet, one SILENT (2026-08-24).** A pattern containing **spaces** gets re-split and the call THROWS (at module scope that kills the whole suite, which then reports **"0 test"** — dead, not failing); a **quoted glob** (`--include='*.ts'`) keeps its quotes so grep matches no filename; and ⚠ **`|| true` swallows either failure into an EMPTY result, so a guard walks ZERO files and PASSES.** This made `npm test` report **54 failures across 10 files of which 53 were not defects**, while CI stayed green — CI is Linux, the platform where the broken shape works. **Use `filesMatching()` from `__tests__/helpers/source-files.ts`; a ban at zero now enforces it.** Full case: [testing-and-ci.md](testing-and-ci.md).
- ⚠ **`f.replace(process.cwd() + "/", "")` NEVER MATCHES HERE** — `node:path.join` yields backslashes, so the value silently stays ABSOLUTE and **any allowlist or suppression keyed on a repo-relative path stops matching**. One guard reported its own deliberately-suppressed entry as an offender, which read like a live product defect until it was traced. Use `repoRelative()` (`relative(cwd, p).split(sep).join("/")`).
- ⚠ **A SECRET EXPORTED IN THE USER PROFILE LEAKS INTO EVERY PROCESS STARTED HERE, AND IT FLIPS AUTH BRANCHES.** `INGEST_SECRET_TOKEN` is ambient on this box (64 chars), and many routes gate as `if (expectedToken && authHeader !== …)` — **enforced only when the secret is SET** — so a test written against the *unset* branch 401s locally and passes in CI. ⚠ **`process.env.X ||= "stub"` cannot help: it defaults a MISSING var and is silent about a PRESENT one** — `vitest.setup.ts` now DELETES the auth secrets. ⓘ It also means a live token sits in any process that dumps `process.env`.
- ⚠ **`workers/*/node_modules` DEFEATS `vi.mock` SILENTLY.** Two worker dirs carry their own install (`@supabase/supabase-js` 2.105.4 vs the root's 2.104.0). **The consequence is not a version skew but a MOCK MISS** — the worker resolves the NESTED copy, a different module id from the one `vi.mock("@supabase/supabase-js")` registered, so the mock does not apply, the code builds a REAL client and makes REAL network calls that hang to the test timeout. ⚠ **It presents as FLAKINESS; at `--testTimeout=60000` the mask comes off and it is an ordinary assertion failure.** ➡ **Re-run a "timeout" with a long timeout before believing it is one.** Those dirs are gitignored, so they exist here and never in CI. Fixed by aliasing the specifier to the root copy in both vitest configs — **not** by deleting a developer's wrangler install.
- 🚨 **`repos/:o/:r/commits/:sha/status` REPORTS `state: success` WHILE GITHUB ACTIONS IS STILL RUNNING — it is NOT the CI result (2026-08-24).** That endpoint aggregates only **legacy commit statuses**; on this repo it returns **`total: 1`**, and **Actions check-runs are not in it.** Measured on `78fef7be`: the status API said **`success`** while the CI run was **`in_progress`** with **`Unit tests (vitest)` and `smoke` still going** (8 of 10 checks done). ⚠ **A watcher polling that endpoint declares victory mid-run**, which is the same class as a guard that passes having inspected nothing — *it answers a question you did not ask, in the vocabulary of the one you did.* ✅ **Use one of the two authoritative views instead:** `gh run list --workflow=CI --json headSha,status,conclusion` (filter on the sha, require **`completed success`** — `conclusion` is `null` until then) or `gh api .../commits/:sha/check-runs` for the per-check breakdown. ⓘ **Seven earlier tips checked this way that day WERE genuinely green**, so the wrong instrument agreeing is not evidence it is the right one — **it is what makes this trap survive.**

---

### ⚠ A guard written in a Linux sandbox can be RED ONLY on this box — backslash paths vs forward-slash prefixes (2026-09-03)

Three tree-walking guards landed green on CI and red on Trevor's Windows box the same day: `github-actions-are-sha-pinned` (`files.filter(f => f.includes("/.github/actions/"))` read **0**), `fmv-current-reads-are-keyed-on-edition-id` (`s.file.startsWith("app/")` never true) and `a-quota-that-counts-events-has-a-writer-for-them` (`/support-chat\/route\.ts$/` matched **1 of 3**). Same mechanism each time: `path.join` / `path.relative` emit `\` on Windows and the assertion compares against `/`. ⭐ **The tell is the non-vacuity assertion firing** — "found 0 of N" on a walk that plainly has files. **Fix at the walker, once:** normalise to POSIX right where the path is built (`.split(path.sep).join("/")` or `.replace(/\/g, "/")`), never at each assertion. ⚠ `npm test 2>&1 | tail` reports **tail's** exit code — the 3-failed run printed `exited with code 0` and a push went out on it; read the `Tests` summary line, not the status.


## Vercel tool behavior

- MCP tools are READ-ONLY for env vars.
- All env var writes: `POST https://api.vercel.com/v10/projects/{projectId}/env?teamId={teamId}` via PowerShell.
- `get_runtime_logs` truncates at ~50 chars — use short time windows (1-2h), low limits (20-50), unfiltered.
- `environment: "production"` required on `get_runtime_logs` or it returns nothing.
- ⛔ **REFUTED 2026-08-25** — this said `console.warn` is NOT indexed. It IS (largest level bucket). The zero came from `level:["warning"]`, whose stored value is `warn`. See the CORRECTION section below.
- ⚠ **`get_runtime_errors`'s `routes=` list is NOT the set of routes that produced the error, and neither is its `users=` count trustworthy** (measured 2026-08-21). `[panini-squeeze] backing view error` was reported as `count=395 users=340` across 26 routes including `/`, `/pricing`, `/moment/[id]` and `/profile/[username]` — but the string is emitted from ONE line (`lib/insights/panini-board.ts:43`) whose function has exactly TWO importers, neither of them any of those pages. Grouping the same string by `requestPath` gives **64 hits on the real emitter (`/api/cron/refresh-insights-cache`) and a 1–3 tail smeared across ~50 unrelated paths**; eight `[candy-mlb] candy_*_board` groups reproduce it exactly. **Confirm any route attribution two ways before acting: `get_runtime_logs` + `group_by: requestPath`, AND a repo grep for the literal log string to find its real emitter.** ⚠ The `after()` explanation is REFUTED — that cron is synchronous with `maxDuration = 60`; lambda instance reuse is an untested hypothesis, not a finding. ⚠ **The inverse is the dangerous half:** a genuine per-route failure on `/` is diluted into the same tail, so this makes real user-facing breakage HARDER to see. This matters because the nightly-pass runbook names Vercel runtime logs as *the* instrument for public-page health. Full measurement: `docs/overnight/inbox/2026-08-21T1730Z-vercel-runtime-error-route-attribution-is-smeared.md`.
- 🚨 **`get_runtime_errors` returns DIFFERENT counts for the SAME window depending on whether `since` is RELATIVE or an explicit ISO timestamp** (measured 2026-09-05, `/api/public/ipfs-media/[cid]`, calls minutes apart). `since: "24h"` → **139**; `since: "2026-09-04T16:45:00Z"`, the same instant → **44**. Re-run: **139 again**, so it is systematic, not transient. At **12 h the two forms agree exactly** (20 vs 20), so this is *not* a blanket relative-vs-ISO bug and cannot be predicted from the argument's shape. ⭐ **Only the ISO form is ADDITIVE**: the two sub-windows either side of a deploy returned **29** and **15**, summing to exactly 44. The relative 24 h figure reconciles with nothing, and is **not** the group's lifetime count either (300 since 09-03T00:00). ⛔ **Cause NOT established — do not theorise it into a rule.** 👉 **Operationally: pass explicit ISO `since`/`until` whenever a count will be quoted, compared, or used to discharge a watch, and NEVER subtract two windows specified differently.** 🚨 **But it is CONDITIONAL, and the controls matter: the SAME route at 12 h agreed (20 vs 20), and a DIFFERENT, lower-volume route over the same nominal 24 h agreed exactly (7/2/1 both ways).** So this is not “relative windows are broken” — it appeared only on a high-volume group (300 lifetime events) at 24 h. A sampling path on large groups is the obvious suspect and is NOT claimed. ⚠ A historical "N events in 24 h" taken with a relative lookback is therefore **suspect rather than wrong**, and most suspect on the noisiest groups — which are exactly the ones anyone bothers to quote. ⚠ And note `first=` in a result is a GROUP property that does not move with the window, so it cannot be used to sanity-check which window you actually got. Case: `docs/overnight/inbox/2026-09-05T1645Z-the-ipfs-media-gateway-race-watch-is-discharged-with-a-positive-control-and-get-runtime-errors-relative-windows-disagree-with-iso-ones.md`.
- 🚨 **A WRONG `routes` filter on `get_runtime_errors` returns "No runtime errors found" — which reads as GOOD NEWS** (measured 2026-09-05). `routes: "/insights/pack-reality"` returned nothing; the real path is **`/api/public/insights/pack-reality`**. ⚠ **The bracketed prefix in the message (`[public/insights/pack-reality]`) is a LOG LABEL the code chose, not the route** — reading it as the route is the mistake. 🚨 **This is the honesty-canon shape inside the instrument**: a failed read rendering as an answer, and the reassuring one — a wrong filter and a genuinely clean window produce identical output. ⭐ **Control, one extra call:** run the SAME filter over a window where events are KNOWN to exist; if that also reads zero, the filter is broken rather than the platform. Take route strings from a result's own `routes=` field, never from the log message. Case: inbox `2026-09-05T1120Z` (second interim reading).
- `web_fetch_vercel_url` returns cached results; `tsCount: 0` in body = reliable proxy failure signal.
- `web_fetch_vercel_url` only supports GET; preview URLs have SSO protection.
- `get_deployment_build_logs` needs `limit: 200` to get past npm warnings to actual TypeScript errors.
- Redeployment after env var changes: `POST https://api.vercel.com/v13/deployments` with gitSource ref. Dashboard "Redeploy" reuses cache, doesn't re-bake env vars.
- **An empty commit — or any docs/`*.md`-only commit — can NEVER force a rebuild on this project.** `vercel.json`'s `ignoreCommand` runs `git diff --quiet HEAD^ HEAD -- . ':(exclude)docs/**' ':(exclude)*.md' …`, which exits 0 (→ build skipped) when the diff is empty or docs-only. The reflex "push an empty commit to bake the new env var" silently no-ops (bit an operator activation on 2026-07-19: `DUNE_SALES_INGEST_QUERY_ID` was set, the empty "rebuild" commit `0e243e5e` was skipped in 2.5s, and the pipeline stayed inert while looking activated). The reliable force-rebuild is the v13 deployments POST above, or touch one non-docs file.
- `list_deployments` (with `since` timestamp in ms) → get deployment ID → poll `get_deployment` until READY (~30-38s).
- ⚠ **`get_deployment.state` LAGS — it reported `BUILDING` for ~45 minutes on a deployment that was READY (measured 2026-08-14, `dpl_37MUhGDnmpgznuN5Xp5vVQBMFSbt`).** The build log said `Build Completed in /vercel/output [3m]` and the final `ready` timestamp was `buildingAt + 3m32s`, yet four successive polls over the next three quarters of an hour all answered `BUILDING`. **Corroborate before diagnosing anything:** on a live build `ready` is a PLACEHOLDER EQUAL TO `buildingAt` and the `alias` array holds only the `*-projects.vercel.app` autogenerated hosts; on a finished one `ready` diverges from `buildingAt` and the production aliases (`www.rippackscity.com`, `rippackscity.com`) appear. `lambdaRuntimeStats` showing up in `meta` is another completion tell. ⚠ **And read the build log by its TIMESTAMPS, not by its tail** — the tail window can sit on an old chunk, which is how a completed build read as "parked at 300/401 static pages" and sent me hunting a prerender stall that had never happened. Two wrong diagnoses in a row, both from trusting one field. There WAS a real disk-IO saturation spell at the time (14 queries >10s, 13 on `DataFileRead`, headed by `refresh_wmc_fmv_changed` at 361s) — **a genuine condition that made the false story plausible is what made it expensive**, so confirm the deploy is actually stuck before explaining why it is stuck.
- Free tier: 100 deploys/day limit; rate limiting resolves after ~24h. (RPC is on Pro now.)
- **⚠ A disk-IO saturation spell can FAIL THE WHOLE PRODUCTION BUILD — the prerendered `/insights` board pages are a render too, and there a slow board is fatal rather than degraded.** Measured 2026-08-12 (`dpl_FwbnxURHqSbbYRqCQus44Cxxgyhc`, state **ERROR**): `Failed to build /insights/first-mint/page … because it took more than 60 seconds` ×3 → `Export encountered an error … exiting the build` → `npm run build` exited 1. **Next gives each page 60s and retries 3×, then kills the build.** The board-cache stale rung existed and first-mint's snapshot was ~85 min old (present and usable) — but the ladder only fell back when the live query **ERRORED**, and a query that is merely SLOW errors nowhere, so the fallback that would have saved the deploy sat one line below a query nobody was timing. Fixed by `BOARD_LIVE_TIMEOUT_MS` (8s) in [lib/insights/board-cache.ts](../../lib/insights/board-cache.ts), which collapses slow and broken into the same stale-fallback branch. ⚠ **A deploy that ERRORs is easy to miss** because the NEXT push supersedes it and goes READY — check the deploy state per commit, not just the tip.
  ⚠ **IT HAPPENED AGAIN 2026-08-13 ON A DIFFERENT PAGE, so treat this as a CLASS, not a first-mint quirk** (`dpl_8e1YhgadAMpx5XmfBTLhFqTUrMHN`, state ERROR): `Export encountered an error on /(analytics)/analytics/sets/[set_id] … exiting the build`. Same mechanism, new location — that page prerenders the **top-100 sets** via `generateStaticParams`, each doing an `analytics_sets_detail` RPC, and a connection-pool saturation spell made them block. **`rpcWithRetry` makes it WORSE, correctly**: a pool timeout is genuinely transient, so it retries, and the retries are what blow the 60s budget. Fixed with `SET_DETAIL_TIMEOUT_MS` (12s) + `loadSet` returning `{ data, ok }`. ⚠ **The build failure and the honesty defect were the SAME BUG**: `loadSet` returned a bare `null` for both "no such set" and "the read failed", so the page answered `notFound()` — at request time telling a visitor a real set does not exist, and at build time **baking that 404 into a static page** a crawler will believe. **Any prerendered page that reads the DB needs BOTH halves: a bound well under 60s, and a failure value distinct from absence.** `dynamicParams: true` is what makes the bound safe (a page dropped from the prerender set falls through to ISR rather than 404ing). Pinned by `__tests__/server-pages-error-vs-absent-guard.test.ts`, which now covers three pages plus the build-safety property.
  ⚠ **THIRD AND FOURTH INSTANCES 2026-08-15, TEN MINUTES APART, AND THAT IS WHY IT IS NOW BANNED RATHER THAN FIXED AGAIN.** `dpl_ARp2A4jk83FEpcs7FxBpbx6YMAJV` (`/insights/market`) and `dpl_8SUfFqqP6LEJLWpqVdqyUQbh31bM` (`/insights/market-pulse`), both `Timed out acquiring connection from connection pool` → `Export encountered an error … exiting the build`. ⚠ **NEITHER commit had touched the page that failed — one was TESTS-ONLY.** They drew the short straw during a saturation spell, which is the whole point: measured that day, only **5 of 30** `/insights` pages bounded anything, so **every deploy was a coin flip on wherever the saturation landed.** Both prior fixes (`BOARD_LIVE_TIMEOUT_MS`, `SET_DETAIL_TIMEOUT_MS`) were applied to the ONE page that failed rather than to the shape, which is exactly why it came back twice.
  **Now: all 26 async server `/insights` pages bound their read, the unbounded count is ZERO, and `__tests__/insights-server-pages-bound-their-reads.test.ts` is a BAN with no allowlist** — the usual ratchet exists to avoid shipping a 30-entry allowlist, and driving the population to zero in the same pass removes that objection. Use one of `readBoardOrLive` / `fetchBoardForPage` / `withBoardBudget` / `withPagedBoardBudget`.
  ⚠ **FIFTH INSTANCE 2026-08-16, AND IT CORRECTS THE "ZERO UNBOUNDED" CLAIM DIRECTLY ABOVE: THE BAN PASSED THE WHOLE TIME AND THE UNBOUNDED LEG WAS INSIDE THE PRIMITIVE.** `dpl_J4xD1YB7CfBtvwFABcBuhmU3SFuX` ERRORed on `Export encountered an error on /insights/deals/page` — again a page the pushing commit never touched. `readBoardOrLive` bounds only its LIVE leg; **`readBoardSnapshot` was unbounded, and the ladder calls it TWICE** (the fresh check, then the stale fallback) around that 8s bound, so the ladder's own worst case could exceed the 60s export budget. ⚠ **`readBoardSnapshot` try/catches to `null`, so it CANNOT THROW — and that is exactly what made it look safe.** The first hypothesis (it throws and propagates) is wrong; the finding only appears once you ask what could **HANG**. Fixed with `BOARD_SNAPSHOT_TIMEOUT_MS` (3s) on both snapshot legs, worst case now **3 + 8 + 3 = 14s**, via a shared `withinBudget` so there is no second primitive. **The lesson generalizes past this file: a guard that checks the CALLER for an approved primitive says nothing about the primitive's own legs** — the guard-scope class met one level *inside* rather than one directory over. ⚠ **Its test fixture is a read that NEVER SETTLES**; a throwing read was already covered and is a different, cheap failure. ⚠ **Stated honestly: this was NOT proven to be the cause of that build failure** — the logs show many boards hitting their 8s bound and degrading correctly, then deals failing, and never identify which leg consumed the budget. Shipped as a fix for a real gap, not as a root cause; a plausible mechanism is not a measurement.
  ⚠ **TWO primitives in [lib/insights/board-page-fetch.ts](../../lib/insights/board-page-fetch.ts), and the second is NOT duplication.** `withBoardBudget` **rejects**, feeding the try/catch these pages already have; `withPagedBoardBudget` **resolves** with `{ rows, error }` because the four `fetchAllPaged` pages have an `if (error)` branch and **no catch** — handing them a rejection would escape and throw during the export, **failing the build just as surely as the hang it replaces**, only faster and with a more confusing message. ⚠ A PAGED read is the worst shape for an export budget: it multiplies one slow round trip by the page count, and `/insights/market` is one of the two that actually died.
  ⚠ **THE REASON THIS WAS CHEAP: every one of those pages ALREADY had the honest-degraded path** — a `catch` or `if (error)` setting `ok:false` and rendering `DegradedDataNotice`. What twelve of them lacked was any way to REACH it, because **a query that is merely SLOW errors nowhere**. So bounding a page is a one-line change that cannot introduce a second, divergent failure policy. **Reach for that framing before rewriting a page's error handling.**
  ⚠ **Do NOT count this population by subtracting.** The first report of it said 17 unbounded; the real number was **12**, because 3 of the 30 are CLIENT pages (they read in the browser — no export budget) and `account-value` is a synchronous shell with no read. The guard encodes that exclusion as a PROPERTY (`export default async function` + not `"use client"`), so adding `"use client"` cannot become a way to hide an unbounded page.
- **Pro Lambda `maxDuration` hard cap is 800s.** Anything higher silently sends the deploy to ERROR state — including docs-only deploys — and the build log shows "Compiled successfully" + Sentry sourcemap upload with no logged error text before transition. Commit 32de87a set `wallet-backfill-multicollection` to 900 thinking it was the ceiling; the next 5 deploys all failed invisibly until `b32102e` reverted to 800. Same flavor of invisible failure as the fmv-recalc silent stall — both class of bug looks healthy from every external signal.

---

---

## Pushing from a sandbox — the full case history (moved verbatim from CLAUDE.md 2026-08-17)

### ✅ Cowork DESKTOP-VM sessions CAN push — durable recipe (Trevor approved 2026-08-29)

A Cowork session linked to Trevor's laptop runs `device_bash` in a Linux VM with open egress to github.com and the repo mounted at `$HOME/mnt/rip-packs-city`. The Windows-side credential lives in Git Credential Manager, invisible to the VM — so on 2026-08-29 a GitHub device-flow token (gh's public client id, scope `repo workflow`, no expiry unless revoked at github.com/settings/applications) was persisted, with Trevor's explicit approval, to **`<repo>/.rpc-git-cred`** (gitignored + `.git/info/exclude`; same exposure class as `.env.local`). ⛔ **Never `cat`, `echo` or `git remote -v` it** — a printed credential is a burned one (08-16).

```bash
# 1. fresh clone in the VM's own $HOME — NEVER commit into the live mount (Claude Code moves its HEAD mid-session)
cd $HOME && git clone -q --depth 50 --branch main https://github.com/jamesdillonbond/rip-packs-city.git rpcwork
cd rpcwork && test -z "$(git status --porcelain)" || echo 'DIRTY FRESH CLONE — stop'
# 2. edit, commit (ledger BEFORE code), then:
git -c credential.helper= -c credential.helper="store --file=$HOME/mnt/rip-packs-city/.rpc-git-cred" push origin HEAD:refs/heads/main
# 3. success test is ls-remote, never the push output
test "$(git rev-parse HEAD)" = "$(git ls-remote origin refs/heads/main | cut -f1)"
```

`npm ci` in that clone stalls for 30+ min on this VM (Node 22 vs the repo's `24.x` engine, native bindings); `npm i --no-save --ignore-scripts` finishes in ~2 min and is enough for vitest + `scripts/recover-fileless-migrations.mjs` (source `.env.local` from the mount with `set -a; . …; set +a` — never print it). The **cloud** Cowork session is still repo-set 403; this recipe is desktop-only.


### Pushing from a sandbox — BOTH sandbox paths are dead, for DIFFERENT reasons

- **CLOUD: there is no credential fix, and looking for one is wasted time.** Since 2026-08-11 the git proxy refuses at the **repository-authorization layer, before any credential is evaluated** — `access denied by the git proxy: … is not in this session's authorized repository set, so the proxy will not inject a credential for it`. Probed directly: an embedded `x-access-token:<PAT>@github.com` returns the **identical 403**. Upstream `anthropics/claude-code#76248`, open.
- **DESKTOP Cowork: the old pushurl-harvest recipe is DEAD and fails QUIETLY.** That `remote.origin.pushurl` is **absent** (verified on Trevor's box 2026-08-17: `credential.helper = manager`, gh 2.90.0 — push works there via the **Git Credential Manager / gh helper**, whose credential lives in the **Windows credential store, not the repo**, so a mount cannot see it). The old command now substitutes an empty string and yields a broken remote rather than an error.
- ⛔ **Do NOT "fix" either by re-embedding a PAT.** It was removed deliberately on 2026-08-16 because merely *reading* it (`git config --get remote.origin.pushurl`, `git remote -v`) prints a live `github_pat_…` into the transcript — that burned a real PAT once. The gh helper also carries the `workflow` scope an embedded PAT lacks.
- **What restores push:** (a) **`/web-setup` in a REAL TERMINAL `claude` session** — syncs the local gh token to claude.ai; ⚠ a built-in CLI command, so it does **not** fire in a VSCode-extension session (it arrives as plain text), and it authorizes **at session creation** — it fixes future sessions, not a running one. (b) **Create the session with the repo as its source** — `claude --cloud` from inside the repo, or claude.ai/code with the repo selected; the desktop Cowork project picker does not authorize, and the repo is not addable mid-session. (c) **Run the task on the computer** (desktop → "Run this task") — guaranteed while #76248 is open. (d) **`git format-patch`** — the sandbox clone works, so it can do the whole job and emit a patch to `git am`; needs nothing from Anthropic, proven end-to-end.
- Bash-green does NOT imply push-green. Never commit from the mount itself; always a fresh clone (deploy-split rule).
- ⚠ **Diagnose a push failure from the ERROR STRING, not from the fact that it failed.** *(Moved verbatim out of CLAUDE.md 2026-08-20 when that bullet was compressed; nothing was deleted.)* CLAUDE.md's text was: "⚠ **Diagnose a push failure from the ERROR STRING, not from the fact that it failed** — `! [rejected] main -> main (non-fast-forward)` means BEHIND ORIGIN and reads exactly like a permissions failure; that misread made the 08-18 night pass file a standing "git push is dead" escalation."

#### ⭐ 2026-08-25 re-derivation — THE TWO MODES ARE BEING CONFLATED, and the tell is the error string

⚠ **The 2026-08-25 night-pass handoff calls itself "cloud Cowork" and quotes the DESKTOP error.** It reported
`remote.origin.pushurl` EMPTY and `git push --dry-run` refused with **`could not read Username for 'https://github.com'`**.
That is **not** the cloud failure. The two are distinguishable in one line, and they have *different* remedies:

| | error string | what it means | remedy |
|---|---|---|---|
| **CLOUD** | `access denied by the git proxy: … is not in this session's authorized repository set` → **403** | refused **before any credential is evaluated** | attach the repo at session **creation** — nothing local helps |
| **DESKTOP / device bridge** | `could not read Username for 'https://github.com'` | git found **no credential at all** and fell back to an interactive prompt | a credential path that shell can actually reach |

**Reading the second as the first (or vice versa) sends you looking for the wrong fix** — which is CLAUDE.md's
own *diagnose from the ERROR STRING* rule, met again.

#### Upstream status, checked 2026-08-25 via `gh issue view 76248 --repo anthropics/claude-code`

**Still OPEN**, last updated 2026-08-24. An Anthropic maintainer has confirmed the 403 is **intended isolation
behaviour**, and the stated workaround is **starting the session with the repo already attached**; a
self-service "attach a repo mid-session" is acknowledged as wanted, with **no timing given**. Reporters confirm
**reads succeed and writes are refused**, and that `gh` and the REST API are refused separately for the same
repo, so **there is no API fallback**. ➡ **For the CLOUD mode there is still nothing to fix locally. Stop
looking.**

⚠ **One upstream detail worth carrying:** the bundle/patch handoff has its own failure mode — *"bundles are
incremental, so if a bundle is built from the agent's local HEAD rather than from the last commit the user
actually pushed, the fetch fails with a missing-prerequisite error."* Build the bundle against `origin/main`,
not local HEAD.

#### 🚨 A CORRECTION THAT WILL SAVE THE NEXT SESSION AN HOUR: `git config --get-all credential.helper` MISSES THE gh HELPER

Tonight I ran `git config --show-origin --get-all credential.helper` on Trevor's box, saw only `manager`, and
concluded the gh helper was not configured. **That was wrong.** The gh helper is registered under a
**host-scoped** key, which that query does not match:

    credential.https://github.com.helper = !'C:Program FilesGitHub CLIgh.exe' auth git-credential
    credential.https://gist.github.com.helper = …

**It was ALREADY set globally, and `gh auth setup-git` is a NO-OP here** (config byte-identical before and
after — verified). ⚠ **Use `git config --get-regexp 'credential.'`, never `--get-all credential.helper`.**

#### ✅ TESTED 2026-08-25: `gh` ALONE can authenticate a push on Trevor's box

Proven by excluding GCM and leaving only the gh helper, which is the control that makes it mean anything:

    git -c credential.helper=         -c credential.https://github.com.helper='!gh auth git-credential'         push --dry-run origin main     # → "Everything up-to-date", exit 0

`gh auth git-credential get` also answers **non-interactively** (exit 0, returns `username`+`password`; token
scopes `gist, read:org, repo, workflow`). ⚠ **Never print that output** — pipe it through something that
reports only whether a `password=` line exists.

➡ **So "the desktop shell has no credential helper" is NOT the explanation, and configuring one is NOT the
fix — it is already there and it works.** The remaining hypotheses for the bridge shell are: it runs as a
**different OS user** (different `~/.gitconfig`, different keyring), it **cannot execute `gh`**, or it operates
on a **clone that does not inherit global config**.

#### The four-command diagnostic to run INSIDE a failing session (do this before theorising)

    git push --dry-run origin main 2>&1 | tail -3   # the ERROR STRING decides which mode you are in
    git config --get-regexp 'credential.'          # NOT --get-all credential.helper
    gh auth status 2>&1 | head -3                   # is gh present AND authenticated in THIS shell?
    whoami                                          # same OS user as the keyring owner?

**Report those four verbatim.** Every wrong turn recorded on this page — the dead pushurl harvest, the
re-embedded PAT, tonight's helper misreading, the night pass's mode conflation — was avoidable by one of them.

- ⚠ **Deleting a REMOTE branch 403s from the sandbox even when pushing works** — the proxy allows push-to-ref and denies delete-ref. *(Moved verbatim out of CLAUDE.md 2026-08-20 when that bullet was compressed to a pointer; nothing was deleted.)* CLAUDE.md's text was: "the proxy allows push-to-ref, denies delete-ref — so confirm it is safe to drop (`git rev-list --count origin/main..<branch>` = 0) and hand the **GitHub UI** deletion to Trevor."

---

## Measuring a file against the memory-file char limit — `wc -c` LIES, and `wc -m` is platform-dependent (added 2026-08-17, NOT part of the verbatim extraction)

The memory-file limit counts **characters**; `wc -c` counts **bytes**. CLAUDE.md is dense in multi-byte punctuation, so the byte count runs several hundred ahead of the real figure and **the file spends its whole life inside that gap** — a session following a `wc -c` recipe reads OVER and starts cutting rules out of a file that has room to spare.

Dated sample, 2026-08-17 PT, CLAUDE.md immediately after the boilerplate trim:

| instrument | value | verdict |
|---|---|---|
| `node -e "…readFileSync('CLAUDE.md','utf8').length"` | 39,805 | **the binding number** — UTF-16 units, what a JS harness measures |
| `wc -m` (this box, `LANG=en_US.UTF-8`) | 39,805 | agrees exactly here — but see both caveats below |
| `wc -c` | 40,314 | **509 too high** — would read OVER on a file that was 195 under |
| `LC_ALL=C wc -m` | 40,314 | collapses to the byte answer; `wc -m` is only char-aware in a UTF-8 locale |

The 509-byte gap, censused: `—` ×132, `⚠` ×63, `·` ×58, `→` ×10, `…` ×5, `⛔` ×2, `✅` ×2 — 3 bytes and 1 char each — plus one 4-byte `🚨`.

- ⚠ **Do NOT record the gap as a fixed offset** ("wc -c over-counts by ~500"). It scales with how much `⚠`-dense prose the file carries, so a constant silently absorbs real growth — the shelf-life rule at the top of CLAUDE.md, applied to itself. Re-measure, never quote.
- ⚠ **`wc -m`'s locale trap is environment-shaped, so the two boxes disagree about whether it is safe.** On **Trevor's Windows box** `LANG=en_US.UTF-8` is already set, so bare `wc -m` is correct. In the **Claude Code sandbox** `LANG` is empty, so bare `wc -m` returns the byte answer — it fails in exactly the environment where you would reach for it. `LC_ALL=C.UTF-8 wc -m` is correct in both; bare `wc -m` is correct in only one.
- ⚠ **`wc -m` and Node disagree by one per ASTRAL character, and which is "right" is platform-dependent.** Measured directly against a one-emoji file: MSYS/Git Bash `wc -m` counts `🚨` as **2** (UTF-16 units, matching Node `.length`); GNU `wc -m` on Linux counts **1** (codepoints). CLAUDE.md carries exactly one astral char — `[...s].length` = 39,804 codepoints vs `.length` = 39,805 units — so the same command reads 1 LOWER from the sandbox than from this box. **Prefer Node `.length`**: the limit is enforced by a JS harness, which measures UTF-16 units.
- The same trap applies to any char-limit check over these docs, skill files, or other `docs/reference/*.md`. Count with Node, not `wc`.


---

## Sandbox + CI gotchas learned 2026-08-17/18 (promoted from session log)

### 🚨 `git checkout -- <file>` DISCARDS UNCOMMITTED WORK — it is not an undo for your last edit

Used to revert a one-line probe mid-session; it restored the file from the index and **destroyed the
entire uncommitted fix**, not just the probe. It surfaced two steps later as a test failing on code I
believed was in place. **Copy the file first (`cp x /tmp/x.bak`) and restore from the copy.**
`git checkout --` has no notion of "just the change I made a minute ago".

### ⚠ Read the failing JOB, not the run's red badge

Twice in one session a red CI run was **8 of 9 jobs green**, with the failure in a job unrelated to
the obvious suspect (`DB invariants (SQL)`, not the vitest suites). Reading the run status alone sends
you to the wrong subsystem. `actions_list` with `method: list_workflow_jobs` and
`workflow_jobs_filter: {filter: "latest"}` names it in one call.

### ⚠ Reproducing `db-tests` locally: `initdb` refuses to run as root

The CI job provisions a throwaway Postgres from the runner's binaries. In this sandbox the shell is
root and `initdb` **hard-refuses** (`cannot be run as root`). Recipe that works:

```bash
PGBIN=/usr/lib/postgresql/16/bin; PGDATA=/tmp/…/pgdata
mkdir -p "$PGDATA" && chown -R postgres:postgres "$PGDATA" /tmp/…
su postgres -s /bin/bash -c "$PGBIN/initdb -D $PGDATA -U postgres --auth=trust"
su postgres -s /bin/bash -c "$PGBIN/pg_ctl -D $PGDATA -o '-p 5433 -k /tmp/…' -l /tmp/…/pg.log -w start"
DATABASE_URL=postgres://postgres@localhost:5433/postgres bash scripts/run-db-tests.sh
```

Worth the two minutes: it turns a CI log into a local reproduce-and-probe loop, and it is how the
08-18 panini fixture breaks were diagnosed and both fixes proved load-bearing.

### ⚠ The anon-exec marker must sit on ONE line with the function name

`__tests__/migration-new-function-states-its-anon-exec-decision.test.ts` accepts a marker only when a
**single line** matches `/anon-exec:\s*\S+/i` **and** contains the function name. A multi-line
justification (marker on line 1, function named on line 2) stays red. The error message shows the
one-line shape; the format is `-- anon-exec: intentional — <why> (<fn>)`.

⚠ **And prefer the marker to a REVOKE for a `CREATE OR REPLACE` snapshot.** Replacing a function does
NOT reset its ACL, so a revoke there is a live production change. Check whether the function is
genuinely new (`grep` prior migrations) before reaching for the revoke — on 2026-08-18
`rpc_thp_leg_panini` had been created *and revoked* on 08-10, so the revoke would have been the
change, not the fix.

### ⚠ Bash tool: literal control characters in a command are rejected

Writing a probe that embedded a raw `0x00`/`0x1f`/`0x7f` (e.g. pasted back from `cat -v` output) is
refused with *"command contains control characters"*. Build such strings from escapes inside a script
file (`String.fromCharCode(0)`, `\u0000`) and run the file.

### ⚠ Supabase MCP: a 60 s cap, and views that recompute

`execute_sql` abandons the RESULT at 60 s, not the query. Under a saturation spell this hit repeatedly
on `pack_ev_latest` — which turned out to be a plain **VIEW** doing `DISTINCT ON` over ~203k rows on
every call (despite a cron named `rpc-refresh-mv-pack-ev-latest`). **Read `pg_views.definition` /
`pg_proc.prosrc` instead of executing the object** when the question is about shape rather than data;
it is instant and it answered what three timed-out queries could not.

### 🚨 A `filter-repo` purge only rewrites the refs you PUSH — the tell for an unpurged one is a merge-base at the ROOT COMMIT (measured 2026-08-22)

The 2026-08-03 `git filter-repo` + force-push purged a leaked credential file from **`main`**. It did
**not** rewrite `origin/claude/todo-implementation-e4tib3`, which branches from the **root commit** and
therefore still carries the entire pre-purge history — **on a public repo**. Blob `02a86fcb` of
`scripts/fetch-allday-collection.mjs` is reachable there and not from `main`, introduced by
**`1c3e01a8f`**, the exact sha the ledger's P0 names as the leak's origin.

⚠ **This repo already knew the mechanism and drew the wrong conclusion from it.** The 08-05 SessionStart
self-heal fix is about precisely this root re-hash — but it was filed as a **branch-alignment** gotcha,
so nobody drew the **security** conclusion sitting next to it for nineteen days.

**After ANY history purge, the completion check is not "the force-push succeeded":**

```bash
for b in $(git for-each-ref --format='%(refname:short)' refs/remotes/origin); do
  echo "$b $(git merge-base origin/main "$b")"    # a merge-base equal to the ROOT commit = UNPURGED
done
```

**Three things that make the write-up honest, all of which cut against alarm:**

- ⚠ **Measure values-free.** Every figure should be a `grep -c` or a reachability boolean — never read,
  print or decode the credential. Compare a suspect blob against `main`'s sanitized one as a **control**
  (`eyJ` JWT markers: 2 vs 0; `process.env`: 2 vs 4) so the instrument is shown to discriminate.
- ⚠ **"Commits ahead" is a re-hash ARTEFACT, not lost work.** `e4tib3` reads **4,024 commits ahead**;
  tested on a CONTENT property (tip tree matches no tree in `main`) the honest figure is **one** draft
  commit. Sizing it down is as much a part of the finding as raising it.
- ⚠ **Deleting the branch is necessary but NOT sufficient**, and the expired-credential half is not the
  point: unreachable objects stay fetchable **by sha** until GC, and the **PII in an RS256 token payload
  does not expire** even after the session cookies do. Rotation, not purging, is the remedy.

⛔ **Remote delete-ref 403s from the sandbox** (push-to-ref is allowed), so the deletion is an operator
action via the GitHub UI — and it should be preceded by triaging whatever unique work the branch holds.

### ⚠ A `send_later` reminder SELF-BINDS to the calling session, and dies with it (measured 2026-08-22)

`mcp__Claude_Code_Remote__send_later` is a thin wrapper over a **self-bound** one-shot Routine: it fires
back into the session that created it. When that session is archived or otherwise goes away, the Routine
does not migrate and does not fail loudly — the trigger list simply shows
`ended_reason: "auto_disabled_session_gone"`. A scheduled apply parked that way **never runs, and nothing
reports it**; the only evidence is a trigger row nobody reads. Proven on `trig_017CHH…`, and a 20:15Z
cross-collection migration apply was one archive away from the same fate.

**So: anything that must happen after this session ends goes in a FRESH-SESSION Routine**
(`create_trigger` with `create_new_session_on_fire: true`) carrying a *standalone* runbook — the fired
session inherits none of this conversation. ⚠ **And it must open with a CAPABILITY CHECK**: `create_trigger`
stores **no MCP connectors**, so the fired session may have no Supabase/Vercel tools at all. A runbook that
cannot execute must **report and STOP**, never improvise — a half-run migration is worse than a missed one,
and "the schedule fired" reads as "the work happened" in every instrument that records it.

---

## ⚠ AN ASSERTION MARKER THAT LINE-WRAPS FAILS ITS OWN ASSERT — and a splice payload read from a REUSED scratch filename passes one (2026-08-23)

Two ledger-splice traps in one session, both caught by asserts, both about **pinning a spelling rather than a
property** — the third and fourth recorded instances of that class.

- 🚨 **The dangerous one, because the assert PASSED.** A rebase resolver read its entry from a scratchpad
  `entry.md` left over from an **earlier entry the same session**, and spliced the WRONG text at the top of
  the ledger. The heading-count check (`1899 → 1900`) went green — **it counts headings, not identity.**
  ⭐ **Assert on a unique string FROM THE CONTENT YOU MEANT TO WRITE**, and never reuse a generic scratch
  filename across entries. (Caught only by reading the result back.)
- ⚠ **The harmless one, twice.** A marker chosen for the assert **line-WRAPPED inside the prose** (`…BY DESIGN
  via the MEDIUM\ndispersion ceiling`), so `count(MARK)` was 0 and the write correctly did not happen.
  ⭐ **Choose a marker that cannot straddle a wrap** — a short unbroken token like a run number — **and assert
  `MARK in entry` BEFORE asserting `MARK in output`,** so a bad marker fails loudly instead of looking like a
  bad splice.

- 🚨 **FIFTH INSTANCE, 2026-08-25 — the splice APPLIED and was catastrophically wrong, and the heading count
  is what caught it.** The entry was built by joining its lines into a single **string**
  rather than leaving them as an array, and was then spread:

  ```js
  lines.splice(i, 0, ...entry)   // spreads the STRING's CHARACTERS, one per array slot
  ```

  `ledger.md` became **2,063 single-character lines** and the `### ` heading ceased to exist. **Nothing
  threw**, and `git diff --stat` read `+2063`, which for a ledger append is large but entirely plausible.
  ⭐ **The ONLY instrument that saw it was CLAUDE.md's mandated post-write `grep -c '^### '` holding flat at
  1063 instead of rising to 1064.** That rule is a **detector, not ceremony** — and **a plausible
  `diff --stat` is not verification.**
  ⭐ **Read together with the reused-scratch-filename trap above, the pair defines the count check's exact
  blast radius: it catches SHAPE corruption and is blind to IDENTITY.** So both assertions are needed — the
  count must RISE BY EXACTLY N, *and* a unique string from the content you meant to write must appear.
  Neither subsumes the other.
  ⭐ **Spread an ARRAY of lines, never a joined string**, and repair with `git checkout --` verified by an
  **empty `git diff`** (see the stale-`index.lock` section below — checkout can silently no-op too).

## `git stash push <path>` on an already-COMMITTED path is a silent no-op — and it fakes a negative control (2026-08-22)

To prove an assertion could actually fail, I reverted the fix with
`git stash push components/WalletSearchBand.tsx` and re-measured: **102px, test still green.** The obvious
reading is "the assertion is vacuous". The truth was the opposite — **the file had no working-tree
changes** (the fix had been committed in an earlier round), so the stash stashed nothing and I had
measured the fixed code twice.

`git stash push <path>` on an unmodified path **prints nothing and exits 0**. The tell was `git stash pop`
answering **"No stash entries found"**.

⚠ **A negative control that "passes" is itself a claim that needs a control.** Confirm the revert actually
reverted — by `git status` on the path, or by watching the MEASUREMENT move — before concluding a test is
vacuous. Redone properly (re-introduce the defect with `sed`, measure, `git checkout --`): 350px, and the
spec failed with the height in its message.

Same family as the `git commit -m` backtick trap already recorded above: a git command that succeeds while
doing nothing you intended.

⚠ **Related, same session:** a backtick inside a CSS **template literal** (`` const CSS = `…` ``) terminates
the literal. A comment quoting `flex:1 1 300px` in backticks broke the build; the dev server's parse error
was the only reason it surfaced.

---

## ⛔ CORRECTION 2026-08-25 — `console.warn` IS indexed. The rule that said otherwise was a BROKEN FILTER, and it nearly cost 158 edits

CLAUDE.md carried `get_runtime_logs: console.warn is NOT indexed — use console.log` for months. **It is wrong**,
and the 08-22 section immediately below always contradicted it (it says `source: ["serverless"]` *surfaced the
warn lines*). The two coexisted because nobody re-measured.

Measured 2026-08-25, production, `group_by: "level"` over a 3-hour window:

| level | count |
|---|---:|
| **warn** | **1,796** |
| error | 1,533 |
| info | 1,393 |

**`warn` is the LARGEST bucket in the index.**

### 🚨 The actual trap, and it is a permanently-zero instrument

```
level: ["warning"]   →  "No logs found for the specified criteria."   (6h window, production)
```

**The tool schema's enum value is `warning`; the stored value is `warn`.** So the one filter a reader would
reach for to find warn lines returns **zero, silently, forever** — which reads exactly like "warns are not
indexed". That is almost certainly where the rule came from. ⚠ **This is CLAUDE.md's own "a permanently-zero
instrument is indistinguishable from a broken one" — committed by a filter enum.**

⚠ **The same mismatch appears on `source`.** The schema enum is `serverless | edge-function | edge-middleware |
static`; `group_by: "source"` reports `middleware | function | cache | redirect | rewrite`. The 08-22 note
records `source: ["serverless"]` working, so the filter is probably translated server-side — **but never read a
zero from either filter as a fact about your logs.**

### What to do

- **Do NOT convert `console.warn` to `console.log` for indexing reasons.** There are **158 `console.warn` calls
  across 43 route files** under `app/api`; that edit was on the table this morning purely on the strength of the
  stale rule, against a premise that is false.
- Use `group_by: "level"` (or no level filter at all) rather than `level: [...]`.
- ⚠ **Full-text `query` timed out at every window tried on 08-25** (6h, 45m, 20m, and scoped to a single
  `deploymentId`), while `group_by` aggregates returned instantly. So this correction establishes that
  **warn-LEVEL entries are indexed**; it does NOT establish that an arbitrary `console.warn` string is
  retrievable by full-text search today. Stated rather than glossed.

---

## `get_runtime_logs` without `source` hides the lines that carry the cause (2026-08-22)

Investigating four `/overview` pages that hung 30s, the default Vercel MCP `get_runtime_logs` view returned
**47 clean `200` lines** for `/nba-top-shot/overview` and nothing else — which reads as a healthy page and
cost ten minutes on the wrong hypothesis.

Adding **`source: ["serverless"]`** surfaced the `warn` lines:

```
[popular-on-collection] hubs read failed collection=ufc: Timed out acquiring connection from connection pool.
```

⚠ Pair it with `environment: "production"` and a SHORT window (`since`/`until` around the incident).
`group_by: "requestPath"` first to find which paths were busy, then filter. ⛔ The `console.warn` half of CLAUDE.md's old note is REFUTED — see the CORRECTION
section above; warn IS indexed and it was `level:["warning"]` that read zero. `get_runtime_errors` route
attribution IS still SMEARED — re-group on `requestPath`.

### 🚨 `group_by` MATCHES THE REQUEST PATH, NOT THE LOG BODY — so a grouped query for a LOG LINE reads zero forever (2026-09-03)

**It nearly produced a false finding about a change made the same day.** Verifying a new
`[ipfs-media] streamed` completion line, three grouped queries over a 6 h window all returned an empty
table:

```
query: "ipfs-media streamed"  →  (no rows)
query: "ipfs-media ok"        →  (no rows)
query: "ipfs-media upstream"  →  (no rows)
```

Read naively, the first says *"the new line is not firing"*. ⛔ **All three are meaningless.** The third
is the control that exposes it: the same window carries **33 × 502**, every one of which logs
`[ipfs-media] upstream fetch failed`. A query that cannot find a line that MUST be there cannot be
used to conclude a line is absent.

⭐ **Only the UNGROUPED form returns a function's own output.** An ungrouped result renders each request
followed by its `console` lines, and the text query still appears to match the PATH — so the practical
recipe for "did this log line fire" is:

```
get_runtime_logs  query: "<path fragment>"  statusCode: "200"  since: "6h"  limit: 8
```

⚠ **`statusCode` is doing real work there, not tidying.** Without it the ungrouped query times out under
daytime traffic (measured: 12 m, 45 m, 2 h and 3 h windows all *"did not finish within the time
budget"*, while the same 6 h window with `statusCode: "200"` returned in one shot). Narrowing the WINDOW
is the documented advice and it was the narrowing that did **not** help.

⚠ **And a 200 with no output lines is a CACHE HIT, not a silent success.** Grouping by `statusCode`
counted 27 × 200 on a route whose successes all log two lines; the function was never invoked for most
of them. Do not read a status count as an invocation count.

---

## Driving Chromium from a Claude Code web sandbox (2026-08-22)

* Playwright's own browser build is **absent** — the repo pins a newer revision than `/opt/pw-browsers`
  carries, and `npx playwright install` is not the answer here. Pass
  `executablePath: "/opt/pw-browsers/chromium"` (a symlink to the 1194 build) plus `--no-sandbox`.
  `playwright.config.ts` already reads `PW_CHROMIUM_PATH` for exactly this.
* ⚠ The agent proxy answers **403 to CONNECT for www.rippackscity.com** — an organization network-policy
  denial, not a transient failure, so **do not retry it**. Production cannot be browsed from the sandbox.
  Measure against a local `npm run dev`, or dispatch `e2e-smoke.yml` (it is `workflow_dispatch`-enabled)
  and read the run.
* ⚠ A script importing `playwright` must live **inside the repo** — Node resolves from the file's own
  directory, so a probe written to the scratchpad dies on `ERR_MODULE_NOT_FOUND`.
* ⚠ `elementFromPoint` returns **null outside the viewport**, and **`NEXTJS-PORTAL`** (the dev
  error-overlay root, absent in production) intercepts points. Both read as failures if unfiltered.

## "The sandbox could not do it" is NOT evidence the DATABASE forbids it (2026-08-22)

A filed finding said **"NO session-reachable role can reschedule 42 of 93 pg_cron jobs"**, and it turned a
two-line fix into a privilege-grant proposal. Re-derived, the privilege half was wrong: `postgres` **is** a
member of `cron_heavy`, and `cron_heavy` **already holds** EXECUTE on `cron.schedule` and both
`cron.unschedule` overloads. Only `cron.alter_job` is missing — which `postgres` does hold but cannot use,
owning none of those jobs and not being superuser here. Since `cron.schedule` upserts on
`(jobname, username)`, rescheduling *under the job's own role* updates it in place. **No grant is needed, and
granting `alter_job` would widen a privilege to buy a capability the role already has by another door.**

⚠ **What actually blocks it is the HARNESS**: the Claude Code auto-mode classifier denies `SET ROLE`, and
after one denial denies cron-schema SQL generally. **Two different boundaries — a harness refusal and a
database refusal — produce the same "I could not do it", and the filing recorded the stronger claim.**
Before writing "cannot", say WHICH layer said no. Operator recipe + the self-check are in known-issues #19.

## `git push | tail` reports `tail`'s exit code — and prints a success banner over a FAILED push (2026-08-22)

CLAUDE.md already records that a pipe reports the LAST command's status. The live variant worth naming:

```bash
for i in 1 2 3 4; do
  if git push -u origin main 2>&1 | tail -3; then echo "PUSH_OK"; break; fi   # ⚠ tests tail, always 0
  ...
done
```

It printed **`PUSH_OK` over a `(non-fast-forward)` rejection**, and the loop exited on the first attempt.
Same shape bit again minutes later as `python resolve.py | tail -3 || { fallback }` — the fallback silently
never ran because the pipeline exited 0. **Redirect to a file and read `$?` on the bare command:**

```bash
git push origin main > "$SCRATCH/push.log" 2>&1; echo "PUSH_EXIT=$?"; tail -2 "$SCRATCH/push.log"
```

⚠ **Diagnose from the ERROR STRING**: `(non-fast-forward)` means BEHIND ORIGIN even when `git status` says
`ahead 2` — the local `origin/main` ref was stale and needed a `fetch` first.

## ⚠ A stale `.git/index.lock` makes `git checkout --` and `git merge` SILENTLY no-op — and `merge` PRINTS a success line while doing nothing (2026-08-25)

Same family as the `git push | tail` banner above, but **worse, because there is no pipe to blame** — the
bare command itself reports success. A zero-byte `.git/index.lock`, minutes old with no git process alive,
ate both a `git checkout --` and a `git merge`. The tell that makes it dangerous:

```
git merge …
Updating d347b101..45481fc1        # ← reads as success. HEAD NEVER MOVED.
```

⭐ **"The merge said `Updating`" is NOT proof it happened. Verify by `git rev-parse HEAD` before and after,
never by the printed line.** The same applies to `git checkout --` (verify by an empty `git diff`) and to
`git commit` (verify the sha moved) — a git command's OUTPUT is not evidence it acted.

⛔ **Do NOT bolt on an "if no git process is running, delete the lock" guard — that exact fix was measured
and REJECTED on 2026-05-31**, and the reasoning still binds. Root cause (confirmed from the reflog, archived
in `docs/archive/handoffs/handoff-2026-05-31-git-locks-and-followups.md`): the Cowork sandbox and this
Windows box **share one `.git`**, and interleaved commits or a sandbox killed mid-rebase leave the lock
behind. So:

- **A "no git process alive" check is scoped to ONE SIDE of the mount** and cannot see a live git process on
  the other. An age-based auto-clear therefore risks unlinking a lock a concurrent writer legitimately holds.
- From the **sandbox** the unlink usually fails anyway (`Operation not permitted` — the mount denies it).
- **Clearing it by hand from Windows is the repair Trevor performs** (`Remove-Item .gitindex.lock`), and it
  is safe precisely because a human confirms nothing else is mid-commit. That is a manual step, not a rule to
  automate. The durable fix remains giving the scheduled runner its **own clone**.

⚠ **The detection half is the part that generalises and is safe to apply everywhere:** read HEAD before and
after. That is what caught it, and it costs nothing.
## Sizing a drift is not reading it (2026-08-22)

Cheap sizing (line/char deltas of live `prosrc` vs the pinned copy) is a good way to ORDER a queue of stale
pins. It is not a change summary. `get_challenge_plan` measured **57 characters SHORTER at identical line
count** — which reads like a trim — while the predicate grew by 6: the other change was a **dropped
comment**, and the negative delta concealed a semantic rewrite entirely. **A shrinking function can be
gaining logic. Only the diff is the measurement.**

## A `send_later` check-in DIES when its session is archived — use a fresh-session Routine for anything that must outlive the thread (2026-08-22)

`send_later` is a thin wrapper over `create_trigger` that **binds to the calling session**
(`persist_session: true`, `persistent_session_id: session_…`). That is exactly right for "remind me later in
this conversation" and exactly wrong for a verification that must happen after the thread is archived.
⚠ **`list_triggers` carries the proof**: an older reminder sits there with
`ended_reason: auto_disabled_session_gone` — it never fired, and nothing announced that it hadn't.

**A monitor that quietly stops existing fails identically to the thing it was watching for** — the same
class this repo already records for the concierge's lost positive control. So, when wrapping up a session:

- **Outlives the thread** → `create_trigger` with `create_new_session_on_fire: true` and a **fully
  standalone prompt** ("assume NO prior context"), because the fired session inherits nothing.
- **Only meaningful inside this conversation** → `send_later` is fine; expect it to die with the session.

⚠ **A fresh-session Routine created this way stores NO MCP connectors** — the tool warns about it — so the
fired session may have no `mcp__github__*` / Supabase tools at all. **Open every such prompt with a STEP 0
capability check that reports and STOPS rather than improvising.** The existing RPC routines already do this;
copy that pattern rather than assuming the tools will be there.

## Reaching a blocked host from the Claude Code sandbox: `net.http_get` from Postgres (2026-08-22)

⚠ **The web/cloud sandbox's network policy DENIES hosts the platform itself can reach.** `rest-mainnet.onflow.org` returns `CONNECT tunnel failed, response 403` from `curl` — a **policy denial at the agent proxy**, visible in `curl -sS "$HTTPS_PROXY/__agentproxy/status"` under `recentRelayFailures`. `www.rippackscity.com` is blocked the same way, so **a route cannot be smoke-tested from the sandbox by fetching it.**

✅ **`net.http_get` from Postgres reaches it, needs no deploy and no gate key**, and was used to characterise the Pinnacle trade shape end to end (two 10,000-block windows, `/v1/events` + `/v1/transaction_results`). Pattern:

```sql
SELECT net.http_get('https://rest-mainnet.onflow.org/v1/blocks?height=sealed');   -- returns a request id
-- then, AFTER it drains:
SELECT status_code, content FROM net._http_response WHERE id = <id>;
```

⚠ **It is ASYNCHRONOUS and the queue is slower than it looks** — 40 requests took **>25 s** and 62 `transaction_results` took **>65 s** to drain. A read immediately after firing returns **zero rows**, which is indistinguishable from a failed batch: check `net.http_request_queue` for the same ids before concluding anything. ⚠ **`pg_sleep()` inside `execute_sql` competes with the MCP's own 60 s timeout** — keep it under ~45 s.

⚠ **Fire each logical batch as its OWN statement and record its id range.** A `(values …) CROSS JOIN generate_series(…)` fan-out gives you ids you cannot map back to inputs, and `net._http_response` does **not store the URL** — so a partial failure becomes unattributable. The first survey attempt had 9 of 60 reads fail and three epochs vanish from the GROUP BY, which reads exactly like "no activity in those epochs" — **the failed-read-rendering-as-an-answer class, inside a measurement.** Always report reads-fired vs reads-200 per bucket.

⚠ **Running the DB-invariant suite locally is documented in [testing-and-ci.md](testing-and-ci.md) → "Provisioning the DB-invariant suite locally" — do not duplicate the recipe here.** Two things that section's recipe assumes and that cost time on 2026-08-22: `initdb` refuses to run as **root**, and **piping its error to `/dev/null` makes the whole failure silent** (`pg_isready` is then the only tell). Also, a `/tmp/claude-*` scratch dir is **not readable by the `postgres` user** — use a `/var/tmp/...` path chowned to it.


## Displaced from CLAUDE.md 2026-08-23 — the two long Vercel bullets, verbatim

Condensed to their rule in CLAUDE.md to keep the memory file under its character limit while three
drifted figures were refreshed. The rules stand; the detail is here.

> - ⚠ **`get_deployment.state` LAGS** (`BUILDING` for ~45 min on a READY deploy). Corroborate: `ready` vs `buildingAt`, production aliases attached, `lambdaRuntimeStats` present. ⚠ **A deploy that ERRORs is easy to miss** because the next push supersedes it and goes READY — **check deploy state PER COMMIT**.
> - **A disk-IO saturation spell can FAIL THE WHOLE PRODUCTION BUILD** — prerendered `/insights` pages get 60 s each, and a *slow* board errors nowhere, so the stale-fallback never fires. Now a **ban at zero** (`insights-server-pages-bound-their-reads`); ⚠ twice the failing page was one the pushing commit never touched.

---

## Two sandbox mechanics that cost a turn each (2026-08-25)

### ⚠ Running `npm test` twice in quick succession OOM-kills the worker (exit 137)

The full vitest suite (**1,379 files / ~15,114 tests**) is already near this container's memory ceiling. A
second run started before the first has fully released **kills the agent worker with exit 137**, which
surfaces as a *worker restart*, not as a test failure — so it reads like an infrastructure blip rather than
something you caused. ⓘ Uncommitted work survived the restart in the observed case, but that is not a
guarantee to rely on. **Run the suite once, let it finish, and commit before re-running it.**

### ⚠ Editing a Cowork `SKILL.md` REDS the bundle-parity guard until you repack

`docs/cowork-skills/` keeps every skill twice: `<name>/SKILL.md` (the source) and `<name>.skill` (the zip
that is actually uploaded and installed). `npm run skills:bundles:check` binds them, so editing the source
alone turns the guard red — **2 of 9 arms**, in the observed case, after adding one bullet to
`rpc-nightly-autonomous-pass/SKILL.md`. The repack is one command:

```bash
node scripts/pack-cowork-skill.mjs rpc-nightly-autonomous-pass   # -> 9/9
```

⭐ **The meta-lesson is the standing rule that would have prevented it:** *grep for the guards that READ a
file before you EDIT it.* The bundle is not a build artifact you can regenerate later — it is the thing the
account installs, so a stale one ships stale instructions (see known-issues #32, which is exactly that
failure in its un-guarded form).

## ⛔ The v13 deployments POST does NOT force a build here — only a non-docs TIP commit does (measured 2026-08-26)

CLAUDE.md said *"an empty or docs-only commit can never force a rebuild — use the v13 deployments POST, **or**
touch a non-docs file."* **The first half is wrong for this project, measured twice in a row:**

| attempt | result |
|---|---|
| `POST /v13/deployments` + `forceNew=1` on the head sha | **CANCELED**, `errorLink: …#ignored-build-step` |
| the same POST + `projectSettings.commandForIgnoringBuildStep = "exit 1"` | **CANCELED**, identical errorLink |

⭐ **Why: `ignoreCommand` is declared in `vercel.json`, which lives IN THE REPO.** A deployment built from the
git source carries that file and runs the ignore step from it, so the per-deployment `projectSettings`
override never gets a say. `forceNew` only guarantees a *new deployment*, not a *built* one.

**The predicate itself:**

```
git diff --quiet HEAD^ HEAD -- . ':(exclude)docs/**' ':(exclude)*.md' ':(exclude)*.mdx'
```

**It inspects `HEAD^..HEAD` — the LAST COMMIT ONLY.** Ten code commits under a docs-only tip deploy nothing.

⚠⚠ **THE NEW HALF, AND IT IS THE PART THAT BITES: `git am` INVERTS THE SAFE ORDER FOR YOU.** The standing
rule ("commit the ledger BEFORE the code") assumes you choose the order. **Applying a patch set does not work
that way** — the code commits arrive first, from the patches, and the ledger entry describing them can only
be written afterwards. **So landing ANY patch set produces a docs-only tip by construction.** That is how
this trap bit a third time, on 2026-08-26, leaving a Sentry quota guard and a telemetry fix sitting on `main`
with neither running.

⭐ **The habit that actually prevents it is not an ordering rule — it is a CHECK: read `state` on the
deployment after every push, and never infer a deploy from a green CI.** CI and Vercel are independent, and
CI was **success** on the very push that shipped nothing. Corroborate on `ready > buildingAt`, attached
production aliases and `lambdaRuntimeStats` — not on `state` alone, which lags.

ⓘ **Prefer a REAL non-docs change over a no-op edit** when you need a tip: the fix used here added
`Rip Packs City/` to `.gitignore` — the untracked `format-patch` drop directory that a `git add -A` would
otherwise commit. A genuine fix that happens to be non-docs keeps the history honest about what changed.

## 🚨 `file://${process.argv[1]}` NEVER matches on Windows — a main-module guard that silently disables the whole script (2026-08-28)

**Found because a test went red LOCALLY while CI was green on the same tree** — the disagreement was
the signal, not the redness.

```js
if (import.meta.url === `file://${process.argv[1]}`) main()   // ⛔ BROKEN on Windows
```

`import.meta.url` is **always a URL**. `process.argv[1]` is an **OS path**. On Linux the two coincide,
because a POSIX path starts with `/` and `file://` + `/home/…` is a valid file URL. On Windows argv[1]
is `C:\Users\…\x.mjs`, so the comparison is `file:///C:/Users/.../x.mjs` vs `file://C:\Users\...\x.mjs`
— **never equal**.

🚨 **THE FAILURE IS SILENT AND TOTAL: `main()` simply never runs, the process exits 0, and nothing is
printed.** `scripts/gen-known-issues-index.mjs` carried this for its whole life. Measured on Trevor's
box: **both** `npm run docs:issues-index` (the **WRITER**) and `-- --check` (the **GUARD**) exited 0
having done nothing. So a Windows session that added a register item and dutifully ran the regenerate
command got a **no-op**, then pushed a stale index — while the guard meant to catch exactly that passed
**vacuously on the same machine**. CI, on Linux, was green the entire time.

**The correct idiom:**

```js
import { pathToFileURL } from "node:url"
const isDirectRun = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href
```

⚠ **THE PART WORTH INTERNALISING: THE REPO ALREADY KNEW.**
`scripts/ingest-topshot-active-listings.mjs` carries both the correct idiom **and a comment describing
this exact trap** ("*wrong on the maintainer's own machine*"), and `check-unbounded-server-reads.mjs`
uses `pathToFileURL` too. **Nothing connected that knowledge to the third script.** Same shape as the
honesty canon's *"grep for the EXPRESSION, not the file — a comment is only read by someone already in
that file."* The fix is therefore a **ban at zero** over `scripts/**`
(`__tests__/scripts-main-module-guard-works-on-windows.test.ts`), not a comment.

⚠ **A ban is the easiest guard to get wrong, so that test pins four anti-vacuity properties:** it
asserts the **count of files it inspected** (a walk that finds nothing looks like a clean repo); the
banned needle is **assembled from two fragments** so the guard cannot match its own source; it proves the
needle **against a known offender AND against the correct idiom**; and a second **behavioural** test
spawns the script and asserts it prints a **non-zero item count** — because reading the condition is
precisely how this stayed broken.

⚠ **Sibling idiom, NOT this bug, left alone deliberately:** `scripts/fix-inbox-index-counts.mjs` uses
`import.meta.url.endsWith(path.basename(process.argv[1]))`. That **works** on Windows, so the ban does
not flag it — though a basename match would also fire for a same-named file in another directory.

### Measuring CLAUDE.md against the memory-file limit (displaced from CLAUDE.md, 2026-08-29)

Kept verbatim, because the numbers are what make the rule stick:

> **KEEPING IT UNDER: the limit is on CHARACTERS; `wc -c` counts BYTES and this file lives inside that gap** (it once read 40,086 on a true 39,610). **Count with `node -e`, not `wc` — and not Python `len()`, which counts CODE POINTS and under-reports by one per astral emoji (4 × 🚨 here, so it reads 39,974 as 39,970)** — `.length` is what the harness and CI's guard both measure.

Three instruments, three different answers on the same file. `.length` is the only one that matches what the harness and `__tests__/claude-md-stays-under-the-memory-file-limit.test.ts` measure.

---

## Two git traps that bit again on 2026-08-29/30

### 🚨 `git push … | tail -2` REPORTS `tail`'s EXIT CODE, so a failed push reads as success

CLAUDE.md already carries *"a pipe reports the LAST command's exit code"* for `tsc`. It applies to
`git push` too, and I wrote a retry loop that did exactly the wrong thing:

```bash
# WRONG — prints the hint lines AND reports success
for i in 1 2 3; do
  if git push -u origin main 2>&1 | tail -2; then echo "PUSH_OK"; break; fi
done
```

The push failed **non-fast-forward**, the hint text printed, `tail` exited 0, and the loop announced
`PUSH_OK` and stopped. Capture first, then test:

```bash
out=$(git push origin main 2>&1); rc=$?
echo "$out" | tail -2
echo "PUSH_RC=$rc"
```

⚠ **And diagnose from the ERROR STRING** — `hint: 'git pull' before pushing again` /
`(non-fast-forward)` means BEHIND ORIGIN and reads exactly like a permissions failure.

### The ledger rebase-conflict recipe, as a script rather than a memory

Against a concurrent session pushing every few minutes, the ledger conflicts on nearly every rebase.
The recipe in CLAUDE.md works but is easy to fumble under pressure, so it is worth driving from a
script that enforces its three traps at once — **splice into upstream's copy (`git show :2:…`) at the
first `^### `, never hand-edit the markers; gate `git add` on the RESOLVER's exit code, not the
rebase's; measure a baseline BEFORE splicing:**

```bash
git show :2:docs/overnight/ledger.md > /tmp/up.md
BEFORE=$(grep -c '^### ' /tmp/up.md)
SW_BEFORE=$(awk -f scripts/find-swallowed-ledger-headings.awk /tmp/up.md)
if python3 splice.py; then                       # ← gate on THIS, not on git
  AFTER=$(grep -c '^### ' docs/overnight/ledger.md)
  SW_AFTER=$(awk -f scripts/find-swallowed-ledger-headings.awk docs/overnight/ledger.md)
  FUT=$(node scripts/find-future-dated-ledger-headings.mjs docs/overnight/ledger.md)
  [ "$AFTER" -eq "$((BEFORE+1))" ] && [ "$SW_AFTER" = "$SW_BEFORE" ] && [ "$FUT" = 0 ] \
    && git add docs/overnight/ledger.md
fi
```

⚠ **The baseline must come from `:2:`, not from the working tree** — mid-conflict the working tree
contains conflict markers, so `grep -c '^### '` over it counts both sides.

⚠ **The future-date arm earned its keep again on 2026-08-29**: I stamped `### 2026-08-30` from a
`date -u` reading while PT was still 08-29, and the guard caught it before the commit. The web sandbox
is **PDT**, so `date -u` is genuinely tomorrow after 17:00 PT — read `TZ=America/Los_Angeles date`.

## 🚨 An instrument that returns GOOD NEWS in the wrong shape — the trust board has no `is_breach`, and asking for one reads CLEAN (2026-08-31)

**Two members of this family are now confirmed, and they fail the same way: you ask the instrument a
question it does not understand, and it answers "all clear" instead of "I don't know".**

### 1. `v_rpc_trust_health` has NO `is_breach` column

`public.get_trust_health()` **does not exist.** The trust board is the VIEW
`public.v_rpc_trust_health`, whose columns are exactly `(metric, value, breach_at, status, catches)`.

A 2026-09-01 cloud pass filtered it on `(to_jsonb(t)->>'is_breach')::boolean` and got **`[]` — a
false all-clear over two real BREACH rows** — because the missing key evaluates to `NULL` and the
filter silently drops every row.

```sql
-- ⛔ WRONG: reads [] no matter how many arms are breaching
select * from public.v_rpc_trust_health where (to_jsonb(t)->>'is_breach')::boolean;

-- ✅ RIGHT: values are CASE-MIXED ('ok' lower, 'BREACH' upper)
select metric, value, breach_at, status
from public.v_rpc_trust_health
where upper(status) <> 'OK';          -- or: status is distinct from 'ok'
```

### 2. `check_secdef_anon_execute_violations()` returns `count(*) = 1` when CLEAN

Already in `database.md` under the mixed-return-shape rule, and it belongs here beside its sibling:
a jsonb-array health function returns ONE ROW containing an EMPTY ARRAY when clean, so `count(*)`
reads **1** and looks like one violation — or, read the other way round, a `count(*) = 1` test passes
on a clean estate and on a one-violation estate alike. **Read the array LENGTH, or the VALUE.**

### 3. `detect_stalled_pipelines()` is the SAME shape — confirmed live 2026-08-31, an hour after this section was written

⚠ **Recorded because the author of this section walked straight into it.** A closing health sweep ran
`(select count(*) from public.detect_stalled_pipelines()) as stalled_rows` and got **1**, which reads
exactly like *one stalled pipeline* on a page of otherwise-green numbers. Reading the **VALUE** gives
`[]` — the estate is clean and `count(*) = 1` is the CLEAN answer.

```sql
-- ⛔ WRONG: reads 1 when clean AND 1 when there is one stalled pipeline
select count(*) from public.detect_stalled_pipelines();

-- ✅ RIGHT
select jsonb_array_length(public.detect_stalled_pipelines());   -- 0 when clean
select * from public.detect_stalled_pipelines();                -- read the VALUE
```

👉 **So the roster is at least three** (`check_secdef_anon_execute_violations`,
`detect_stalled_pipelines`, and the `v_rpc_trust_health` filter above). **Treat `count(*)` over ANY
`check_*` / `detect_*` function as unsafe until you have checked its return type** — the safe habits
are `jsonb_array_length(...)` for the jsonb-array ones and reading the row set for the SETOF ones.
Knowing the rule is not protection: it has to be applied at the moment the query is written.

### The general rule

⚠ **Before trusting a filter over a health view, confirm the COLUMN EXISTS** — `information_schema.columns`,
or select the row set unfiltered once and look at it. A predicate over a non-existent key is not a
narrower question, it is an *unanswerable* one, and both SQL and JSON answer it with silence that
reads as good news. This is the same failure class as CLAUDE.md's "a failed read must not render as
an answer", but on the OPERATOR's side of the glass rather than the user's.

### ⓘ And that read is NOT free — budget it

`v_rpc_trust_health` costs **~280,000–350,000 buffers per SELECT** (measured three times in one pass's
own pgss diff: 352,591 / 336,813 / 279,358). A single wasted read — such as the `is_breach` one above
— costs ~350k buffers on its own, and three reads across two passes came to ~969,000.
**Read the board ONCE per pass and reuse the row set.** ⚠ It also CAN time out at 60 s; CLAUDE.md
already prefers the sentinel's `Trust Health` check to any arm count quoted in
[trust-board-and-safety.md](trust-board-and-safety.md).

---

## 🚨 A credential probe is bounded by its CORPUS, not its regex (2026-09-02)

The deep-audit register's standing **"No hardcoded credentials"** probe greps `eyJhbGciOiJ`,
`sb_secret_`, `sk-ant-`, `AKIA`, `ghp_`, `github_pat_`, `re_`, the Telegram shape and **`rpc_pls_`**
over **`origin/main`**, and reports **0 real hits**. The pattern list is right. The search space is
not:

- **All 14 HTTP-dispatching pg_cron jobs send their gate key in the URL** (`…/functions/v1/<fn>?key=`),
  **13 of them active, 0 using a header.** That is the `rpc_pls_` prefix the probe greps for, sitting
  in `cron.job.command` — which lives only in the database and is outside `origin/main` by
  construction.

👉 **"0 real hits" reads as an estate-wide all-clear and is a statement about one corpus.** The same
blindness covers Vercel env, edge-function secrets, cron-job.org job definitions and anything else
that is *configuration* rather than *code*. When a probe returns clean, ask what it SEARCHED before
believing what it found — the same rule as *"ask what a passing guard is structurally silent about"*,
applied to a corpus instead of a code path.

### Handling rules that apply the moment you go looking

- ⛔ **Do NOT read Supabase edge-function logs to "confirm" a URL-borne credential.** Full request
  URLs are exactly what those logs record, so reading them is the leak. The count of offending jobs
  IS the finding; log evidence adds nothing and costs what it measures.
- **Project so a value cannot be selected.** `count(*) FILTER (WHERE command ~ '[?&](key|token|secret)=')`
  answers the question without returning command text. To name the target, capture only what precedes
  the credential: `substring(command from 'functions/v1/([a-z0-9_-]+)')` stops at the `?`.
- ⚠ **A truncating projection is not a redaction.** `left(command, 140)` on one of these rows prints
  a *partial* key into the transcript — enough to be a leak, not enough to be useful. Filter and
  aggregate; never truncate.
- **The DB-side remedy needs no key to pass through a session at all:** rewrite the command in place
  with `regexp_replace` inside `cron.alter_job`, so the value never leaves the database. One job at a
  time, post-state checked against `net._http_response` — `net.http_get(url, params, headers,
  timeout_milliseconds)` does take a `headers jsonb`.
- ⚠ **Relocation is not rotation, and the ORDER matters.** Moving a key out of the URL stops the log
  store filling; it does not un-log what is there, and on this estate these values are additionally
  burned in public git history (known-issues #22). Rotation is what closes it — but rotating BEFORE
  the relocation lands just re-publishes the new value on the next tick.

## Cloud-session tooling, measured 2026-09-03 (the CI audit session)

- **GitHub MCP `actions_list › list_workflow_runs` exceeds the tool's output cap at ANY `perPage`, including 1** (~60 KB: each run embeds its full head commit). The result lands in a file under `tool-results/`; parse it with `json.loads(raw[raw.index("{"):])` and print `id / head_sha / status / conclusion / created_at`. `list_workflow_jobs` and `get_job_logs` fit. **`get_job_logs` returns HTTP 404 until the job COMPLETES** — a 404 a minute after dispatch is "not yet", not "no logs".
- **`send_later` / `create_trigger` check-ins are bound to the session and die with it.** A read that must happen after the session archives (tomorrow's liveness report, a re-surfacing ack) belongs in the ledger as ⏳ OWED and in the register row, not in a trigger.
- **The artifact service refuses wake subscriptions from a cloud session** (`subscribing requires a session credential`, HTTP 403) — comments on a published report will not wake the session; re-read on demand.
- **`api.github.com` is 403 through the agent proxy; `github.com` anonymous git is served.** So `git ls-remote --tags` / `git clone --depth 1` of a public action repo works where the releases API does not. `console.cron-job.org`, `api.cron-job.org` and `www.rippackscity.com` are unreachable (000) — verify a deploy through the Vercel MCP and a route through a `workflow_dispatch` that calls it.
- **Vercel `list_deployments` `since` is epoch MILLISECONDS** — a seconds value returns an empty page, which reads as "no deploy was triggered".
---

## Concurrent-session hazards that a CLEAN rebase does not surface (2026-09-03)

Three distinct traps from one session, all in the same afternoon, none of which produced a merge
conflict at the point where the mistake was made.

### 1. Two sessions can take the same "next free" ID and git will merge both

Both sessions appended a register row numbered **`R84`** — different lines, different table sections,
so **there is nothing for git to conflict on.** The clash is *semantic*, and only
`register-integrity-guard` sees it. ⛔ **The local run before the push is worthless here**, because at
that moment the other row does not exist in your tree yet.

⚠ **AND THE RED DOES NOT NAME YOU.** It surfaced on the OTHER session's commit — the first CI run after
the duplicate landed — so a reader following the failing commit blames the wrong change.

➡ **Claim an ID against `origin/main` at the moment you PUSH, and re-run the guard AFTER the rebase.**
Resolution rule: **the row pushed FIRST keeps the number** (every reference to it is already public);
the later one renumbers and says so, because its own earlier commit messages now cite a stale ID.
Recorded as cheap-check 11 in `docs/audits/deep-audit-register.md`.

### 2. A stash-pop conflict will happily offer you a STALE copy of someone else's row

Resolving the conflict by "taking my side" would have reverted **667 characters** of the other
session's update to a row I had not touched. **Both sides looked like "the R78 row".**

➡ **Never take a side wholesale on a shared append-a-row file. DIFF the two sides first**, and if the
upstream side is longer/newer on a row you did not edit, keep upstream's and re-apply only your own
delta. Verify after with `diff <(grep '^| R78 ' file) <(git show origin/main:file | grep '^| R78 ')`.

⚠ **The length comparison itself nearly misled me: `awk length()` counts BYTES, python `len()` counts
CODE POINTS.** On a file full of em-dashes and emoji the same line measured 3,672 and 3,620. This is
the *same* byte-vs-code-point trap CLAUDE.md records for the memory-file limit — **it also applies to
comparing two versions of one line.** Compare like with like.

### 3. `git add -A` sweeps ALREADY-STAGED files into whatever you commit next

A stash pop left the pin, the guard registration and the register **staged**. The next
`git add docs/overnight/ledger.md && git commit` therefore shipped all four in a commit whose message
said `docs(ledger):`. **Nothing was lost and the tree was clean afterwards — which is exactly why it is
easy to miss.**

➡ **`git show --stat HEAD` after every commit**, and treat a file count higher than what you staged as
a stop. The fix while unpushed is `git reset --soft origin/main && git reset`, then re-stage
deliberately. (Same family as the `.gitignore` swallow: *a clean `git status` afterwards is consistent
with both outcomes.*)
