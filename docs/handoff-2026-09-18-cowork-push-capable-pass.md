# Handoff — 2026-09-18, the Cowork pass that could push (and gate)

> ⚠ **SCOPE LINE.** Nothing in this document describes a blocker on Trevor's machine or on Claude Code. The one environment limitation that still applies is the **cloud session's** git proxy (`not in this session's authorized repository set`), which is a fact about *that sandbox* and not about the repo. **Commit and push these files as usual.**

**Nine commits landed in two pushes** (`3fae32dc0..5a8ca4e31`, then `49b50f529..ec22f1f58`). Two migrations applied to prod **with their repo halves committed in the same session**, so `migration-parity` stays green. Full gate green throughout.

---

## 0. The two capability findings that made this pass different — read these first

**(a) The laptop VM shell is ALIVE again.** `device_bash` works; the September-8 Windows-update failure (`sandbox-helper: no Plan9 drive shares mounted`) has cleared. `.rpc-git-cred` still authenticates — `git push --dry-run` exit 0 from a fresh `$HOME` clone. **Push path 1 from the nightly-pass skill is live; the laptop `cowork-push` queue was not needed.**

**(b) ⭐ The cloud container can CLONE even though it cannot PUSH, and it has `psql 16`.** Together those two facts change what an autonomous pass can claim:

- `git clone https://github.com/...` succeeds in the cloud; only `git push` is refused by the proxy. So the gate can run on a **clean Linux tree** — which matters, because **`npx vitest` cannot run on the mount at all**: `node_modules` there is a Windows install and rolldown dies on a missing `@rolldown/binding-linux-x64-gnu`. (A Linux binding was copied in as a stopgap; the durable answer is to gate in a cloud clone.)
- A **container-local Postgres** starts and the DB-invariant suite runs for the first time:
  ```
  su claude -s /bin/bash -c "export PATH=/usr/lib/postgresql/16/bin:\$PATH; \
    initdb -D /tmp/pgd/data -U postgres --auth=trust; \
    pg_ctl -D /tmp/pgd/data -o '-p 55432 -k /tmp/pgd' -l /tmp/pgd/pg.log start"
  DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres bash scripts/run-db-tests.sh
  ```
  ⚠ Three traps, all hit: `initdb` refuses to run as root (use `su claude`), the data dir must be writable by that user, and **the default socket dir `/var/run/postgresql` is not writable — pass `-k` or the server exits FATAL after reporting "listening".**
  Result: **192 DB-invariant files pass · 1,089 migrations parse with 0 syntax errors.**

⛔ **Still not readable from here:** CI run status. `gh` is absent on the laptop VM and the GitHub API is 403 in the cloud (`GitHub access to this repository is not enabled for this session`). **Vercel deployment state was used as the proxy for "did it build", which is not the same thing.** 👉 **Please check the Actions runs for the nine commits.**

---

## 1. What shipped

| # | Item | Files | Revert |
|---|---|---|---|
| 1 | **`next` 16.2.9 → 16.3.5** — eleven CVEs incl. **unauthenticated RCE via AVIF** in the Image Optimization API | `package.json`, `package-lock.json` | `git log --grep="16.3.5"` |
| 2 | **R97 + R98 (half)** — two shared secrets out of URLs; the secret-in-URL guard can finally read the root it declared | 3 src + 3 tests | `git log --grep="secret-in-URL"` |
| 3 | **R95** — a freshness stamp is never minted from a failed read | 10 src + 2 tests | `git log --grep="minted from a failed read"` |
| 4 | **R105** — the homepage stops quoting multipliers the model does not implement | 2 src + 1 test | `git log --grep="R105"` |
| 5 | **R102** — the cadence-collapse arm publishes the TRUE last run | migration `20260918225454` + SQL test + drift pin | header of that migration |
| 6 | **R104** — `editions.badges` documented rather than dropped, **and its premise refuted** | migration `20260918225909` | header of that migration |
| 7 | ~~`rpc_trust_health_precompute_refresh_p` search_path pinned~~ **RETRACTED — see below** | migration `20260919002535` | n/a |

### The one that matters most, and its verification
`next@16.2.9` sits inside the affected range of an eleven-CVE bundle whose headline is **GHSA-2xp9-vwfh-vxw4, unauthenticated RCE through AVIF handling in the Image Optimization API** — an endpoint RPC serves publicly on every board, moment tile and OG card. It had been found by an earlier session and written into `docs/handoff-2026-09-18-dep-cves.md` **only because that session had no push credential.**

🧪 `npm run build` was **not** run (no env in the cloud), so the deploy is the end-to-end proof: **`dpl_HxyQAiaVaitZpcjTXnGsYzgedcF5`, commit `5a8ca4e3`, reached READY**, and a live probe of `/api/og/insights/top-sales` returns a real **58 KB `image/png`** — the satori/sharp path the CVEs touch. `/`, `/insights/top-sales` and `/insights/pack-reality` all 200 in 0.3–0.44 s.

⚠ `npm audit --omit=dev` after the bump: **28 vulnerabilities, 0 critical**, everything remaining transitive under `@onflow/*`, `@walletconnect/*` and `viem` (the `ws` memory-disclosure/DoS family). **Deliberately not touched** — no test here exercises a live socket, and an unattended pass must not trade a working chain read for an advisory number. 👉 **Cheaper question first: RPC does no wallet connect at all, so measure whether `@walletconnect/*` and `viem` are reachable before upgrading them. A dead dependency is deleted, not upgraded.**

---

### ⛔ RETRACTION added 2026-09-18 ~17:3x PT — item 7 above was WRONG and is self-reverted

I pinned `search_path` on `rpc_trust_health_precompute_refresh_p()`. Migration **`20260914055000`**, four days old and sitting in this repo, carries that exact statement in its header under *"REVERT OF THIS REVERT (do not, without solving the COMMIT problem first)"*.

**A procedure with a `SET` clause runs inside an implicit transaction block and may not execute `COMMIT` or `ROLLBACK`.** That procedure is `prokind='p'` with eight `PERFORM … COMMIT` pairs.

📏 **Nothing broke, and the reason is its own finding:** `cron.job` holds **no job that calls this procedure**. The legs are dispatched individually (jobids **324–331**); jobid 488 is a plain INSERT, not a CALL — so the 09-14 header's *"jobid 488 CALLs it every 10 minutes"* is **stale** and the procedure has no caller at all. 0 failures across all nine trust-health jobs and **zero runs of the procedure** over the 110 minutes the pin was live. Reverted anyway, because the pin arms a landmine for whoever next gives it a caller.

⛔ **My "positive control" was the same category error that migration names, in almost the same words.** I checked that all eight leg identities resolve under the pinned path — correct, and **irrelevant**: the hazard was never name resolution, it was transaction semantics. I also read the precompute's freshness *after* the pin and took "all legs fresh" as safety; every `computed_at` in that read predated the pin.

👉 **Rule: check `prokind` FIRST. For `prokind='p'`, grep the body for `\m(commit|rollback)\M` and stop.** The `scripts/` search_path guard checks name resolution and does not check this.

⚠ **Consequently `functions_without_pinned_search_path` is 2, not 1** — the deliberate state register #115 records. Owed item 3 in §4 below is **withdrawn**; a concurrent session corrected it in the same window and its version is the one to read.

🚨 **AND IT IS WORSE THAN "a migration four days old": THIS IS THE THIRD ATTEMPT AT THIS CLASS.** Per that corrected item 3, the same pin was shipped and reverted on **2026-08-22/23** (R14, closed **WONTFIX**, *"do NOT re-attempt"*) and again on **2026-09-13/14** (`20260914053000`, reverted by `20260914055000` twenty minutes later when jobid 259 failed its first tick in 0.5 s). **Mine is the third.** ⭐ Three sessions, three months, one PostgreSQL rule: `2D000 invalid transaction termination` at the first `COMMIT` of any routine carrying an attached `SET`. **A WONTFIX with "do not re-attempt" on it was not enough to stop a third attempt — the thing that would have stopped it is a guard, and `scripts/`'s search_path guard checks name resolution only.**

## 2. Three things this pass got WRONG or had to retract — read these, they are the useful part

### (a) ⛔ R104's premise is refuted, and its recommendation followed from the wrong half
R104 reads *"a universally empty `text[]` on all 14,016 Top Shot and all 6,190 AllDay rows"* and recommends **"drop the column"**. Re-measured over the **whole table**: 21,424 rows — 100 NULL, 21,299 empty, **25 POPULATED**, all Candy MLB, written 09-18 01:18–01:23Z, holding **parallel labels** (`Rainbow (Blue)` …) by `editionBadges()` in `lib/chains/solana/normalize.ts`.

**Dropping the column would have destroyed live data.** ⭐ The row's population was taken over two collections — 20,206 of 21,424 rows — and generalised to the table. It was true about everything it looked at and false about the thing it named. **Count the population the code touches, not the one you happened to sample.**

### (b) ⛔ Two autonomous sessions raced on the same register and duplicated work three times
A concurrent Claude Code session (`session_01AU2GQKnNWCujh5rCYGzHeb`) was shipping from the same register at the same time. **R94 was done twice. R95 was done twice. R97 was done one-and-a-half times.** Roughly a third of this session's code work was thrown away or merged down on rebase.

⭐ The R95 collision is the instructive one, because **both halves were kept and neither covered the other**: theirs fixed the CALL SITES (`ok ? … : null` across nine `app/insights/*/page.tsx` plus a tree-walk guard); this one fixed the TYPE (`BoardPageFetch.fetchedAt` is now `string | null`) and the CLIENT. A call-site fix cannot stop the *next* page forwarding the clock; a type fix cannot reach a refetch that fails after mount. The conflicting render copy was resolved **in their favour** — theirs explains the dash (*"the read did not complete, so there is no data time to show"*).

👉 **The register's status column is the only coordination point that exists, and it is written at the END of a pass — which is exactly too late.** A claim-before-you-start convention (a row's status set to `IN PROGRESS <session>` before the first edit) would have saved all three.

### (c) ⚠ A stale `.git/HEAD.lock` on the mount blocked HEAD from moving for ~40 minutes
Left by this session's first commit — `git commit` succeeded but its cleanup `unlink` failed, because **the Cowork mount refuses deletes until the user approves them**. `npm run git:unstick` only handles `index.lock`. 👉 **Worth teaching `scripts/git-unstick-index-lock.mjs` about `HEAD.lock` and the other `*.lock` files**, since the same permission gap will reproduce on every Cowork commit against the mount.

---

## 3. Health verdict

✅ **The 09-18 platform outage is fully behind us.** `detect_stalled_pipelines()` **10 → 1**; 2,738 runs / 8 failed / 132 distinct lanes in the last hour; security block all zeros; `v_fmv_sanity_flags` 0.

✅ **The ledger's open falsifier is DISCHARGED, positively.** Every one of the nine 3-hourly lanes resumed on its own scheduled minute: `candy-sales-indexer` 21:20:13Z, `topshot-onchain-art-backfill` 21:22:06Z, `allday-listing-serial-backfill` 21:34:14Z, `golazos-sales-history-backfill` 21:34:19Z, `candy-listings-indexer` 21:35:12Z, `allday-unmapped-resolver-tail` 21:40:48Z, and the three `*-studio-sales-history-backfill` drains at 21:52/21:56/21:58Z. ⚠ **The studio three were read TWICE** — the first read was before their ticks were due and proved nothing, which is the premature-reading trap the ledger flagged earlier the same day.

📏 **Vercel, 6 h: 50 groups / 2,630 occurrences / 658 users — but 39 of the 50 have a last-seen BEFORE the 19:01Z recovery.** Outage shadow, already stopped. **Eleven groups are still live (950 occurrences):**

- **`/[collection]/pack/dist/[distId]` — ~478 occurrences across five groups** (`pack_table_rows`, `ev_contributors`, `pack_lifecycle`, `pack_realized_ev`, `pack_market`), each exceeding its own 5,000 ms bound, last seen 23:1xZ. ⛔ **CHRONIC and already analysed** (inbox 2026-09-04, 2026-08-14; `pack_ev_latest` has no materialized alternative). **Recorded, deliberately not re-diagnosed.**
- **`[profile/public-profile-resolve] read exceeded 6000 ms` — 200 occurrences / 101 USERS**, the largest user count of any group, on `/api/og/trophy-case/[username]` and `/api/public/profile/[username]`.
- **`Vercel Runtime Timeout Error: Task timed out after 60 seconds`** — 169 / 17 users on `/api/wallet-backfill`, `/api/ready`, `/api/wmc-fmv-populate`. ⚠ **`/api/ready` is a readiness endpoint that is itself timing out.**
- `DEP0169` — 76, known and root-caused 2026-09-05. Not re-filed.

🚨 **Sentry is now formally dark by decision** (the concurrent session removed `@sentry/nextjs`; quota exhausted since 08-18, Trevor declined to buy more). **The Vercel runtime-error count is the instrument now** — the nightly-pass rule "a Sentry zero is health only if the Vercel number is also near zero" simplifies to "read Vercel".

---

## 4. Owed / next

1. ✅ **READ 2026-09-18 ~4:5x PM PT (Claude Code cloud, which can reach the GitHub API):** all nine (`1232b44ec` → `ec22f1f58`) are **`completed / success`** on the `CI` workflow, as are the twelve other main pushes around them (22 of 22 in the window). Nothing to chase.
2. 🕐 **`candy_offers_unverified_pct` = 100 against a breach_at of 25** — the only trust-health breach. Its falsifier is `candy-offers-indexer`'s ~00:50Z tick. **PRE-READ 2026-09-18 ~5:0x PM PT (Claude Code cloud):** still 100 — 4 active offers, all 4 last seen at the 06:51Z tick (11:51 PM PT 09-17). The lane is a Vercel cron (`50 */6 * * *`, `/api/ingest/candy-offers`) and `pipeline_runs` holds its 00:50Z and 06:50Z ticks but NOT 12:50Z or 18:50Z — both fell INSIDE the #122 window (05:48 → 12:0x PT = 12:48Z → 19:0x Z), 2 min after onset and 8 min before the restart. So the reading is the outage's shadow, not an arm defect; the falsifier stands as written. ⚠ Read the NEXT value with the 999 case in mind: the book runs 95 deactivations per 99 upserts each tick and is down to 4 active rows, so a clean sweep that retires all 4 returns 999 (EMPTY set) — a breach for a different, benign reason. **Under 25 ⇒ self-healed, close. Still 100 after a clean run ⇒ a real verification/deactivation-arm defect, and the ARM is what to investigate, not the indexer cadence.**
3. ⛔ **`reconcile_all_saved_wallet_stats` — DO NOT PIN IT. CORRECTED 2026-09-18 ~5:1x PM PT (Claude Code cloud).** The line this item used to carry ("pin it *after* qualifying the references") is a filed decision that has ALREADY broken production TWICE: it is a PROCEDURE that `COMMIT`s per wallet, and PostgreSQL raises `2D000 invalid transaction termination` at the first COMMIT of any routine carrying an attached `SET` clause — `search_path` included. Shipped and reverted 2026-08-22/23 (R14, closed WONTFIX, "do NOT re-attempt") and again 2026-09-13/14 (`20260914053000` → reverted by `20260914055000` twenty minutes later, after jobid 259 failed its first tick in 0.5 s). Qualifying the references does not change that — and the premise is refuted anyway: read live, every object reference in the body is already `public.`-qualified (`saved_wallets`, `wallet_moments_cache`, `aggregate_saved_wallet_stats`, `log_pipeline_run`); the rest are pg_catalog built-ins and types. Exposure is zero: INVOKER, no anon/authenticated EXECUTE, both callers are pg_cron jobs 259/497 running as `postgres`, whose role-level `search_path` is `"$user", public, extensions` and whose commands schema-qualify the `CALL`. The only viable form, if ever wanted, is a `SET search_path` STATEMENT inside the body (R14 says the same). **Closed; the advisor WARN stays by design — [database.md](reference/database.md) "A ROUTINE WITH AN ATTACHED `SET` CLAUSE CANNOT `COMMIT`".**
4. **R98's other half** (`/api/cache-refresh` unbounded anonymous service-role writes) and **R96** (`/api/allday-pack-ev` POST) both need a **product call on anonymous write amplification**, not a code fix. Still open, unchanged.
5. **R103** (34.4% of TS asks past the corroboration bound) and **R100/R101** (price-snapshots bucket loss; `ts-listings-atlas-sync` losing 58.6% of ticks invisibly) are untouched this pass.
6. ⛔ **The FMV question inside R105 is deliberately unshipped:** the market says the model **under-prices the last mint** (≈2.6× observed against 1.0× applied). Real money, human decision. The new guard's header says so in place so nobody mistakes the copy fix for a verdict on the multiplier.
7. 👉 **`rpc-dune-free-tier-sunset`** is a one-shot self-pause (`0 12 23 9 *`) that fires **2026-09-23**.
