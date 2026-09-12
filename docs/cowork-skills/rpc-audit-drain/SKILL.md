---
name: "rpc-audit-drain"
description: "Rip Packs City audit-drain execution pass — load when Trevor says \"handle what you can\", \"keep going\", \"drain the register/findings\", \"work the open items\", or after a deep-audit/nightly pass leaves shipped-or-handoff items. Encodes the proven ship stack: the three push paths (device-flow cred on the VM, cloud with the repo attached, the laptop cowork-push queue), temp-index plumbing commits against a live concurrent session, migration/pin/guard three-file discipline, redacted-subagent edge-fn inspection and deploys, cron-job.org console edits, CI babysitting per commit, and real-caller watch verification."
---

# RPC audit-drain execution pass

Project `bxcqstmqfzmuolpuynti` · repo `jamesdillonbond/rip-packs-city` · main-only, no branches/PRs.
This skill is the EXECUTION half after an audit/nightly pass: take open register/inbox items and ship
them, with verification, while at least one other Claude session is usually working the same repo.
Every recipe below was proven end-to-end on 2026-08-28 (deep-audit run-4 follow-up) and the third
push path on 2026-09-12; re-derive any NUMBER before quoting it — recipes age slower than figures.

## 0. Triage before touching anything

- Read `docs/audits/deep-audit-register.md` OPEN rows + top of `docs/overnight/ledger.md` FIRST.
  Re-derive an item's evidence before acting — severities/rates/liveness go stale; mechanisms hold.
- Ownership: ship what you have tools for; **decisions stay Trevor's unless he is present and answers**
  (AskUserQuestion). "Do what you think is best" = decide, and write the displacement/cost argument
  into the ledger so the decision is re-litigable.
- The fix boundary: when each verification attempt costs ~10 min of shared CI and you cannot run the
  suite locally, and fixes need per-item judgment — STOP, revert to a safe state, and write the
  precise requirements down as the handoff. A well-specified handoff of guard demands IS output.

## 1. Push stack (the part that always fights back)

**Find out which of the three paths you have, by actual test (`git push --dry-run` from a fresh clone —
the dry-run authenticates receive-pack, so exit 0 is proof), and write it in the ledger entry.**

**Path A — desktop VM alive (`device_bash` works):** the durable cred at
`$HOME/mnt/rip-packs-city/.rpc-git-cred` (Trevor-approved 2026-08-29, gitignored). If it is missing or
401s, fall back to the per-session device flow (~60s of Trevor): GitHub device flow with gh's public
client id —
`curl -s -X POST https://github.com/login/device/code -d 'client_id=178c6fc778ccc68e1d6a' -d 'scope=repo workflow'`,
show Trevor the `user_code` + github.com/login/device via AskUserQuestion, poll
`/login/oauth/access_token` (grant_type device_code), write `https://x-access-token:<tok>@github.com`
to `$HOME/.rpc-git-cred` mode 600 — NEVER echo the token. `workflow` scope is required for any
`.github/workflows/**` change.

**Path B — cloud session with the repo attached as a source at task creation:** the proxy injects the
credential; plain `git push origin HEAD:refs/heads/main` from a fresh clone, no cred file. If the push
403s with *"not in this session's authorized repository set"*, the repo was not attached — ⛔ do NOT
stage `.rpc-git-cred` into the cloud: the proxy OVERWRITES any `Authorization` header a tool sends, so a
supplied token changes nothing and only widens the secret's exposure.

**Path C — both dead (VM shell fails on `echo` — the 2026-09-08 Windows-update state — and the repo
not attached):** `Rip Packs City\cowork-push\apply-and-push.cmd` on the laptop, proven 2026-09-12
(`ede6cc7..da71df7` CI #5209 and `b5ee842..ce0cab7` CI #5211, both green). Commit in the cloud clone →
`git format-patch origin/main -o out/` → copy under `/mnt/user-data/outputs/` → `device_commit_files`
into `…\cowork-push\queue\` → double-click the `.cmd` (Trevor, or click-only File Explorer computer
use: `computer_open_application("File Explorer")`, pinned `rip-packs-city` in the sidebar → `Rip Packs
City` → `cowork-push`; zoom to tell the `.cmd` icon from the `.log`) → `device_stage_files` the log and
READ it — success is the literal `[PUSH CONFIRMED]`, and a log that does not end `=== done ===` did not
finish. The Node script applies with `git am -3` onto a fresh clone of origin/main, is idempotent by
commit subject (re-runs skip what landed), and aborts before the push on any conflict. Never point it
at the live working tree.

**Committing while a concurrent session owns the shared index — TEMP-INDEX PLUMBING, never `git commit`
(paths A/B on a mount; in a fresh clone of your own, plain commits are fine):**
```bash
git fetch -q origin main
export GIT_INDEX_FILE=/tmp/myidx; rm -f /tmp/myidx
git read-tree origin/main                        # base = FRESH remote, never local HEAD
B=$(git hash-object -w /path/to/file)            # per file
git update-index --add --cacheinfo 100644,$B,repo/relative/path
T=$(git write-tree)
C=$(echo "msg" | git commit-tree $T -p $(git rev-parse origin/main))
unset GIT_INDEX_FILE
git -c credential.helper= -c credential.helper="store --file=$HOME/.rpc-git-cred" push origin $C:main
```
Wrap in a 3-attempt retry (origin moves constantly). Hard rules, each learned the expensive way:
- **Success test is `git ls-remote origin refs/heads/main` == $C.** NEVER grep push output — the
  success line and the rejection line both contain `-> main`; that bug once pushed 2 empty duplicate
  commits.
- **Guard against empty commits:** if `write-tree == origin/main^{tree}`, a concurrent session already
  landed your content — skip, don't commit-tree.
- **Shared append-at-top files (the ledger): inside EVERY retry, re-extract YOUR entry and re-splice it
  onto the fresh `origin/main` copy at the first line-start `### `** — pushing your older merged copy
  is the documented clobber. Run `awk -f scripts/find-swallowed-ledger-headings.awk` (must print 3) on
  the candidate before hashing. When splicing with Edit-tool anchors, your new_string must RE-INCLUDE
  the heading you anchored on, or you swallow it.
- Stale `.git/*.lock` on the mount: check mtime + owner; if yours and old, `mv` into `_to_delete/`
  (rename works where unlink is denied). If fresh or not yours: WAIT — another session is mid-commit.
  NEVER stash/autostash files you didn't modify; they're a live session's in-flight work.
- Concurrent-session reality: they sweep your uncommitted working-tree edits into THEIR commits
  (content lands, attribution muddles — acceptable); they may ship the OPPOSITE fix to yours (one
  session reverts, the other adapts) — the ledger is how it converges, so write yours immediately.

## 2. DB shipping

- `apply_migration` for DDL; then **read the version from `supabase_migrations.schema_migrations` and
  commit the file as `<version>_<name>.sql` in the same pass** or migration-parity reds.
- Batch independent DDL into one migration (one PGRST002 window). Header carries cause + evidence +
  exact revert SQL.
- **Re-pinning a drift-guarded function is a THREE-file change:** pin (`supabase/tests/<fn>.sql`
  verbatim DDL block) + migration + **the guard's own `migration:` registration row in
  `__tests__/db-invariants-drift-guard.test.ts`** — the guard compares pin↔REGISTERED migration, not
  the migration the pin's comment cites. Build the new body FROM the pin's verbatim block (one-token
  edits), and prove pin==live first: `md5(trim(regexp_replace(prosrc,'\s+',' ','g')))` both sides.
- Every migration that `CREATE OR REPLACE FUNCTION`s needs the `-- anon-exec: intentional — <why> (<fn>)`
  marker (or a 3-role REVOKE) or `migration-new-function-states-its-anon-exec-decision` reds. Same
  signature preserves ACLs; say so in the marker, and verify post-apply: anon EXECUTE false +
  `jsonb_array_length((select check_secdef_anon_exec_drift())) = 0`.
- Changing a function's behavioural pin also means auditing the pin's OWN tests — an error-injection
  test that drops a table the new body no longer reads silently stops proving anything.
- pg_cron: `cron.schedule(<same jobname>,...)` preserves jobid; `cron_heavy`-owned jobs need
  `SET LOCAL ROLE cron_heavy` first; verify a reschedule by its next TICKS in `cron.job_run_details`,
  not the schedule string. Pick minutes from a measured free-set query, respecting the stagger ban
  (never 0,1,20,21,40,41) and the hours-divisible-by-3 waste band.
- Grep DB object definitions with `strpos`, never ILIKE — `_` is a single-char wildcard
  (`ILIKE '%high_med%'` matches `HIGH/MEDIUM` prose).
- `statement_timeout` vs the ~120s PostgREST gateway is a RACE: steps called via PostgREST must
  declare ≤110s or the gateway wins and 57014-truncation contracts never engage.

## 3. Edge functions

- **Never fetch deployed source into the main transcript** — it can carry pre-hardening keys. Spawn a
  REDACTED-REPORT subagent: it fetches via `get_edge_function`, scans for credential shapes (eyJhbGciOiJ,
  sb_secret_, sk-ant-, AKIA, ghp_, github_pat_, re_*, rpc_pls_, telegram shape, any literal *KEY/TOKEN/
  SECRET/GATE* const), writes verbatim files to the session outputs folder as the rollback artifact, and
  reports only facts (lengths + first-4 of anything suspicious, env-var NAMES for auth).
- Deploy precondition (§1 of rpc-edge-fn-deploy) can be verified WITHOUT the secret store: if the
  DEPLOYED build reads the same env var with a boot-throw and currently answers its cron, the secret is
  proven set. If the deployed build predates the env-gate hardening, do NOT deploy unattended.
- MCP deploy: pass `deno.json` + `import_map_path` whenever the source uses bare specifiers (bare
  specifier + no map = boot-fail); keep `verify_jwt` as it was; round-trip md5 the deployed index.ts
  against the repo file; **verify as the real caller: the next cron tick's `pipeline_runs` row**, and
  know that some functions log under TWO pipeline names — check both before declaring silence.
- Retiring an orphan: prove zero invocations in `function_edge_logs` (24h window) WITH a positive
  control (sibling fns showing hundreds), plus no cron.job/repo caller — then deploy the house 410-stub
  pattern (`verify_jwt:true`), verify anonymously (expect 401), keep the old source committed or staged
  as the revert. A slow-cadence unseen caller then fails LOUDLY; watch its logs ~7 days.
- Bulk-committing clean deployed sources into `supabase/functions/` WILL red the fleet guards
  (drift-checker pin, *KEY*-literal ban, reachable-tests ratchet, inline-copy pins) — they demand
  per-function integration. Parking verbatim copies under `docs/audits/<staging>/` as `index.ts.txt`
  (tsc + .ts-walking guards skip them) preserves them durably without the fight.

## 4. cron-job.org console (Chrome)

Common tab ONLY — never Advanced (live secrets in its DOM). Job URLs `console.cron-job.org/jobs/<id>`;
find ids from list-page anchors. The one reliable edit path: focus the crontab expression input →
`select()` → `document.execCommand('insertText', false, '<expr>')` — this syncs the whole form
(radio mode, selects, next-execution preview) even when direct field edits and radio clicks are
ignored. Save via JS `.click()`, confirm a POST to api.cron-job.org fired, then read SERVER truth from
the jobs LIST page's next-execution column (per-job fields can show client-only state). Update
`docs/operations/cron-schedule.md` in the same pass.

## 5. CI babysitting

- Watch per-commit. With a session token (path A): `api.github.com/repos/.../commits/<sha>/check-runs`;
  on failure fetch the JOB log (`Authorization: Bearer` from `.rpc-git-cred` — extract with sed, never
  echo) and read the failing TEST, not the badge. From the cloud (paths B/C) `api.github.com` is
  repo-policy 403 and `WebFetch` gets 403 too — read the Actions page in Chrome instead
  (`find` → "completed successfully: Run N of CI. <commit title>"). A push of several commits runs CI
  once, on the tip.
- Distinguish guard-REGISTRATION gaps (pointer/pin/marker updates — mechanical, fix and repush) from
  code faults. Expect one round: guards here are layered and the second guard fires only after the
  first passes.
- A red caused by racing a concurrent session's opposite fix resolves through the ledger, not through
  force — check `git log origin/main` before assuming your change caused it.

## 6. Verification and watches

- **Exit conditions are answered by the REAL caller's own record** (cron tick rows, rendered DOM,
  anonymous probes), never by your manual run alone — though a manual run first is cheap insurance.
- State every watch with an exit condition AND a falsifier at ship time, in the ledger entry.
- Hour confounds: a kill/failure rate read outside the band it was measured in proves little; say so
  before anyone quotes it. GHA schedules drift hours — attribute runs by `run_started_at`, not slot.
- One upstream outage = ONE filed incident, with blast radius by error-string across pipelines and a
  timeline check against your own changes (first-occurrence vs your apply time exonerates or convicts).
- A zero from a log/metric query needs a positive control in the same instrument before it means
  "orphaned/never/none".

## 7. Output contract (per shipped item, same turn)

Ledger entry (re-read + re-splice, guards must pass: heading count +N, awk prints 3, future-dated 0) ·
register row updated with what shipped, what's owed, exit condition + falsifier · revert path that a
stranger can execute · `docs/operations/*` docs updated when the dashboard is the truth they mirror.
Close the pass with a short direct summary: shipped / verified / worse / better / what needs Trevor.

