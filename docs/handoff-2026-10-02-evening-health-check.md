# Handoff — 2026-10-02 ~7:29–9:15 PM PT · evening health check (Claude Code, cloud)

> ⚠ **Scope of the two blocks below:** both were refusals by **this cloud session's permission layer** (a `git rm` of three routes, and a read-only grep for the `url.parse` caller). They say nothing about the routes or the code. Trevor's machine and other sessions can do both normally.

Ledger entries for everything here are in `docs/overnight/ledger.md` under 2026-10-02 (evening); session log in `docs/sessions/2026-10.md`.

## Shipped (all CI-green, repo files committed)

| migration | what | measured |
|---|---|---|
| `20261003031302` | `get_pack_ev_contributors` latest FMV by index probe | dist 4184: 303 ms warm / 1,484 ms cold → 46 ms, temp spill gone; equivalent over 40 dists. Production traffic is low (10–50 calls / 2 h), so the user-visible gain is small. |
| `20261003033052` | `idx_editions_collection_base_external_id` | the edition page's #142 serial-ceiling subquery: 3,806 → 5 buffers per execution |
| `20261003033402` | `get_edition_recent_sales` `sub_names` scoped to Top Shot | across 80 editions: **36 % fewer buffers, 14 % faster** (one-edition sample had read neutral, 388 → 440); closes a latent cross-collection naming hole. Production 8:50–9:50 PM PT (52 ms / 921 buffers per call) sits inside the pre-change range — traffic mix dominates |
| `20261003023303` → `20261003030546` | probe-lane 90 s timeout, **reverted** | made things worse (whole-batch 503s); prod is on the 09-29 body |

New DB pins: `supabase/tests/get_pack_ev_contributors.sql`, `supabase/tests/get_edition_recent_sales.sql`.

## Needs Trevor

1. **#163 — retire three dead-host routes.** 0 requests in a 24 h Vercel read (positive control 12,402). The item's exit ("0 hits over 30 days") is unmeasurable on Pro's 24 h log retention — restate it or accept the weekly-caller risk. Task prompt below.
2. **pack-mint-probes.** The mainnet24 Flow node swings between ~0 % and ~85 % per tick on its own (measured 8:23–9:08 PM PT; a single light request is always fine). 25 concurrent vs 5–10 concurrent did not separate cleanly — **per-node concurrency is NOT established as the lever**. The 8:15 AM PT entry's two options (longer timeout — now measured harmful; or `ok` meaning dispatch+collect worked) remain your call. Failed probes are requeueable (SQL in the ledger); 69 were requeued at 9:09 PM PT.
3. **`get_pack_realized_ev_row`** — 4.9 s cold on the largest dist (7800, 22k attributed rips), but production is 17–293 ms / call and 4 page timeouts in 7 days. A ~150 MB covering index on `pack_rips` (1.2M non-HOT updates) is not justified by that; the hourly MV is not equivalent (stale means). Decided: no change.

## Task prompt — #163 (run in any session that can `git rm`)

Rip Packs City repo (push straight to `main` per CLAUDE.md). Close known-issues #163 **after Trevor decides the exit rule**:
1. Re-grep callers of `/api/moment-market`, `/api/market-feed`, `/api/allday-wallet-search` across `app/ components/ lib/ workers/ scripts/ .github/ vercel.json`, `cron.job` commands, and `href` builders.
2. `git rm -r app/api/moment-market app/api/market-feed app/api/allday-wallet-search __tests__/api-market-feed.test.ts __tests__/api-market-feed-integration.test.ts __tests__/api-moment-market.test.ts __tests__/api-allday-wallet-search.test.ts`.
3. Lower `BASELINE` in `__tests__/dead-topshot-host-consumers-only-decrease.test.ts`; tidy the comments at `__tests__/invariants-postgrest-cap.test.ts:189` and `lib/chains/flow/topshot-username-resolve.ts:221`.
4. `npm ci`; `NODE_OPTIONS=--max-old-space-size=3072 npx tsc --noEmit`; `npm test`; `npm run lint:ratchet`.
5. Mark #163 resolved (its first sentence drives the generated index — run `npm run docs:issues-index` and diff before `git add`); ledger entry; commit ledger first, code last; confirm Vercel deploy + CI.

## Task prompt — the `url.parse()` deprecation warning

Vercel's top error group (1,828 events / 850 users in 7 days) is `[DEP0169] DeprecationWarning: url.parse()`, on `/api/wallet-backfill*`, `/api/cache-refresh`, `/api/wallet-search`, `/api/cron/ownership-onchain-walk`, `/api/owned-flow-ids`, `/api/sales-indexer`. It buries real errors.
1. Find the caller: grep `app lib workers` for `url.parse(` / `from "url"`; otherwise the shared dependency of those routes (the Flow/FCL HTTP transport is the likely suspect). `node --trace-deprecation` on one handler is the fastest proof.
2. Ours → `new URL(...)` (mind relative URLs) + a test. A dependency → an in-range update via `npx -y npm@11 update <pkg>` (npm 10 crashes on `update`); never downgrade or patch `node_modules`; if no fix exists, record it in known-issues.
3. tsc / `npm test` / `npm run lint:ratchet`; ledger; push; confirm deploy + CI.
