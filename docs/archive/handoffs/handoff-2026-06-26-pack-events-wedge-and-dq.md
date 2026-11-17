# Handoff — pack-events forward wedge + canonical metadata gaps (2026-06-26)

Three items. #1 is what Sentinel keeps alerting on (split into one operator action + one CC fix). #2 is a data-quality gap that needs the source catalog. #3 is bookkeeping. Each claim is labelled **verified** (I ran the query) vs **inferred** (I could not observe it from here) — don't take the inferred parts as fact.

---

## 1. [HIGH — Sentinel `cursor_stalled` is firing on this] pack-events forward cursors frozen

**Verified (queried `pipeline_runs` + `event_cursor`, 2026-06-26 ~02:0xZ):**
- The `pack-events-ingest` forward worker is still LOGGING `ok=true` — but its fire cadence has degraded: runs at 17:54 / 18:09 / 18:24 / 18:39 / 18:54 / 19:09Z (~15-min spacing), then 20:24 (75-min gap), 22:24 (120-min gap), then **nothing for ~220 min**. Every logged run is `ok=true`, no error text.
- Cursor state NOW:
  - `topshot_pack_purchases` → block 156009044, advanced 22:24Z (220 min ago).
  - **`allday_pack_purchases` → block 156004422, frozen since 18:54Z (430 min).**
  - **`topshot_pack_opens` → block 156004422, frozen since 18:54Z (430 min).**
  - `allday_pack_purchases_backfill` → 156003422 (423 min).
  - The three `topshot_pack_*_backfill` / `_primary_backfill` cursors sit at 151610000 / 151848205 (idle/retired by design — ignore).
- The two frozen cursors (`allday_pack_purchases`, `topshot_pack_opens`) at block 156004422 are **exactly** what the Sentinel `cursor_stalled` alert named.

So: the worker still runs, but (a) the trigger is firing irregularly and (b) even on the 22:24Z run that DID fire, it advanced `topshot_pack_purchases` while leaving the allday/opens legs frozen at 18:54Z.

### 1a — trigger cadence degrading → OPERATOR
**Verified:** `pack-events-ingest` is **not** in `vercel.json` and **not** in `.github/workflows/` (grepped both). So it is triggered by an external scheduler (cron-job.org). Last fire 220 min ago vs the normal ~15-min cadence.
**Do:** check the `pack-events-ingest` entry on cron-job.org — confirm it's enabled and re-fire it. (I have no access to the cron-job.org console, so I can't tell you whether it's paused, erroring, or just slow — that console is the only place that shows it.)

### 1b — allday_pack_purchases + topshot_pack_opens wedged → CLAUDE CODE
**Verified:** the 22:24Z run advanced `topshot_pack_purchases` but NOT `allday_pack_purchases` / `topshot_pack_opens` (still at 18:54Z), with `ok=true` and no logged error. This is the swallowed-flush wedge CLAUDE.md already documents (p25/p26: "if a batch flush throws, that cursor does not advance" — and the worker can still return ok because the throw is swallowed per-leg).
**Inferred, NOT verified:** the flush for those two legs at ~block 156004422 is throwing — most likely a statement-timeout on a large `pack_opens` / `pack_purchases` batch (the same class as the p25 1796-row timeout that was fixed by chunking writes to 400; current worker `CHUNK_SIZE=250`). I did **not** read the Cloudflare worker logs (can't reach them from here), so I cannot confirm which table or why.
**What would settle it:** `wrangler tail pack-events-ingest` (or the CF dashboard live logs) during a run — look for the flush error on the allday_pack_purchases / topshot_pack_opens legs around block 156004422. Fix = make that leg's flush not throw (smaller per-write chunk, or catch+log so the cursor advances past the bad block).
**Do NOT** manually advance the frozen cursors — that skips the un-ingested blocks and permanently loses that pack data.

### UPDATE 2026-06-26 ~04:00Z — `fdb09b59` did NOT fix it; forward worker still wedged (VERIFIED via cron-job.org test runs)
- Operator ran both cron-job.org test runs. **Forward** ("RPC Pack Events Ingest TopShot") → **Failed (timeout)**. **Backfill** ("RPC Pack Events Ingest Backfill TopShot") → **200 OK 737ms**, clean (`caught_up_to_forward:true`, `sealed_tip:156044913`, `allday_forward_cursor:156004422`).
- **Verified after the forward test run: ZERO cursor advance.** `allday_pack_purchases` + `topshot_pack_opens` still 156004422 (~9h stale); `topshot_pack_purchases` still 156009044 (~5.5h). The forward worker ran the full 30s, cron-job.org killed it, and it committed nothing.
- **Conclusion (verified):** the wedge is NOT fixed by `fdb09b59`. The worker hangs/cancels before its first cursor commit — it's not merely slow, because even prior runs where Cloudflare could continue server-side advanced nothing. Raising the cron-job.org timeout is therefore unlikely to help (a run that commits nothing in 30s won't commit in 60s either) — but it's a cheap experiment if CC wants the worker to self-drain once the hang is fixed.
- **Compounding factor (verified):** the forward cursor is ~40,491 blocks behind the sealed tip (156004422 → 156044913). Even once the hang is fixed, the worker must chew through that backlog within whatever per-run budget keeps it under the cron timeout — so the fix likely needs (1) eliminate the hang at ~block 156004422, AND (2) ensure the chunk/soft-budget loop actually commits + returns inside 30s so it makes incremental progress per run instead of all-or-nothing.
- **DB-side cause RULED OUT (verified 2026-06-26 ~04:0xZ):** the flush-target tables are healthy — `pack_purchases` 214K rows/168MB/3.7% dead, `pack_rips` 179K/121MB/4.4% dead, `moments` 393K/179MB/4.3% dead, `moment_acquisitions` 510K/275MB/0.7% dead; all recently autovacuumed; **no locks or long-running queries on any `pack_%` table.** A chunked 250-row upsert into these is sub-second, so the hang is NOT a slow flush / bloat / lock. The cause is in the worker's control flow.
- **Strong hypothesis (NOT verified — needs the worker logs):** the forward worker commits its cursor only when it reaches `caught_up`, so a ~40K-block backlog can never finish inside the 30s cron window → it times out and commits nothing → the gap grows → permanent wedge. If so, the fix is to commit the cursor incrementally per chunk (or after the soft-budget cutoff) so each run makes partial progress and the worker self-drains over several runs. The 22:24Z run advancing `topshot_pack_purchases` by ~4,622 blocks but the opens/allday legs by 0 is consistent with the purchases leg consuming the whole budget before opens/allday run.
- **What would settle the cause:** `wrangler tail pack-events-ingest` during a forward invocation — find what runs >30s before the first `event_cursor` commit. I can't reach the worker logs from Cowork.

### RESOLVED 2026-06-26 ~04:12Z (worker `d9f863b5`, commit `80a9238`) — VERIFIED
- Root cause confirmed: (1) staged budgets measured absolute-from-`startedMs` but each leg's flush ran *between* loop sections, so the purchases flush ate the opens budget window → opens/allday stuck at `chunks: 0`; (2) all cursor writes + the `pipeline_runs` log were batched at the very end, so a CF-killed run lost everything (no log since 22:24Z = the run never reached the end). Both are exactly the failures verified above.
- Fix: `processCursor` takes a `commitChunk(toBlock)` callback; the three live legs flush + advance the cursor after every ~250-block chunk, then clear the accumulator. Backfill mode untouched (single end-of-leg flush).
- **Verified live:** forward test run → **200 OK in 20.6s** (under the 30s cron wall). DB `event_cursor` 83s later: `topshot_pack_purchases` 156017794 (+8,750), `allday_pack_purchases` 156007922 (+3,500, off 156004422), `topshot_pack_opens` 156005672 (+1,250, off 156004422). All three advance + commit per-chunk; a killed run now banks every finished chunk.
- **Remaining = drain + cadence (operator, not a bug):** ~28K–40K blocks behind the 156046234 tip. Staged drain — the purchases leg (first in the loop) takes most of each run's budget (~4,750 blk/run) so it catches up first (~6 runs); once it hits `caught_up` the opens/allday legs get the full window and accelerate. Full catch-up ≈ a few hours of normal cron cadence.
- **VERIFIED 2026-06-26 ~04:16Z — the cron is NOT currently firing on schedule (1a, OPERATOR action required).** `pipeline_runs` cadence: normal ~15-min spacing through 19:09Z, then it degraded (75-min → 120-min gaps) and **stopped entirely from 22:24Z to 04:09Z — a 345-min gap with zero scheduled fires.** The only runs since are the two manual cron-job.org test runs at 04:09 + 04:11Z (2.5 min apart). So the backlog is NOT auto-draining; the cursors move only on a manual trigger. **Most likely cause: cron-job.org auto-disabled the "RPC Pack Events Ingest TopShot" entry after the hours of 30s-timeout failures (its standard behavior on repeated failures).** Action: re-enable / confirm that entry is ACTIVE on its ~15-min schedule. Now that runs succeed in ~20s, once it's firing the ~28–40K backlog drains in a few hours and Sentinel `cursor_stalled` clears. Until it's re-enabled, the wedge fix is proven but the data stays stale.

---

## 2. [LOW-MED] canonical-edition metadata gaps need the source catalog (not wmc)

**Verified (queried 2026-06-26):** after the thumbnail recovery (item 3), the remaining canonical-edition metadata gaps are NOT cleanly backfillable from wmc, so I deliberately did not touch them:
- **TS ~290 null `player_name`** (plus smaller tier/set/circ gaps). Of the 290, **163 are ambiguous** (multiple distinct wmc `player_name` values for the same `edition_key`), and the unambiguous remainder are mostly team/exhibition moments — sample wmc values: "Atlanta Hawks", "Utah Jazz", "Philadelphia 76ers", "Team Moment", and some **empty strings**. A naive wmc backfill would write wrong or empty player names.
- **AllDay 36 null `player_name`** → **0** fixable from wmc.
- **UFC 72 null `set_name`** → **0** fixable from wmc.

**Do (CC):** backfill from the source catalog (TS catalog GQL / AllDay GQL / UFC studio), with team-moment-aware handling — an empty string must stay NULL (never written), team-named values only if confirmed legitimate, and the 163 ambiguous TS rows resolved by the authoritative play→player mapping, not by "most common wmc value."

---

## 3. [bookkeeping] repo-sync the DQ migration shipped this session

Live-only migration (applied via MCP) needs a parity copy under `supabase/migrations/` + a ledger entry:

**`audit_20260626_recover_canonical_ts_null_thumb_via_per_moment_cdn`** — recovered **1,427** canonical TS null-thumbnail editions (mostly `::` subedition parallels) by repointing `thumbnail_url` to the proven per-moment CDN form `https://assets.nbatopshot.com/media/<nft_id>/image?width=400` (nft_id = the edition's representative moment from wmc/moments). Backup table `audit_20260626_ts_canonical_thumb_recovery` (RLS-on; anon grants 0). **Verified:** backed_up=1427, canonical null-thumb remaining=149 (those 149 have no representative moment anywhere → on-chain mint discovery, same niche class as the 11 dead-media WNBA Ultimates), `check_public_security_invariants()`=0, secdef anon `[]`.

(Plus the still-pending `audit_20260625_recover_ts_dead_media_via_moments_nft_id` from `docs/handoff-2026-06-25-cc-prompt-remaining.md` item 4.)
