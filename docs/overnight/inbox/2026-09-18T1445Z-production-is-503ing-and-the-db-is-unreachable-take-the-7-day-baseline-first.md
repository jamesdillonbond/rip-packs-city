# 🔴 Production is 503ing on public boards, the DB is unreachable from tooling — and the FIRST job is a baseline, not a fix

*Filed 2026-09-18 ~7:45 AM PT by Claude Code (cloud), immediately before the thread was archived. **Read-only — nothing was shipped, because the database could not be reached.** Register item: **#122**.*

---

## 1 · What is measured

| what | reading |
|---|---|
| `/api/public/insights/pack-reality` | **HTTP 503**, `x-vercel-cache: MISS`, `retry-after: 30`, body *"the database is under heavy load"*, `code: "timeout"`, `retryable: true` |
| Runtime errors, 24 h | **9,748 across 50 groups — ALL 50 last seen 09-18** |
| `get_player_detail timed out after 45000ms` | 780 errors · **75 users** |
| `[pack-detail] pack_lifecycle read exceeded 5000ms` | 1,445 · 43 users |
| `pack_market rpc error (nba-top-shot)` | 1,019 · 34 users |
| `popular-on-collection read failed` | 637 · 37 users |
| largest single group | **222 distinct users** |
| Supabase MCP | **3× `Connection terminated due to connection timeout`, including on `select 1`** |

⭐ **The 503 route is HONEST** — real status, explicit `code`, `retryable`, no fabricated empty board. **Do not "fix" the copy.** The canon is working; the condition under it is the problem.

## 2 · 🚨 DO NOT SKIP — the first job is a BASELINE, not a remedy

⛔ **This is CHRONIC. The top clusters were first seen 2026-08-15 and 2026-08-23.** Nothing measured here shows the last three days are worse than the weeks before, **and this filing deliberately makes no such claim** — the 24 h counts have no comparison window beside them.

👉 **STEP 1, needs no DB:** take a **7-day** window and compare to the 24 h one.
```
get_runtime_errors(projectId: prj_YBJ6Utl32GfyBOIzbsp3kbshJh96,
                   teamId: team_YWGCVToPBJSS60NgVh8jiCFV, since: "7d")
```
**If 7d ≈ 7 × 24h, this is the steady state and is a capacity/roadmap question, not an incident.** If the last 24 h is materially elevated, it IS an incident and the next step is to correlate the timeout clusters by route and time to find the reader driving the load. ⚠ **Do not spend scarce DB access on this until that question is answered** — and per CLAUDE.md your own probe is part of the load.

## 3 · ⚠ Measurement traps this pass actually hit

- ⛔ **The sandbox cannot see either host.** `curl` to `bxcqstmqfzmuolpuynti.supabase.co`, `api.supabase.com` and `www.rippackscity.com` all return **`curl: (56) CONNECT tunnel failed, response 403`**. **Every 000 from the sandbox is a fact about the sandbox.** `api.github.com` → 200 is the positive control. **Take readings from Vercel's plane** (`web_fetch_vercel_url`, `get_runtime_errors`).
- ⚠ **A 200 is not proof a DB read happened.** `/api/market-pulse` returned 200 and looked healthy — but `x-matched-path` was **`/login`**, `x-vercel-cache: HIT`, `age: 305294` (3.53 days). A cached auth redirect that never touched Postgres. **Read `x-matched-path` and `x-vercel-cache` before believing a 200.**
- ⚠ **Read the WHOLE error string.** `Connection terminated due to connection timeout` is **connectivity**; `canceling statement due to statement timeout` is **cost**. This estate sees the second constantly and the first almost never — they need opposite responses.

## 4 · Correlation recorded, cause NOT asserted

The repo has been **silent since 2026-09-14 6:50 PM PT** — 198 commits on 09-13, 130 on 09-14, **1 on 09-15, none since** — and there is **no `docs/FREEZE.md`**, so it is not the documented halt. **Whether the autonomous passes have been unable to run, or nobody was working, is NOT established.** Worth one cheap check by whoever picks this up.

✅ **Ruled out — a deploy today.** Serving deployment `dpl_EVxLveodfDHMn39N2BT8ZEhsDisw`; the cached page's `age` of 3.53 days matches the 09-15 commit as the last deploy. **Nothing shipped today caused this.**

## 5 · What is blocked while the DB is unreachable

`pipeline_runs` · the sentinel · `cron.job_run_details` · trust health · **every migration** — and **#75's 2026-09-20 re-measure**, armed in [`2026-09-14T1430Z-…`](2026-09-14T1430Z-75-re-measure-the-pg-net-store-on-or-after-09-20-the-connectors-param-is-org-gated.md). ⚠ **That re-measure is due in two days and needs Supabase MCP.** If the DB is still unreachable then, **record that it could not be taken rather than letting the item read as re-checked** — a check that could not run must never look like one that passed.
