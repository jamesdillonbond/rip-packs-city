# RPC open backlog — consolidated tracker (2026-06-05)

Single source of truth for everything still open after the 2026-06-04/05 platform audit + FMV engagement. The substantive work (FMV correctness, data quality, confidence to ~98%, public-surface accuracy) is DONE; what's below is the remaining cleanup + the intentional honest gaps. Consumed handoffs archived to `docs/archive/handoffs/`.

## Code — Claude Code (priority order)
1. **Pack-EV public board fix** (P1) — `docs/handoff-2026-06-05-public-surface-pack-ev.md`. The `/insights/pack-reality` "top EV" board is 84% stale (<=44d), 84% >=90% depleted, 33% implausible ratios (max 71x). Filter to fresh/rippable/covered packs, fix recompute coverage, badge high-variance. The ONLY broken public surface — everything reading live FMV (deals, squeeze, rookies) verified healthy.
2. **B1 — sniper mobile overflow**: `app/(collections)/[collection]/sniper/page.tsx` ~1566 `minWidth:980` → `minWidth:"100%"` / >=md gate.
3. **B3 — analytics horizontal overflow**: `app/analytics` + dashboard children; wrap the wide child in `overflow-x-auto`.
4. **B4 — Flowty-proxy teardown** (deferred): remove the Flowty legs from the 4 live routes (`allday`/`golazos`/`topshot`/`listing-cache`) + retire their crons, THEN delete `supabase/functions/flowty-proxy`.
5. **DQ4 — dupe-writer leak** — ✅ **CLOSED 2026-06-06 (edge fn v20 `bf4c38c`, now v21); verified 2026-06-14.** The re-key shipped: `editionExtKey` in `compute-topshot-pack-ev` now prefers the on-chain int pair `${set.flowId}:${play.flowID}` (requested inline in `EDITIONS_QUERY`), so `seed_topshot_editions` only ever receives canonical int-pairs and stops minting inert UUID dupes. Evidence: last UUID-keyed TS edition created 2026-06-06 15:39 (the v20 deploy); 0 new in 48h; `uuid_fallback_keys=0` on every recent tick (and 86 ticks/36h per the 06-07 session); sentinel UUID-leak-48h = 0; trust-health `ts_uuid_dupes_created_24h` = 0 (ok, breach 200). Rollback of the re-key = redeploy v34 source / `git show bf4c38c~1:supabase/functions/compute-topshot-pack-ev/index.ts`. **Residual (separate, NOT DQ4):** ~6,400 pre-2026-06-06 fossil UUID rows still sit inert in `editions` (trigger-gated, no corruption). Clearing them is the Item B2 one-time canonical merge (`docs/audits/item-b2-uuid-merger-plan-2026-05-30.md`) — explicitly a careful manual sit-down task, do NOT run autonomously.
6. **F4 tail** — grid/team entity tiles lack the basis inputs (sales_count/ask) on their API payload; surfacing the basis there needs an API change (out of the pure-presentation pass already shipped).
7. **Doc archive** — `git mv` the older committed shipped handoffs (06-01 → 06-04 non-overnight) into `docs/archive/handoffs/` in a CC commit (sandbox can't run git safely).

## Operator — Trevor (no code)
8. **K3** — dial "RPC FMV Recalc Force Stale" cron `3,13,23,33,43,53` → `8,28,48`.
9. **K4** — reconcile `cron-schedule.md` entries not seen live 48h (classify-acquisitions-multicollection, lock-check-batch, run-insider-detectors).
10. **Commit the docs** — `git add docs/ && git commit -m "docs: 2026-06-04/05 audit + FMV engagement"` (Cowork can't push; that's why they accumulated).

## Intentional honest gaps (NOT backlog — by design, do NOT "fix" with guesses)
- ~228 truly-no-market TS editions → honest NO_DATA (no sales, no ask).
- UFC / Golazos thin markets (no ask feed) → honest "insufficient market" states.
- 37 NULL-tier / 325 NULL-thumbnail canonical editions → no accurate source exists; guessing injects confident-wrong data. Tracked by `v_edition_integrity_flags`.

## Done this engagement (for reference)
FMV correctness (`bf4cbd5`/`1c5ccf5`), data quality (16,470→9,123 clean canonical TS, on-chain reconcile, `v_edition_integrity_flags`), confidence (A2 `b8a0a49` + Step-5c ASK fallback `d881a75` → held TS HIGH+MED 10%→27.6%, canonical ~97.5% honestly labeled), F4 basis renderer (`fd61038`), OG/SEO (`b3dae3d`/`23fc419`), audit fixes (`9cfba65`/`ff1e43d`), public-surface sweep (3/4 healthy). Records: `fmv-confidence-strategy-2026-06-04.md`, `fmv-held-low-rootcause-2026-06-04.md`, `audit-2026-06-04-full-platform-health.md`.

---

## Update — 2026-06-05 (post-daytime-monitor + durable monitoring)
- **DQ4 ELEVATED from "deferred/bounded" → near-term priority.** ✅ **RESOLVED the next day (2026-06-06, edge fn v20 `bf4c38c`) — see item 5 above for the verification.** The daytime monitor + the new trust-health guardian both caught it: the `seed_topshot_editions` writer is re-minting inert UUID dupes at ~550/hr, re-filling the DQ1/DQ2 drain in real time (TS-UUID-48h sentinel headed for the 2000 CRITICAL line). The dupes stay inert (trigger-protected, no corruption), but the dedup win is Sisyphean until the writer is re-keyed. CC's disposition (`0441d8b`: a naive DB-side skip regresses pack-EV) still holds — the real fix is re-keying the pack-EV edge flow to canonical integer editions [shipped as the v20 int-pair `editionExtKey` preference]. Worth prioritizing so the clean-canonical set stays clean and the CRITICAL sentinel stops firing daily (alert fatigue) [sentinel now quiet at 0 for 8+ days].
- **SEC1-EXP FIXED (Cowork, `audit_20260605_harden_dq_scratch_tables_rls`).** CC's dedup work left `audit_dq1_dupe_map` / `audit_dq2_merge_map` / `audit_dq2_uuid_resolve` RLS-off + anon/auth-writable. Hardened in place (RLS on + grants revoked; not dropped, since the dedup re-mint is ongoing). Posture restored: 0 RLS-off base tables, 0 anon writes on the three. The night pass can DROP them once the DQ work settles.
- **Durable trust-health guardian SHIPPED (Cowork).** `public.v_rpc_trust_health` (service_role, fast — 5 data-rot metrics: pack-EV staleness/depletion, dupe-rate, integrity drift, impossible-FMV) + daily `rpc-trust-health-watch` scheduled task. Encodes the silent-rot classes this engagement found so the accuracy can't quietly erode again. Currently: only the known DQ4 dupe-rate breaches; all else green.
