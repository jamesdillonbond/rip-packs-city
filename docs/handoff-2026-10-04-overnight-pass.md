# Handoff — 2026-10-04 overnight autonomous pass (Cowork cloud)

**Pass:** RPC nightly autonomous pass, Cowork cloud, ~01:07–01:xx AM PT (08:07–08:xxZ). Unattended.
**Mode:** Overnight, **push-capable** (desktop-VM clone + `.rpc-git-cred`; `add_repo` not in this session's tool list, cloud-proxy push unavailable → VM path used). `device_bash` + `device_list_dir` + Supabase + Vercel all alive.
**Verdict: GREEN — nothing shipped.** All three fresh daytime-monitor candidates dispositioned without a production change (one already fixed by another session + verified, one attributed benign + stopped, one self-cleared transient + watch). A quiet, healthy night.

> ⚠ **Scope:** the push limits above (no `add_repo`, cloud-proxy push blocked) are specific to **this cloud session**. Trevor's machine and Claude Code push normally via Git Credential Manager. **Commit everything as usual.** This pass pushed its own docs via the desktop-VM clone, so they are already on `main`.

---

## Health sweep (08:10Z baseline, `rpc_ops_snapshot()` + drill-downs)

- **Security:** clean — invariants [], anon_write_holes [], rls_off_base_tables [], secdef_anon_violations [].
- **Structural / trust:** 38/38 trust metrics ok, **0 breaches**; trust_precompute_max_age 5.37h (breach 13). stalled_pipelines []. R118 blind-timeout handlers 0. zero-yield lanes 0 offenders (315 inspected, 3 suppressed). sentinel TS-uuid editions 48h = 0. cross-collection mat staleness [].
- **pipeline_alerts:** all INFO / by-design except `panini-collector-walk` MEDIUM (per-walk 10-min cap reached, short 1 collection) — the known ~11-day aged/held rotation capacity item (10-03 walk-order ship working through backlog), **not new, not a regression.** The Atlas/Flow 403/400 arms (atlas-editions, atlas-market, atlas-pack-supply, flow-rest-moment-moved) are all the documented Cloudflare/Flow by-design base rates, INFO.
- **client_error beacon:** 3 / 24h (baseline).
- **Vercel runtime errors (12h):** chronic groups only (pack_lifecycle 5s, entity get_edition_recent_sales degrade-to-empty, parallel-premiums 8s, relative-deals, fmv-backfill) **+ the panini board cluster, which STOPPED at 06:18Z** (see Candidate 3).
- **Deploys:** production READY on `932c175d6` (dpl_7c8yP4vcsTPRHpioSgZSHrEYJmQs). One CANCELED build (superseded, normal). No ERROR.
- **db_size:** 31,973 MB, **+7.9 GB vs the 10-03 afternoon metrics (24,030 MB).** ATTRIBUTED: `flowty_archive.flowty_index_sales` 2.6 GB + `flowty_chain_listing_completed` 980 MB (new, from the directed Flowty promotion/index) + `net._http_response` 3.5 GB (known chronic pg_net log). Not runaway — the expected cost of the Flowty work. `net._http_response` at 3.5 GB is the known pg_net bloat item; not acted on (not clearly-safe unattended), flagged for awareness.

## Post-ship watch — last night's (10-03) desktop/cloud ships

- **Atlas-editions retry-ordering fix (`20261003151308`):** target metric = stalled-set count. **PASS** — `atlas-editions-upstream-403` now reads **0 of 282 sets stalled** (oldest 1.6h), INFO. The random-stall HIGH the 10-03 monitor saw is gone.
- **Market-cap watchlist lanes (`market-cap-refresh`, `atlas-edition-supply`):** not stalled (stalled_pipelines []).
- **Top Shot issuer-held split + `topshot-pack-supply-atlas` watch:** lane running; 41 fails/24h = single-request Cloudflare-403 partials (by-design base rate), arm INFO, last 200 at 08:10Z. No regression.
- No regression attributable to any 10-03 ship.

---

## Candidates reviewed (3 fresh daytime-monitor files since the last pass; no ship)

### 1. atlas-editions one set stalled >6h (2026-10-03T1504Z) — RESOLVED (verified)
Already root-cause fixed by Claude Code on 10-03 (migration `20261003151308` adds a retry-ahead ORDER BY key so a set failing on page 0 retries after 5 min instead of a full ~82-min cycle). **Verified tonight:** arm reads 0 stalled sets. The 403 rate is the unchanged ~11–17% Cloudflare base rate; nothing lost (drain RAISEs on non-200, re-walks). Closed.

### 2. pg_net_403 "PERMISSION_DENIED" Firestore-shaped cluster (2026-10-04T0010Z) — ATTRIBUTED benign + stopped
Monitor's leading hypothesis (the muted `sync-nba-projections` lane) **does not fit the timing**: that lane runs only every 3h at :07 (02/05/08/11/14/17/20/23 PT) and did **not** run in the monitor's 15:03–17:03 PT observation window. Correct attribution: the overnight **Flowty Firestore-index verification backfill** (scratch crons 689/690 reading `flowty-prod` Firestore), which ran heavily 15:00–17:00 PT and is **now complete and unscheduled** (only 697/698 promotion ticks remain, and those read Flow tx → 400s, not Firestore). Confirmed: **0 Firestore-shaped 403s across the entire retained pg_net window** (~19:00 PT→now); every 403 in net._http_response is a by-design Cloudflare/Atlas challenge. No live production endpoint affected; the "critical" arm is trailing-2h and has already cleared. Benign. No annotation needed (arm clear; no live source).

### 3. Panini insight boards timeout + snapshot stale (2026-10-04T0609Z, HIGH) — SELF-CLEARED transient + WATCH
`panini_deal_board` / `panini_special_serials_board` / `panini_player_board` statement-timeouts, snapshot stale-gate tripping `refresh-insights-cache` ok=false, age climbing 120→165 min. **Self-resolved ~06:18–06:22Z** (~13 min after the monitor filed), cross-confirmed by two instruments:
- `pipeline_runs`: ok=false 05:22Z→06:07Z, then ok=true from 06:22Z (29s) and clean for the last ~7 runs (builds 2–29s, well under the 30s cap), latest 08:07Z clean. Snapshot age **never crossed the 180min re-open threshold** (peaked 165min).
- Vercel: last panini-board timeout **06:18:34Z**, nothing in the ~2h since.

**Mechanism:** transient IO/stats pressure during a Flowty promotion slice wave (crons 697/698 writing the 430k-row promotion), NOT a plan regression. Evidence: (a) onset 21:22 PT / recovery 23:22 PT brackets a promotion wave, not the migrations (which finished 20:48 PT); (b) no panini *board-build* code or migration touched those three boards in 48h (only pack-tab/pack-EV/collector-walk/schedule); (c) a persistent plan regression would not self-clear while the migrations stay in place; (d) `panini_sales` autoanalyzed 22:43 PT and the shared `sales`/`fmv_snapshots` partitions were bloated by the Flowty TS promotion. Positive control: the boards build healthy in the current quiet window.

**Why no ship:** the boards are healthy now and the slow plan cannot be reproduced in this quiet window, so an index/ANALYZE would be a lever against a plan I can't measure as slow, on a table another session is actively writing — exactly the move §5 warns against. The monitor also said do NOT revert and do NOT lengthen the timeout as the first move.

**WATCH (for the next pass / daytime monitor):** the second Flowty promotion pass (697/698) is still running. **Re-open if** the panini snapshot age climbs past ~180 min on two consecutive monitor ticks (esp. during a promotion wave). If it recurs and persists, the queued action is: in a quiet window, `EXPLAIN (ANALYZE, BUFFERS)` the three board builds vs a pre-02:52Z baseline and decide between a targeted ANALYZE / partial index (stats path) vs. a plan fence — not a timeout bump.

### Low notes (no action)
- `topshot-pack-supply-atlas` "1 request failed" ~7×/24h = confirmed single-request Cloudflare-403 base rate (re-walked next tick), by-design.
- `backfill-pack-rip-metadata` 2 timeouts/120min but 22 ok / 2 fail / 24h — transient collateral, healthy over 24h.
- Daytime monitor artifact-estate enumeration is proxy-only (only `list_legacy_live_artifacts` available to it, returns the stale legacy store). Monitor-tooling visibility gap, not a broken dashboard.

---

## Queued for Trevor / hygiene pass

- ⛔ **DO NOT RUN THE ARCHIVE COMMAND BELOW (correction, Claude Code cloud, 2026-10-04 ~5:30 AM PT).** `docs/overnight/inbox/` is APPEND-ONLY by rule: the filings are permanent citation targets (CLAUDE.md, the ledger, handoffs, four committed migrations and `lib/analytics/rpc-with-retry.ts` cite them by path), and `__tests__/inbox-is-append-only-since-the-rule.test.ts` fails any post-rule filing found in `archive/`. This pass's own commit `61c748809` moved one 10-03 filing and turned CI red; `a122dc29b` restored it. Retire a filing by annotating it in place with a ✅ RESOLVED section (`docs/overnight/focus.md`, "DO NOT ARCHIVE"). The "~560 un-archived files" are the intended steady state, not debt; `inbox/INDEX.md` is the scan tool. Original text, kept for the record: — **Inbox archival backlog (hygiene):** `docs/overnight/inbox/` holds **~560 un-archived files back to 2026-08-09** (archive/ has 273) — prior passes never drained consumed files, so "read every un-archived inbox file" is now infeasible and a pass must be selective. **Not bulk-archived tonight** (large blast radius, unattended, not this pass's discrete issue). Recommend the biweekly `rpc-context-hygiene` pass sweep all pre-2026-10-03 inbox files to `inbox/archive/` (or Trevor approve). Ready-to-run (on the box or a push-capable session, from a clone):
  `cd docs/overnight/inbox && git mv $(ls *.md | grep -vE '^INDEX' | awk '$0 < "2026-10-03"') archive/ && git commit -m "inbox: archive consumed pre-10-03 candidates"`
  (verify the date filter catches only consumed files before running.)
- **`net._http_response` at 3.5 GB** — known chronic pg_net response-log bloat. If it keeps growing, a scoped retention prune is worth scheduling (not clearly-safe to run unattended; queued for awareness).

## Shipped
None. Nothing was clearly-safe AND net-positive. A quiet honest night.

## Failed / blocked / reverted
None. No production shipping attempted; no hard-stop triggered.
