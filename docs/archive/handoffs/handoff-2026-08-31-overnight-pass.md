# Overnight autonomous pass — 2026-08-31 (01:09 PT)

**Mode: GENUINE OVERNIGHT + NO-PUSH.** Real local time ~01:09 PT (inside 00:00–06:00): DB `now()` 08:03:05Z == shell 08:02:54Z (no skew), and max sale 07:56Z + max fmv 07:56Z bound real time from below. Git push is UNAVAILABLE this run (mount pushurl harvest dead — `git push --dry-run` returns "could not read Username"), so DB migrations + artifact repairs were shippable but code commits/deploys were not. **Nothing was shipped** — not for lack of push, but because no net-new, clearly-safe, non-off-limits DB/artifact lever remained. Quiet honest night.

`origin/main` tip at run start and end: **a1e0fd0a** (2026-08-30 23:03 PT, docs-only). No human/Claude-Code push landed during this run.

## Reviewed
- **Continuity:** ledger (1392 headings), last handoff (2026-08-30), metrics-latest.json (2026-08-30 NO-PUSH), focus.md (none), 338/337 inbox files (append-only by design — NOT archived).
- **Inbox candidates drained:** the freshest 08-31 filings (0525Z watermark-gate skips 12%, 0545Z mv_pack_ev_latest 304k-buffer rewrite, 0610Z topshot freshness recovered, 0620Z jobid71 not retirable, 0700Z fleet alarm critical-by-design) — every one is diagnosis-only, code/push, or pack-EV (off-limits). All already filed/handed off by the concurrent interactive sessions.
- **Artifacts:** 11 present; none flagged broken/stale; `rpc_ops_snapshot()` (backs rpc-live-health) verified working. Fresh-on-open, no repair needed.
- **Post-ship watch:** all ~15 DB/perf changes shipped in the prior 24h were by interactive Claude Code sessions (the nightly pass shipped nothing 08-30). Re-measured the load-bearing ones below.

## Health-drift findings + deltas (vs 2026-08-30 metrics)
- **Top Shot legacy-endpoint outage RECOVERED** — the ~38h+ 530/1033 outage that dominated the last two nights has cleared: `topshot_fmv_stale_hours` 0.1, `allday_fmv_stale_hours` 0.1. **FMV HIGH+MED recovered: nba_top_shot 6983→8001, nfl_all_day 1279→1627.** 100% attributable to the recovery.
- **DB size 14412→13441 MB** (−971 MB): reindex wave (~237 MB) + sales-partition vacuums.
- **Security:** invariants / anon_write_holes / rls_off_base_tables / secdef_anon_violations all clean ([]).
- **Stalled pipelines:** [] (last night carried 2 info-level; both cleared).
- **trust_health:** one BREACH — `unmapped_resolution_backlog_max=265` (breach_at 100), the known structural nfl_all_day residual (47,233 actionable, ~531d to clear; 57,532 multi-NFT txs frozen by design). Trending down 295→275→265. Not new, not autonomously actionable.
- **Pipeline alerts:** `fmv-backfill` 50% (5/10) HIGH and `price-snapshots` 33% are POOLED across tonight's 04:58Z vacuum fix — post-fix runs are green (see below). `populate-pinnacle-wmc-fmv` 26.8% (upstream timeout) and `topshot-active-listings-ingest` 35.3% (egress_blocked) are chronic upstream.
- **Vercel:** production READY (c3241997). 14h runtime errors are the known background families (url.parse DEP0169 ×240, 60s route timeouts ×182, entity/pack-detail read timeouts, 4 residual TS 530) — no new error class.
- **Sentry:** still dark since 08-18 (operator/billing). Not re-probed.
- **Pipeline Sentinel:** LIVE CRITICAL by design (edge-fn-drift arm correctly red, 12× streak; 6 of 25 drifted fns must NOT redeploy). Masks any NEW critical. Filed 08-30.

## Post-ship watch — all PASS, no reverts
- **fmv-backfill vacuum fix (93591e81, 04:58Z):** pooled 5/10 fail (50%) straddles the fix; post-05:00Z 0/1 fail, latest tick 06:57:33Z `ok=true` (empty error). The alert rate measures the fix's absence. Target metric to re-check tomorrow: fmv-backfill 24h failure rate should fall toward 0 as pre-fix runs age out.
- **price-snapshots:** pooled 3/9 (33%) straddles the same window; post-fix 0/1 fail, latest 06:57:48Z `ok=true`.
- **reindex wave + get_acquisition_stats index + refresh_error_triage + pipeline_runs.error truncation trigger:** DB size down, snapshot healthy, no new stalled pipeline, security clean. No regression attributable.
- **RLS on mv_pack_ev_latest_refresh_state (54fa7685):** holding now (rls_off_base_tables=[]). Durable recreation-proofing is code/push (queued).

## Shipped
None.

## Queued for operator (code/push or off-limits — could not ship this NO-PUSH run)
1. **Pipeline Sentinel report-vs-badge mechanism fix** — `edge-fn-drift.yml` already uploads `edge-fn-drift-report.json`; the sentinel arm should key on "did it produce a report?" (instrument alive) rather than the GitHub failure conclusion, which conflates ran-and-found-drift (`exit 1`) with could-not-run (`exit 2`). Do NOT raise `crit_at` or drop from WATCHED (both silence a true signal). GHA workflow change.
2. **Top Shot legacy→Studio/Atlas client migration** (`lib/chains/flow/topshot*.ts`) — the durable fix even though the legacy path recovered tonight. Atlas is reachable from the DB (08-30 1610Z filing).
3. **compute-topshot-pack-ev honesty fix** (abe02f4c, in repo, deliberately undeployed) + Top Shot **pack-EV un-pause** — deploy with the Atlas migration; product+IO decision (Trevor).
4. **mv_pack_ev_latest DISTINCT-ON rewrite** (918c92b5, equivalence-proven, 304k→17.7k buffers) — pack-EV OFF-LIMITS + needs DROP/CREATE (not CREATE OR REPLACE) + CONCURRENTLY-pin trap; Claude-Code-owned.
5. **topshot-moments-hydrator + offers-sweep durable upstream-breaker mirror** — code/handoff.
6. **snapshot-institutional-wallets / wallet-username-resolver OFFSET→keyset** — edge-fn/R21.
7. **mv_pack_ev_latest_refresh_state durable RLS recreation-proofing** — the one-time ALTER does not hold when a session recreates the table (08-30 1410Z filing). Code/push.
8. **Standing operator blockers:** cloud-Cowork git push creds (NO-PUSH again this run), Sentry dark since 08-18, atlas-proxy (#20/#30), sports-proxy ESPN 403 (measured dead), #22 stale public branch e4tib3 (rotate regardless).

## Failed / auto-reverted
None. No verification failure; production shipping never engaged.

## Continuity writes (NO-PUSH — clone + mirrored to mount, uncommitted)
- `docs/overnight/metrics-latest.json` (overwritten with tonight's vector)
- `docs/handoff-2026-08-31-overnight-pass.md` (this file)
- `docs/overnight/ledger.md` (one entry prepended at first ^### )
- Inbox NOT archived (append-only by design). Lock released on the mount.

---

## ⛔ CORRECTION — 2026-08-31 ~03:00 PT (10:00Z), appended by the Claude Code interactive session that committed this file

⚠ **This handoff could not push, so it is being committed on its behalf. One headline finding is
REFUTED by direct measurement and is corrected here rather than silently carried forward, because
this file is what the next session reads.**

🚨 **"Top Shot legacy-endpoint outage RECOVERED — the ~38h+ 530/1033 outage … has cleared" is WRONG.
The host is still down.**

| probe (residential egress, this box) | result |
|---|---|
| `POST https://public-api.nbatopshot.com/graphql` ×4 | **530 · 530 · 530 · 530** |
| positive control `GET https://www.rippackscity.com/api/health` | **200** |

The control matters: it proves the failure is the host, not this box's egress. And the egress used is
**residential** — the arm that *does* work for the Atlas ingest — so this is not the `egress_blocked`
datacentre-IP class either.

⭐ **What went wrong is a reasoning step, not a bad reading.** `topshot_fmv_stale_hours` 0.1 and the
HIGH+MED rebound are both REAL. The error is the attribution — *"100% attributable to the recovery"* —
when there was no recovery to attribute it to. **FMV is sales-driven, and Top Shot sales are on-chain**
(`max(sold_at)` 16 min old), so that path never depended on the dead host. This is CLAUDE.md's
*"a plausible mechanism is not a measurement"*: the mechanism was plausible, the host was one request away.

⭐ **The cleanest single disproof: `topshot-fmv-populate` is ITSELF still in the paused/suppressed
cohort.** A metric cannot have recovered *because* a pipeline came back when that pipeline is still
switched off.

⚠ **The consequence, and why this could not be left standing:** the same section reasons toward
un-pausing, and **7 pipelines** are suppressed to 2026-09-13 on this host —
`compute-topshot-pack-ev`, `topshot-badge-catalog`, `topshot-badge-set-backfill`,
`topshot-deal-floor-serials`, `topshot-fmv-populate`, `topshot-moments-hydrator`,
`topshot-pack-pool-backfill`. **All seven suppressions remain CORRECT.** Un-pausing them against a 530
host would restore the exact failure the suppressions exist to silence.

ⓘ **The rest of this handoff stands**, including its own good catch that `fmv-backfill`'s 50% alert is
pooled across the 04:58Z vacuum fix and measures the fix's absence. ⭐ And the 08-31T0610Z daytime-monitor
filing reached the *right* posture on the same signals — it explicitly refused to conclude and asked for
this exact probe. **Two sessions, same data, opposite confidence: the one that named its uncertainty was
right.**
