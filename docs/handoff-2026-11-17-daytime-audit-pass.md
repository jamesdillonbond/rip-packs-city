# Handoff — 2026-11-17 daytime audit pass (Cowork cloud)

**✅ RESOLVED 7:03 PM PT 11-17: GitHub scheduled workflows are firing again after 18 hours dark (item 1 below; cause not established — see the last addendum).**

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

## Addendum 5 — 2:05–5:15 PM PT (Claude Code, laptop; "Keep going", then "update any relevant documentation")

- **Shipped:** Panini team walk retries a failed walk within ~2 nights (`20261117230420`); pack-reality staleness snapshot (`20261117232134`); **database-side main-tree watch** (`20261117233007`: a 404 on any of 7 sentinel files on `main` raises a critical alert through `/api/check-alerts`, which runs outside GitHub); light-theme fixes for two labels + `scripts/qa/light-contrast-sweep.mjs`. Ledger has an entry for each.
- **GitHub schedules:** still 0 scheduled runs at 5:08 PM PT. Another session's probe (`schedule-probe.yml`, a brand-new workflow) never fired, so the fault is repository-wide. Lanes dispatched by hand at 5:08 PM PT; **this session's 3-hourly backstop ends when the thread is archived**, so the next cover has to come from whoever picks this up (the 12 files are listed in addendum 4). Next levers: Settings → Actions → General toggle (Trevor) or GitHub Support.
- **Watch tomorrow (also in focus.md):** the ~3:35 AM PT team walk should start with Denver, Indianapolis, Pittsburgh, Seattle and Washington; `main-tree-watch` should keep reading 7/7 `present`; `mv_topshot_pack_reality_ranker_staleness.computed_at` should be < ~2 h old.

## Addendum 6 — 12:00–5:40 PM PT (Cowork cloud; Trevor: "Keep probing and looking for ways to fix this yourself", then "I approve toggling Actions off and on")

GitHub `schedule` events are still not delivered to this repo. Last scheduled run: 2026-11-17 12:59 AM PT. Nine attempts have failed; the last three are new since addendum 3:

- **Seventh (1:25 PM):** every cron line rewritten to the `m-m` minute form (`92e0517`, owner credential). No effect.
- **Eighth (3:46 PM):** a brand-new workflow, `.github/workflows/schedule-probe.yml` (id 422003051, cron `1,16,31,44,58 * * * *`). It has never fired on schedule; manual dispatch works.
- **Ninth (5:07 PM):** repo-level Actions disabled and re-enabled in Settings (Trevor's Chrome). Settings read back unchanged; 0 scheduled runs in the following 30 minutes.

A new workflow that never fires rules out anything in our workflow files. What is left is GitHub's side: **Trevor files a GitHub Support ticket** (text is in the 11-17 chat). Until then the GitHub-only lanes need manual dispatch; pg_cron and cron-job.org carry the rest.

Also shipped in this window: picomatch advisory `GHSA-fc5q-39xc-vjpf` baselined in `prod-dep-audit-baseline.json` (no fix published, not reachable from requests); Dependency audit is green again.

**When schedules return:** delete `schedule-probe.yml`, and decide whether to revert `92e0517`. Run `npm run preflight` before either push.

- **6:12 PM PT:** GitHub Support ticket filed from Trevor's session (see ledger); all 30 scheduled workflows dispatched by hand at 6:01 PM PT.

## Addendum 7 — 6:04–6:35 PM PT (Cowork cloud; Trevor: "You do it all", "Check their response", "Figure it out")

- **GitHub Support closed ticket 5020807 unread** (6:04 PM PT): the free plan gets self-service resources only.
- **Shipped instead: the schedule relay** (`.github/workflows/schedule-relay.yml`, `scripts/gha-schedule-relay.mjs`). One ~5.5 h job dispatches each scheduled workflow when its cron is due and then dispatches its own next link. No stored token. It skips a workflow that ran in the last 110 minutes, and stops for good when a real `schedule` run appears. First link started 6:26 PM PT.
- **Watch:** Actions → "Schedule relay" should always show one run in progress. If none is, start it with Run workflow. `scheduler-liveness` and `gha-schedule-watchdog` stay red while the outage lasts, because they count `schedule` events only.
- **Still open:** the outage itself. Free routes left are a GitHub Community Discussions post, or a paid plan to reopen the ticket (Trevor's call).

## Addendum 7 — 6:45 PM PT (Claude Code, laptop; "Figure it out")

- **The GitHub-only lanes no longer need hand dispatch:** the Windows task "RPC GHA schedule fallback" (every 5 min, `scripts/gha-schedule-fallback.mjs`) dispatches each scheduled workflow when its cron slot passes with no run, only while GitHub delivers no schedules. Verified on three ticks with no doubles. It stands down when GitHub recovers; delete it then.
- ⚠ Every hand dispatch of ufc-aptos-sales-ingest on 11-17 was a dry run (`apply` defaults to false). Fixed in the fallback, and a 6:31 PM PT `apply=true` run wrote.
- Fixed: three `github.event.schedule ==` gates still named the pre-rewrite cron text (badge-sync ×2, ops-monitor's daily data-integrity), so those jobs would never have run once schedules resumed. A guard now keeps gates and crons in step.

## Addendum 8 — 6:55–7:15 PM PT (Cowork cloud; Trevor: "Keep working on anything you can")

- **✅ Schedules resumed at 7:03 PM PT:** 10 real `schedule` runs across 10 workflows in six minutes, all green. Cause not established (candidates and why none is proven: ledger 11-17 ~7:15 PM PT).
- The relay was changed to defer to the laptop fallback and send its inputs (it had sent none), then retired itself when it saw the real runs. The laptop fallback stands down by itself.
- **Cleanup owed, 11-18 evening, only if schedules have held:** delete `schedule-relay.yml`, `scripts/gha-schedule-relay.mjs`, `__tests__/gha-schedule-relay.test.ts`, `schedule-probe.yml`; delete the Windows task "RPC GHA schedule fallback"; decide on reverting the `m-m` cron form (`92e0517`; three `github.event.schedule ==` gates now name the new text, so a revert must change them back too). `npm run preflight` first.

## Addendum 9 — 7:25–7:50 PM PT (Cowork cloud; Trevor: "Do the rest of those untouched items")

Read-only; nothing shipped.

- **Accessibility gate:** the `a11y-audit` job of the 6:01 PM PT dispatched E2E run passed. 72 route × theme audits (plus the 390 px pass on each): 0 gated violations, 0 serious ungated.
- **Dashboard artifacts (16 sources in `docs/cowork-skills/`):** each loaded headless with a recording stub in place of the Cowork bridge. All 16 ran without a script error and issued their first-load queries (29 SQL, 2 Vercel). 159 explicitly selected columns across 33 relations all exist. Not covered: queries an artifact only issues after its first result, and how the charts look with real data.
- **Panini / Candy parity walk:** 9 shared tabs each on production, Top Shot as control. Every supported tab rendered with an h1, no error or stuck-loading text, no failed API call, no broken image, no overflow, no confidence wording. Unsupported tabs redirect to the overview (Panini: badges, challenges; Candy: sniper, badges, challenges). Cosmetic only: Panini's headings say "PANINI — COLLECTION" and "PANINI — SET TRACKER" where the others say "— BINDER" and "Set Tracker".
- **Scheduled tasks, remaining pages: NOT done.** The list returns four tasks per page with full prompts; the first page was four already-read entries (three are disabled copies of "RPC laptop pull main"). Finishing it needs a fresh session.

## Addendum 10 — 7:35–7:55 PM PT (Cowork cloud; Trevor: "get everything done")

- **Shipped:** Panini binder heading now reads "Panini — Binder" (ledger 11-17 ~7:55 PM PT).
- **Scheduled tasks, full list read (35 tasks, 8 pages, by a subagent; read-only).** Every recurring task's last run reads OK. Prompt edits need Trevor's named approval, so none were made. Stale prompt text found:
  1. `Rpc weekly health report` (3 AM, unattended) tells the run to request folder access, which waits for a human; it also has a "revenue/conversion blockers" section.
  2. `Rpc flow ecosystem watch` and `Rpc data quality sweep` (both untouched since 09-23) still treat UFC as on Flow and leave out Panini and Candy.
  3. `Rpc nightly autonomous pass` and `Rpc weekly health check` still refer to a Candy "July tripwire"; the nightly pass and `Rpc surface qa` say 11 artifacts where the daytime monitor says 13.
  4. `Rpc dependency advisory digest` says `flowty_archive` is a deliberate keep; the weekly health check says it was dropped 06-10.
  5. `Rpc pending signups watch` reports users by email and carries pre-Large-tier wording.
  6. One-shot `RPC wallet verification adoption check` (11-18 10:23 AM PT) equates 22:20 UTC with 3:20 PM PT; that is 2:20 PM PT.
  7. Nine expired or failed one-shots and three disabled copies of "RPC laptop pull main" can be deleted. The Windows-native pull replaces the Claude task. The #248 close-out was done by hand on 11-16. R133 (`?token=` admin arms): see the line below.
  8. Eleven recurring tasks are pinned to an older model.
  9. **Possible follow-up, not verified as a defect:** R133 was closed 11-04 for the proxy and the shared admin-auth helper, but 36 route files under `app/api/admin` and `app/api/cron` still read a `?token=` query parameter themselves (e.g. `admin/evm-health`, `admin/backfill-allday-buyers`). Whether any live caller (cron-job.org, pg_cron, GitHub) still sends the secret in the URL was not enumerated; do that before removing any of them.

## Addendum 11 — 8:00–8:20 PM PT (Cowork cloud; Trevor: "Yes I approve of everything mentioned")

Scheduled-task changes, applied by the subagent that read the list:

- **Prompt edits done (8 tasks):** weekly health report, flow ecosystem watch, data quality sweep, weekly health check, surface qa, dependency advisory digest, pending signups watch, wallet verification adoption check (kept 22:20 UTC, corrected the PT text to 2:20 PM). Only the corrections listed in addendum 10 were made; model, schedule, name and enabled state untouched.
- **Deleted (10):** seven dead one-shots and the three disabled copies of "RPC laptop pull main".
- **Refused by the permission system, NOT done, not retried:** the edit to `Rpc nightly autonomous pass` (it still says "11 claude.ai artifacts" and refers to a Candy "July tripwire"), and deleting two dead one-shots ("#248 first daily resync read", "Dapper + Flowty recovery check"; both disabled, harmless). Trevor can make these three in the scheduled-tasks UI.
- **Left as found, outside the approved wording:** flow ecosystem watch says Candy "has its OWN dedicated audit tasks" (none exists); pending signups watch's check 1 still says "lead loudly with email" (the new reporting rule overrides it).
- **Nightly-pass prompt, decided not to apply from here:** the edit means replacing a 27,600-character prompt that governs unattended production work with a retyped copy, for two cosmetic phrases, after the permission system had refused it. The two phrases for Trevor to change by hand: "the live dashboards are 11 claude.ai artifacts whose sources are" → drop the count; "(chain-two / Candy / Solana → July tripwire task)" → remove.
- **`?token=` follow-up (addendum 10, item 9), callers checked 8:25 PM PT:** 0 GitHub workflows and 0 of 319 active pg_cron jobs send a token in a URL to the site. **cron-job.org read 8:50 PM PT by page script (paths and parameter names only): 77 jobs, 64 to the site, none with a `token`/`key`/`secret` parameter.** So no scheduled caller sends it. The 36 routes still accept the query form; removing it is an auth change, so list hand callers first (steer in `docs/overnight/focus.md`).

## Addendum 12 — 8:45–9:00 PM PT (Cowork cloud; Trevor: "update any relevant documentation before I archive this thread")

- **Scheduler:** two more real `schedule` runs at 8:39 and 8:43 PM PT (12 since 7:03 PM). Holding.
- **Docs updated:** outcome and lessons appended to the outage paragraph at the end of `docs/reference/cron-and-schedulers.md`; session entry in `docs/sessions/2026-11.md`; a steer at the top of `docs/overnight/focus.md` with the cleanup owed (not before 11-18 evening) and the `?token=` follow-up.
- **Nothing else is in flight from this thread.** No relay run is in progress, no background job, no pending reminder.
- **9:00 PM PT (Trevor: "Do what you need to do. I approve"):** the two remaining dead one-shots ("#248 first daily resync read", "Dapper + Flowty recovery check") are deleted. The nightly-pass prompt was still NOT replaced from here, for the reason in addendum 11; its two phrases remain for a hand edit.
