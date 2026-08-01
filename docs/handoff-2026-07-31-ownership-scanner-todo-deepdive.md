# Handoff — Deep-dive: `docs/code-todos.md` #2 (TopShot/AllDay Deposit-event ownership scanner)

**Date:** 2026-07-31 (PT) · **Author:** Claude Code (interactive, "deep-dive one gated TODO as a handoff, don't ship") · **Ships nothing** — this is a decision-ready design + a correction of a now-stale TODO.

---

## TL;DR / verdict

The TODO in `code-todos.md` #2 — "build the edge function that polls the port-8070 spork API, parses TopShot/AllDay `Deposit` events, and feeds `upsert_*_ownership_batch`" — **should NOT be built as written. The Deposit-event scanner design is abandoned and superseded.**

- **TopShot ownership is already solved**, by a *different, live, healthy* two-pipeline design that landed after this TODO was written (2026-06-26). `topshot_ownership` holds **267,742 rows, fresh to 2026-07-31**, fed by Dune event-replay (Pipeline A, `sync-topshot-ownership-dune`) + a per-wallet on-chain verification walk (Pipeline B, `ownership-onchain-walk`), and it has a real product consumer (`lib/set-completers-board.ts`, the rookie/set-completers boards). The Deposit-scanner scaffold for TopShot is redundant — **retire it, don't finish it.**
- **AllDay ownership is a genuine gap** (no index exists — `allday_ownership_snapshots` = 0 rows, there is no `allday_ownership` table), **but it has no product consumer today.** Per CLAUDE.md's "keep parallel until a real consumer exists" rule, building it now is premature. The decision is a *product* one ("does AllDay need a set-completers/holder board?"), not an engineering blocker.
- **If** an AllDay ownership consumer is ever greenlit, the cheapest correct path is to **generalize the proven live TopShot pipelines to AllDay** (Dune replay + FCL wallet-read walk), **not** to resurrect the Deposit-event edge-scanner. A full drop-in template exists either way (§5).

**Recommended action:** update `code-todos.md` #2 to reflect this (done in the same commit as this handoff), and treat the Deposit-scanner scaffold (frozen cursors + empty tables + unused RPCs) as retire-on-sight dead weight. Optional cleanup SQL in §6 — gated, not run.

---

## 1. What the TODO asked for, and the scaffold that exists for it

`code-todos.md` #2 says the DB-side primitives are in place and only the edge function is missing. Verified live — the scaffold is real but **inert**:

**RPCs (all exist, SECURITY DEFINER, `search_path=public`):**
| RPC | Signature | Behavior |
|---|---|---|
| `scanner_get_progress` | `(p_scanner_id text)` | reads a `flow_backfill_progress` cursor row → jsonb |
| `scanner_advance_progress` | `(p_scanner_id text, p_new_height bigint, p_events_found int, p_events_inserted int, p_events_skipped int)` | `FOR UPDATE`-locked cursor advance + totals |
| `upsert_topshot_ownership_batch` | `(p_events jsonb)` | dedup-by-`nft_id` (latest `deposit_block_height` wins) → upsert `topshot_ownership_snapshots` |
| `upsert_allday_ownership_batch` | `(p_events jsonb)` | same, into `allday_ownership_snapshots` |

Event JSONB element shape the batch RPCs expect: `{ nft_id, owner, deposit_block_height, observed_at? }` (rows missing `nft_id`/`owner` are dropped; `observed_at` defaults to `now()`).

**Cursors (`flow_backfill_progress`) — all four FROZEN since 2026-05-05, 0 events ever:**
```
topshot-deposit-scan-forward    last_height=150585016  events=0   (untouched since 2026-05-05)
topshot-deposit-scan-backward   last_height=150585016  events=0
allday-deposit-scan-forward     last_height=150585016  events=0
allday-deposit-scan-backward    last_height=150585016  events=0
```

**Target tables (`nft_id text PK, owner text, deposit_block_height bigint, observed_at timestamptz`):**
```
topshot_ownership_snapshots   1 row     (single test row at height 150585020)
allday_ownership_snapshots    0 rows
```

So: the plumbing was staged on 2026-05-05 and never wired to a producer. Nothing reads either `*_snapshots` table (grep: referenced only in `ledger.md` + one archived handoff — no code consumer).

---

## 2. What actually happened instead (the live design that superseded it)

Seven weeks later (2026-06-26) the ownership problem was solved a different way, scoped to the **rookie holder graph** (the data the set-completers / rookie boards actually need):

- **Pipeline A — `app/api/cron/sync-topshot-ownership-dune/route.ts`** — discovers the full holder graph via Dune event replay (weekly, to stay in the free Dune credit tier). Writes `topshot_ownership` with `source='dune'`.
- **Pipeline B — `app/api/cron/ownership-onchain-walk/route.ts`** — independent on-chain confirmation: for the stalest-verified holder wallets it reads the wallet's current TopShot moment-ID set in one FCL `getIDs()` call (contract-verified script reused verbatim from `wallet-backfill`), re-stamps every still-held Dune-attributed NFT as `source='onchain_walk'` with a fresh `observed_at`, and counts `vanished` for sold/moved NFTs. Free (Flow public REST), runs daily.
- Both upsert on `nft_id`; on-chain confirmation wins via fresher `observed_at`.
- **Consumer:** `lib/set-completers-board.ts` (rookie / set-completers surfaces).

Live state: `topshot_ownership` = **267,742 rows, freshest `observed_at` 2026-07-31 13:30Z, sources `dune,onchain_walk`.** Healthy and consumed.

Background/reference: `docs/integrations/dune-ownership-index-buildbook.md`, `docs/research/dune-ownership-index-state-2026-07-07.md`, `docs/archive/handoffs/handoff-2026-06-26-ownership-index*.md`.

**Why Dune+walk beat the Deposit-scanner (and why it should stay that way):** TopShot `Deposit` is one of the highest-volume events on Flow. A full-history Deposit walk via public sporks is (a) bounded — the public historical nodes only serve blocks back to **mainnet17 root = 2022-04-06** (`workers/spork-proxy/index.ts` FLOOR note; mainnet1–16 are decommissioned), so pre-2022-04 ownership is unrecoverable this way — and (b) throughput-heavy. Dune replay does full-history discovery in one query tier; the FCL walk does cheap current-state confirmation. The Deposit-scanner would have been strictly more work for a strictly worse result on TopShot.

---

## 3. Per-collection verdict

| Collection | Ownership index today | Deposit-scanner scaffold | Verdict |
|---|---|---|---|
| **TopShot** | `topshot_ownership` (267k rows, live, consumed) | `topshot_ownership_snapshots` (1 test row), cursors frozen | **Redundant — retire scaffold.** Do not build. |
| **AllDay** | none (no table, no index) | `allday_ownership_snapshots` (0 rows), cursors frozen | **Genuine gap, but no consumer.** Gate on a product decision. |
| **Pinnacle** | `pinnacle_ownership_snapshots` (live, healthy — see §4) | n/a | Already built + running. Not part of this TODO. |

---

## 4. If AllDay ownership is ever greenlit — the proven build path

There is a **live, healthy, single-file template** for exactly this shape: the Pinnacle owner-discovery scanner. It writes `pinnacle_ownership_snapshots` (same 4-column shape as the AllDay target), cursors on `flow_backfill_progress` (`pinnacle-deposit-scan-forward`, **321,567 events found / 320,838 inserted, updated 2026-08-01**), and is battle-tested. So this is a **~1-day-per-collection job, not the "multi-session architecture project" the TODO describes** — that framing predates the template.

**Two viable architectures (recommend Option A):**

### Option A (recommended) — generalize the live TopShot pipelines to AllDay
Mirror `sync-topshot-ownership-dune` + `ownership-onchain-walk` for AllDay. Fits the existing consumer shape (`topshot_ownership`-style table + `set-completers-board`), reuses the Dune proxy and a contract-verified AllDay wallet-read (AllDay's typed `borrowMomentNFT` on `/public/AllDayNFTCollection` is documented in CLAUDE.md's per-collection Cadence gotchas — verify via Cadence MCP before writing). Net: same table/consumer/ops model product already runs, no new dead-letter/spork machinery.

### Option B — finish the Deposit-event edge scanner (mirror `pinnacle-owner-discovery-forward`)
Only if you specifically want raw Deposit-event ownership snapshots. Concrete contracts, all verified live:

- **Template to copy:** `supabase/functions/pinnacle-owner-discovery-forward/index.ts` (forward walker) + `supabase/functions/pinnacle-owner-discovery/index.ts` (backward). Change exactly:
  - `DEPOSIT_EVENT` → **AllDay: `A.e4cf4bdc1751c65d.AllDay.Deposit`** (TopShot would be `A.0b2a3299cc857e29.TopShot.Deposit`, but see §3 — don't).
  - `SCAN_STATE_ID` → `allday-deposit-scan-forward` / `-backward` (cursor rows already exist).
  - upsert target → `allday_ownership_snapshots` on `nft_id` — **or** call `upsert_allday_ownership_batch(p_events)`, which does the dedup + block-height-guarded upsert atomically (the RPC scaffold is arguably better than the inline Pinnacle upsert for concurrency; either works).
  - `log_pipeline_run` pipeline name + `p_collection_slug: 'nfl-all-day'`.
  - Keep verbatim: `unwrapCdc`, the fetch-throws-on-non-OK contract (returning `[]` on error advances the cursor past an unscanned window = silent permanent loss — see the comment at `fetchDepositEvents`), `EdgeRuntime.waitUntil` background pattern, `CHUNK_SIZE=250`, `MAX_BLOCKS_PER_RUN=5000`, `SAFETY_LAG_BLOCKS=100`, `AbortSignal.timeout`.
  - The AllDay `Deposit` payload field for the recipient is `to`; the NFT id is `id` (same as Pinnacle's `extractDeposit`). Confirm against a decoded tx before trusting.
- **Reset the frozen cursors first** — they sit at `150585016` (a stale 2026-05-05 seed). For a forward-only "current state" index, re-seed to `safeTip-1` (the template does this automatically when `last_processed_height <= 0`, so `UPDATE flow_backfill_progress SET last_processed_height=0 WHERE id='allday-deposit-scan-forward'` and let it self-seed). For historical backfill, seed the backward cursor and remember the **2022-04-06 spork floor** (older AllDay history is unrecoverable via public sporks; AllDay launched 2022, so most is in range but the earliest may not be).
- **Egress:** current-spork event windows read `https://rest-mainnet.onflow.org` **directly from the edge function** (Supabase edge egress reaches Flow REST — only Vercel is WAF-blocked). For blocks `< 137390146` use `spork-proxy` (`GET /?start_height&end_height&event_type`, single-spork per request, Bearer `SPORK_PROXY_SECRET`).
- **Cron:** wire forward at ~`*/20`–hourly via cron-job.org or a Vercel cron (Bearer `INGEST_SECRET_TOKEN`), matching how Pinnacle's forward walker is driven.

**Pre-flight for either option:** confirm a real consumer exists first (a board/route/RPC that reads AllDay ownership). Without one, this is parallel data with no product value — exactly what CLAUDE.md says to defer.

---

## 5. Recommended action

1. **Update `code-todos.md` #2** to record that the Deposit-scanner design is superseded for TopShot and consumer-gated for AllDay, pointing here. *(Done in this commit.)*
2. **Leave the scaffold in place but marked dead** (don't spend effort finishing it). If a cleanup pass wants to reclaim it, §6 has the retirement SQL — but it's harmless (1 test row + 0 rows + 4 frozen cursor rows + 4 unused SECDEF RPCs), so retiring is optional, not urgent.
3. **AllDay ownership** stays a *product* backlog item ("does AllDay need a set-completers/holder surface?"), not an engineering TODO. When greenlit → Option A.

## 6. Optional retirement SQL (NOT run — gated on a cleanup decision)

```sql
-- Retire the abandoned 2026-05-05 Deposit-scanner scaffold (TopShot half superseded
-- by topshot_ownership; AllDay half never wired to a producer/consumer).
-- Revert: re-create from git history of the 2026-05-05 scaffold migration.
DROP FUNCTION IF EXISTS public.upsert_topshot_ownership_batch(jsonb);
DROP FUNCTION IF EXISTS public.upsert_allday_ownership_batch(jsonb);
-- scanner_get_progress / scanner_advance_progress are generic over flow_backfill_progress
-- and MAY be reused by a future scanner — keep them unless confirmed unused.
DROP TABLE IF EXISTS public.topshot_ownership_snapshots;   -- 1 test row
DROP TABLE IF EXISTS public.allday_ownership_snapshots;    -- 0 rows
DELETE FROM public.flow_backfill_progress
 WHERE id IN ('topshot-deposit-scan-forward','topshot-deposit-scan-backward',
              'allday-deposit-scan-forward','allday-deposit-scan-backward');
```
> ⚠ `scanner_*` RPCs and `flow_backfill_progress` are shared infra (Pinnacle scanners use the same table) — the DELETE above is scoped to the 4 dead TopShot/AllDay cursor rows only. Do not drop the table or the generic RPCs.

---

## Grounding (everything above verified live this session, 2026-07-31 PT)
- `pg_proc`: 4 scanner RPCs exist, signatures + bodies read.
- `flow_backfill_progress`: 4 TS/AllDay cursors frozen at 150585016 since 2026-05-05; Pinnacle cursors live.
- `topshot_ownership_snapshots` = 1 row, `allday_ownership_snapshots` = 0 rows.
- `topshot_ownership` = 267,742 rows, fresh 2026-07-31, sources dune+onchain_walk; consumer `lib/set-completers-board.ts`.
- No `allday_ownership` table exists.
- Template read in full: `supabase/functions/pinnacle-owner-discovery-forward/index.ts`; spork floor from `workers/spork-proxy/index.ts`.
- Live walker read in full: `app/api/cron/ownership-onchain-walk/route.ts`.
- Contract addresses (Deposit event types) cross-checked against CLAUDE.md "Flow/Cadence contract addresses".
