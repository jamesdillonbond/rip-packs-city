# Handoff — 2026-07-11 evening audit follow-ups (Cowork → Claude Code)

Context: full-audit session ran with the Cowork sandbox DOWN (host disk full) — no git/shell available, so nothing here was committed. DB work already shipped live via MCP (see below). This doc + the two companion docs are **uncommitted new files** on the working tree.

## 0. Commit the audit deliverables (first)

New untracked files to commit (docs-only, one commit):

- `docs/audits/full-audit-2026-07-11.md`
- `docs/strategy/roadmap-2026-07-11.md`
- `docs/handoff-2026-07-11-audit-followups.md` (this file)

Also append the ledger entry in §5 to `docs/overnight/ledger.md` (Cowork could not edit it — big-doc mount-truncation hazard).

## Already LIVE (DB via MCP — no action, just awareness + revert paths)

1. **`audit_20260711_circ_floor_raise_impossible_parallel_wave2`** — trust breach `topshot_impossible_parallel_serials` 11→0. Raised `circulation_count` to max observed sale serial on 4 `::` parallels: `221:7458::20` (8→10), `221:7468::20` (1→9), `228:7657::21` (4→5), `228:7661::21` (4→5). Revert: set those values back.
2. **pg_cron job 53 `rpc-pack-opens-api-topshot` UNSCHEDULED** — TS opens API backfill `done=true` (788,061/788,061). Revert: re-`cron.schedule` from job-run history.

## 1. Code fix — no-confidence-UI violation on pack pages (HIGH visibility, small diff)

`app/(collections)/[collection]/pack/dist/[distId]/page.tsx` still renders FMV confidence on the public UI (survived the `ad47da8`/`b5d66fa` sweeps):

- Pull-odds table cells render `$1.48 · LOW` — strip the confidence suffix from the FMV cell.
- Footnote: "…Low-confidence FMV (LOW / ASK_ONLY / STALE / NO_DATA) is flagged inline." — delete/reword to pure facts (e.g. "EV share = pull odds × FMV ÷ per-slot EV, over the editions remaining in the pool.").
- Grep the same file for any other `LOW|ASK_ONLY|STALE|NO_DATA` render paths while in there.

Directive: Trevor 2026-07-11 — confidence and derivatives are build-time signal only, never rendered. Verify live on `/nba-top-shot/pack/dist/7800` (its pull-odds table shows the chips today).

## 2. Code polish (small, same wave)

- **Reward-pack hero art:** TS pack dist 7800 hero tile renders solid black (no art asset for reward packs). Give packs a branded placeholder (AllDay already falls back to a letter tile).
- **AllDay pack lifecycle caption** "observed since Jun 2026" is now false — the API backfill reaches 2021-12. Suggest "complete history via the Dapper pack registry" or compute the earliest observed open per dist.
- **Team-hub montage blanks:** `/nba-top-shot/team/portland-trail-blazers` montage strip shows 3/5 empty tiles — likely dead thumb URLs in the montage picker; prefer editions with verified `thumbnail_url`.

## 3. Post-storm re-checks (after AllDay opens backfill hits done=true)

The pack-opens API backfill saturated DB IO most of 07-11 (pack_rips → ~3.49M rows). Once `pack_opens_api_state.done=true` for AllDay (was 2.72M/2.81M "page 11" at 02:20Z — likely done within the hour):

1. `SELECT cron.unschedule('rpc-pack-opens-api-allday');` (job 52) — same retire-on-done rule as job 53.
2. Verify on quiet ticks: `rpc-allday-rollup-rip-value` (jobid 23), `rpc-allday-cross-source-sales-dedup` (32), `rpc-remap-misattributed-sales` (7) stop failing (`check_pgcron_recent_failures()`), and `classify-acquisitions-multicollection` logs runs again (it fires hourly but was dying at the 300s cap under contention — NOT a dead cron).
3. If `rpc-allday-rollup-rip-value` STILL times out quiet: it now aggregates a 50x bigger AllDay rip set — needs a covering index on `pack_rips (collection_id, pack_nft_id) INCLUDE (...)` or an incremental/set-oriented rewrite. Measure first (EXPLAIN on the fn's agg CTE).
4. `[edition] offers` / `[pack-detail]` statement-timeout classes in Vercel runtime errors should decay; if they don't, they're no longer storm-attributable.

## 4. Offers-completeness investigation (parity gap found in audit)

v2.nbatopshot.com shows 3 OPEN offers on `223:7512::20` Jukebox ($45 / $44 / $14, oldest 7mo) that RPC's `offers` table does not have as open (open set there: $30 on ::19, $20/$15/$13 on base). Also `edition_offers` has no ::19/::20 per-printing rows yet (expected — the 07-07 per-printing GQL sweep accrues ~4 ticks/cycle and lost ticks to cron dropouts).

After the offers-sweep completes a full catalog re-walk: sample ~10 editions' v2 open-offer lists vs `offers` + `edition_offers`. Outcomes: (a) rows appear → pure lag, close; (b) v2 offers persistently missing on-chain → they live in the dapper.market off-chain book → scope a small indexer for that surface (it's one GQL endpoint; would also unlock the "% listed" stat v2 shows).

## 5. Ledger entry to append (docs/overnight/ledger.md, newest-first position)

```
### 2026-07-11 ~19:30 PT (Cowork, interactive) — Evening full audit: 385-page sweep ALL PASS; trust breach cleared (impossible-parallel wave 2, 11→0); TS opens cron retired on done; AllDay SUNSET intel; offers parity gap queued

Sandbox down all session (no git) — DB via MCP only; docs delivered uncommitted (this entry appended by CC).

- SHIPPED (DB): audit_20260711_circ_floor_raise_impossible_parallel_wave2 — 4 :: parallels circ-floor-raised (221:7458::20, 221:7468::20, 228:7657::21, 228:7661::21); topshot_impossible_parallel_serials 11→0, trust 16/16 ok. Revert: restore prior circ values (8/1/4/4).
- SHIPPED (DB): unscheduled pg_cron job 53 rpc-pack-opens-api-topshot (state done=true, 788k/788k; retire-on-done per the 07-11 pack-opens ship). AllDay leg (job 52) left running at ~97% — retire on done=true.
- AUDIT: 385 sampled pages (225 editions/25 pins/50 packs/20 sets/20 teams, all 4 collections) — 100% HTTP 200, 0 missing images, all content sections present. Native parity vs v2 (223:7512 family): circs/badges exact, ASP consistent, serial offers captured incl. the filled $78; GAP = 3 open v2 Jukebox offers absent from on-chain offers (sweep lag vs dapper.market off-chain book — queued §4 of the handoff).
- FINDING (root cause of the day's contention): pack-opens API backfill drove pack_rips to ~3.49M rows (~400k rips/hr writes) — Vercel 300s-timeout + statement-timeout classes and 3 flapping pg_cron jobs are storm-attributable; classify-acq "stall" = firing-but-dying-at-300s, self-heals. Post-storm re-checks queued.
- INTEL: NFL ALL DAY officially SUNSET (no new Moments ever; 5% Dapper rebate through 2026-09-09; Founding Collector; "next evolution" teased) — roadmap reframed (docs/strategy/roadmap-2026-07-11.md).
- QUEUED (CC): pack-page LOW/ASK_ONLY confidence chips + footnote (no-confidence-UI violation, §1); reward-pack hero placeholder; team-montage blanks; stale lifecycle caption; hydrator worker deploy still pending (operator).
- Docs: docs/audits/full-audit-2026-07-11.md + docs/strategy/roadmap-2026-07-11.md + docs/handoff-2026-07-11-audit-followups.md.
```

## Operator items (Trevor)

- `cd workers/topshot-moments-hydrator && wrangler deploy` — activates the c1ba51e partial-data fix; hydrator keeps burning ~72 fails/24h until then.
- Optional: `deploy_edge_function` for `backfill-pack-opens-api` (c1ba51e concurrency guard) — belt-and-suspenders only; DB lock_timeout fix already stopped the failures, and the backfill is ending anyway.
- Home-machine Task Scheduler ingests (Deal Board / AllDay badges) still down since ~07-07 — log in + confirm both tasks run.
- Cowork sandbox host was out of disk this session — if future Cowork sessions report "no space left on device" on bash, restart the Cowork VM / clear its disk.
