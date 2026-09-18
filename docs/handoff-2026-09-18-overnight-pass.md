# RPC overnight pass — handoff 2026-09-18 (~07:5x PT / 14:5xZ)

> 📌 **STATUS 2026-09-18 ~08:25 AM PT (Claude Code, desktop): the event below is STILL LIVE, and its CAUSE BRANCH is now settled — it is PLATFORM-SIDE.** At 08:04–08:05 PT MCP `select 1` was still refused and `/api/public/insights/` `squeeze` · `rookies` · `offer-spread` returned **500 · 503 · 500**.
>
> ⭐ **The positive control this handoff says it could not take has a substitute that needs no DB connection.** `/auth/v1/health` and `/auth/v1/settings` **also return Cloudflare 522 after ~19.6 s** — GoTrue does not read our tables and holds its own pool, so it **cannot** be starved by `fmv-recalc` or a wallet-backfill wave. Controls both ways: the edge answers `/rest/v1/` **401 in 195–335 ms**; `api.github.com` → **200**. And the `<!DOCTYPE html>` this handoff flags in §3 is identified — it is Cloudflare's own page, `<title>supabase.co | 522: Connection timed out</title>`.
>
> ⛔ **So this handoff's "first suspect" — connection-pool/IO saturation from our own pipeline fan-out on the SMALL tier — is NOT SUPPORTED for this event.** Do not throttle pipelines, re-tune `fmv-recalc`, or chase the wallet-backfill back-pressure gap on account of it. ⚠ **Not asserted:** Supabase's internal root cause; and nothing here says this estate's load is healthy in general (the #42/#73/#84/M11 saturation class stands on its own evidence). Full measurement: ledger 2026-09-18 and register **#122**'s addendum.


**Run:** rpc-nightly-autonomous-pass, fired late (on app launch, not overnight).
**Mode:** OFF-HOURS monitor (real local time ~07:5x PT, outside 00:00–06:00) **+ NO-PUSH** (sandbox git has no credential — harvested `remote.origin.pushurl` returns *"could not read Username"*; the desktop pushurl harvest is dead per CLAUDE.md). **Shipped 0 · reverted 0.** Nothing was shipped by design in this mode, and there was nothing safe *to* ship even absent the mode (see the event below). This is the correct output.
**Lock:** was RELEASED at start (prior run np-20260914-b1f7); taken over and re-RELEASED at close.

---

## HEADLINE — live production DB read-availability event (external clients starved; engine healthy)

A sustained event in which **external database reads are failing while the engine itself is healthy and doing heavy internal work.** Corroborated by four independent instruments, so it is real and current, not the known `rpc_ops_snapshot()`-statement-timeout false signal:

1. **MCP `execute_sql`** — `SELECT 1` / `SELECT now()` / the `pg_stat_activity` positive control all fail **~13× across ~35 min (14:20–14:55Z)** with *"Connection terminated due to connection timeout"* — connection **establishment** refused, not a statement cancel.
2. **Production public boards** (PostgREST path) — `/insights/squeeze` and `/insights/rookies` render the honest degraded state: *"PARTIAL DATA · temporary database-load failure … treat as unknown rather than zero."* **The honesty layer is working — no fabricated zeros.** (ISR caveat: these refresh hourly, so the cached panel *could* trail the live state by up to ~1h; the live MCP refusals make the event current regardless.)
3. **Vercel runtime errors (last 24h)** — a **NEW error cluster begins ~12:48Z** (05:48 PT): `<!DOCTYPE html>` fetch failures on `/api/fmv-recalc`, and on `refresh-insights-cache`'s candy-mlb / panini-squeeze / player / scarcity boards (server-to-server fetches receiving HTML error pages instead of JSON), plus new `popular-on-collection` read failures for golazos (13:06Z), candy-mlb (13:03Z), pinnacle. Chronic slow-read surfaces (pack-detail RPCs since Aug 23; player/edition/team/set detail 45s RPC timeouts since Aug 15–16; popular-on-collection since Sep 9) are all firing with `last` timestamps at 14:45Z.
4. **Management API `get_project`** → `status: ACTIVE_HEALTHY` (Postgres 17.6.1.111 GA, not paused). **Vercel latest prod deploy** → `READY` (commit `00662ce`, migration-autorecover bot). Engine and app server are alive.

### What the postgres logs show (the discriminator — read via the management-API log stream, which needs no DB connection)
Over 12:00–14:30Z, **pg_cron jobs start and complete normally** — the Atlas firehose lanes (`atlas_market_drain/dispatch` 462/463, `atlas_editions_drain/dispatch` 448/449, `atlas_listing_verify_tick` 466), `topshot_moment_hydrate_tick` 469, `sync_sales_from_atlas` 471, `backfill_wmc_fmv_confidence` 302, plus net.http_get dispatchers — every ~2 min, each *"completed: 1 row"*. Only **2** internal `canceling statement due to statement timeout` in the whole 2.5h window; 21× `duplicate key … sales_2026_tx_nft_sold_idx` (benign — the unique index doing its job). (The 14:30–14:55Z sub-window shows zero cron/postgrest log rows: **log-ingestion lag on the last ~25 min**, not a second signal.)

**Interpretation:** internal work proceeds on reserved connections; **external clients (MCP connection establishment, Vercel PostgREST reads) are starved.** Production reads abort on their own client-side budgets (`read exceeded 8000ms`) *before* the DB's `statement_timeout` fires, which is why the postgres log shows almost no cancels.

### Cause — BEST-SUPPORTED, explicitly NOT ASSERTED (per CLAUDE.md §1c)
I could **not** obtain the direct positive control (`pg_stat_activity` io_wait / active / total) — the connection it needs is exactly what's refused. So I do **not** assert the cause and **nothing was shipped off this observation.** The log-backed evidence points to **connection-pool / IO saturation from concurrent pipeline load on the SMALL compute tier** (90 conns, ~22 MB/s IO floor), *not* a platform/engine outage:
- engine `ACTIVE_HEALTHY`; internal pg_cron jobs completing; only 2 internal statement cancels; heavy concurrent Atlas + wmc-backfill pipeline load in the exact window; saturation here is documented as IO-bound.
- The **wallet-backfill fan-out has no back-pressure** and its cost to every other lane is already filed (inbox `2026-09-13T1445Z`) — a standing candidate contributor.
Alternative not excluded: a connection-layer / pooler incident with the engine otherwise fine. **The two are only separable by the positive control**, which must be taken the moment a connection succeeds.

### Attribution to a recent ship: NONE
Last ledger ship was **2026-09-14** (WMC delete-not-seen; fmv-confidence precompute). **Nothing shipped in the last 24–48h**, so there is no recent change to attribute or auto-revert. Not a code regression — an operational load event.

### Why nothing was done (and nothing should have been)
- OFF-HOURS monitor mode → queue, don't ship. NO-PUSH → code/deploys can't take effect anyway.
- The only levers that take effect without a push (pausing/throttling a pipeline cron) are (a) a **fix derived from an unconfirmed cause** (§1c forbids), (b) **pipeline route/schedule logic** (OFF-LIMITS to autonomous shipping), and (c) potentially harmful — pausing an ingest lane creates data gaps. **Correctly queued for a diagnosed, push-capable, waking decision.**

---

## Section 2 health-drift triage
- **Security block** (invariants / anon-write / secdef-anon-exec drift): **UNMEASURED** — DB unreachable. Not reported clean (per the #121 exit practice, legs would be re-derived individually, but that also needs a connection). No reason to suspect drift (no DDL shipped since 09-14).
- **Trust health / stalled pipelines / sentinel counters / rpc_ops_snapshot / FMV split / db_size:** **UNMEASURED** — same reason. Prior close (09-14) carried 1 open trust breach `topshot_impossible_parallel_serials` which was **RESOLVED later that morning** (#82, metric read 0); no fresh reading this run.
- **Post-ship regression watch:** no ships in 24–48h → nothing to re-measure or revert.
- **Sentry:** browser SDK off (#34, no-spend); server-side picture taken from Vercel runtime errors instead (above).
- **Artifacts:** 11 enumerated, **none flagged broken** in the inbox this run. Payload validation **deferred** — every payload query hits the same unreachable DB, and re-running heavy payloads into a possible saturation spell is exactly what the monitor filing warned against. Re-validate `rpc-live-health` et al. in a quiet window.
- **Overnight deltas:** cannot compute this run (health vector UNMEASURED). `metrics-latest.json` carries forward the 09-14 values with this run's UNMEASURED status recorded.

---

## Inbox drained / candidates folded
- **`2026-09-18T1445Z.md` (mount-only, daytime monitor first tick):** the same event, filed with the same instruments; it left the exact positive-control query to run once a connection succeeds. Folded — this handoff is its night-pass follow-through. (Not archived: NO-PUSH; archival is a git move.)
- Older 09-13/09-14 inbox items remain open and mostly Claude-Code/Trevor-gated (Q-SCB partial indexes, #82 miskey, back-pressure, #100/#101/#102, retention). Carried forward.

---

## Queued — needs a diagnosed, push-capable, or Trevor decision
1. **[THIS EVENT] Diagnose + relieve the DB read-availability event.** The moment a connection succeeds, take the positive control:
   `SELECT count(*) FILTER (WHERE wait_event_type='IO') AS io_wait, count(*) FILTER (WHERE state='active') AS active, count(*) AS total FROM pg_stat_activity WHERE pid <> pg_backend_pid();`
   — majority IO-wait / near-90 total ⇒ saturation (identify the pinning reader from `pipeline_runs`/pg_cron around 12:48–15:00Z 2026-09-18; the wallet-backfill fan-out back-pressure gap, inbox 09-13, is the first suspect). Low counts ⇒ connection-layer/pooler incident (platform, nothing in-repo). Then confirm self-clear (`/insights/squeeze` real rows + trivial MCP `SELECT 1`) and record the window it spanned.
2. Carried forward from 09-14 (unchanged, all gated): Q-SCB sales-claimable partial indexes · **#82** miskey re-key + writer fix · concierge Goofy-probe contract · #100 master-alarm GHA trigger rate · #101 topshot-misattrib-drain backlog · #102 suppression is_active scoping · retention reclaim (cron.job_run_details + Atlas events, +~1.36 GB/24h) · #55 Routines · #22 credential-purge GC + rotate · cron-job.org re-enables · inbox archival (needs push).

## Failed / blocked / reverted
- None reverted. **Blocked:** all DB-backed health checks + artifact payload validation (DB unreachable); all git writes uncommitted (NO-PUSH).

## Ops note
NO-PUSH: this handoff + the ledger entry + `metrics-latest.json` are written to the **mount, UNCOMMITTED**. A push-capable pass must `git fetch`, reconcile (origin may be ahead), re-splice the ledger entry at the first `^### `, run the three ledger guards, then commit. CLAUDE.md "Recent sessions" line **owed** to a push-capable pass (not edited here — the 40,000-char file can't be guard-verified from a no-push mount edit without risking collision). Inbox not archived (needs push).
