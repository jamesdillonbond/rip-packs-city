# Handoff — FMV trust + remaining audit items (consolidated, Claude Code) — 2026-06-04

Single authoritative work order from the 2026-06-04 platform audit + FMV deep-dive. Develop on `main`, commit + push to `main`, run smoke after each shippable unit. Rules: full-file edits, verify Supabase rowcounts + Vercel READY before calling anything done.

Source docs (read for evidence/locations):
- `docs/fmv-held-low-rootcause-2026-06-04.md` — AUTHORITATIVE FMV root-cause + code locations (CC, `171f226`).
- `docs/fmv-confidence-strategy-2026-06-04.md` — FMV plan L0–L7 + parallel-diagnostics addendum (All Day / Pack EV / UFC-Golazos).
- `docs/fmv-accuracy-targets-2026-06-04.md` — accuracy hit-list + the do-NOT-clamp rule.
- `docs/audit-2026-06-04-full-platform-health.md` + `docs/handoff-2026-06-04-audit-fixes.md` — the original audit.

Already shipped by CC (DO NOT redo): R1 offers FK (`audit_20260604_offers_moment_fk_on_delete_set_null`), C1 title dedup, C2 UFC footer, K1 ts-listing-ingest delete, M-2 PackTable breakpoint, C4 sub-$1 deals, C5 artless placeholder, C7 insider-buyback empties. Cowork shipped `v_tracked_wallet_fmv_confidence` view + `rpc-tracked-fmv-confidence` artifact.

Cross-cutting KPIs to check before AND after every FMV item below:
- `SELECT * FROM public.v_tracked_wallet_fmv_confidence;` (held-wallet HIGH+MED should rise, LOW fall).
- `v_fmv_sanity_flags` must not regress.
- Named editions: Chaz Lanier (207 sales, currently LOW showing 0 sales), `218:7778` Neemias Queta (FMV $6.40 fossil vs $0.30 real), plus one All Day fossil.
- Baseline now: held TS HIGH+MED 882 (~10%); held TS fossils 613; held All Day fossils 247.

======================================================================
SECTION A — FMV TRUST (pricing logic; Trevor has GREENLIT A1; A2+ after A1 soaks)
======================================================================

A1 — Cause-B fix: kill the Step-6 "fossil" + re-price traded editions. TS AND ALL DAY.
Trevor approved proceeding. The freshness bug: the GQL writers `upsert_topshot_marketplace_fmv` and `upsert_allday_marketplace_fmv` write `sales_count_30d=0` / LOW off a crude average; `/api/fmv-recalc` Step 6's "stale freshness touch" then re-stamps those forward as fake-fresh `1.7.0` (algo hardcoded ~`:926`), so actively-traded editions are pinned LOW showing 0 sales. Fix the SHARED path (Step 6) so it cannot carry a snapshot forward as fresh when that snapshot's `sales_count_30d=0` but the edition has real recent sales — instead let the real sales re-price (Step 1/5b) win, or skip the touch for such editions. Fixing Step 6 itself covers BOTH collections; if you instead patch the writers, you must patch both. Then re-price the held/traded fossils (one-time recompute over editions with >=5 sales/30d whose latest snapshot says 0).
Scope: 613 held TS fossils + 247 held All Day fossils (more globally). All Day is proportionally WORSE (49% of its traded held editions vs TS 32%) — do not ship a TS-only fix and call it done.
Validate: before/after the KPIs above; confirm Chaz Lanier and an All Day fossil flip off LOW with correct sales_count; confirm `218:7778` drops to its real ~$0.30–0.75. Watch a FULL cron cycle for re-fossilization — Step 6 has a self-perpetuating history (the 2026-05-30 NO_DATA cycle `14ae144`; the `dd84526` silent stall). 
Revert: `git revert` the route change; snapshots self-heal forward. Keep this isolated from A2.

A2 — Ask-corroborated confidence (only AFTER A1 has soaked one clean cron cycle).
In `lib/fmv-confidence.ts` (escalateConfidence) + wherever fmv-recalc finalizes confidence, take the edition's live ask (`edition_offers.low_ask`, joined by `collection_id` + `external_id`; present for ~100% of held TS/AllDay). Rule to implement + tune: if >=3 qualifying sales/30d AND the sales WAP/median is within ~20–25% of the live ask, raise ONE confidence step (LOW->MEDIUM, MEDIUM->HIGH with strong sample). If they diverge, do NOT raise. Keep ASK_ONLY for zero-sales editions unchanged.
CRITICAL: `low_ask` is a FLOOR. Use it only to corroborate (raise) or flag for review — NEVER to clamp/lower a sales-based FMV. A clamp false-positives on legit editions with lowball asks (e.g. `218:7826` CJ McCollum: FMV $4.38 ≈ $4.00 sales median, ask $0.34 — FMV is correct).
Validate: KPI view (held HIGH+MED rises further); spot-check that no correct FMV got clamped. Reset expectations — the original ~39% was an optimistic proxy; measure the real number.

A3 — Right-size the MEDIUM gate (verify, don't assume). The serial-residual HIGH gate is already wired (`fmv-recalc:535`) and working — do NOT "re-wire" it. After A1 clears the fossils masking the distribution, re-check that >=3 recent sales with a tight spread reliably clears MEDIUM; adjust the sample-size threshold only if the data shows it's too strict.

A4 — Accuracy gates before confidence (F-series). Most of the set-218 "inflation" is A1 fossils and should clear with A1 — re-measure first. Then finish: the serial>circulation guard (F3) in the recalc WAP path, and the 8:62 Cosmic / mis-key cleanup. An edition failing an accuracy sanity check must not rate above LOW.

A5 — Verify the two SPILLOVER surfaces after A1 (no separate logic; same fmv_snapshots).
(i) Pack EV: `pack_ev_latest` / the `/packs` +EV board sum per-edition FMV, so A1 de-inflates them automatically — re-check that the +450%-margin / low-FMV-coverage packs (and the overview "Top 5 Sniper Deals") normalize. (ii) Concierge: `/api/support-chat` `get_fmv` reads the same table and inherits A1 — just confirm a spot query returns the corrected value.

A6 — (Separate UI task, L5) FMV basis on portfolio/dashboard tiles. Show "$X — N sales (30d), ask $Y" like the squeeze-check tool, so even honest LOW reads as trustworthy. Reserve a visible "low confidence" treatment for genuinely thin/divergent editions only.

A7 — UFC / Golazos honest empty-states (thin market, NOT a bug). Held: UFC 362 (only 20 with sales/90d, 0 live asks), Golazos 44 (10 with sales, 0 ask). No ask feed → cannot ASK-fallback. Render an "insufficient market data" state for the ~94% with no market, and ensure the ~30 that DO trade are priced from sales. Low priority / low ROI.

======================================================================
SECTION B — REMAINING AUDIT CODE ITEMS (not pricing; ship independently)
======================================================================

B1 — Mobile overflow, sniper (M-1). `app/(collections)/[collection]/sniper/page.tsx` ~line 1566: the deals table sets `minWidth: 980` inside an overflow:auto parent — tablets 768–960px overflow. Change to `minWidth:"100%"` or gate the 980 behind a >=md check. Verify no horizontal scroll at 768px.

B2 — Mobile overflow, market (M-3). `app/(collections)/[collection]/market/page.tsx` ~lines 689, 714: fixed cell `minWidth` 110/180 widen columns on phones. Drop or make responsive under 640px.

B3 — Analytics horizontal overflow (C3/M-4). `app/analytics` (page + its dashboard child components) shows a horizontal scrollbar even at ~960px desktop. Find the widest child (a table/flex row without wrap) and wrap it in a div with `overflow-x-auto` — don't widen the page. Verify no horizontal scroll at 390px and 768px.

B4 — Flowty-proxy teardown (K2, the DEFERRED item — do NOT just delete). My original "zero live callers" precondition was wrong: 4 live routes still call the proxy URL — `allday`/`golazos`/`topshot` listing routes (three `throw` on non-OK) + `listing-cache`. Proper teardown: remove the Flowty fetch legs from those 4 routes (Flowty shut 2026-05-13; the data is frozen/dead), retire their cron-job.org entries, THEN delete `supabase/functions/flowty-proxy`. Grep `flowty-proxy` + `api2.flowty.io` to confirm zero remaining callers before deleting. Ship the route changes first (smoke green), then the proxy delete. Revert: `git revert`.

(Skip, already correct: C6 skeletons exist; C8 pipeline-stale badge intentional. Optional/cosmetic: C9 title-strategy normalize, C10 insights surface-F label.)

======================================================================
SECTION C — OPERATOR (no code; Trevor, cron-job.org)
======================================================================
- K3 — dial "RPC FMV Recalc Force Stale" from `3,13,23,33,43,53` back to `8,28,48` (the first full sweep is long done; verified safe 2026-05-30).
- N1 — re-fire `snapshot-institutional-wallets` (curl -H "Authorization: Bearer $INGEST_SECRET_TOKEN" <fn-url>); consider moving its slot off the 06:00Z cron-rush peak.
- K4 — confirm or prune `cron-schedule.md` entries not seen live in 48h: `classify-acquisitions-multicollection`, `lock-check-batch`, `run-insider-detectors`.
- (After B4 ships) retire the Flowty listing crons tied to the torn-down routes.

======================================================================
SUGGESTED SEQUENCE
======================================================================
1. A1 (greenlit) — ship isolated, soak one cron cycle, verify KPIs incl. All Day. 
2. In parallel / independent: B1, B2, B3 (mobile), B4 (Flowty teardown).
3. After A1 verified: A5 (confirm pack-EV + concierge normalized), A4 (re-measure F-series), then A2 (ask-corroboration), A3 (gate check).
4. A6 (UI basis) and A7 (UFC/Golazos empty-states) when convenient.
5. Operator items C any time.
