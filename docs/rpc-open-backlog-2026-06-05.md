# RPC open backlog — consolidated tracker (2026-06-05)

Single source of truth for everything still open after the 2026-06-04/05 platform audit + FMV engagement. The substantive work (FMV correctness, data quality, confidence to ~98%, public-surface accuracy) is DONE; what's below is the remaining cleanup + the intentional honest gaps. Consumed handoffs archived to `docs/archive/handoffs/`.

## Code — Claude Code (priority order)
1. **Pack-EV public board fix** (P1) — `docs/handoff-2026-06-05-public-surface-pack-ev.md`. The `/insights/pack-reality` "top EV" board is 84% stale (<=44d), 84% >=90% depleted, 33% implausible ratios (max 71x). Filter to fresh/rippable/covered packs, fix recompute coverage, badge high-variance. The ONLY broken public surface — everything reading live FMV (deals, squeeze, rookies) verified healthy.
2. **B1 — sniper mobile overflow**: `app/(collections)/[collection]/sniper/page.tsx` ~1566 `minWidth:980` → `minWidth:"100%"` / >=md gate.
3. **B3 — analytics horizontal overflow**: `app/analytics` + dashboard children; wrap the wide child in `overflow-x-auto`.
4. **B4 — Flowty-proxy teardown** (deferred): remove the Flowty legs from the 4 live routes (`allday`/`golazos`/`topshot`/`listing-cache`) + retire their crons, THEN delete `supabase/functions/flowty-proxy`.
5. **DQ4 — dupe-writer leak** (deferred, bounded): re-key the `compute-topshot-pack-ev` edge flow to canonical integer editions so `seed_topshot_editions` stops minting inert UUID dupes (~250/6h). Inert (trigger-gated) + bounded by the DQ2 resolver; tracked by `v_edition_integrity_flags`.
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
