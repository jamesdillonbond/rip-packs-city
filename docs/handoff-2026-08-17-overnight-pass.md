# Overnight autonomous pass — 2026-08-17 (01:04 PT / 08:04Z)

**Mode:** genuine overnight window (01:04 PT, DB `now()` 08:03Z matches shell exactly — **no clock skew**). **NO-PUSH MODE** — the mounted repo's `remote.origin.pushurl` carries no embedded credential (`push --dry-run` → "could not read Username"), so code commits + Vercel deploys are impossible this run; DB migrations and Cowork artifact repairs would still apply. **Shell is GREEN** (the 9-night `/sessions` outage is closed — first pass in 9 nights with a working shell), and the public `git clone` succeeded, but **push remains dead** (repo-scoped credential, operator-only).

**Result: shipped 0 / reverted 0 / repaired 0.** An honest quiet night: health is green/known-class (and improving — 5→3 trust breaches), the post-ship regression watch PASSES on every recent ship with nothing to revert, and every actionable candidate is either code-deploy-blocked by NO-PUSH, operator/secret-gated, or a deferred operator decision.

Origin/main tip at run start: `7fdc8436` (docs). Concurrent Claude Code work was active until ~08:00Z (many commits in the last 24h touching CLAUDE.md, ledger, dashboard/profile honesty fixes, the jobid-215 cadence migration, and the pipeline-restoration filings).

---

## Post-ship regression watch — PASS (0 reverts)

Re-measured every prod-state change from the last ~24–48h. All healthy or improving:

| shipped change (by CC) | target | measured this run | verdict |
|---|---|---|---|
| **apply-fmv-haircut** per-collection split (was 100% fail since >=08-14, ~125s inert-timeout) | writes rows again | **08-17 06:30Z run: ok=true, 65 rows, 109.9s** (first post-fix run; prior 2 days fail at 125.2s `upstream request timeout`) | RECOVERED |
| **drain-fmv-cold-tail** telemetry fix (reported 0/0 while repricing) | rows_found/written populated | 08-17 rollup **rows_written 33** (vs 0 on 08-15/16); 9/9 ok | CONFIRMED |
| **8-way trust-precompute leg split** (jobs 324-331) | `trust_precompute_max_age_hours` < 13 | **10.39 / ok** — cleared. Freshness view names the one stale leg (`sales_serial_supply_worst_pct`, max age 10.47h) = **jobid 327 `rpc-thp-leg-serial-supply` failed at 03:48Z** while 7 siblings succeeded — the split's ISOLATION working as designed (monolith would have frozen legs N..8) | HOLDING |
| **fmv-recalc** (had re-breached to 4.32 at 05:24Z) | `fmv_sweep_wedge_hours` < 3 | **0.39 / ok**, `fmv_sweep_stall_pct_24h` **39.7 / ok** — sweep advancing again | RECOVERED |
| **jobid 215** cadence cut `*/30`->`37` (`20260817015354`) | halve attempts, don't starve throughput | migration registered in `schema_migrations`; verified live by CC (jobid 215, cron_heavy, `:37`) | LIVE |
| dashboard/per-collection-profile honesty fixes | frontend read-honesty | frontend-only, own tests + reverts, no prod-DB state | N/A to DB watch |

Nothing correlated with a regression; **nothing to revert.**

---

## Section 2 health-drift findings

- **Security — 4/4 CLEAN.** `pg_tables rowsecurity=false` -> `[]`; anon/authenticated write-grant-on-RLS-off -> `[]`; `check_public_security_invariants()` 0 rows; `check_anon_write_surface()` 0 rows; `check_secdef_anon_exec_drift()` array length 0.
- **Trust health — 3 BREACHED (down from 5), all known-class.** `fmv_sweep_wedge_hours` and `trust_precompute_max_age_hours` both **CLEARED** since the prior baseline. Remaining: `panini_sale_price_capture_dry_days` **20** (home-box runner outage, operator; +1/day expected), `public_board_slow_count` **5** (saturation, oscillating DOWN from 12), `unmapped_resolution_backlog_max` **291** (AllDay permanent-class floor). None new, none actionable autonomously.
- **Stalled pipelines — 2, both known.** `candy-editions-ingest` silent **2847 min** (missed the 08-16 daily tick; the documented 300s-timeout-kill under saturation — QUEUE, code fix). `allday-pack-opens-backfill` silent 122 min vs 90 (finite spork-floor backfill, expected to slow/stop; known).
- **pg_cron failures — ~7, all saturation-class** ("canceling statement due to statement timeout" / one "job startup timeout" on leg 327). Includes 2 weekly-by-design jobs (serial-fmv-multipliers/jersey). None post-fix; all documented disk-IO-saturation collateral.
- **Sentry (48h) — 6 issues, ALL `smoke check could not run: ...`** from `/api/smoke-test`. The documented `couldNotRun`-under-saturation honest-degradation path (checks that could not RUN said so rather than asserting a violation). Security independently verified clean, so these are NOT real security failures. Not attributable to any ship.
- **Vercel — 0 ERROR** (20 recent: 10 READY / 10 CANCELED; CANCELED = docs-only commits skipped by `ignoreCommand`, normal). Current prod tip = the jobid-215 migration commit.
- **FMV coverage (from precompute, cheap):** TS 52.8%, AllDay 24.5%, Candy 60.0%, Golazos 0.9%, Pinnacle 40.7%, UFC 0.0% (dead market). None at the 999 fail-sentinel. Slight TS/AllDay decline vs 08-13 (denominator growth + fmv-recalc saturation kills), not a new regression.

### Overnight deltas vs metrics-latest (2026-08-16 14:46Z)

- DB size **13074 -> 13114 MB** (+40, normal growth).
- Trust breaches **5 -> 3** (fmv_sweep_wedge + trust_precompute_max_age cleared).
- `fmv_sweep_stall_pct_24h` **44.9 -> 39.7**.
- Sentry new/regressed 48h: **0 real** (6 smoke-couldNotRun, saturation collateral).
- editions_est 27193 (stable). Security still fully clean.

---

## Cowork artifacts — 11, none flagged broken

The daytime monitor flagged none broken/stale; artifact data is fresh-on-open, so no repair/regeneration needed (per protocol, working artifacts are not regenerated).

---

## QUEUED — needs operator action or a code deploy (all blocked by NO-PUSH this run)

1. **candy-editions-ingest timeout (user-facing — Candy is live).** Missed the 08-16 daily tick (silent ~48h); the documented 300s-timeout-kill under saturation. Fix = `maxDuration` 300->800 on `/api/ingest/candy-editions` (code deploy). Already handed off: `docs/handoff-2026-08-04-candy-editions-timeout.md`. Editions change slowly so coverage is stale-not-degrading, but it has now missed 2 ticks — worth prioritizing since Candy is public.
2. **Pipeline SUCCESS-coverage monitoring gap** (filed `inbox 2026-08-17T0320Z`). The platform has cadence coverage and essentially no success coverage — a watchlisted pipeline can fail 100% for days with every arm green (`apply-fmv-haircut`, `match-topshot-players` did exactly this). Design = one arm over `pipeline_runs_daily`: watchlisted+active pipelines with trailing `ok_count=0` while `runs>0`. **Deliberately QUEUED, not shipped:** the intended artifact is a sentinel check (code = NO-PUSH-blocked), `warn` NOTIFIES hourly (needs a suppression story or it buys weeks of hourly noise on the known-broken `match-topshot-players`), and the `pipeline_runs_daily` 6-hourly-rollup staleness tradeoff is an operator judgement. Do NOT implement as `fail_count>0` (fires on the 32.6%-fail-but-working saturation pipelines). Operator/CC to choose threshold + severity.
3. **`sync-nba-projections` — 51/51 failing, all 3 upstreams 403, with an OCTOBER deadline** (filed `0320Z`). DraftKings/ESPN/scoreboard all 403 the `sports-proxy` worker's egress. Currently NIL impact (NBA offseason, no future games), but if unfixed before the 2026-27 season opens, Fast Break launches with no projections. Fix = Cloudflare `wrangler deploy` on `sports-proxy` (operator, unverifiable from here) + an offseason honest-skip edge-fn change (boot-fail trap). On no watchlist arm — pages nobody.
4. **`topshot-wmc-fossil-drain`** — both weekly runs (08-03, 08-10) timed out on `targets:` (the candidate-selection query is the expensive part), 0 rows, no run since. Needs its `targets` query profiled + bounded (QUEUE, not blind-fixed).
5. **`ownership-sync-dune` — HTTP 402, Dune credits exhausted.** Degraded honestly (served 114k rows from stale cache). Ownership index stops refreshing until credits reset / plan changes. Operator/billing.
6. **`backfill-historical-pack-ev` is STARVED, not saturated** (filed `0225Z`). Chases a 12h internal freshness window against a 48h breach arm; delivers ~30% of its target for 5,224 worker-s/day. The cadence lever (used on jobid 215) would make it WORSE. Relaxing a monitored freshness window is a data-quality decision — Trevor's call. Board is fresh enough today (21.8h vs 48h breach).
7. **`compute-pinnacle-pack-ev` ON CONFLICT fix** (`bd53bb3a`) — already deployed 08-15T20:27Z (version 22), green since. **No action needed** — recorded so it is not re-queued.

## STANDING ESCALATION (operator)

- **git PUSH is dead** (mounted `remote.origin.pushurl` has no credential). This blocks ALL overnight code commits/deploys and inbox archival. The 9-night `/sessions` shell outage is now CLOSED, ⚠ **CORRECTED 2026-08-17 — the fix named here ("re-embed a valid PAT in the mounted repo's pushurl") is WRONG TWICE OVER; do not do it.** (1) **A credential cannot help a CLOUD session.** Since 2026-08-11 the git proxy 403s at the *repository-authorization* layer — it refuses to inject a credential because the repo is not in the session's authorized set, and it does so **before any credential is evaluated**. This was probed directly: an embedded `x-access-token:<PAT>@github.com` PAT returns the **identical** 403. Upstream `anthropics/claude-code#76248`, still open. (2) **Re-embedding a PAT would revert a deliberate security fix.** The token was removed from `remote.origin.pushurl` on 2026-08-16 because merely *reading* it (`git config --get remote.origin.pushurl`, `git remote -v`) prints a live `github_pat_…` into the transcript — it burned a real PAT. The replacement, `gh auth setup-git`, also carries `workflow` scope the embedded PAT lacked. Verified on Trevor's box 2026-08-17: **pushurl ABSENT, `credential.helper = manager`, gh 2.90.0** — and push works fine there. **The real routes are: (a) `/web-setup` in a REAL TERMINAL `claude` session** (a built-in CLI command — it does NOT fire in a VSCode-extension session, it arrives as plain text — which syncs the local gh token so a cloud session is authorized **at creation**); **(b) create the session with the repo as its source** (`claude --cloud` from inside the repo, or claude.ai/code with `rip-packs-city` selected — sessions from the desktop Cowork project picker are NOT authorized, and this is **not addable mid-session**); **(c) run the night pass on the computer** (desktop → "Run this task"), where push works through the gh helper; **(d) ship a `git format-patch`**, which needs nothing from Anthropic and is proven end-to-end. Until one of those, night passes are DB + artifact only.
- **Inbox archival deferred** — ~35 consumed inbox files (Aug 9-14) remain un-archived because archival is a git push op. ⛔ **DO NOT ARCHIVE THEM — measured 2026-08-17 and the action is HARMFUL, not merely deferred.** Those files are cited by **exact path** from `CLAUDE.md` (4), `docs/overnight/ledger.md` (many), ~12 handoffs, the roadmap, `docs/sessions/2026-08.md`, **four committed `supabase/migrations/*.sql` files**, and **`lib/analytics/rpc-with-retry.ts:268`** (live product source). A `git mv` breaks every one of them, and a migration is immutable history that must not be edited to chase a moved path. It has already bitten: `inbox/archive/2026-08-10T0515Z-…md` cites `inbox/2026-08-09T1941Z.md` — an already-archived file pointing at a still-live inbox path. **The archival convention and the citation practice are in conflict and the citations win: treat `inbox/` as append-only.** Recorded in `docs/overnight/focus.md`.

## Repo-hygiene note (benign, no action)

- `supabase/migrations/20260816153000_...freshness_companion_view.sql` is committed and its header correctly says APPLIED; the migration IS live but registered under version `20260816173845` (apply_migration auto-timestamps). Cosmetic version mismatch only; `v_rpc_trust_health_freshness` is live and healthy (19 rows).

## Outputs (mount, UNPUSHED)

- `docs/handoff-2026-08-17-overnight-pass.md` (this file)
- `docs/overnight/metrics-latest.json` (overwritten with tonight's metrics)
- Ledger NOT spliced — nothing shipped needs a revert-path entry, and splicing against an origin advanced ~20 commits by concurrent CC is the documented destroyed-revert-path hazard. Deferred to push restoration.
