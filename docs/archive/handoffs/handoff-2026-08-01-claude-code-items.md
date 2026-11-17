# Claude Code handoff — 2026-08-01

> ## ✅ DRAINED 2026-08-01 (Claude Code) — READ THIS BEFORE ACTING ON ANYTHING BELOW
>
> The body of this document is preserved **verbatim as written**. Several of its
> premises did **not** survive verification against live state — details and
> evidence in `docs/overnight/ledger.md` (2026-08-01) and the CLAUDE.md session
> entry. Status per item:
>
> | # | Item | Status |
> |---|---|---|
> | 1 | git-history credential purge | **OPERATOR ONLY** — still open (HEAD is clean; history is not) |
> | 2 | Deploy `scan-pinnacle-wallet` | **OPERATOR ONLY** — still open |
> | 3 | Wrong player teams | ✅ **SHIPPED** `418ed607` — ⚠ but the diagnosis here is wrong (see below) |
> | 4 | GHA dropping ticks | ✅ **SHIPPED** `2fefdad9` — + a route auth change this doc didn't anticipate |
> | 5 | active-listings 53% fail | ✅ **SHIPPED** `44e97c34` — kept `exit 1`, deliberately not the `exit 0` suggested here |
> | 6 | `db-pin-staleness` secrets | **OPERATOR ONLY** — still open |
> | 7 | 2 AllDay editions under TS | ✅ **SHIPPED** `3a24ba05` — ⚠ the proposed `UPDATE` would have FAILED |
> | 8 | Two unobservable crons | ✅ **SHIPPED** `44e97c34` |
> | 9 | Inert cron schedules | ✅ **SHIPPED** (UFC) / queued (`evm-transfers-ingest` → operator item 12) |
> | 10 | 409 overstated-FMV editions | ✅ **MEASURED — recommendation: do NOT clamp** (see below) |
> | 11 | `edge-deno` → blocking | Untouched — needs a Deno + deploy session |
> | 12 | cron-job.org console audit | **OPERATOR ONLY** — still open |
> | 13 | Panini sale-feed disclosure | ⏸ Correctly **not** shipped — 4 days out vs this doc's own >7-day gate; FMV verified fresh. Re-check from 2026-08-04 |
> | 14–17 | Concierge / read-only strip / `user_wallets` / fold Overview | Untouched |
> | 18 | Homepage h1 + account-value | ✅ **SHIPPED** `7ba54184` |
> | 19 | 441 views → 0 pastes | ❌ **DISPROVED — do not redesign the wallet box** (see below) |
>
> **The four corrections that matter most:**
> 1. **Item 3** — the tie-break was **not** arbitrary and SGA/Mitchell/Brunson were
>    **already correct** before this session. The real bug was *stale-for-traded-players*.
>    The fix proposed here (order by newest `first_minted_at`) is **impossible**: that
>    column is **0 of 19,583 populated** on Top Shot.
> 2. **Item 7** — "a 2-row `UPDATE`" of `collection_id` **would have errored**: AllDay
>    already holds both `external_id`s under `UNIQUE(external_id, collection_id)`. They
>    were duplicate stubs (+2 phantom `sets` rows not mentioned here).
> 3. **Item 19** — "319 + 122 views, ZERO pastes" measures **crawlers and missing
>    instrumentation**, not conversion. Real human denominator ≈ **8 sessions**, and the
>    one paste is Trevor's own wallet.
> 4. **Item 10** — real but immaterial: median overstatement **$0.55**, **$339 total**
>    across all 432 editions, **zero** above $20 FMV. A ratio artifact on penny moments.
>
> **⚠ One open follow-up from the work itself:** confirm the two new Vercel crons
> authenticate (`CRON_SECRET` must be set in prod) — see the ledger entry for the exact
> query and the revert if they read zero.

## Context

Today's Cowork audit shipped a large batch live (P0 credential removal at HEAD, anon-grant revokes on `moment_acquisitions` + `watchlist_items`, 6 dead `qual=true` policies dropped, 6 anon-EXECUTE writer revokes, 5 IDOR routes closed behind a new owner-key guard, ask-derived-FMV disclosure on 4 surfaces, pack-EV surface 1,814 → 4,595 pages, Candy Holders 82s → 1.2s, `/insights/market` 500 fixed via an MV, TS `/api/market-analytics` 36.2s → 814ms via a covering index, fabricated `$0.00` pull values → `—`, per-collection tier chips, 91 Golazos accented team redirects, new `v_pipeline_failure_rates` + a failure-rate arm in `get_pipeline_alerts()`, `ufc_fmv_pct_stale_30d` re-armed, robots/AI-crawler unblock).

**This handoff covers what is still open.** `main` HEAD as observed from the mount clone: `90abbef4`. That clone may be behind Trevor's working tree — re-check `git log --oneline -1` on the real repo before starting.

Companion roadmap: `RPC-Roadmap-2026-08-01.md` (same folder). Items 15–19 below are the code items that roadmap creates.

**Read `docs/overnight/ledger.md` from disk before shipping anything here** — it is append-at-top, several sessions write it concurrently, and the nightly pass will not touch files committed in the last 24–48h.

---

## Priority order (impact ÷ risk)

| # | Item | Who | Risk |
|---|---|---|---|
| 1 | git-history credential purge | **OPERATOR ONLY** | High (force-push) |
| 2 | Deploy `scan-pinnacle-wallet` | **OPERATOR ONLY** | Low |
| 3 | 219 wrong player-team displays | Claude Code | Low–Med |
| 4 | GHA drops 60–83% of sub-hourly ticks | Claude Code | Low |
| 5 | `topshot-active-listings-ingest` 53% fail | Claude Code | Low |
| 6 | `db-pin-staleness` repo secrets | **OPERATOR ONLY** | Very low |
| 7 | 2 AllDay editions public under Top Shot | Claude Code | Very low |
| 8 | Two unobservable/never-running crons | Claude Code | Low |
| 9 | Inert/wasteful cron schedules | Claude Code + operator | Low |
| 10 | 409 liquid TS editions with FMV > 2× own median | **HAND-OFF, do not auto-fix** | High |
| 11 | `edge-deno` → blocking (16 errors) | Claude Code **w/ Deno + deploy** | Med |
| 12 | cron-job.org console audit (~30 entries) | **OPERATOR ONLY** | Med (secret exposure) |
| 13 | Panini sale-feed disclosure on the page | Claude Code | Very low |
| 14 | Concierge re-hardening for read-only + multi-wallet | Claude Code | Med |
| 15 | Read-only strip: delete cart / trade hub / gifting | Claude Code | Med |
| 16 | `user_wallets` table replacing polymorphic `owner_key` | Claude Code | Med |
| 17 | Fold Overview into Analytics | Claude Code | Low–Med |
| 18 | Homepage `<h1>` + promote `/insights/account-value` | Claude Code | Very low |
| 19 | Diagnose the 441-views → 0-pastes wallet box | Claude Code (query first) | None |

---

## 1. git-history purge of the credential file — **OPERATOR ONLY**

**What's wrong.** Today's P0 removed live Dapper session cookies and an RS256 JWT containing a real email address, legal name, and Flow account id from `scripts/fetch-allday-collection.mjs`. That removal is **HEAD-only.** The repo is **public**. Every one of those values is still retrievable from git history by anyone who clones it.

**Evidence.** File confirmed present at `scripts/fetch-allday-collection.mjs`. The secrets were removed in today's commit; `git log -p -- scripts/fetch-allday-collection.mjs` will show them in the prior revision.

**Fix, in this order — order matters:**

1. **Invalidate the credential first.** Log out / rotate the Dapper session that produced those cookies + JWT. Until this is done the history purge is cosmetic — assume the values are already scraped.
2. Then purge history with `git filter-repo` (preferred over BFG; `filter-branch` is deprecated):
   ```
   git filter-repo --path scripts/fetch-allday-collection.mjs --invert-paths --force
   ```
   or, to keep the file and scrub only the blob content, `--replace-text` with a patterns file.
3. `git push --force origin main`.
4. Contact GitHub Support to purge cached views/forks of the old objects — a force-push does not remove them from GitHub's object store.

**Why operator-only.** Force-push to `main` rewrites every commit SHA. Every ledger revert path (`git revert <sha>`) in `docs/overnight/ledger.md` becomes invalid, and every concurrent session's local clone diverges. This must happen when nothing else is in flight, and only Trevor can decide when that is.

**Before doing it:** create `docs/FREEZE.md` so both autonomous tasks drop to read-only, and delete it afterward.

**Revert path.** There is none for a history rewrite — that is the point. Take a full mirror backup first:
```
git clone --mirror https://github.com/jamesdillonbond/rip-packs-city rpc-backup-20260801.git
```
Keep it off the public internet; it contains the secrets.

---

## 2. Deploy `scan-pinnacle-wallet` — **OPERATOR ONLY**

**What's wrong.** The edge function has written **nothing** to `wallet_moments_cache` since 2026-06-10. The 2026-06-10 commit `acf85c04` ("repair the broken 2-col onConflict writers") accidentally deleted the `.from("wallet_moments_cache")` line, so `supabase.upsert(...)` throws at runtime on every invocation. The repo fix landed 2026-07-31. **It was never deployed** — live is still v24 dated 2026-06-10.

**Evidence.** `supabase/functions/scan-pinnacle-wallet/index.ts` exists with the fix. Confirm live version with the Supabase MCP `get_edge_function` before and after.

**Impact.** Seven weeks of Pinnacle wallet scans silently discarded. This directly blocks the Phase-2 "My Wallet — items" parity row for Disney Pinnacle in the roadmap.

**Fix.** One command:
```
supabase functions deploy scan-pinnacle-wallet
```
or via the Supabase MCP `deploy_edge_function` with `verify_jwt: false` (**preserve that flag** — the function has no cron caller and is invoked manually/opportunistically).

⚠ If deploying via MCP, ship a **minimal diff** — the deployed bodies historically carry inline `esm.sh` imports while the repo uses bare specifiers via `supabase/functions/deno.json`. A naive repo-file deploy of the bare form breaks unless you also pass `deno.json` + `import_map_path`.

**Verify.** Invoke it against a known Pinnacle wallet, then confirm `wallet_moments_cache` row count for that wallet + `collection_id = 7dd9dd11-e8b6-45c4-ac99-71331f959714` is non-zero and `updated_at` is today.

**Revert.** Redeploy v24 (recoverable via `get_edge_function` history). No DB unwind — the writes are idempotent upserts.

---

## 3. 219 Top Shot player pages show the WRONG current team

**What's wrong.** `get_player_detail` resolves a URL slug via the computed expression `regexp_replace(lower(trim(name)),'[^a-z0-9]+','-','g')`. There are **3,075 duplicate `players` rows** — up to **32 rows for a single slug** — and the function tie-breaks arbitrarily among them, so the team shown is whichever duplicate the planner happened to return.

**Evidence — named, verifiable examples:**
- Shai Gilgeous-Alexander displayed as **Clippers**
- Donovan Mitchell displayed as **Jazz**
- Jalen Brunson displayed as **Mavericks**

219 Top Shot player pages are affected.

**Why this is high priority despite being cosmetic.** It is the most visible correctness bug in the product to the actual target audience. A basketball fan who lands on the SGA page concludes the entire site is stale, and player pages are exactly what SEO delivers people to. It also gates the collection-agnostic Team Hub in the roadmap (Phase 3) — building cross-collection team identity on top of a broken team assignment makes the bug worse and harder to see.

**Files involved.**
- `app/(collections)/[collection]/player/[slug]/page.tsx`
- `app/(collections)/[collection]/player/[slug]/layout.tsx`
- `app/api/og/player/route.tsx`
- The DB function `get_player_detail` (query it live with `pg_get_functiondef` — check whether a committed migration exists; if not, this is another "MCP-applied, unpinnable" function and a snapshot migration should be authored alongside the fix per the DB-invariant pin convention).

**Precise fix.** Do **not** dedupe the `players` table as step one — that is destructive and `players` has a composite `UNIQUE(external_id, collection_id)`, so the duplicates are legitimately distinct upstream rows. Instead make the tie-break **deterministic and correct** inside `get_player_detail`:

1. Determine the right tie-break rule empirically first. Most likely candidate: pick the row whose most-recent associated edition is newest (i.e. team-as-of-latest-minted-edition), not an arbitrary row. Query the 32-row SGA slug and confirm the newest-edition row actually carries the correct current team before encoding the rule.
2. Apply the rule as an explicit `ORDER BY … LIMIT 1` in the resolution CTE.
3. Consider surfacing team as **"team at time of this moment"** on edition rows rather than a single "current team" on the player header — that is the honest model, since a player genuinely has multiple teams across their moment history.

⚠ **Check the functional expression index before touching the query shape.** `players` has `idx_players_collection_name_slug` on the exact slug expression. If you change the expression at all, the index stops matching and the page falls back to a full collection scan (this is the documented pool-acquire-timeout class — Sentry NEXTJS-20). Keep the expression byte-identical.

**Risk.** Low–Medium. It is one function, but it is on a public page with a known performance cliff. Profile warm **and** cold with `EXPLAIN (ANALYZE, BUFFERS)` before and after.

**Revert.** `git revert <sha>` for the migration file; to unwind prod, `CREATE OR REPLACE FUNCTION public.get_player_detail(...)` back to the prior definition (capture it with `pg_get_functiondef` **before** you change anything and paste it into the ledger entry).

**Verify.** The three named players show their current teams. `npx tsc --noEmit` clean. Rendered-DOM check on `/nba-top-shot/player/shai-gilgeous-alexander` — not an HTTP 200 check.

---

## 4. GitHub Actions is dropping 60–83% of sub-hourly ticks

**What's wrong.** GHA's scheduler silently skips runs under load. Measured:

| Workflow | Scheduled | Actual | Loss |
|---|---|---|---|
| `topshot-listing-cache` | 72/day (every 20 min) | **12/day** | **83%** |
| `allow-list-reconcile` | — | — | **60%** — and **not even on the pipeline watchlist**, so the loss is invisible |

`topshot-listing-cache` median gap: **105 minutes** against a 20-minute design.

Vercel crons and cron-job.org both deliver at ~100%. This is a GHA platform behaviour, not a bug in the workflows.

**Why it matters.** `topshot-listing-cache` feeds `cached_listings`, which feeds ASK-derived FMV, which today's audit found is used to price **5,794 Flow editions at 0.9× a single ask**. A 105-minute median staleness on the ask feed directly degrades the number the whole roadmap is built on.

**Files.**
- `.github/workflows/topshot-listing-cache.yml`
- `.github/workflows/allow-list-reconcile.yml`
- `vercel.json` (currently 33 cron entries)

**Fix.** Move both to Vercel crons.
1. Confirm each workflow's actual work is a plain authenticated HTTP call to a route (they are backstop-style triggers). If so, the migration is: add the route + schedule to `vercel.json`, delete the `schedule:` block from the workflow (keep `workflow_dispatch` so manual runs still work).
2. ⚠ **Enumerate every caller before changing either schedule.** The 07-18 seed-wallet incident: a route gate silently no-op'd the GHA backstop because the caller sweep stopped at cron-job.org. Check cron-job.org, GHA, `vercel.json`, pg_cron, and in-repo `fetch` calls.
3. ⚠ Vercel Pro `maxDuration` hard cap is **800s**. Anything higher sends the deploy to ERROR **invisibly** (build log shows "Compiled successfully" with no error text). If either job needs longer than 800s it cannot move to Vercel — split it instead.
4. Add `allow_list_reconcile` to `pipeline_cadence_watchlist` regardless of where it ends up running. A 60% loss that nothing watches is the worse half of this finding.

**Risk.** Low. Reversible config.

**Revert.** `git revert <sha>` restores both the `vercel.json` entries and the workflow `schedule:` blocks in one commit. For the watchlist row: `DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline='allow-list-reconcile';`

**Verify.** After 24h, compare `pipeline_runs_daily` (the new indefinite rollup, jobid 233) `runs` count for each pipeline against the scheduled count. Expect ≥95%.

---

## 5. `topshot-active-listings-ingest` fails 53% of runs, burning 24 GHA-minutes each time

**What's wrong.** 53% failure rate — surfaced for the first time by today's new `v_pipeline_failure_rates` arm in `get_pipeline_alerts()` (previously invisible: all 98 watchlist rows keyed on *silence* only, so a job that runs on time and always fails looked healthy). Each failing run spends **~24 minutes** of GitHub Actions compute before discovering that Atlas returns `egress_blocked`.

**Evidence.** `.github/workflows/topshot-active-listings-ingest.yml` — the workflow already carries a `DEADLINE_MS` wall-clock budget and `curl --max-time` (added 2026-07-29 after it was being SIGKILLed at the 30-min job timeout). The budget bounds the damage; it does not avoid it.

**Fix.** Fail fast on a cheap probe:
1. First step: a single lightweight request to Atlas with a short timeout (≤10s).
2. If it returns `egress_blocked` (or any non-200), log a `pipeline_runs` row with `ok=false` and an explicit `extra.reason = 'egress_blocked_probe'`, then **exit 0** and skip the sweep.
3. Exiting 0 on a known-upstream block keeps the failure-rate metric meaningful (real failures stay distinguishable from a blocked upstream) while cutting ~24 min × ~half the runs of wasted compute.

**Related, already known:** this pipeline is also night 4 of the queued `GHA-ACTIVE-LISTINGS-INGEST-DROPOUT` — it now fires, gets `egress_blocked`, then recovers. Its sibling `topshot-listing-cache` is healthy, so live TS listing coverage is intact. This is visibility + cost, not data loss.

**Risk.** Low.

**Revert.** `git revert <sha>`.

**Verify.** Next 24h of `pipeline_runs_daily` for `topshot-active-listings-ingest`: `fail` count should drop and `duration_p95` should fall sharply on the blocked runs.

---

## 6. `db-pin-staleness.yml` soft-skips green — **OPERATOR ONLY (repo secrets)**

**What's wrong.** `.github/workflows/db-pin-staleness.yml` runs `npm run db:pins:check` weekly (Mon 07:20 UTC), but **soft-skips to green** because the repo secrets `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` were never added.

**Why it matters.** This is the **only** check that can catch a DB pin that matches its committed migration but has diverged from what production actually runs. The in-CI drift guard is repo-vs-repo and structurally cannot see it. On 2026-07-31, **3 of 42 pins were in exactly that state** — one nearly 3 months behind — validating definitions that no longer ran anywhere.

**Fix.** Add both repo secrets in GitHub → Settings → Secrets and variables → Actions. The workflow then enforces automatically (exits 1 on a stale pin). No code change.

⚠ `SUPABASE_SERVICE_ROLE_KEY` is a full-privilege key. Confirm the workflow does not echo it, and that the repo's Actions settings do not allow fork PRs to run workflows with secrets.

**Revert.** Delete the two secrets — the workflow reverts to soft-skipping.

**Verify.** Trigger the workflow via `workflow_dispatch` and confirm it reports a real pin count instead of skipping.

---

## 7. Two NFL All Day editions are publicly reachable under the Top Shot collection

**What's wrong.** Two AllDay editions are filed under the Top Shot `collection_id` and render at:
- `/nba-top-shot/edition/2815`
- `/nba-top-shot/edition/4845`

**Fix.** Reassign `collection_id` to AllDay (`dee28451-5d62-409e-a1ad-a83f763ac070`) — a 2-row `UPDATE`.

⚠ **Check dependents before updating.** `editions` has dependents that join by text (`badge_editions`, `wallet_moments_cache`) plus wishlists that CASCADE. Enumerate what references these two `edition_id`s first — a bare `collection_id` flip can orphan a wmc row or leave a badge row pointing at the wrong collection. Also verify the edition `external_id` does not collide with an existing AllDay row (composite unique constraints).

⚠ Add a redirect from the old `/nba-top-shot/edition/{2815,4845}` URLs to the AllDay path if either is indexed — a 404 on an indexed URL is worse than the current wrong-collection render.

**Risk.** Very low, but only after the dependent check. This is 2 rows.

**Revert.** `UPDATE public.editions SET collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' WHERE id IN (…);` — capture the exact `id` values in the ledger entry.

---

## 8. Two crons with no observability

### 8a. `/api/cron/compute-laliga-pack-ev` has NEVER logged a run

**Evidence.** `vercel.json` line ~37: `"path": "/api/cron/compute-laliga-pack-ev", "schedule": "30 5 * * *"` — daily. Zero rows in `pipeline_runs` for it, ever. Most likely 401-ing silently every day (Vercel cron auth header mismatch), or throwing before it reaches `log_pipeline_run`.

**Fix.** Decide: is Golazos pack EV wanted?
- **If yes:** hit the route manually with the correct `Authorization: Bearer $CRON_SECRET` and read the actual response. Then fix the auth path and add `log_pipeline_run` on **both** the success and the fatal-catch legs. (This is the exact silent-stall class that hid the `fmv-recalc` outage in May — a route that crashes inside `after()` before logging looks like it never ran.)
- **If no:** delete the schedule from `vercel.json`, keep the route (matching the `sync-sales-ingest-dune` / `evm-transfers-ingest` disposition precedent).

⚠ Verify against the roadmap parity matrix first — Golazos pack EV is listed as **Partial** and Phase 1 depends on pack valuation. Do not delete it without checking whether Golazos pack EV data exists from another source.

### 8b. `/api/cron/purge-stale-listings` is a daily DELETE with zero observability

**Evidence.** `vercel.json` line ~33: `"schedule": "0 4 * * *"`. It runs a DELETE daily and calls `log_pipeline_run` **never**. Nobody knows how many rows it removes, or whether it has been silently deleting zero (or far too many) for months.

**Fix.** Add `log_pipeline_run` with `rows_written` = the delete count, on both the success and the error path. Do **not** change the delete predicate in the same commit — instrument first, read a week of `pipeline_runs_daily`, then decide whether the predicate is right.

⚠ Before touching it at all, run the SELECT form of its predicate and count the rows. Destructive-op discipline: rowcount first, always.

**Risk.** Low for both (8a is diagnostic, 8b is additive logging).

**Revert.** `git revert <sha>` for both.

---

## 9. Inert and wasteful cron schedules

| Job | Schedule | Reality |
|---|---|---|
| `/api/cron/ufc-studio-sales-history-backfill` | `1,21,41 * * * *` = **72×/day** | UFC market has been dead since 2026-05-13 (Aptos migration). Returns **0 rows**. |
| `evm-transfers-ingest` | ~24×/day | Beezie/Base retired; **0 rows**. Not in `vercel.json` — its scheduler is cron-job.org or pg_cron, so it must be found as part of item #12. |
| `/api/cron/sync-sales-seller-recovery-dune` | `47 * * * *` | **Inert** — pending `DUNE_SALES_SELLER_QUERY_ID=8027085`. Dune datapoints have been exhausted twice in a week; this is PARKED by decision. |

**Fix.**
- **UFC**: drop from `1,21,41 * * * *` to daily (`0 6 * * *`) rather than deleting — if UFC ever reactivates, a daily probe finds it. Confirmed present at `app/api/cron/ufc-studio-sales-history-backfill/route.ts` and `vercel.json:93`.
- **`evm-transfers-ingest`**: find its scheduler (item #12) and disable there. Do not delete the route — Beezie/Base is documented as revivable.
- **`sales-seller-recovery-dune`**: leave the schedule but confirm it is a cheap no-op when the env var is unset. ⚠ **Do NOT touch `sales_ingest_state.cursor_end`** — that is an explicit standing warning.

**Risk.** Low. Pure schedule config.

**Revert.** `git revert <sha>` restores the `vercel.json` schedules.

**Note the standing trap:** an empty commit or a docs-only commit can **never** force a Vercel rebuild — `vercel.json`'s `ignoreCommand` excludes `docs/**` and `*.md`. If a change needs a rebuild, either touch a non-docs file or POST `https://api.vercel.com/v13/deployments` with a gitSource ref (via PowerShell `Invoke-WebRequest`; `curl` fails silently in Git Bash).

---

## 10. 409 liquid Top Shot editions carry an FMV more than 2× their own sales median — **HAND-OFF ONLY**

**What's wrong.** Of 4,443 Top Shot editions with ≥4 sales in the last 30 days, **409 (9.2%)** have an FMV more than **2×** their own 30-day sales median. The concentration is in the **ask-blended LOW confidence tier** — i.e. FMV is being pulled up by asks on editions that are actually trading much lower.

**Why it matters.** The entire roadmap Phase 1 promise is "what is your collection worth." A 9.2% overstatement rate on the *most liquid* slice of the flagship collection is the number that gets the product called wrong in public. It is worse than a coverage gap, because a gap is visibly a gap and this is confidently wrong.

**Why I am not proposing a fix.** This is **FMV pricing logic**, which is explicitly off-limits for autonomous change (standing rule: data fixes OK, pricing logic hands off). A naive clamp risks the opposite failure — suppressing genuinely-rising editions during a real run-up, which is how you get a valuation tool that lags the market.

**What Claude Code should do instead:**
1. **Characterize before changing.** For the 409: what fraction have `confidence = LOW`? How many have an ask but ≤2 sales? What is the median overstatement ratio — 2.1× or 6×? Is the ask a genuine listing or a troll ask (today's audit found a **$5,000,000** troll ask on the public squeeze board, now flagged with a disclosed 10× rule)?
2. **Note that a clamp already exists**: `fmv_clamp_disconnected_ask_topshot` — live predicate is `fmv > med*3 AND fmv > p90*1.5`. These 409 are at >2×, i.e. they are sitting *underneath* the existing clamp threshold. So the question is narrow and answerable: **should the clamp move from 3× to ~2×, and what does that do to the rest of the corpus?** Measure the blast radius (how many editions change, by how much) before recommending anything.
3. **Present the measurement to Trevor with a recommendation. Do not ship it autonomously.**

⚠ Note the existing pin for `fmv_clamp_disconnected_ask_topshot` was found **STALE** on 2026-07-31 (pinned to a superseded circulation-gated predicate). Re-read the live definition with `pg_get_functiondef`; do not trust the test copy. And if the pin is repointed, **re-read its assertions too** — they describe behaviour prod stopped exhibiting.

**Risk if done wrong.** High. FMV feeds pack EV, deal detection, the sniper board, wallet valuation, and the public insights boards.

---

## 11. Promote `edge-deno` to blocking — **needs a Deno toolchain + deploy session**

**What's wrong.** The `edge-deno` CI job is the **only** type-check over the Deno edge source (vitest and `tsc` both exclude `supabase/functions/**`). It is `continue-on-error: true` with **16 `deno check` errors** outstanding, so it cannot red a broken edge fn.

**This job has already earned its keep**: when first added it caught a **live production bug** — `scan-pinnacle-wallet` writing nothing since June 10 (item #2 above).

**Root cause, already established (do not re-derive).** The 16 are a toolchain conflict, **not** edge-source bugs:
- `--node-modules-dir=auto` is required, because the SDK's type-only `import "@supabase/functions-js/edge-runtime.d.ts"` drags a transitive `npm:openai` dep that only resolves in node_modules mode.
- But that mode then rejects that jsr **subpath** import (×12) and the `std/http/server.ts` **URL** imports (×2) as `TS2307 "not a dependency"`, plus 2 `TS7022` cascades.
- Remapping `jsr:` → `npm:` was CI-tested and **did not help**.

**The fix, in order:** delete the 12 type-only `edge-runtime.d.ts` imports → the openai dep disappears → drop `--node-modules-dir=auto` → the std/URL imports and cascades resolve → drop `continue-on-error`.

**Full playbook:** `docs/handoff-2026-07-30-deno-edge-ci.md` (confirmed present).

**Why it needs a special session.** `deno check` **cannot be verified from the Cowork sandbox** — jsr.io and esm.sh are proxy-blocked (403), and there is no Deno toolchain. CI is the only adjudicator, and promoting blind would red `main` for every concurrent session. Also: the repo edge source now **diverges from the deployed edge functions** (the bare-specifier import-map refactor was never deployed). Verify by deploying ONE low-risk fn first.

⚠ `compute-topshot-pack-ev` is flagged do-not-redeploy / must stay byte-identical to prod. Its import line was changed in the refactor. Handle it explicitly.

**Risk.** Medium — it is CI plus a deploy channel.

**Revert.** `git revert <sha>`; re-add `continue-on-error: true` to restore non-blocking behaviour immediately if it reds `main`.

---

## 12. cron-job.org console audit (~30 entries) — **OPERATOR ONLY**

**What's wrong.** ~30 pipelines are triggered by cron-job.org and the entries are **not enumerable from the repo**. There is no way to answer "what is actually scheduled" without opening the console. Items #4 and #9 both need this (`evm-transfers-ingest`'s scheduler is unknown precisely because of this gap).

**Fix.** A Chrome session that enumerates the job list (name, URL, schedule, enabled/disabled) into a committed reference doc — something like `docs/reference/cron-job-org-inventory.md` — so future sessions can reason about the full scheduler surface.

⚠⚠ **NEVER broad-read that console's DOM.** A prior Cowork session leaked `INGEST_SECRET_TOKEN` by reading a job-edit page — the Advanced-tab `Authorization` header is present in the DOM **even when that tab is not open**. Do not use `read_page`, `get_page_text`, or `querySelectorAll('input')` on any job-edit page. Scope every read to the specific control (use the `find` tool for one element). Never echo a Bearer/token/key value into the transcript or the doc.

Record only: job name, target URL path, schedule, enabled state. **Not** headers, **not** auth values.

**Other known cron-job.org gotchas to record while you're in there:** the apex domain 308-redirects, so every URL must use `www.rippackscity.com` (an apex URL returns a 200 that is actually the redirect/login body); avoid `:00` scheduling (dropout cluster).

**Risk.** Medium — entirely because of the secret-exposure hazard, not the change itself.

---

## 13. Panini sale-feed disclosure exists in the JSON but not on the page

**What's wrong.** `panini_sale_feed_status` reports `feed_ok: false` since **2026-07-28** — upstream stopped supplying serial sale prices, and priced coverage is down to **7.88%**. This is disclosed in `meta.sale_price_feed` on `/api/public/insights/panini-squeeze`, but **not** rendered on the page.

**Context (this is why it is item 13, not item 3).** The judgment on 07-31 was deliberate and defensible: `serials_with_recorded_price` is fetched into the client Row type but is **not one of the 10 rendered columns**, and FMV + Ask are unaffected (FMV comes from a separate `getCardMarketStats` upstream call, confirmed still moving 18–48% across 07-29→07-31). So no user-visible number is currently stale, and a second banner would dilute the real listing-gated coverage warning sitting right beside it.

**What changed.** `PANINI_PUBLIC` was flipped **true** on 2026-08-01 — the board is now public and indexable. The bar for silent staleness is higher on a public surface than a staged one.

**Fix (small, and only if the feed is still out when you get here — re-query `panini_sale_feed_status` first).** If `feed_ok` is still false and the gap is now >7 days, add a single compact line to the existing coverage banner rather than a second banner — e.g. "serial-level sale prices unavailable from upstream since 2026-07-28." Fail-soft in the identical shape as the existing `meta.coverage` block: a status error omits the line, never 500s the board.

⚠ **Do not remove or dilute the listing-gated coverage disclosure** ("treat this board as a floor, not a census"). It is a launch requirement that travels with the surface.

**Risk.** Very low.

**Revert.** `git revert <sha>`.

---

## 14. Re-harden the concierge for read-only + multi-wallet

**What's wrong.** `app/api/support-chat/route.ts` carries 29 tools and predates both the read-only decision and Trevor's multi-wallet model. Three of them are write tools: `manage_alerts`, `manage_watchlist`, `manage_deal_subscriptions`.

**Why it matters.** Today's audit found five IDOR routes whose root cause was **`owner_key` being polymorphic and client-controlled** (auth UUID | `profile_bio.username` | `0x` address, with **no server-side mapping table**). A tool-calling LLM is the most persuadable caller in the system — if any of those three tools accepts an identity from the model's arguments rather than from the session, it is an IDOR with a natural-language interface.

**Fix, in order:**
1. **Audit the three write tools.** Each must resolve the acting user from `requireUser()` / the session cookie, and must ignore any identity present in the tool arguments. Grep for `owner_key` inside the support-chat route and its tool implementations.
2. **Multi-wallet awareness** — once item #16 lands, "what is my collection worth" should mean *all* registered wallets across all chains. This is the best conversational demo of the Phase-1 wedge that exists.
3. **Mirror to Discord and Telegram.** Roadmap-relevant: a bot answering "what's this moment worth" inside a Discord where collectors already are is a lower-friction front door than any page. Scope it as a distribution item.

⚠ The system prompt already carries a never-disclose security block (added 2026-07-20). Keep it, and extend it to cover the wallet-registration surface.

**Risk.** Medium. `/api/support-chat` is 22.6% line-covered and its tool loop is exercised via `__tests__/helpers/anthropic-fixture.ts` (`buildAnthropicClass`) — use that harness; do not hand-roll a mock.

**Revert.** `git revert <sha>`.

---

## 15. Read-only conversion — delete cart, trade hub, and gifting

**What's wrong.** Trevor's direction is that RPC goes **purely read-only** — no write/transactional surfaces at all. Three exist today in various states of shelved-but-present:

| Surface | State | Files |
|---|---|---|
| **Cart** | Shelved. `CartButton` has zero importers — **but a `CartDrawer` was observed rendering on a cached `/nba-top-shot/overview`.** | `lib/cart/CartContext.tsx`, `components/cart/CartButton.tsx`, `components/cart/CartDrawer.tsx`, `lib/cadence/purchase-moment.ts` |
| **Trade Hub** | Shelved **but the 5 FCL submitters + 2 client sign helpers were wired for REAL on 2026-07-31** and are **UNVERIFIED on-chain**. | `lib/trade-escrow/fcl-submit.ts`, `lib/trade-escrow/cadence.ts`, `lib/trade-escrow/sign-deposit.ts`, `lib/trade-escrow/sign-cancel.ts`, `app/api/trade-chain/**`, `app/dashboard/trade-hub/**`, `app/api/trade-hub/**` |
| **Gifting** | **Live** at `/dashboard/gift`, account-linked. | `app/dashboard/gift/page.tsx` |

**The Trade Hub is the urgent one.** It is currently gated by `ensureLive()` (throws unless `RPC_TRADE_ESCROW_ADDRESS` is set) plus 503 routes plus a `notFound()` page — but the code behind that gate now performs real `fcl.mutate` calls that have **never been run against a chain**. Gating live-fire, untested on-chain write code behind an env var is precisely the configuration where a future env change ships an unverified transaction.

**Fix.**
1. Delete the three surfaces: routes, pages, components, and the `lib/trade-escrow/**` + `lib/cart/**` modules.
2. Keep `lib/cadence/purchase-moment.ts` **only** if there is a documented reason; otherwise delete it too.
3. **Add a structural guard so this cannot come back**: a test asserting **zero `fcl.mutate` call sites** in the tree. Model it on the existing directory-driven guards (e.g. `__tests__/sales-batch-insert-23505-guard.test.ts`, which sweeps `app/api/*sales-indexer/route.ts` so new indexers are covered automatically).
4. Delete `RPC_TRADE_ESCROW_ADDRESS` / `NEXT_PUBLIC_RPC_TRADE_ESCROW_ADDRESS` from Vercel env if set.

⚠ **Do not delete the Cadence test suite** (`cadence/tests/RPCTradeEscrow_test.cdc`, 16/16 green) or the `cadence-escrow-tests` CI job in the same commit — that is a separate decision, and the CI job passing is currently a signal about the contract, not the frontend.

⚠ The wishlist/offers/matches CRUD under `/api/trade-hub/*` is a **separate** surface from the on-chain `/api/trade-chain/*` routes. Wishlists are read/organizational, not transactional. Decide explicitly whether they survive — do not delete them by association.

**Risk.** Medium — it is a large deletion. Do it in **three commits** (cart, trade, gift), each independently revertable, each with `npx tsc --noEmit` clean.

**Revert.** `git revert <sha>` per surface.

**Verify.** `tsc` clean; the new zero-`fcl.mutate` guard passes; rendered-DOM check that `/nba-top-shot/overview` no longer mounts a CartDrawer; deploy READY; smoke green.

---

## 16. Replace polymorphic `owner_key` with a real `user_wallets` model

**What's wrong.** `owner_key` is **client-controlled and polymorphic** — it may be an auth UUID, a `profile_bio.username`, or a `0x` address, and there is **no server-side mapping table**. That is the root cause of the 5 IDOR routes closed today (guarded via the new owner-key guard module — **confirm its exact path in the current tree; it was not present in the mount clone at `90abbef4`**). Tables still on `owner_key` include `user_achievements` and `watchlist_items`.

**Trevor's model, which is the replacement.** Users register the wallets they want to track: **one per blockchain, except Flow which allows three** (Dapper, Flow Wallet, Flow EVM).

**Proposed table** (validate column names against live before applying):
```sql
CREATE TABLE public.user_wallets (
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  chain       chain_type  NOT NULL,
  wallet_kind text        NOT NULL,   -- 'dapper' | 'flow_wallet' | 'flow_evm' | 'primary'
  address     text        NOT NULL,
  label       text,
  verified_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, chain, wallet_kind)
);
```
The PK enforces the one-per-chain / three-for-Flow rule **structurally**, not in application code. `chain_type` is the existing enum (`flow | ethereum | polygon | solana | flow_evm`).

**Non-negotiable security requirements — every one of these has been violated in this repo before:**
1. `ALTER TABLE … ENABLE ROW LEVEL SECURITY` with policies scoped to `auth.uid() = user_id`.
2. **`REVOKE SELECT, INSERT, UPDATE, DELETE ON public.user_wallets FROM anon, authenticated;`** if server-mediated — **explicitly**, because `REVOKE … FROM PUBLIC` does *not* strip Supabase's default per-role grant. Verify with `has_table_privilege('anon', 'public.user_wallets', 'SELECT')`, **never** by reading `information_schema.role_table_grants` (which still lists `anon` after a successful revoke).
3. Every server write resolves `user_id` from the **session**, never from a request body. That single rule permanently kills the IDOR class.
4. Any new SECDEF function: `REVOKE EXECUTE … FROM PUBLIC` as well as from `anon, authenticated` — a new function's default EXECUTE grant is to `PUBLIC`, so revoking the roles alone leaves `has_function_privilege('anon', …)` **true**.

**Migration path.** Do not big-bang it. (a) Create the table + RLS. (b) Dual-write. (c) Migrate each `owner_key` consumer one at a time. (d) Drop `owner_key` last, only after a grep confirms zero readers.

⚠ `user_achievements` and `watchlist_items` are documented as having **no `/api` route consumers today** — verify that is still true before migrating them; if so they are the cheapest ones to move first.

**Risk.** Medium. New table + auth surface. Follow the migration skill's checklist.

**Revert.** `DROP TABLE IF EXISTS public.user_wallets CASCADE;` + `git revert <sha>`. Trivially reversible while dual-writing; **not** reversible after `owner_key` is dropped — so keep those as separate commits, weeks apart.

---

## 17. Fold Overview into Analytics

**What's wrong.** Every published collection carries both an `overview` and an `analytics` page. They show overlapping numbers, and `overview` exists mainly as a landing target for the tab bar. Trevor's call: **Overview is redundant; consolidate into Analytics.**

**Files.**
- `lib/collections.ts` — remove `"overview"` from each collection's `pages` array (5 published + placeholders).
- `app/(collections)/[collection]/overview/**` — the route dir.
- `app/(collections)/[collection]/analytics/**` — absorbs whatever Overview uniquely rendered.
- Anything redirecting to `/overview` as a default landing (the badges tab 307-redirects to `/overview` today — that target must change).

**Fix.**
1. Diff the two pages first. Anything Overview shows that Analytics does not must move, not vanish.
2. Add a **307 redirect** `/[collection]/overview` → `/[collection]/analytics`. Overview URLs are indexed; a 404 costs the little search traffic there is.
3. Update the badges-tab redirect target.
4. Update `lib/collections.ts` `pages` arrays and re-check `tabBarPages()` / `TAB_BAR_HIDDEN_PAGES` output.

⚠ **`__tests__/proxy-is-public-path.test.ts` will need updating** — it is a 117-case `(path, method) → public|gated` table and is the security contract for `isPublicPath`. Overview appears in the public-tab allowlist in `proxy.ts`. Update the table; do not delete the rows.

⚠ **The sitemap skeleton count is pinned by tests** (`sitemap-data`, and both launch-flag contract tests). Removing a page type per collection will move it. Run the **full** suite before pushing — a targeted run misses this drift (documented lesson from the Candy and Panini flips).

**Risk.** Low–Medium. Mechanical, but it touches the route registry, the proxy allowlist, and the sitemap in one change.

**Revert.** `git revert <sha>`.

**Verify.** `npx tsc --noEmit` clean; full suite green; rendered-DOM check on `/nba-top-shot/analytics` and on the `/overview` redirect for all 5 published collections (5, not 4 — Pinnacle has its own page set, so check it explicitly).

---

## 18. Homepage `<h1>` + promote `/insights/account-value`

**What's wrong.** Two cheap SEO/activation misses:
1. The homepage `<h1>` is the **brand name**. That optimizes for people who already know RPC exists — there are 39 of those, lifetime, from Google.
2. `/insights/account-value` is, by today's measurement, the **best-optimized page in the product** and the direct answer to the question the company is built around. It sits at **card #24 of 26** on the `/insights` hub.

**Fix.**
1. Change the homepage `<h1>` to the question users actually search — in the shape of *"What is your NBA Top Shot collection worth?"* — with the wallet input directly beneath it, above the fold. Brand moves to the logo and `<title>`.
2. Move the `account-value` card to position **#1** on the `/insights` hub, and link it from the homepage above the fold.

⚠ **Confirm h1 counts from RENDERED HTML**, not a grep: `curl -sL <url> | grep -c '<h1'`, recording `res.url` / `res.redirected`. A grep misses headings that render from a child component, and an anonymous `fetch(redirect:'follow')` on a gated route returns **HTTP 200 with the /login body** (~21.35 KB on this site) — a prior session's "h1 regression" evidence turned out to be exactly that artifact.

⚠ `HomePageMarketing` is the anonymous landing; signed-in users redirect to `/dashboard` inside the page component. Change the anonymous path.

**Risk.** Very low.

**Revert.** `git revert <sha>`.

---

## 19. Diagnose the wallet box: 441 views → 0 pastes — **query first, no code**

**What's wrong.** Since the 07-25 consolidation put an instrumented wallet box on every collection and insights page, those surfaces logged **319 + 122 views and ZERO pastes**. Lifetime pastes: **24**. Last 7 days: **0**. Last paste: **2026-07-20**.

**Do NOT redesign anything yet.** First answer one question with a query:

**How many of those 441 views had a referrer?** 96.7% of all sessions have no referrer (crawler signature). If the wallet-box views are similarly crawler-dominated, the real human denominator may be single digits and there is no conversion signal at all — in which case a redesign is chasing a bot number and the answer is item #18 plus distribution.

Query `track-funnel` / `outbound_clicks` / the telemetry table for the wallet-box view events, split by referrer-present.

**If the human denominator turns out to be real (say ≥40), then investigate, in this order:**
1. **Does the box accept a username?** Most Top Shot collectors know their username, not their `0x…`. Username resolution exists (~75% resolution rate) — if the box's placeholder/validation implies an address is required, most people literally cannot use it. This is my top suspicion.
2. **Does the box say what happens next?** "Enter wallet" with no promise, no "takes one click, no signup."
3. **Placement** — is it below the fold or below a dense board on the pages where it converts at zero?

**Risk.** None — this step is read-only.

---

## Guardrails — repeat on every item

- **Direct to `main`. No branches. No PRs.** If a `claude/*` branch is pre-checked-out, switch to `main` first.
- **Commit the ledger BEFORE the code** so the code commit is the tip and auto-deploys. A docs-only tip suppresses the Vercel build (`ignoreCommand` excludes `docs/**` and `*.md`) — this trap has bitten three times.
- **Re-read `docs/overnight/ledger.md` from disk immediately before writing it.** It is append-at-top and concurrent. Splice your entry into the freshly-read file; never write back a copy you read earlier. Sanity check: `grep -c '^### ' docs/overnight/ledger.md` must go **up** by exactly the number of entries you added.
- **Commit via PowerShell `git` on Windows** — Git Bash `git commit` can silently no-op. Re-verify the push with `git rev-list --count origin/main..HEAD` (expect 0).
- **`curl` fails silently in Git Bash for Vercel REST** — use PowerShell `Invoke-WebRequest`.
- **Vercel Pro `maxDuration` hard cap is 800s.** Anything higher sends the deploy to ERROR **invisibly** — the build log shows "Compiled successfully" with no error text.
- **CRLF**: do not string-replace-patch on Windows. Use full-file writes, or `findIndex` on split line arrays.
- **Full file replacements, not diffs/snippets.**
- **Verify pages by rendered DOM, not HTTP 200.** Streaming shells always return 200.
- **`npm ci` fails in-sandbox** (Node 22 vs CI Node 24). Use `npm install` then `git checkout package-lock.json`. **Never commit a regenerated lock** — that breaks CI.
- **Run vitest via `node_modules/.bin/vitest`**; a bare `npx vitest` fetches a fresh copy that cannot resolve `vitest/config`.
- **`npx tsc --noEmit` before every push.** vitest does not run it, so a green local test run does not catch a type error — and a red `typecheck` job blocks every concurrent session.
- **Every prod/`main` change gets a ledger entry with a revert path, in the same turn it ships.**
- **Before gating or short-circuiting any route, enumerate EVERY caller** — cron-job.org, GHA, `vercel.json`, pg_cron, in-repo fetches.

**Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape.** Several paths here were verified against a mount clone at `90abbef4` which may lag Trevor's working tree; two files named in today's audit (`lib/auth/owner-key-guard.ts`, and the exact `CartButton` location) were not present or not where expected in that clone. Grep before you edit.

---

## Expected end state

Items 2, 6, and the operator half of 12 are one-command/console fixes that unblock a Pinnacle data path, a stale-pin detector, and the scheduler inventory. Items 3, 4, 5, 7, 8, 9, 13, 17, 18 are Claude-Code-shippable, each independently revertable, and together they remove the most visible correctness bug in the product (219 wrong player teams), recover 60–83% of dropped ingest ticks, and put the product's best page and best question in front of the people who arrive. Item 1 is Trevor's to schedule and should happen behind a `docs/FREEZE.md`. Item 10 must come back as a measurement with a recommendation, not a commit. Items 15–16 are the read-only conversion and the identity model that permanently closes the IDOR class.

Success looks like: `main` green on all 8 CI jobs, prod deploy READY, `pipeline_runs_daily` showing ≥95% tick delivery on the two migrated workflows, zero `fcl.mutate` call sites, and `/insights/account-value` at position #1.
