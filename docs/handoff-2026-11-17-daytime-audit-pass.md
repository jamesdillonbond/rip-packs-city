# Handoff — 2026-11-17 daytime audit pass (Cowork cloud)

**First line, because it is the one open P1: GitHub scheduled workflows have not fired since 12:59 AM PT 11-17 (item 1 below).**

> ⚠ Any limitation noted here is specific to **this cloud session**. Trevor's machine and Claude Code push normally. Commit these files as usual.

Trevor, 7:47 AM PT: "work autonomously for the next 5 hours. Do a deep dive audit, QA, cybersecurity review, SEO review, and health check … Fix any issues you encounter." 8:16 AM PT: "also audit and review all of our scheduled tasks, artifacts, and skills." The pass ended early (~9:15 AM PT) when the session ran out of working room; what was and was not covered is stated per section.

## Verdict

Platform GREEN on every DB instrument · 3 ships · 1 open P1 (GitHub schedules) · oldest routed: #261 acquisition dates, 2 nights (blocked on Dune credits until 12-14).

## Shipped

| what | where | revert |
|---|---|---|
| `/api/pack-pulls` POST: id shape `^[A-Za-z0-9:_.-]{1,80}$` + fail-closed cap of 100/day per IP across all packs | `17602a4d` | `git revert` |
| `/dashboard/packs` per-collection activity counts get commas | `17602a4d` | same |
| GitHub schedule re-registration attempts (see item 1) | REST disable/enable ×30; `416bcfca`; `75a31da2` | comment lines only, already removed |

CI, Smoke Tests and E2E DOM Smoke were green on `17602a4d`.

## Queued for Trevor / Claude Code

1. **[P1, Trevor, 0 nights] GitHub scheduled workflows are dark.** `2e021e372` (1:16 AM PT) deleted `.github/`; `22814c4` (6:22 AM PT) restored it. Schedule-triggered runs: 0 between 1:00 AM and 9:11 AM PT today, against 12 in the same hours on 11-16. `gha-schedule-watchdog` has been red since 7:08 AM PT. Tried, in order, with no scheduled run after any of them as of 9:10 AM PT: (a) REST disable → enable on all 30 scheduled workflows (30/30 answered 204, all read back `active`); (b) a commit touching all 30 files (`416bcfca`, pushed through the cloud proxy, GitHub login `claude`); (c) a commit removing those lines pushed from the laptop VM with `.rpc-git-cred` (`75a31da2`, 8:50 AM PT). Working theory, NOT proven: the restore re-created every workflow file in a push whose GitHub actor is `claude` (not a collaborator), and GitHub attributes a schedule to the account that last created/changed it; every scheduled run before today has actor `jamesdillonbond`. (c) was the test of that theory and had had only ~20 minutes (about one expected run) when this was written. **If no scheduled run has appeared by ~10 AM PT:** from Trevor's own machine, make any edit to one `cron:` line (e.g. `site-availability-alarm.yml` minute `4,19,33,49` → `5,19,33,49`), commit and push as himself, and watch Actions → that workflow for a "Scheduled" run; then repeat for the rest. Read: `gh api "repos/jamesdillonbond/rip-packs-city/actions/runs?event=schedule&per_page=3"`. **(d), 9:14–9:26 AM PT:** a real `cron:` change on `site-availability-alarm.yml` (`4,19,33,49` → `3,19,33,49`, `511da98` + `e2e29b1`), also pushed with the owner's credential — **still 0 scheduled runs at 9:56 AM PT, 42 minutes later.** Exposure is smaller than first stated: `detect_stalled_pipelines()` is `[]` and the watchdog reads 0 cadence lanes breaching, because pg_cron / cron-job.org are the primaries for the watched lanes and GitHub is their backstop. GitHub-only lanes were covered once by a manual dispatch of 12 workflows at 9:42 AM PT. The one untried route is a change made in Trevor's own GitHub session (web UI toggle or a commit from his machine). Meanwhile `workflow_dispatch` works (Site Availability Alarm, Pipeline Sentinel and Sales Indexers Backstop were dispatched by hand at 8:15 AM PT and passed). Lanes with no other scheduler are the exposure: UFC Aptos ingest, E2E DOM Smoke's schedule, Site Availability Alarm, Dead Lane Backstop, migration auto-recover.
2. **[P2, Trevor, 0 nights] Six installed Cowork skills are behind their repo copies** — `rpc-data` and `rpc-migration` still say Panini is the only inactive collection (false since 10-19) and lack the UFC tier list; `rpc-cron-ops` lacks the 11-04 batch-edit recipe; `rpc-artifact-ops`, `rpc-surface-qa` (+ 2 reference files) and `rpc-nightly-autonomous-pass` differ too. One-click `.skill` bundles built from `docs/cowork-skills/` were sent in the chat. `rpc-audit-drain`, `rpc-edge-fn-deploy`, `rpc-fmv-audit`, `rpc-insights-qa` match; `rpc-handoff` differs only in frontmatter quoting.
3. **[P2, Trevor, 0 nights] Scheduled tasks (partial audit — 14 of the account's tasks were read; the list has more pages).** (a) "Rpc monthly strategy review" still says "RPC is read-only (no cart, trading or gifting)" — the trade room has been live since 10-31 — and is pinned to an older model. (b) "RPC laptop pull main (daily, device-bound)" has been disabled since 11-13; the Panini runner runs from that tree. Confirm that is intended. (c) Two one-shot reminders never ran (`auto_disabled_session_gone`): "#248 first daily resync read" (its work was done by the 11-16 close-out) and "Re-measure fmv-recalc sale-to-price lag (hot lane)" — **correction 9:25 AM PT: that read was done by hand on 11-16** (`claude/fmv-engine-open-items-2026-11-12.md`: sale → new price about half an hour at the median); lane re-read today, healthy, backlog 4. Nothing owed. Prompt edits were not made from this session.
4. **[P3, Trevor] Binder shows a subset larger than the whole.** On `/nba-top-shot/collection` for jamesdillonbond at 8:00 AM PT: WALLET FMV $44,897.32 (15,794 moments, "+ $5,049.50 across 7 stale-priced" shown apart) but the cost-basis line reads "Current FMV: $46,704.67" for the 15,470 moments with a known cost. **Confirmed in `get_wallet_summary`:** `current_fmv` and `pnl` sum every moment with a cost and a price, STALE-priced ones included, while the headline is `wallet_fmv − stale_fmv`. Which definition P&L should use is a stale-pricing call (#209), so it is his.
5. **[P3, Claude Code] A 2-minute PostgREST saturation at 10:12–10:14 PM PT 11-16**: 13,143 and 10,532 PostgREST requests/minute (baseline ~300), 423 "Thread killed by timeout manager", and ~40 Vercel error groups all stamped in that minute (pack-detail 5 s bounds, market-cap tile 8 s bounds, player hubs). Requests that minute came from a long tail of residential ISPs (top ASN 513 requests), not Tencent. Evidence for #235's 11-20 read: the "no minute > 400" exit did not hold.
6. **[P3] SEO, optional:** 105 of 2,662 sampled sitemap pages carry no JSON-LD — the collection tool tabs (`/<c>/market|packs|sets|collection|sniper|analytics`), public profiles, and `/help`, `/market`, `/teams`, `/blog`. 651 meta descriptions run past 170 characters and 228 titles past 65. `/giveaways/<unknown>` answers 200 + noindex rather than 404.
7. **[carried, 2 nights] #261 acquisition dates remainder** — blocked on Dune credits until 12-14.

## What was checked and read clean

- **Health:** `rpc_ops_snapshot` — security invariants all empty, 0 trust breaches, 0 stalled pipelines, DB 51 GB. `hybrid_custody_backfill` medium alert is the pooled pre-fix failures (ages out 11-18). Client-error beacon: 0 real rows in 48 h. Feedback inbox: 0 open.
- **Accuracy (7 d):** Top Shot published ALL ratio 1.00, 69.6 % within ±25 % (naive last-3 median 70.6 %); All Day 1.00, 61.1 % (naive 63.8 %). Top Shot ASK_ONLY published still 2.00 / 17.7 % — mostly pre-cap sales; this morning's caps are not yet in that window.
- **Security:** all 139 `/api/admin/*` and `/api/cron/*` routes refuse anonymous GET and POST (five GETs return harmless cursor/status JSON). Response headers: CSP, HSTS preload, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy present. Supabase advisors: 6 mutable-search-path and 7 anon SECURITY DEFINER warnings, all on the repo's own allowlists (`secdef_anon_violations` empty).
- **SEO:** stratified sitemap sweep, 2,662 of 117,088 URLs across 9 shards: all 200, all self-canonical, all with title, description, og:image and exactly one h1, none noindex. 15 nonsense slugs: honest 404 + noindex everywhere except the giveaway and share cases above.
- **Signed-in walk (Trevor's Chrome):** dashboard, pack history, transaction history, alerts, trades compare, Top Shot binder — no broken images, no horizontal overflow, no error panels.
- **Artifacts:** every table, view and function named in the 16 dashboard sources under `docs/cowork-skills/*.html` exists in the database (column-level not checked). "Rookie Debut Drop Planner" is for the 11-11 drop and can be retired; "RPC Pack Board" (09-24) has no source file in the repo.
- **Laptop VM:** `/sessions` 1 % used (864 K of 9.8 G) — the 11-17 disk-full finding is cleared.

## Not covered

Mobile-width sweep, light-theme pass, concierge probes, Panini/Candy parity walk, the remaining scheduled-task pages, per-artifact rendering, and known-issues/roadmap drain.

## Addendum — 9:15–9:56 AM PT (Trevor: "Keep going", then "Go through everything open and resolve as much as you can")

- **Shipped:** the concierge now says UFC Strike moved to Aptos when asked whether it is tradeable (verified live). Ledger 11-17 ~9:25 AM PT.
- **My error:** `511da98` put the alarm on minute 5, which another workflow uses, and was pushed from the VM without the guards; `main` was red 9:14 → 9:26 AM PT until `e2e29b1`.
- **Read clean:** 390 px sweep of 64 pages (no overflow, no broken images, no error panels; two Pinnacle set images 404: `GEN-20CG-AVTR-S0`, `GEN-20CG-ALIN-S0`); four concierge probes; fmv-recalc hot lane.
- **Refused for this session (needs Trevor's explicit yes):** rewriting the "Rpc monthly strategy review" prompt (the corrected text is ready: trade room live since 10-31, UFC on Aptos).
- **Scheduled tasks read so far (18):** nothing failing among the recurring ones read (daily X draft, monthly deep audit, context hygiene, strategy review, memory consolidation, daytime monitor). Several are pinned to an older model; not changed.
- **Decided not to do:** `/giveaways/<unknown>` stays 200 — the whole route is `noindex, nofollow` by design; JSON-LD on the collection tool tabs stays off (the 10-21 decision moved it to `/overview` on purpose).

## Addendum 2 — 9:58–10:15 AM PT (Trevor: "I approve you doing everything mentioned", then "I approve")

- **🚨 Found and repaired: the laptop repo tree was gutted at 5:15 AM PT.** Its own 2-hourly pull fast-forwarded to `2e021e372`, deleting `app/`, `.github/` and most of `scripts/` locally; the residential runners stopped (`topshot-active-listings-ingest` 5:13 AM, `panini-collector-walk` 5:17 AM, `panini-ingest` 5:46 AM PT). Restored to `origin/main` at ~10:07 AM PT (batched checkout + `update-ref`, then `--ff-only`; 0 behind, no locks). **Open:** the Windows Task Scheduler runners had not restarted by 10:14 AM PT — read `pipeline_runs` for `panini-ingest` after the next scheduled start; if still silent, run the tasks by hand on the laptop.
- **Guard worth adding (not done):** `pull-main-ff.cmd` should refuse a fast-forward whose diff deletes most of the tree (e.g. `git diff --shortstat HEAD origin/main` deletions > 1,000 files), so one bad commit on `main` cannot gut the laptop again.
- Carried to `main`: the weekly data-quality sweep's ledger entry that existed only on the laptop tree.
- Done: "Rpc monthly strategy review" prompt corrected; "Rookie Debut Drop Planner" artifact deleted; `site-availability-alarm` disabled → enabled in the GitHub web UI in Trevor's session at 10:00 AM PT (fifth schedule attempt; still 0 scheduled runs at 10:14 AM PT).

## Addendum 3 — 11:05 AM–12:00 PM PT (Trevor: "I approve", then "Do what makes sense")

- **Laptop runners resumed on their own schedule** after the tree restore: `topshot-active-listings-ingest` 11:13 AM PT, `panini-collector-walk` from 11:20 AM PT (7 runs by 11:50). The Panini runner's slot is 12:00 PM PT. Task Scheduler could not be driven by desktop control (elevated window ignores injected clicks).
- **Shipped:** `scripts/laptop-tree-ff.mjs` refuses a fast-forward that deletes ≥ 500 files and ≥ 20 % of the tree (exit 3, `FAILED: REFUSED` in `pull-main-ff.log`). The laptop already has it (HEAD `962f17937` at 11:35 AM PT).
- **GitHub schedules, sixth attempt:** `db5b6ab` — a one-line comment on `site-availability-alarm.yml` committed on github.com in Trevor's own session (author `jamesdillonbond`, committer `web-flow`, 11:37 AM PT). Still 0 scheduled runs at 11:57 AM PT, but that one workflow only fires ~3 times a day under GitHub's shedding here, so 20 minutes proves nothing; the test is any `event=schedule` run across the repo over the next few hours. If none by mid-afternoon: GitHub Support (schedules stopped after `.github/` was deleted at 1:16 AM PT and restored at 6:22 AM PT; workflows read `active`; `workflow_dispatch` works).

## Addendum 4 — 1:40–2:05 PM PT (Claude Code, laptop; Trevor: "make sure we're all caught up", then "Address as much of this as possible")

- **Re-checked against the DB:** every staged-for-apply filing 11-13 → 11-17 is applied. The two "for Trevor" filings of 11-16 (Candy merged editions, wallet search cache-first) were already resolved 11-15. Their index lines are now marked; the Candy re-measure reads 0 editions / 0 cards over circulation.
- **Item 4 (binder subset > whole) — decided and shipped:** P&L follows the headline's rule. A STALE-priced moment leaves Cost Basis / Current FMV / P&L (migration `20261117215147`). The strip says how many: "· N stale-priced left out". Control wallet Top Shot: Current FMV $46,311 → $41,262 under a $44,501 headline, 7 moments left out.
- **Item 1 (GitHub schedules):** still 0 scheduled runs at 2:02 PM PT, after the seventh attempt (`92e051756`, 1:25 PM PT, every cron rewritten `m` → `m-m`, pushed with the owner's credential). githubstatus: Actions operational, no incident. Workflow IDs are unchanged and `active`. GitHub-only lanes were dispatched by hand again at 1:42 PM PT: 12 workflows, all green, including `topshot-sales-history-backfill` and `pinnacle-owner-discovery` (dark since ~6 PM 11-16).
  **Next step (Trevor, from github.com/contact → Actions):**
  > Repository jamesdillonbond/rip-packs-city: no `schedule`-triggered workflow run has been created since 2026-11-17 08:59 UTC. At ~09:16 UTC a commit deleted the `.github/` directory; it was restored at ~14:22 UTC. All 30 scheduled workflows read `active` (same workflow IDs as before), `workflow_dispatch` runs succeed, and Actions is enabled for all actions. Since then we have disabled/enabled every workflow via the API and the web UI, and pushed cron changes as the repository owner (latest 21:25 UTC, every cron rewritten). No scheduled run has appeared. Could you re-register the repository's schedules?
- **Dependabot #31 (picomatch ReDoS, GHSA-fc5q-39xc-vjpf):** every version ≤ 4.0.7 is affected and no patch exists. It reaches only build/test tooling (vitest, vite, Next build), and no app path feeds it a user-supplied pattern. Left open so it clears when a patch ships.
