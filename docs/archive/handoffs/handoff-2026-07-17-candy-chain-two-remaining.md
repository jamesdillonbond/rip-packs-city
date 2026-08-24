# Candy chain-two — remaining items after discovery + ingest (2026-07-17)

## Context
Discovery + the first editions ingest for the **2026 MLB Base Series ICONs** (Solana / Metaplex Core) are COMPLETE and live (see docs/overnight/ledger.md, 2026-07-17). Shipped by Cowork this session, all on `main`, deployed READY: the `lib/chains/solana/normalize.ts` discovery fill (collection `JkJA4yUBweFQdKAWNDhoFj8zHMZrQ1uZEYfjbkc3p8n`, serial/edition-size/edition-key logic, pack filter), a `serial_number` + bare-serial-name QA fix, `candy_mlb.contract_address`, and the **helius-proxy `HELIUS_PROXY_SECRET` reconciliation** (worker↔Vercel — the ingest 401'd until they matched). `candy_mlb` (Supabase UUID `209ade70-32c5-4470-bc7c-4793d660f713`) is `is_active=false`, no cron. Data verified: ~125 editions (100 Core /250 + ~25 Rainbow /15), 25,375 ICON serials, `serial_number` populated, 0 orphans. This doc is what's LEFT — none urgent, each gated on a decision or external state.

## 1. Ongoing-refresh cron for candy-editions-ingest (DECISION + wiring)
The editions ingest has run manually clean; wire a scheduled refresh so newly-opened packs / future released inventory keep flowing.
- Route: `POST /api/ingest/candy-editions`, `Authorization: Bearer INGEST_SECRET_TOKEN` (already the route's own auth).
- Option A (cron-job.org, operator console): add an entry hitting `www.rippackscity.com/api/ingest/candy-editions`, own stagger slot off `:00`, PLUS a `pipeline_cadence_watchlist` row (pipeline `candy-editions-ingest`, e.g. `max_silent_minutes` 1500, severity `info`) so it can't false-alarm `detect_stalled_pipelines()`.
- Option B (Vercel cron in `vercel.json`): the route currently accepts ONLY `INGEST_SECRET_TOKEN`; Vercel crons send `CRON_SECRET`, so either extend the route's auth to also accept `CRON_SECRET` (mirror an existing cron route) or configure the cron's auth header.
- Frequency: **daily is plenty pre-launch** (Base Series drops ~every 2 weeks). NOT wired yet by design (runbook: crons are a deliberate step gated on a clean manual run — now met).

## 2. ME symbol flip -> activate candy-sales-indexer + FMV (GATED on the first secondary SALE)
`lib/chains/solana/normalize.ts` has `CANDY_MLB_ME_SYMBOL = "TODO_2_CANDY_ME_SYMBOL"` ON PURPOSE. Confirmed value: `2026_mlb_base_series_icons_candy_digital`. There are **0 secondary sales** yet (bids + mints only; Candy's quest-hold rule suppresses listings). The daily `candy-solana-launch-watch` scheduled task now detects the first sale. When it fires:
- Flip that one constant to the confirmed symbol -> `candyMeSymbolReady()` becomes true -> `app/api/candy-sales-indexer/route.ts` stops no-op'ing.
- Wire a `candy-sales-indexer` cron (same pattern as #1) + a watchlist row.
- FMV auto-computes for `candy_mlb` via `fmv-recalc` (collection_id-driven) once sales exist — expect LOW / sparse / NO_DATA on a thin book (honest; never force ASK_ONLY on zero-sale editions).
- Revert: set the constant back to `"TODO_2_CANDY_ME_SYMBOL"`.

## 3. Chain-aware address validators — wallet-paste (GATED on public launch; CAREFUL — do NOT blind-sweep)
For a Solana wallet pasted into a Candy surface to resolve, the ~40 Flow-shaped validators (`/^0x...{16}$/`) need `isValidAddressForChain(addr, collection.dbChain)`. **MEMORY WARNING:** most of these are the last gate before Flow-specific machinery (`ensureFlowPrefix`, TopShot GQL, TS-only RPCs) — flipping one in isolation routes a Solana address INTO Flow code and corrupts it (strictly worse than today's clean 400). Flip each validator TOGETHER with its Candy data surface, never as a standalone sweep. Full per-site guidance: `docs/archive/handoffs/handoff-2026-06-08-candy-readiness-gaps.md` (Items 4/5/7). Not needed until Candy is public.

## 4. Public go-live (Trevor's readiness call — NOT day one)
When ready: `collections.is_active=true` for `209ade70...`, `published:true` on the `candy-mlb` entry in `lib/collections.ts`, then the `rpc-insights-qa` checklist (pages / sitemap / OG / canonical). Caveats for any copy: thin 500-pack book, and the 25,375 serials are Candy's **pre-mint inventory** (~92.6% held by treasury wallet `BhA2Bfd8...`), NOT circulating supply — don't render them as "holders" / "in circulation".

## 6. wmc transfer-staleness (minor; before go-live)
The editions ingest upserts wmc on `(wallet, collection, moment)`; a transfer — mostly Candy treasury -> buyer on pack-open (launch day) — leaves the OLD owner's row behind (stale, NULL `serial_number` after the 2026-07-17 fix). A one-time prune ran 2026-07-17 (474 rows), but it re-accumulates. Durable fix before go-live: add a post-walk stale-prune to `app/api/ingest/candy-editions/route.ts` (after `paginateGroup`, `DELETE` wmc for the collection where `last_seen_at < run start` — guard with `SET LOCAL rpc.allow_bulk_delete='on'` since it can span the treasury wallet), OR rely on a periodic wmc refresh. Symptom if skipped: per-edition "minted" counts read slightly high.

## 5. FMV — no action (folds into #2).

## Guardrails
Direct-to-`main`, no branches / PRs. PowerShell `git` + `Invoke-WebRequest` on Windows. Vercel `maxDuration` <=800s. CRLF-safe full-file writes. **Claude Code's direct file inspection wins over this doc on any disagreement — adapt to the actual file shape.**

## End state
Pick up #1 (decision) + #2 (when a sale prints, detected by `candy-solana-launch-watch`); #3/#4 when going public. Nothing blocks — the collection is fully indexed and correct at `is_active=false`.
