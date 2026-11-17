# Handoff — Pack-opens historical backfill (AllDay deep-history fix + TopShot historical builder)

**Written:** 2026-07-11 ~02:17 PT (Claude Code, interactive) · **Status:** code staged in the worktree, **NOT deployed, NOT pushed**. Deploy is gated on the operator steps below (secret wiring + cron). No FMV code touched. No git push. No edge-fn deploy.

**Files changed / added (worktree only):**
- `supabase/functions/ingest-allday-pack-opens/index.ts` — MODIFIED (loop-bug fix + spork-proxy deep-history routing + floor auto-gating). Forward/probe paths unchanged by construction.
- `supabase/functions/ingest-topshot-pack-opens-history/index.ts` — NEW (TS historical pack-opens backfill; sibling to the AllDay fn; writes `pack_rips` only).

---

## TL;DR

1. **AllDay backfill had two bugs** and could never reach genesis: (a) its floor is the *current-spork root* (137,390,146), not AllDay genesis; (b) a real loop bug — *any* scan error (incl. a permanent 404 on a pruned block) held the cursor, so the tick retried the identical dead window forever. **Both fixed.**
2. **The hard constraint that reshapes the TopShot ask:** `rest-mainnet` prunes everything below the current spork; deep history is only reachable via the `spork-proxy` worker, whose public floor is **block 27,341,470 = 2022-04-06** (mainnet17 root). **TopShot genesis (block ~7M, Oct 2020) is permanently unrecoverable.** A TS historical backfill can realistically reach **2022-04-06 → present**, not 2020-10. AllDay genesis (~35–40M) *is* above the floor, so AllDay is fully recoverable.
3. Reaching any sub-current-spork block needs `SPORK_PROXY_URL` + `SPORK_PROXY_SECRET` in the edge-fn env. Both functions **auto-gate** on those: unwired → they stay at the current-spork floor and are inert-safe (no flapping); wired → they descend into the sporks. This matches focus.md's standing rule that spork ingest extensions are "not an unverifiable blind ship."

---

## How `pack_rips.tx_hash` is populated (verified, identical old vs. new, both collections)

`tx_hash` = the on-chain **`PackNFT.Opened` transaction id**, present on every `/v1/events` row regardless of era:
- AllDay: `A.e4cf4bdc1751c65d.PackNFT.Opened.transaction_id`; opener + pulls from same-tx `A.e4cf4bdc1751c65d.AllDay.Deposit`.
- TopShot: `A.0b2a3299cc857e29.PackNFT.Opened.transaction_id`; opener + pull count from same-tx `A.0b2a3299cc857e29.TopShot.Deposit`.

The historical backfill has the same data available — nothing about `tx_hash` differs across sporks. `pack_rips` has UNIQUE(pack_nft_id) AND UNIQUE(tx_hash); writes are idempotent upserts (`ignoreDuplicates`), so re-runs and any overlap with the live worker never double-write.

---

## Change 1 — `ingest-allday-pack-opens` (MODIFIED)

**Loop-bug fix (Step 2/3).** The old backfill advance was `after = err ? end+1 : start` with `end+1 === cur` → cursor never moved on error → the pruned-block window retried forever. New logic distinguishes **transient** (network / 429 / 5xx → hold + retry, `ok=false` so it's visible) from **permanent** (404 pruned, proxy 400/401 → advance DOWN past the dead window, `ok=true`, `extra.skipped_permanent=true`). The cursor can no longer wedge.

**Deep-history routing (Step 3).** New height-routed fetchers: windows `< CURRENT_SPORK_MIN` (137,390,146) go to the **spork-proxy** (`?event_type=…&start_height=…&end_height=…` for events; `?tx=` for tx results, whose events live under `.result.events` — normalized by `txEvents()`); windows at/above it use `rest-mainnet` exactly as before. Each backfill tick is clamped to a **single spork** (`sporkFloorOf()`; the `SPORK_MAX_HEIGHTS` table mirrors `workers/spork-proxy` `SPORKS`) because the proxy rejects cross-boundary event ranges.

**Floor auto-gating (Step 3).** `reachableFloor(requested)` = `SPORK_AVAILABLE ? max(requested, SPORK_FLOOR=27,341,470) : max(requested, CURRENT_SPORK_MIN=137,390,146)`. Requested floor now defaults to `ALLDAY_GENESIS_FLOOR = 35,000,000` (overridable via `?floor=`). **Net effect:**
- Deployed **without** the spork secret → floor stays 137,390,146; the backfill drains the reachable current-spork window once and reports `done`. This alone kills the flapping even with no proxy.
- Deployed **with** the spork secret → floor drops to 35M; the backfill descends through mainnet27→mainnet18 to AllDay genesis.

**Untouched:** `forward` and `probe` modes (they only ever touch ≥ CURRENT_SPORK_MIN heights → always `rest-mainnet` → byte-identical behavior), `writeRips`, `allday_pack_pull` writes, the `GATE`.

## Change 2 — `ingest-topshot-pack-opens-history` (NEW)

Near-clone of the (now spork-aware) AllDay fn with TS event signatures. **Deliberately isolated from the live `pack-events-ingest` worker** (which uses rest-mainnet only and owns TS forward + near-tip backfill) so historical/spork complexity can't disturb live ingest.

- Modes: `probe`, `backfill`. Cursor: **`topshot_pack_opens_history_backfill`**. Writes **`pack_rips` only** (`onConflict: tx_hash, ignoreDuplicates`; `dist_id=null` — TS dist resolves later via the existing hourly `backfill_pack_rip_metadata` sweep).
- **Does NOT write `moment_acquisitions`** — pull provenance is owned by the worker's wallet-walk + `flushOpens`; blind historical writes there would risk that system. A follow-up can attribute pulls off the `pack_rips` rows this fn lands.
- Floor: `reachableFloor(SPORK_FLOOR)`. Default start = **137,390,145** (top of the last historical spork) so that (a) it doesn't re-scan the current spork the worker already owns and (b) **without the spork secret it reports `done` on the first tick — a safe no-op; it does real work only once `SPORK_PROXY_*` is wired.** `?start=151610000` forces belt-and-suspenders current-spork overlap.
- **Reach ceiling (honest):** SPORK_FLOOR = 2022-04-06. **TS 2020-10 → 2022-04-06 is unrecoverable** (mainnet16 and older decommissioned — see `workers/spork-proxy` FLOOR note + focus.md line 19). The "~block 7M genesis" target in the brief is not achievable with public infra; this is a documented gap, not a defect.

Gate key: `<gate-key — now an edge secret, see D2>` (mirrors the AllDay `?key=` pattern).

---

## Operator deploy steps (gated — do in order; nothing below is auto-done)

**A. Deploy the AllDay fix (safe even without the spork secret — it fixes the wedge and is inert w.r.t. deep history until B).**
1. Deploy `ingest-allday-pack-opens` with `verify_jwt=false` (there's no `supabase/config.toml`; set it on the deploy call / dashboard). Supabase MCP: `deploy_edge_function` (project `bxcqstmqfzmuolpuynti`, `verify_jwt: false`).
2. Smoke: `GET …/ingest-allday-pack-opens?key=<gate-key — now an edge secret, see D2>&mode=backfill` → expect JSON with `spork_available:false`, `routed:"rest"`, and the cursor draining toward 137390146 then `done:true`. Confirm `pipeline_runs` pipeline=`allday-pack-opens-backfill` logs `ok=true` and **no re-attempt of an identical window** across two ticks.

**B. Wire the spork proxy (unlocks deep history for BOTH functions).** Prereq: the `spork-proxy` worker must be deployed with its secret (per focus.md 2026-06-25 it's already deployed + functional; if not: `cd workers/spork-proxy && wrangler deploy && wrangler secret put SPORK_PROXY_SECRET`).
1. Add two secrets to **both** edge functions' env: `SPORK_PROXY_URL` = the spork-proxy `*.workers.dev` URL (no trailing slash), `SPORK_PROXY_SECRET` = its bearer secret. (Supabase edge-fn secrets: dashboard → Edge Functions → Secrets, or `supabase secrets set`.)
2. Re-probe AllDay backfill → now expect `spork_available:true` and, once the cursor drops below 137390146, `routed:"spork"`.

**C. Deploy + schedule the TS history fn.**
1. Deploy `ingest-topshot-pack-opens-history` with `verify_jwt=false`.
2. Add a cron-job.org entry (COMMON tab only — Advanced holds secrets; see the cron memory) → `GET …/ingest-topshot-pack-opens-history?key=<gate-key — now an edge secret, see D2>&mode=backfill`, on an off-anchor minute-trio (avoid 0/1/20/21/40/41 and 06:00 UTC per docs/operations/cron-schedule.md). Suggest matching the AllDay backfill cadence. **Schedule it only after step B** — before that it's a deliberate instant no-op every tick.
3. First tick with cursor null seeds at 137390145; subsequent ticks descend to 27,341,470 then `done`.

**D. (optional) Watchlist rows** once each backfill banks ≥2 clean ticks (the BUYERBF "measure first" rule): `pipeline_cadence_watchlist` for `topshot-pack-opens-history-backfill` (and confirm `allday-pack-opens-backfill` is present) at ~90 min / medium. Verify `detect_stalled_pipelines()` `[]` after.

---

## Verification once wired (what "working" looks like)

- AllDay: `pack_rips` rows with `collection_id='dee28451-…'` and `block_height < 137390146` begin appearing; `event_cursor.allday_pack_opens_backfill` descends past 137390146 toward 35M; `v_allday_pack_lifecycle` per-dist `packs_opened` grows for older dists.
- TopShot: `pack_rips` rows with `collection_id='95f28a17-…'` and `block_height` between 27,341,470 and 137,390,145 appear; `event_cursor.topshot_pack_opens_history_backfill` descends; no `moment_acquisitions` churn (by design).
- Both: `pipeline_runs` show `ok=true`, `extra.routed` flipping `rest`→`spork` as the cursor crosses 137390146, and **never** two consecutive ticks with the same `start`/`end` (the wedge is gone).

---

## Revert paths

- **AllDay fn:** `git checkout -- supabase/functions/ingest-allday-pack-opens/index.ts` (uncommitted) — or if committed, `git revert <sha>`. Re-deploy the prior fn to roll back live. The prior behavior (floor 137390146, wedge-on-error) is what's live today.
- **TS history fn:** delete `supabase/functions/ingest-topshot-pack-opens-history/` and the cron-job.org entry; it writes only idempotent `pack_rips` rows (no schema, no other table). To purge its rows if ever needed: `DELETE FROM public.pack_rips WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND block_height < 137390146;` (only the historical rows this fn added; live-worker rows are ≥ 137390146). Also `DELETE FROM public.event_cursor WHERE id='topshot_pack_opens_history_backfill';`.
- **Spork secrets:** remove `SPORK_PROXY_URL`/`SPORK_PROXY_SECRET` from the two fns' env → they auto-revert to current-spork-floor behavior (no deploy needed).

---

## Notes / open items

- No `supabase/config.toml` in the repo → `verify_jwt=false` is a deploy-time flag, not committed. Header comments in both fns document it.
- The `SPORK_MAX_HEIGHTS` list in both fns is duplicated from `workers/spork-proxy` `SPORKS`. If the spork list is ever re-tuned there, update both edge fns to match (they only matter for boundary-tick clamping).
- Could not run Deno type-check here (Deno edge fns are outside the Next `tsc` project; task constraint = no external probing). Changes were verified by close reading against the proven live AllDay fn; the operator smoke steps above are the runtime gate.
- Ledger: add a Queued/Shipped line for this once deployed (this doc is the artifact).
