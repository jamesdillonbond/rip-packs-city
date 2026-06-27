# RPC nightly autonomous pass — handoff 2026-06-01

**Mode: OFF-HOURS MONITOR + NO-PUSH. SHIPPED NOTHING (queued 1 new + carried forward).** Run fired late at **13:54Z = 06:54 local (PDT)** — ~54 min past the 00:00–06:00 overnight window → MONITOR-MODE (review + triage + post-ship watch; queue rather than ship). `git push` has no credentials in this sandbox ("could not read Username for github.com") → NO-PUSH; all outputs below are **written to disk, uncommitted** (they persist via the mount for future runs to pick up). Trevor is actively committing this morning (latest `7c1b81b` landed 13:52Z, ~2 min before this run) — another reason to stay queue-only and avoid `.git` index-lock contention (Q7).

Repo: shared `C:\Users\TDill\rip-packs-city` (bot clone `rip-packs-city-bot` still not mounted in the scheduled sandbox — Q7). On `main`, HEAD `7c1b81b`, == `origin/main` (0/0).

## Health: ✓ GREEN across the board

- **Security 0/0** — 0 RLS-off public base tables; 0 anon/authenticated write grants on RLS-off base tables (`relkind in r,p`). Clean.
- **`detect_stalled_pipelines()` = `[]`** — authoritative absence-of-runs check clean. No stalls (Q3 stays resolved; TS sales-indexer + listing-cache both healthy).
- **FMV writers fresh** — fmv-recalc wrote TS + AllDay ~10 min before the sweep (13:48Z). Primary FMV writer healthy.
- **FMV improving** — see deltas. TS HIGH+MED **880**, NO_DATA **5109**; AllDay HIGH+MED **267**.
- **Sentinel TS-UUID-keyed-48h = 40** — far under the 250 ok-line, down hard from 1099 baseline / 119 @ 06:18. The UUID-writer leak is effectively closed.
- **Pipelines** — only low-single-digit transient `ok=false` in 24h (max 5: pack-events-ingest), all connection-pool / statement-timeout / upstream-timeout clustered at the 00:00Z + 06:00Z cron rush, every one with same-tick recovery. evm-transfers-ingest 3/24h (known Q6 Base-429). No new logic fault; none attributable to any deploy.
- **Vercel** — 20/20 most-recent prod deploys **READY, zero ERROR**. Current prod = `7c1b81b` (sitemap prune) READY.
- **Sentry** — no new issue in the last ~6h except NEXTJS-15 firing once ~07:54Z (gated AllDay capture, ledger C1 — still not 24h-quiet, watch). The smoke-test cluster (NEXTJS-14/-1D/-4/-A/-12/-1E) all last fired ~00:54Z (midnight cron rush) — known cry-wolf; **none fired in the 06:00Z rush**, an early sign `a79b778`'s smoke `rpcRetry` (live ~04:53Z) is working.
- **DB** 5912 MB (normal growth). Editions TS 16308 / AllDay 6191 / Golazos 581 / UFC 446.

### Infra note — repaired a corrupted `.git/config` (local-only, no commit)
At run start **every git operation failed** with `fatal: bad config line 18 in file .git/config`. Cause: the on-disk `.git/config` had **16 trailing NUL bytes** after `name = Trevor\n` (file 410 bytes; valid content 394). Read was stable across 3 reads → genuine on-disk corruption, not a transient flapping read. This is the same Windows↔sandbox bridge fragility documented in Q7 (the ledger's 22:30Z note predicted exactly this: "a bash read of `.git/config` returned 16 NUL bytes at line 18 → fatal: bad config line 18"). Fix: backed up to `.git/config.bak-nullfix-20260601`, truncated the NUL bytes (rewrote 394 clean bytes). Git restored immediately (`main`, log readable). This touched only local git internal state — not a tracked file, no commit, no history change. **Without it the run could not have done git review at all.** Reinforces Q7: the scheduled sandbox needs sandbox-native clone storage, not a Windows-mounted `.git`.

## Post-ship regression watch — GREEN, nothing reverted
Re-measured the metrics that the last ~24–48h of ships were meant to move; every one is healthy with no attributable regression:

- **`7c1b81b` sitemap prune (06:52 PDT, ~1h before run)** → deploy `dpl_BjwxfSHdqVrgmkMUYYttqT4EurrZ` READY = current prod. No new Sentry, no pipeline impact.
- **`a79b778` audit follow-ups A1–A6 (04:53Z)** → READY. `edition_offers` table live, `offers-sweep` firing (per 06:18 monitor: 4 runs, last 06:00:40Z ok=true), security still 0/0, smoke `rpcRetry` live and apparently suppressing the 06:00Z cron-rush smoke false-REDs.
- **`65421e26` FMV ask-over-WAP (00:04Z)** → READY. ASK_ONLY at the intended elevated level (TS 680), NO_DATA falling — intended behavior, not drift.
- **team-hub Phases 1–5, `/insights/market`, badge-sync on-chain-key fixes, share wallet-intel** → all deploys READY, zero ERROR, no regression in any touched surface.

No ship correlated with a regression → **no auto-revert needed.**

## Shipped this run
**None** (off-hours monitor mode). The one SHIP-eligible candidate (P1 watchlist insert) is queued below as **Q10**.

## Queued

### Q10 · NEW · [LOW–MED] Add `topshot-listing-cache` (+ `-v2`) to `pipeline_cadence_watchlist` so a listing-cache stall is detectable
From the 2026-06-01T06:18Z monitor inbox (P1). `topshot-sales-indexer` is watchlisted (180m) but its siblings `topshot-listing-cache` / `-v2` — which stalled *together with it* during the 05-31 Q3 incident (01:35→09:28Z) — are not (confirmed: watchlist has only the 4 `*-sales-indexer` rows). So `detect_stalled_pipelines()` is structurally blind to a listing-cache stall; the only reason the Q3 listing-cache half was caught was a human eyeballing absence-of-runs. These feed `cached_listings` → `badge_editions.low_ask` → fmv-recalc's ASK_ONLY path, which is **more** load-bearing for FMV honesty since `65421e26` (TS ASK_ONLY now 680), so a silent stall now degrades FMV quality, not just listing freshness.

Current state (NOT an alert): both run 11×/24h, last 13:04Z (~56 min before sweep), within their irregular ~60–206 min daytime envelope. Healthy, just unwatched.

NOT auto-shipped: off-hours monitor-mode (would have been SHIP-eligible in a true overnight run — it's an additive, reversible, non-destructive monitoring-config INSERT, not route logic / not destructive / not off-limits). Threshold 360 min chosen ABOVE the observed routine envelope (max routine ~206 min daytime, ~4.1h overnight) and BELOW the real 7.9h Q3 stall, so it pages only on a genuine multi-hour stall (the Q9 "don't false-positive on normal gaps" lesson).

Ready-to-run migration (verified against live schema: PK on `pipeline`; `severity` is NOT NULL — vocabulary high/info/medium):
```sql
INSERT INTO pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active) VALUES
  ('topshot-listing-cache', 360, 'medium',
   'TS listing-cache feeder (cached_listings -> badge_editions.low_ask -> fmv-recalc ASK_ONLY). 360m > routine overnight gap (~4.1h) and < the 7.9h Q3-class stall. Added so detect_stalled_pipelines() can see a listing-cache stall.', true),
  ('topshot-listing-cache-v2', 360, 'medium',
   'Sibling of topshot-listing-cache (trails ~2s); same rationale.', true)
ON CONFLICT (pipeline) DO NOTHING;
```
Verify post-apply: `SELECT detect_stalled_pipelines();` should STILL return `[]` (listing-cache last ran ~56 min < 360).
Revert: `DELETE FROM pipeline_cadence_watchlist WHERE pipeline IN ('topshot-listing-cache','topshot-listing-cache-v2');`
Target metric: a future listing-cache multi-hour stall appears in `detect_stalled_pipelines()` rather than being invisible.

### Carried forward (unchanged — operator/CC/Trevor-owned, or low/by-design)
- **Q5 / smoke cron-rush cry-wolf** (night 2) — the smoke suite goes RED on transient connection-pool timeouts at the :00/:06 cron rush (Sentry NEXTJS-14/-1D/-4/-A/-12/-1E, all last ~00:54Z). `a79b778` added `rpcRetry` to 4 DB-backed assertions and the 06:00Z rush produced **no** new smoke events — early evidence it's working; keep watching. Remaining: rebase the sales-lag check on last-successful-run + scope/relax the `detect_stalled_pipelines` smoke gate (NEXTJS-1E fires on evm — see Q6). Operator/CC (smoke route + schedule).
- **Q6 / evm-transfers-ingest Base-429** (night 2) — 3/24h statement-timeout, Beezie/Base parallel plane, no product consumer, self-heals. Also trips the NEXTJS-1E smoke gate (fold with Q5). LOW. Operator/CC.
- **Q7 / scheduled-sandbox `.git` fragility** (night 2) — recurring. This run hit the predicted NUL-corrupted `.git/config` (fixed locally; see Infra note). Bot clone still not mounted; push still unavailable. Durable fix = sandbox-native clone syncing via origin, Trevor's call. INFRA.
- **Q8 / badge-sync row-grain** (night 2) — `onConflict:"id"` vs `UNIQUE(external_id,collection_id)` poisons ~40% of upsert batches; needs a one-row-per-play vs per-parallel decision + Trevor review. Note: offers coverage was decoupled from this via `edition_offers` (a79b778), so Q8 is now badge-only. MED, needs Trevor.
- **Q2 / compute-laliga-pack-ev cadence** — by-design Golazos cadence; watch. LOW.

### Other observations (not new candidates; logged for operator/CC)
- **Rookies view name nit** — ledger's "Insights batch" Resolved entry says the rookies surface shipped as `topshot_rookies_board` via `audit_20260531_topshot_rookies_board_view`, but live `to_regclass('public.topshot_rookies_board')` = NULL; the live view is **`topshot_2025_rookie_index`** (resolves). `rpc-insights-health` references the correct name and is healthy → pure ledger-vs-schema doc nit (monitor flagged it 3×: 00:15/03:28/06:18). Reconciled in the ledger this run.
- **Sentry NEXTJS-1B** (pinnacle/moment null destructure, fixed by `fe96d4b`) — now ~24h+ since last seen → **ready for operator to mark resolved** in Sentry (not done here: write action + monitor-mode).
- **Sentry NEXTJS-18 / -17** (pack-dist: "Attempted to call tierChip() from the server…" + a Server-Components render error on `/[collection]/pack/dist/[distId]`, 23+8 events) — real client/server boundary bug but **6 days stale** (no recent fire). Code-owned (can't ship NO-PUSH); LOW. Operator/CC to verify if still reproducible and, if so, move `tierChip` to a client component / pass as a prop.

## Failed / blocked / auto-reverted
None. No verification failure (nothing shipped). No regression to revert.

## Artifacts
11 enumerated; all backing objects validated healthy this run (security catalog 0/0, `sentinel_fmv_confidence_rows` both collections, `pipeline_runs` / `detect_stalled_pipelines()` / `db_size` / editions, insights views incl. the live `topshot_2025_rookie_index`). No schema drops occurred (all recent DDL additive) → nothing drifted; **none broken, none repaired**. (Artifact HTML lives on OneDrive, not mounted this run — validation is via backing-object health, as prior monitor runs did.)

## Metrics deltas (baseline 2026-05-31T08:10Z → now 2026-06-01T13:54Z)
| Metric | Baseline | Now | Δ |
|---|---|---|---|
| TS FMV HIGH+MED | 776 | 880 | +104 |
| TS FMV NO_DATA | 6055 | 5109 | −946 |
| TS ASK_ONLY | 114 | 680 | +566 (intended `65421e26`) |
| AllDay FMV HIGH+MED | 243 | 267 | +24 |
| AllDay FMV NO_DATA | 522 | 522 | 0 |
| Sentinel TS-UUID-48h | 1099 | 40 | −1059 |
| editions (TS) | 16279 | 16308 | +29 |
| unmapped_sales open | 144 | 147 | +3 (draining normally) |
| DB size | 5827 MB | 5912 MB | +85 |
| Security RLS-off / anon-write | 0 / 0 | 0 / 0 | clean |
| detect_stalled_pipelines | [] | [] | clean |
| prod deploy | 6c6950b READY | 7c1b81b READY | advanced, 20/20 READY |

## Inbox drained
6 monitor files consumed (2026-05-31T15:14Z → 2026-06-01T06:18Z) and archived to `docs/overnight/inbox/archive/`. Drain watermark: **2026-06-01T06:18Z**.
