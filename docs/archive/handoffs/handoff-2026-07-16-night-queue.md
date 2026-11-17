# Claude Code handoff — 2026-07-16 night queue

**Context.** Everything executable from the evening queue is done. Shipped live today by Cowork (ledger 2026-07-16 rounds 1–7 has reverts): rwfd delta-rewrite (524 MB/call → 0.03s) + drift catch-up queue (20/25 drained at write time, ~2k rows corrected, cron finishes the whales — then CLEAN UP: when `SELECT count(*) FROM _rwfd_catchup_queue WHERE done_at IS NULL`=0 → `SET ROLE cron_heavy; SELECT cron.unschedule('rpc-rwfd-catchup-tick');` + DROP FUNCTION `_rwfd_catchup_wallet_tick()` + DROP TABLE `_rwfd_catchup_queue`); TS art fill + selfheal (real gap 214→46, converging); impossible-parallel wave 4 cleared (trust 16/16); Pinnacle render-bridge (sales attribution 99.96%) + edition thumbs 351/503 + daily selfheals; pinnacle cursor-alert suppression; challenges ends_at filter (+ your `7c13872b` data expiry); smoke probe retargeted 7800→5048 (`87dd80d` — the recurring page was the pathological mega-dist colliding with hourly heavy-cron saturation windows). CC's evening ships: challenges expiry, badge-coverage Vercel cron, `idx_wmc_fmv_null`, AllDay rebate.

Claude Code's direct file inspection wins over this doc and `project_knowledge_search` on any disagreement — adapt to the actual file shape.

---

## 1. `get_lock_check_batch` — the NEW #1 disk reader (HIGH, measured)

- **What:** post-wmc-fix pg_stat_statements ranking (reset 15:40Z, first window) puts `public.get_lock_check_batch(p_collection_slug, p_limit, p_max_age_days)` at **1,522 MB read / 193s in a SINGLE call** (historic table: 1,286 GB / 1,460 calls ≈ 0.9 GB/call — it was #3 all along, now #1 after the wmc fixes). It window-ranks the ENTIRE stale set of `wallet_moments_cache` (~2M rows) per call: `ROW_NUMBER() OVER (PARTITION BY collection_id ORDER BY <EXISTS hot_wallets subplan per row> DESC, lock_checked_at NULLS FIRST)` then `LIMIT p_limit` — full scan + giant sort + per-row subplan, to pick a few hundred rows. Its caller is the lock-check pipeline (squeeze data; runs many times/day) — this is very likely the driver of the hourly saturation windows that page the smoke + burn 30s statement timeouts on page views (bursts logged 14:49Z / 15:39Z).
- **Proposed shape (verify with EXPLAIN first):** materialize `hot_wallets` once into a temp/CTE-hashed set (not a per-row EXISTS), then per collection take two index-driven arms UNION ALL — (a) stale rows whose wallet ∈ hot set, (b) stale rows otherwise — each `ORDER BY lock_checked_at NULLS FIRST LIMIT p_limit`, then merge/prioritize client-side of the fn. Supporting index: `(collection_id, lock_checked_at ASC NULLS FIRST)` (or partial `WHERE lock_checked_at IS NULL` + a second aged arm, mirroring the idx_wmc_fmv_null win). Result identity: same batch selection semantics (priority wallets first, stalest first) — write a before/after comparison on a fixed snapshot if feasible.
- **File/fn:** DB fn `get_lock_check_batch` + whatever cron/route calls it (`lock-check-batch` pipeline). Same-signature CREATE OR REPLACE preserves grants.
- **Verify:** pg_stat_statements read_gb/call drops ~100×; the hourly page-view statement-timeout bursts stop; smoke stays green through :34–:45.
- **Revert:** restore prior fn def; drop the new index.

## 2. Pinnacle grain migration (ARCHITECTURAL — Trevor decides scope)

Your corrected diagnosis stands: `pinnacle_catalog` (2,272 renders) fully mirrors the live studio catalog with 100% mint data; the legacy 503-row `pinnacle_editions` has 152 render-less / 154 mint_count-NULL fossils, and the legacy bridge can't fill them. Options: (a) migrate consumers (moment page edition object, FMV collapse, concierge triple-join) to render-grain; (b) accept the fossils and mark them dead. Either way the residual 79 unattributed sales + 152 thumb-less editions resolve or get honestly retired. Sequenced AFTER Trevor's call.

## 3. fmv uuid-stub pricing (LOW, FMV-path, Trevor review — your corrected framing)

163 inert `UUID:UUID` stubs are priced by the **GQL-catalog job** (not fmv-recalc) and 21 moments still point at stub edition ids. Fix = repoint those 21 moments to canonical editions + exclude uuid-shape rows from the catalog pricing job's targets.

## 4. Team-summary rollup incl. FMV totals (Trevor's freshness call — carried)

`get_team_detail` dies on the FMV leg first under saturation; a full team-summary rollup (≤1h stale displayed $) is the fix. Waiting on Trevor.

## 5. Mega-dist pack pages (LOW, optional)

Dist 7800-class pages sum to ~14s cold even fully index-driven (many cold legs). If it ever matters: cache the per-dist RPC outputs for the top-N heaviest dists (matview or 15-min swr table). Smoke no longer probes it; warm hits 2–3s.

## 6. Operator (Trevor's machine)

- Home-machine Task Scheduler revival (`scripts/register-active-listings-task.ps1`) — underpriced-#1s + AllDay-badges lanes; consider disabling `topshot-active-listings-ingest.yml`'s schedule (Atlas 403s all datacenter egress permanently).
- `ownership-sync-dune` retrigger (PowerShell Invoke-WebRequest POST w/ INGEST token) — Top Owners stale since ≥07-13.
- Optional: cron-job.org `wmc-fmv-populate` cadence 65s → 10 min (insurance).
- rwfd catch-up cleanup if the queue is empty and nobody has done it (SQL above).

## 7. Roadmap (docs/strategy/roadmap-2026-07-14.md)

Mobile pass; Pinnacle set-completion tracker; AllDay Top Owners; TS Autographs + Redeem cataloging.

---

**Guardrails:** direct-to-`main`, no branches/PRs; PowerShell git; `git rev-list --count origin/main..HEAD`=0 after push; Invoke-WebRequest for Vercel REST; maxDuration ≤800s; CRLF-safe writes; tsc + tests pre-push; code commit must be the push tip (docs-only tip = canceled deploy — force-deploy the SHA); watch READY + smoke.

**Expected end state:** lock-check batch reads MBs not GBs and the hourly saturation windows disappear; Pinnacle grain question decided and executed; stub-pointing moments repointed; operator lanes revived; roadmap items in flight.
