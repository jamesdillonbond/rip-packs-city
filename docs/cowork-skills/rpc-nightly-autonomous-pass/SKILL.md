---
name: rpc-nightly-autonomous-pass
description: The Rip Packs City autonomous health-and-ship pass. Load when running the overnight or daytime pass, when asked to "run the nightly pass", "do a health sweep", "address anything you can", or when a scheduled RPC task fires with no other instruction. Encodes the capability triage, the instruments that lie, what is shippable without git, and the output contract.
---

# RPC autonomous pass

Standing authority: ship what is clearly-safe and net-positive; queue the rest. Accuracy is the gate — never propose promotion or distribution. Report all times in **PT** (infra is UTC).

## 0. Capability triage — do this FIRST, and write down the answer

Never assume last night's environment. Establish, in one batch:

- `bash`, `git --version`, `df -h /` — shell green?
- **Push capability, by actual test:** clone `origin/main` fresh, then `git push --dry-run origin HEAD:refs/heads/main`. On desktop, first harvest the mount clone's token without echoing it: `git -C <clone> remote set-url --push origin "$(git -C <mount> config --get remote.origin.pushurl)"`.
- Supabase / Vercel / Sentry MCP, and the device bridge (`device_list_dir` and `device_bash` fail **independently** — test both).

**bash-green ≠ push-green.** Three distinct NO-PUSH causes need three different fixes: desktop `useradd … /sessions no space` (vhdx reset) · desktop missing cred-injection (wire the mount pushurl) · cloud proxy *"not in this session's authorized repository set"* (operator-only; the mount-token trick cannot cross filesystems).

⛔ **Whatever you find, SCOPE IT in every document you write:**
> ⚠ This blocker is specific to **this cloud session**. Trevor's machine and Claude Code push normally via the PAT in `remote.origin.pushurl`. **Commit these files as usual.**
> 
> Omitting that line once left two applied migrations uncommitted for ~18 hours. An environment limitation is a fact about the environment that hit it, never about the artifact.

**Mode:** cloud = nightly, DB + handoff, cannot push. Desktop = weekly, can push, takes the queued code work.

## 1. Orient

Real time from the DB (`select now()`), never the prompt. Then: take the LOCK, check FREEZE, read `docs/overnight/ledger.md` **top matter** (correct it if stale — appending under a stale "Nothing shipped" header is what the next pass acts on), `metrics-latest.json`, and every un-archived file in `docs/overnight/inbox/`. Items with a SUPERSEDED banner need no action; read the banner, not the body.

## 2. Health sweep — and the instruments that lie

Run security invariants, `detect_stalled_pipelines`, `get_pipeline_alerts`, trust health, Sentry, and Vercel runtime logs. Then distrust each:

- ⚠ **`public_board_slow_count` = 0 does NOT mean the boards are healthy.** The probe times `SELECT count(*) FROM <view>`, which the planner prunes — it read 0 while five of five candy-mlb queries were timing out. **For public-page health the instrument is Vercel runtime logs.** Group 5xx by route, then read `level=error` lines.
- ⚠ **A page can serve HTTP 200 with `cache=STALE` while every query behind it dies.** Invisible to 5xx metrics. Worse in a paginated board: a page-3 failure renders the top rows *as the whole ranking*.
- ⚠ **`cron.job_run_details.status` measures DISPATCH, not outcome.** `job startup timeout` is a *third* status — pg_cron never started the job (worker-slot exhaustion), and the tier-B backfills it hits write no `pipeline_runs` row, so it is their only signal.
- ⚠ **Check trust-precompute freshness before believing a cluster of red arms.** A row >24h old auto-becomes 999; one 600s kill rolls back all 18 metrics at once. `trust_precompute_max_age_hours` (breach 13) is the arm that tells you it was the refresher, not the platform.
- 🚨 **A Sentry zero is NOT health, and this list not naming Sentry is why two passes wrote one down as health.** The sweep above tells you to run Sentry; **"no new issues in 24h" is the same reading a DARK REPORTER gives.** The discriminator is a pair, never the Sentry number alone: **a Sentry zero is health only if the Vercel 24h error groups are ALSO near zero.** Measured 2026-08-26 00:55Z — Sentry newest event **2026-08-18** (7 days) against **50 Vercel error groups, newest in the same minute**; the 08-25 monitor filings had logged that as *"✅ Healthy … no new Sentry issues in 24h"*. ⛔ Sentry cannot report its own darkness, so **never** put its zero in the healthy column without the Vercel number beside it.
- ⚠ **A failures-only query reads as 100% failing.** Always carry the denominator. A window straddling a deploy measures neither state.
- ⚠ `pipeline_runs` retains ~73h — check `pipeline_runs_daily` first (its column is `pipeline`).

Cost triage recipe: `sum(end_time - start_time)` per job over 24h, split by status. Worker-seconds spent on runs that wrote nothing is the cheapest headroom on the board.

## 3. Before shipping any lever

1. **Grep `docs/overnight/ledger.md` for it.** The repo records its dead ends and its verdicts. A lever the ledger has already tabulated is not yours to re-derive — and read the whole table, because a "this is unsafe" line often refers to a *different row* than the one you want.
2. **Enumerate the full dependency set**, then diff against live `prosrc`/`pg_get_viewdef` — never against a handoff's description.
3. **Separate warm from cold before quoting a cost.** A single warm timing on a cheap sample is not a cost model.
4. **State your sample window with any absence claim** — "did not appear in a 90-minute sample", never "does not appear".

## 4. What is shippable without git

- **DB migrations via `apply_migration`** (load the `rpc-migration` skill). Guarded splices that RAISE on no-match; assert on the arm/function **anchor**, never a bare substring; pair every `CREATE OR REPLACE VIEW` with `ALTER VIEW … SET (security_invoker = on)`.
- ⚠ Every Cowork DB change opens a prod/repo drift window. **Write the matching `supabase/migrations/<version>_<name>.sql` to the mount in the same session** — use the exact version `apply_migration` recorded. Revert path in the file header.
- Edge functions via MCP (ship `deno.json` alongside `index.ts`).
- **Not shippable:** route/`.tsx`/worker code → `rpc-handoff` skill.

## 5. Verify the fix, not the diagnosis

Hand-evaluate the new logic against the real payload. Demand a **positive control** for any "removing Y recovers Z". Re-read state after each ship — post-conditions in the migration are not enough; confirm from outside. If a monitor ticket's target is already correct code, say so and queue the real log rather than closing it with a no-op edit.

## 6. Output contract

Ledger entry (append at top, dated, with revert paths) · `metrics-latest.json` · a handoff at `docs/handoff-YYYY-MM-DD-<topic>.md` **carrying the scope line from §0** · migration files on the mount · memory writes for anything durable · release the LOCK.

⚠ The `remote-devices` server can drop mid-session, taking memory and mount writes with it — **mirror the handoff to the claude.ai Project** (`project_write`), which persists regardless.

Close with a digest: health verdict, what shipped, post-ship watch on the previous pass, what needs Trevor, what failed. State "nothing shipped" plainly when nothing was clearly-safe — a quiet pass is a valid outcome, a fabricated one is not.
