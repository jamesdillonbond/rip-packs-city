> # ⛔ SUPERSEDED 2026-08-09 — all items below are CLOSED or CORRECTED. Read this banner first.
>
> Claude Code shipped 6 commits off this handoff; tree clean, in sync with `origin/main`, CI green.
>
> **⚠ MY NO-PUSH BANNER WAS OVER-BROAD AND COST ~18 HOURS.** The 403 below is specific to the
> **cloud Cowork session**. Trevor's box carries the PAT in `remote.origin.pushurl` and pushes
> normally — the two migration files sat uncommitted for ~18h purely because this document did not
> say so. **Any environment limitation must be scoped to the environment that hit it, in the same
> breath.** The operator ask (add the repo to the session's sources) still stands and is real.
>
> **Shipped against this doc:** `ac36cc5a` migrations committed · `18d40be7` pack/dist 500s killed
> (`v_allday_pack_info` cost 1,195,280 → 7.54, 0-row `EXCEPT` diff across 3,052 dists; live 36–883 ms)
> · `9f93a221`+`f3def4a4` boards now banner "3 of 10 sections could not be loaded… not an empty
> result" instead of rendering a timeout as `[]` · `51ccfab2` daily `migration-parity` monitor
> (first run: 114 prod migrations in 14d with no committed file).
>
> **Three claims in this doc are WRONG — do not act on them:**
> 1. **"panini-squeeze does not appear in any failure log."** False. I sampled **90 minutes** and
>    asserted over 24h. It fails repeatedly, and via the worse shape: a **page-3** failure renders
>    the top ~1,800 rows *as the whole ranking* — a fabricated ranking, not a blank section.
> 2. **"`where metric in (…)` returns instantly, so single arms are cheap."** Measured on two cheap
>    arms, **warm**. The same 10 arms are **19,002 ms cold vs 80 ms warm** — chunking would NOT fix
>    the `/api/sentinel` 504s. Idea measured and discarded.
> 3. **`/api/market` framed as a caching/scoping item.** Profiled at 14 s cold / 9.8 s warm with an
>    already index-optimal plan. **The lever is precompute, not query tuning.** Queued with numbers.
>
> **Also deliberately not done, correctly:** the build-fragility fix — its target (`loadSet`,
> `generateStaticParams`) is *already* fail-soft try/catch, so implementing it would close the
> ticket without fixing anything. Queued with the real build log instead.

# Handoff — 2026-08-09 daytime pass (~07:50–08:30 PT), continuation of the overnight run

**Session envelope, and it differs from last night's in an important way.**

| capability | state |
|---|---|
| `bash` / git clone / node | ✅ **GREEN** (cloud sandbox, 30 GB free — not the 08-08/08-09 `useradd` no-space failure) |
| `git push` | ❌ **BLOCKED — different cause than last night** |
| Supabase MCP (read + `apply_migration`) | ✅ green |
| Vercel MCP (runtime logs) | ✅ green |
| Sentry MCP | ✅ green |
| device bridge — file API (`device_list_dir` / `stage` / `commit`) | ✅ green |
| device bridge — `device_bash` | ❌ down (failed 1/1; not retried per the standing rule) |

⚠ **The NO-PUSH cause has changed and the fix is different.** Last night it was sandbox
provisioning (`useradd … /sessions no space left on device`) — the `sessiondata.vhdx` class.
Tonight bash provisioned fine and the clone worked; the push failed at the **credential proxy**:

```
remote: access denied by the git proxy: jamesdillonbond/rip-packs-city is not in this
session's authorized repository set, so the proxy will not inject a credential for it.
To fix, add the repository to the session's sources.
fatal: unable to access '.../rip-packs-city.git/': error 403
```

This is the *push-cred injection* failure mode, orthogonal to bash health (already recorded:
"bash-green ≠ push-green"). Note the repo **is** synced as a claude.ai Project source, and the
proxy still does not count it. The desktop workaround (ride the mount clone's tokenized
`remote.origin.pushurl`) is **not available from a cloud session** — the cloud container and the
device are separate filesystems and `device_bash` is down, so the token cannot be wired across
without reading it, which is not something I do. **Operator action:** add the repo to this
session type's authorized sources, or run the pass on-device.

---

## SHIPPED — 2 DB migrations, both applied to prod and verified

Both need their repo record committed (files supplied alongside this doc).

### 1. `20260809145547_audit_20260809_retire_ufc_pct_stale_arm_add_precompute_freshness_arm`

Two changes to `v_rpc_trust_health`, net arm count unchanged at **38**.

**(a) Retired `ufc_fmv_pct_stale_30d`** — the dated fuse. It reads 96.1 against breach 99.5 and
was scheduled to hit 100.0 on **2026-09-03 06:31:44Z**, where a percentage cannot exceed 100 so
no threshold remedy exists. It would have become a permanent red, and a permanent red trains you
to skim past all 38 arms. UFC revival is already covered by `ufc_flow_revival_sales_30d`.

⚠ **Corrects the 08-08 finding's "this is a TWO-part change" claim.** It is one part. The metric
is a single row of the `want` VALUES list LEFT JOINed to an aggregate legs 2–5 compute anyway, so
its marginal cost is **zero** — there was no saturation saving to bank by stripping it out of a
13 KB load-bearing plpgsql function mid-contention. It is now TRACK-only, like the five existing
`{coll}_fmv_high_med_share_pct` metrics, and it **must keep refreshing** (see below).

**(b) Added `trust_precompute_max_age_hours`, breach_at 13** — because of a live failure nobody
was watching:

> `rpc-trust-health-precompute-refresh` (jobid 222, `58 */6 * * *`) **failed at 12:58Z after
> exactly 600.001 s**, its own proconfig `statement_timeout`. The function is single-transaction
> and Leg 7 has no exception handler, so the kill **rolled back all 18 metrics** — at 14:50Z the
> table still held 06:58Z values, 7.97 h stale. Run times swing wildly with contention: **59 s
> and 71 s** on the two quiet ticks, **536 s and 569 s** on the 08-08 contended ticks, then 600 s+.

The failure was invisible: the board only notices at the `pre` CTE's 24 h cutoff, which maps
every stored row to 999 and reddens ~13 unrelated precomputed arms at once — presenting a dead
refresher as a platform-wide collapse. breach_at **13** fires on two missed cycles (~18.2 h) but
not one (~12.2 h), ahead of the 24 h cliff. It reads max(age) over **all** rows, which is why the
retired UFC metric must keep being written.

**Verified after:** 38 arms · UFC arm anchor absent · revival arm intact · `{security_invoker=on}`
re-asserted · `anon` SELECT false · `check_public_security_invariants()` = 0 · new arm read live
through the view at **7.97 / 13 / ok**.

💡 **Reusable discovery:** `select … from v_rpc_trust_health where metric in (…)` returns
**instantly**. Postgres prunes the UNION ALL branches on the constant predicate. The recorded
"the board cannot be SELECTed inside 60 s" is true only of the *whole* board — individual arms
have always been cheaply readable, which makes per-arm verification possible from Cowork.

### 2. `20260809145945_audit_20260809_halve_cadence_four_wasteful_hourly_mv_refreshes`

Hourly → `*/2` on jobids **235** (market-index), **236** (perfect-mint-premiums), **237**
(pack-reality-dist), **240** (pack-reality-stats).

Measured over 24 h of `cron.job_run_details` (worker-seconds = wall time squatting a pg_cron
worker slot):

| job | runs | worker_s | wasted_s on failures | ok/24 | avg ok |
|---|---|---|---|---|---|
| `rpc-refresh-market-index-daily` | 24 | 5,268 | 2,407 | 20 | 143 s |
| `rpc-refresh-perfect-mint-premiums` | 24 | 4,896 | 2,576 | 20 | 116 s |
| `rpc-refresh-pack-reality-dist` | 24 | 2,857 | 600 | 23 | 98 s |
| `rpc-refresh-pack-reality-stats` | 24 | 2,923 | 618 | 22 | 105 s |
| | | **15,944** | **6,201** | | |

A *successful* refresh costs 98–143 s; a contended one dies at the 600 s ceiling having written
nothing. ~**6,200 worker-s/day (1.7 h)** produced nothing — and that is also the mechanism behind
the `job startup timeout` class (9 distinct jobs in 24 h, overwhelmingly the uninstrumented
tier-B backfills): a doomed run holds a worker slot for ten minutes and pg_cron then cannot start
anything else.

**This is the ledger's own "safe" row, not a fresh guess.** The 08-08 entry tabulated jobid 236's
options against its 16.7 % failure rate and the breach-at-8 gate: hourly = safe but wasteful;
**every 2 h = SAFE, ~50 % saved**; every 3 h = marginal; every 6 h = unsafe. The later
"cadence-cutting stays unsafe" line refers to the 6 h→12 h row. Three consecutive failures at
2-hourly reach the 8 h edge — p ≈ 0.46 %/cycle, inside the tolerance that table called marginal
at 2.8 %. **This closes the "2h-cadence lever is still open — do not close it" item** from
`inbox/2026-08-08T1945Z.md`.

**Verified the gate rather than assuming it:** `board_mv_refresh_max_stale_hours()` returns
max(hours since last SUCCEEDED run of any active cron whose *command text* contains the matview
name) and **ignores the watchlist's own `max_stale_hours` column, which has no consumer anywhere**.
Command text therefore left byte-identical — editing it would have silently blinded the watchdog.
Post-ship the arm reads **0.82 h / breach 8**.

**Not touched, deliberately:** `rpc-refresh-pack-reality-top-ev` is a similar over-refresh but has
24/24 successes and its arm reads `topshot_pack_reality_top_ev`, not obviously the same object as
`mv_topshot_pack_reality_top_ev`. Small win, unresolved conflation risk.

**Still the bigger lever, not shipped:** split the 180-day `ed_med` median into its own
daily/6-hourly MV and have the perfect-mint board join it — removes work instead of doing it less
often, output-equivalent by construction (both final joins are INNER).

---

## 🔴 FOR CLAUDE CODE — the #1 item, and it inverts what the monitors say

**The `/insights/*` pages return HTTP 200 while every query behind them times out.** Production
runtime logs, 2026-08-09 14:41Z saturation burst:

```
14:41:14 GET /insights/candy-mlb   200  cache=STALE
    [candy-mlb] candy_scarcity_board error: canceling statement due to statement timeout
    [candy-mlb] pack-ev error: canceling statement due to statement timeout
    [candy-mlb] candy_player_board error: canceling statement due to statement timeout
    [candy-mlb] candy_parallel_premium error: canceling statement due to statement timeout
    [candy-mlb] pack-market error: canceling statement due to statement timeout
14:41:12 GET /insights/rookies     200  cache=STALE
    [insights/rookies] stats  canceling statement due to statement timeout
    [insights/rookies] index  canceling statement due to statement timeout
14:41:08 GET /insights/deals       200  cache=STALE
    [insights/deals] initial fetch canceling statement due to statement timeout
14:41:11 GET /api/public/insights/deals  500   57014 statement timeout
```

Five of five Candy queries dead, page serves **200**. This is triply invisible:

1. **The 5xx metrics cannot see it** — it is a 200.
2. **The board-liveness probe cannot see it** — `public_board_slow_count` and
   `public_board_empty_count` both read **0**, and every active board sits inside its own
   `max_ms`. The probe measures `SELECT count(*) FROM <view>`, which the planner prunes; the
   real page queries are a different animal. This is the 08-06 "understates by up to 8,300×"
   finding **confirmed in production for the first time**.
3. **Users see a stale board with no error state** — the roadmap amendment's "a timeout must not
   render as a number", live.

⚠ **I nearly filed the opposite conclusion.** Reading only the probe, I had written "nothing is
breaching, the caching item is a margin fix." The probe is blind; the Vercel logs are the truth.
Distrust the instrument before the system.

**Scope correction to the 08-09 digest:** the digest named *candy-mlb, panini-squeeze, deals,
rookies, first-mint*. Evidence says **candy-mlb (5 queries), deals (page + a hard-500 API), and
rookies (2 queries)** are the real set. `panini_squeeze_board` is 475 ms (16 % of budget) and
rookies' board probe is 235 ms — **panini-squeeze and first-mint do not appear in any failure log**
and should not be in scope. Worst by share-of-budget is `topshot_first_mint_trophy_stats` at
4,311/5,400 ms (80 %) for a **single row**, but it is not failing.

### Second public-page defect, currently unnamed anywhere

`/[collection]/pack/dist/[distId]` — **81 hard 5xx in 24 h, 15 in the last 4 h, ongoing.**

```
14:41:27 GET /nfl-all-day/pack/dist/5674  500
    [pack-detail] bundle error canceling statement due to statement timeout
    [pack-detail] allday_corrected_ev error canceling statement due to statement timeout
    Error: pack detail bundle unavailable: … digest: '3015417561'
```

This is the top *public page* 5xx source and it fails hard (no stale-cache mask). Worth fixing
before the insights caching, since it is a visible error rather than a quiet staleness.

### Third: `/api/market` is the single worst timeout route — **51 × 504 in 24 h**

Full 24 h picture: ~33 k requests, 232 × 500 + 144 × 504 + 109 × 502 ≈ **1.5 % 5xx**. Top 504
routes: `/api/market` 51, `/api/cron/stale-fmv-monitor` 20, `/api/wallet-backfill-allday` 19,
`/api/cron/warm` 16, `/[collection]/edition/[slug]` 7.

### Closes a recorded open question

`/api/sentinel` logged **2 × 504**. The trust-board memory said "Not verified: that any consumer
actually fails … treat as a real risk, not a proven outage." **Now verified** — the external
consumer does time out. The "extend the `pre` precompute pattern to the remaining 25 live arms"
item is no longer speculative.

---

## Checked and found clean (so nobody re-opens them)

- **Security:** `check_public_security_invariants()` = 0; anon SELECT on the trust view false.
- **Sentry:** 0 new issues in 24 h.
- **Board-liveness coverage gap — investigated, NOT a hole.** `public_board_liveness_state` has two
  rows last probed 2026-08-02 (`candy_deals_board`, `topshot_underpriced_serials_board`). Both are
  `is_active = false` in the watchlist — deliberately deactivated, and the metrics are computed
  from the probe's return values, not from the state table. The stale rows are residue (the table
  upserts and never deletes), not a monitoring blind spot.
- **Inbox items 08-08 1443Z / 1511Z / 1717Z / 1945Z / 2350Z** read this pass. `2350Z-allday-lock-refresh`
  and `1945Z` both carry SUPERSEDED/PARTIALLY-DRAINED banners and needed no action; 1443Z
  (`mv_topshot_misattrib_candidates` 46.8 h stale, `fmv_thin_sale_ask_disclosure_cache` 29.1 h
  stale) and 1717Z remain queued as written.

## Could not do

- **Inbox archival — still blocked, and it is not a shell-availability problem alone.**
  `device_bash` is down, and the file API cannot move or delete. Copy-to-archive without removing
  the original would make the next pass re-drain the same files, which is worse than leaving them.
  10 files remain in `docs/overnight/inbox/`. ⓘ Note `2026-08-07T2108Z.md` and `2026-08-08T0306Z.md`
  exist in both inbox (508 / 569 bytes) and archive (4,910 / 4,664 bytes) — **the inbox copies are
  truncated stubs**, consistent with the known mount big-doc-edit truncation. The archive holds the
  good copies.
- **Any code change**, per the push blocker above.

## Repo records to commit

```
supabase/migrations/20260809145547_audit_20260809_retire_ufc_pct_stale_arm_add_precompute_freshness_arm.sql
supabase/migrations/20260809145945_audit_20260809_halve_cadence_four_wasteful_hourly_mv_refreshes.sql
```

Both are already applied to prod; committing them only closes the drift window. Revert paths are
in each file's header.
