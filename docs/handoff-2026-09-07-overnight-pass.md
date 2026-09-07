# Overnight pass handoff — 2026-09-07 (Cowork cloud, NO-PUSH)

> ⚠ **Scope of the push blocker:** this is specific to **this cloud session** — the cloud sandbox has no GitHub credential, so `git push --dry-run` returns *"could not read Username for github.com"*. Trevor's machine and Claude Code push normally via the PAT in `remote.origin.pushurl`. **These handoff/ledger/metrics files are written to the mounted tree (Trevor's disk); commit them as usual.** DB reads were the only production touch this run — **nothing was shipped**, so there is no prod/repo drift to reconcile.

Real time at open: DB `now()` = 2026-09-07 08:03Z = **01:03 PT** (inside the overnight window; shell clock agreed, no skew). Lock taken over from a ~24 h-stale 09-06 lock that was never released.

## Verdict

**Quiet, honest night. Health green. Nothing clean and additive surfaced to ship.** The three fresh inbox/monitor candidates are all closed-by-verification or QUEUE (route code / product call / no-push). The one candidate that was a real defect — the `allday-lock-refresh` false-alarm — had already been fixed by another session before this pass ran.

## Health sweep (`rpc_ops_snapshot`, 08:05Z)

- **Security:** all four invariant arrays `[]` (invariants / anon_write_holes / rls_off_base / secdef_anon). Clean.
- **trust_health_breaches: `[]`** — the two breaches the 09-06T15:10Z daytime monitor reported have both cleared: `unmapped_resolution_backlog_max` drained 119 → **2** (breach_at 100), `public_board_slow_count` 1 → **0**.
- **stalled_pipelines: `[]`.**
- **Public 5xx (Vercel, 24 h): ~19 total**, none on a public board — `/api/collection-stats` 11, `/api/collection-moments` 4, `packs/summary` 2, `liquidity-distribution` 1, `admin/recover` 1.
- **TS FMV HIGH+MED = 7,636 / 20,441 = 37.4 %** (go-live bar 50 %); `topshot_fmv_pct_stale_30d` 30.6 (ok). Editions: TS 20,612 · NFL 6,190 · UFC 518 · Golazos 575 · Candy MLB 125.
- **DB size 18,191 MB.**
- `pipeline_alerts`: all `info` and all previously attributed (golazos resolving-editions; nfl unmapped backlog 41,303 actionable, 47.8 d to clear at the 7 d net rate; atlas editions 403 4.2 % and market-feed 403 4.6 %, both Cloudflare challenge, no rows lost, escalate only on freshness).

## Post-ship watch — 09-06 ships, all holding

| Ship (09-06) | Watch | Reading now | Verdict |
|---|---|---|---|
| `atlas_edition_verify_dispatch` opt (`20260907024130`, was scanning the requests table 13,884×/tick, 3.4 s → 0.6 s) | `ts-listings-atlas-sync` `extra.duration_ms` not creeping back | 622–1,709 ms across last 6 ticks, all ok | ✅ holding |
| `hydrate_topshot_moments_from_wmc` (`20260907051909`) | ok 3×/h, ~1–1.8K rows/tick until queue drained | ok, 1,043–1,506 rows/tick, `wrapped:false` (still draining ~50K), 5–13 s | ✅ draining as designed |
| `refresh_wmc_fmv_changed` #36 closed | no regression | 1 minor fail/24h, no wedge | ✅ |

## Fresh candidates — dispositions

### 1. `allday-lock-refresh` trypdub false-alarm — ALREADY RESOLVED (close on record)
Daytime monitor (09-06T15:10Z) flagged every hourly run since 09-05 05:23Z as `ok=false` because one wallet (`trypdub`) throws Flow-1052, while 20–33K rows still landed — the overloaded-`ok=false` shape.
**Verified fixed by another session:** last `ok=false` was 09-06 **16:23Z**; **every run since 17:23Z is `ok=true`** with the trypdub Flow-400 error recorded in `error` and rows_written normal (23,456–28,468). This is exactly the daytime monitor's suggested option (a) — per-wallet failure made non-fatal, error logged. The snapshot's "9 fails/24h" is the pre-17:23Z tail decaying out. **No action; closed.**

### 2. `/api/best-offers` `break`s on a failed chunk read (inbox 09-07T0200Z) — QUEUE, low priority
The route abandons all remaining `.in()` chunks on one PostgREST error and a missing offer renders as a dash indistinguishable from "no bid" (read-failed / genuinely-empty collapse). The filing's own disposition is **measure first**.
**Measured:** the warn `[best-offers] marketplace_offers error` fired **0× in a 24 h Vercel sample** — the chunk-error path is cold. Recommend confirming zero over a full week and then **closing**, rather than shipping a client-visible "unchecked" third state for a defect that fires never. If it becomes non-zero: `continue` not `break`, return `degraded.dapperOffers`, and give the grid a third rendering — never the route half alone (route code, no-push).

### 3. UFC + 3 collections soft-404 tabs, ~19 anon-public (inbox 09-07T0330Z) — QUEUE, product call
`proxy.ts`'s feature-tab regex makes ten tab URLs anon-public per collection, but most collections ship fewer tabs; the missing ones render `FeatureTabGate` (a 200 "not available" body = soft-404) on crawlable URLs. **None is in the sitemap.** Fix is a product decision (redirect to overview vs `notFound()` on the gate — the layout-`notFound()` pattern this repo already proved for entity routes) and touches `proxy.ts` (**off-limits**). **Measure Search Console's Soft-404 / Crawled-not-indexed buckets before spending.**

### 4. `sync-nba-projections` dry ≥72 h (`all_upstreams_failed`) — QUEUE / watch
24 of 24 runs failed and **0 rows written in the full 72 h retention window**, `all_upstreams_failed` every 3 h tick. Mis-bucketed as `upstream=0` in the snapshot's fail count, but it is an external-feed outage. **Most likely the NBA offseason** (season opens ~late Oct) — the projection provider has nothing to serve. Trevor to confirm the feed is expected-empty vs genuinely broken. Route code, no-push. Low priority; not a user-facing FMV surface.

## Ops note — inbox archival backlog
`docs/overnight/inbox/` holds **405 un-archived files back to 2026-08-09**. Archival is a `git mv` that needs a push to persist to origin, and cloud nightly runs can't push — so it never lands. **A desktop / push-capable run should sweep the consumed set into `inbox/archive/`.** `INDEX.md` CI assertions are intact; leaving the files in place is inert, just noisy.

## Shipped / failed / reverted
- **Shipped:** none.
- **Failed / reverted:** none. No production changes were made.

## Output written (mount-only this run, unpushed — mirror when a push run next syncs)
- this handoff · `docs/overnight/ledger.md` top entry · `docs/overnight/metrics-latest.json` · `docs/sessions/2026-09.md` top entry.
