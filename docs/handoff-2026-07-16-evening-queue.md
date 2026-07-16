# Claude Code handoff — 2026-07-16 evening: current queue (supersedes the morning iops-diet handoff)

**Context.** The morning handoff (`docs/handoff-2026-07-16-iops-diet-and-roadmap.md`) is mostly executed: `idx_wmc_fmv_null` (CC, ~40× read cut), `refresh_wmc_fmv_drift_active` delta-rewrite (Cowork, 524 MB/call → 0.03s, migrations `audit_20260716_rwfd_*`), AllDay rebate line (CC, `a259589b`), Item 3 closed by measurement (art gap filled a different way — see below). Also shipped live today by Cowork: TS art per-moment-CDN fill + `rpc-ts-artless-selfheal` cron (real gap 214→46, self-converging), impossible-parallel wave-4 floor-raise (16→0, trust 16/16), challenges `ends_at` display filter, pinnacle cursor-alert suppression, Pinnacle sales render-bridge fn + edition-thumb fill (83→351/503). Read the four 2026-07-16 ledger entries first. Current origin/main HEAD at write time: `8e6fa30`+.

Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape.

---

## 1. `ingest-topshot-challenges` never expires challenges (MED — data honesty)

- **Where:** `app/api/cron/ingest-topshot-challenges/route.ts` (verified path).
- **What/why:** the ingest upserts what `searchChallenges` returns and never flips absentees — once a wave ends upstream (fetched:0), all rows stay `status='active'` forever (live finding: all 31 challenges sat "active" 2 days after ending). Cowork shipped the display filter (`audit_20260716_challenges_ends_at_display_filter` on `get_active_challenges` + `get_challenge_plan`) so the UI is honest, but the DATA still lies. Add an expiry pass to the ingest: after upsert, `UPDATE challenges SET status='<pick vocabulary>' WHERE status='active' AND ends_at < now()` (only 'active' exists today — pick/introduce the ended vocabulary deliberately, check every status consumer first: grep `challenges.*status` across app/lib + the artifact `rpc-set-challenge-roi`).
- **Verify:** after the next wave ends, `SELECT count(*) FROM challenges WHERE status='active' AND ends_at < now()` = 0.
- **Revert:** git revert.

## 2. FMV recalc wastes ticks on inert uuid stubs (LOW — cleanliness; FMV-adjacent, Trevor review)

- **Where:** the fmv-recalc target-selection predicate (`app/api/fmv-recalc/route.ts` Step 2 candidate query).
- **What/why:** 163 of the 6,530 inert `UUID:UUID` TS stub editions (nulled dupes, non-canonical) carry a <7d fmv_snapshot — recalc spends budget pricing rows nothing renders. Exclude uuid-shape `external_id ~ '^[0-9a-f]{8}-'` TS rows from candidates. FMV-adjacent: Trevor reviews.
- **Verify:** `SELECT count(*) FROM fmv_snapshots f JOIN editions e ON e.id=f.edition_id WHERE e.external_id ~ '^[0-9a-f]{8}-' AND f.computed_at > now()-interval '24 hours'` trends to 0.

## 3. Pinnacle catalog expansion — the last real Pinnacle data gaps (MED)

Coverage measured 2026-07-16: sales attribution ~100% after the render bridge (fn `bridge_pinnacle_sales_editions`, daily selfheal `rpc-pinnacle-bridge-selfheal`); renders FMV 2,214/2,272; edition thumbs 351/503. Remaining, all one root cause — **the studio-GQL catalog walk doesn't cover every legacy edition**:
- **152 pinnacle_editions have zero `pinnacle_catalog` renders** (so no FMV rollup, no thumb, no render bridge for their sales).
- **154 editions have `mint_count` NULL** (do NOT derive from render sums — measured wrong: only 14/349 comparable editions match Σ render mints; get it from the editions-grain GQL).
- **Where:** the pinnacle catalog ingest (edge fn family — `pinnacle-listings-indexer` / catalog walk; find the writer of `pinnacle_catalog`) + `pinnacle-proxy` for GQL. Extend the walk to enumerate ALL editions/renders (the studio-platform GQL is documented in memory `[[pinnacle-studio-platform-graphql]]`; floor ÷1e8).
- **Verify:** editions with 0 renders → ~0; mint_count NULL → ~0; `ed_no_thumb` 152 → ~0 (the thumb fill + bridge fns then converge automatically — both are re-runnable).

## 4. Pinnacle resolver: stop burning ticks on bridge-covered rows (LOW)

- `pinnacle-nft-resolver` picked 100 candidates/tick and hit `null_edition` on 99 — the render-bridge now attributes those set-based. Either exclude rows whose render_id is bridge-covered from the resolver queue predicate, or let it be (the bridge daily cron drains first). File: the resolver edge fn.

## 5. Team-summary rollup incl. FMV totals (Trevor's freshness call — carried)

Your 07-16 measurement: `get_team_detail` dies on the FMV leg first under throttle, so the full rollup (not just 30d sales) is the real fix; displayed-$ go ≤1h stale. Trevor decides; design in the morning handoff §2 still applies, extended to FMV totals.

## 6. Operator (Trevor's machine)

- **Home-machine Task Scheduler revival** (`scripts/register-active-listings-task.ps1`): underpriced-#1s ingest (Atlas 403s ALL datacenter egress incl. CF Workers; GHA lane permanently dead — consider disabling `topshot-active-listings-ingest.yml`'s schedule, keep workflow_dispatch) + AllDay-badges ingest, both down since ~07-07/07-13.
- **ownership-sync-dune retrigger** (no successful run in retained history; last attempt failed 07-13; Top Owners stale): PowerShell `Invoke-WebRequest -Method POST -Uri "https://www.rippackscity.com/api/cron/ownership-sync-dune" -Headers @{ Authorization = "Bearer $env:INGEST_SECRET_TOKEN" }`.
- **Optional:** cron-job.org wmc-fmv-populate cadence 65s → 10 min (insurance; the index+delta already cut the I/O ~40×/15,000×).
- **rwfd catch-up cleanup** (if the night pass hasn't): when `SELECT count(*) FROM _rwfd_catchup_queue WHERE done_at IS NULL`=0 → `SET ROLE cron_heavy; SELECT cron.unschedule('rpc-rwfd-catchup-tick');` + DROP FUNCTION `_rwfd_catchup_wallet_tick()` + DROP TABLE `_rwfd_catchup_queue`.

## 7. Roadmap (as capacity allows — docs/strategy/roadmap-2026-07-14.md)

Mobile small-viewport pass; Pinnacle set-completion tracker; AllDay Top Owners (Dune or honest alternative); TS Autographs + Redeem cataloging (first-class on v2.nbatopshot.com, invisible in RPC).

---

**Guardrails:** direct-to-`main`, no branches/PRs; PowerShell `git` on Windows, re-verify `git rev-list --count origin/main..HEAD`=0; PowerShell `Invoke-WebRequest` for Vercel REST; `maxDuration` ≤800s; CRLF-safe full-file writes; `npx tsc --noEmit` + `npm test` pre-push; make sure the CODE commit is the push tip (docs-only tip = ignored-build-step cancels the deploy — force-deploy the SHA if stranded); watch the deploy to READY + smoke green.

**Expected end state:** challenges data self-expires; fmv-recalc prices only canonical rows; Pinnacle catalog/mints/thumbs at 100% with sales attribution converged; resolver quiet; operator lanes revived; roadmap items picked up in priority order.
