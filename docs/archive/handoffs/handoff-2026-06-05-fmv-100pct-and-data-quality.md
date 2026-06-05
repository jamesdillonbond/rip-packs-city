# Handoff — FMV confidence toward 100% + data quality + remaining audit (2026-06-05, Claude Code)

Fresh consolidated work order. Develop on `main`, commit + push to `main`, smoke after each shippable unit. This is the FMV thread only (Trevor is running a separate build elsewhere — don't touch that). Prior context: `docs/fmv-confidence-strategy-2026-06-04.md` (incl. the post-ship RESULT + keystone), `docs/fmv-held-low-rootcause-2026-06-04.md` (authoritative root-cause), `docs/handoff-2026-06-04-fmv-trust-and-remaining.md` (still-open items).

Status going in: the held-LOW fossil generator (Step-1 PostgREST 1000-row truncation) is FIXED (`1c5ccf5` + `bf4cbd5`); the sweep is repricing live (held TS HIGH+MED 10%→15% and climbing, fossils TS 955→137 / AllDay 338→183). N1 (institutional-wallets) already re-fired by Trevor.

## Framing of "100%" (read first — it changes the target)
Literal "100% HIGH confidence on every edition" is NOT the goal and should not be pursued: ~3,900 TS + ~520 AllDay editions have NEVER traded (NO_DATA). Forcing HIGH on a never-traded item = a confident-wrong price, which violates the entire trust mission (a confident wrong price is worse than an honest unknown). The correct, achievable goal:
- **100% accurate** — every shown value is correct given its data (no fossils, no mis-keys, correct circulation).
- **100% honestly-labeled** — HIGH only when sales support it; ASK_ONLY / LOW / estimated / "no market" clearly communicated.
- **Maximal HIGH/MED** wherever the market actually supports it.
Two ceilings must be RAISED first (Part 1, data quality), then confidence maximized on the clean set (Part 2).

Current global confidence (all editions): TS 1,796 HIGH+MED (11%) / 9,697 LOW / 3,898 NO_DATA over 16,470; AllDay 379 (6%) / 4,745 LOW / 523 NO_DATA over 6,191. Note the TS total is inflated by ~7,374 inert dupes (below).

======================================================================
PART 1 — DATA QUALITY (raises the ceiling; do FIRST — this is the topshotexplorer insight)
======================================================================
topshotexplorer.com (Trevor's reference) reads on-chain TopShot directly (Flow REST `ExecuteScriptAtLatestBlock`, Cadence against the TopShot contract) — the SAME ground truth RPC already has via `topshot-proxy` (GQL `searchEditions`) + `spork-proxy` + the Cadence `TopShot.getPlayMetaData(playID)` / `getSetData(setID)` / `QuerySetData` calls in CLAUDE.md. So: NO third-party dependency — reconcile our `editions` table against on-chain. topshotexplorer stays a human spot-check.

Live integrity gaps (TS, 16,470 rows):
- ~7,374 (45%) inert UUID-keyed dupes (external_id not `setID:playID`); 7,330 missing `set_id_onchain`/`play_id_onchain`.
- 1,963 bad circulation (NULL or 0); 1,311 missing tier; 7,650 missing thumbnail.
- AllDay metadata is CLEAN (its "uuid_keyed" flag is a false positive — AllDay keys are single-integer `editionFlowID`, not `setID:playID`).

DQ1 — Merge/retire the ~7,374 TS UUID-keyed dupe editions (canonical-merger, like the 2026-05-26 dedup pass). They are unpriceable noise that inflates NO_DATA and the confidence denominator. They have FK dependents (per CLAUDE.md: ~33k pack_drop_pool, ~16k moments, ~13.8k fmv_snapshots, ~7k sales) — RE-POINT dependents to the canonical integer-keyed edition, THEN retire the dupe. Do NOT bulk-delete. The `editions_block_topshot_uuid_dupe_trg` trigger already keeps new ones inert; this drains the historical backlog. Validate: canonical TS edition count stabilizes ~9k; 0 orphaned dependents; confidence % recomputed over canonical editions only.

DQ2 — On-chain edition-integrity reconcile sweep (new, periodic). For each canonical TS edition, compare `editions.{circulation_count, tier, set_id_onchain, play_id_onchain, retired, player_name, set_name}` against on-chain truth (`searchEditions` via topshot-proxy, or `getPlayMetaData`/`QuerySetData` via Cadence). Backfill the 1,963 bad-circulation + 1,311 missing-tier; surface mismatches in a new `v_edition_integrity_flags` view + a cron like the other pipelines. WHY THIS RAISES FMV CONFIDENCE: circulation is the squeeze-board denominator AND an input to the serial-residual HIGH gate (`fmv-recalc:535`) — wrong circulation => wrong squeeze% + wrong confidence gating; wrong set/play keys => sales aggregate to the wrong edition => wrong WAP. Use the Cadence MCP to verify struct fields before writing any new script (per CLAUDE.md Cadence rules); route production reads through the existing proxies, never direct to rest-mainnet.

DQ3 — Thumbnail backfill for the canonical artless editions (the ~715 real-but-artless TS canonicals noted in CLAUDE.md, separate from the dupe noise). Improves entity pages + removes the blank-image CX issue (audit C5 placeholder already shipped as the fallback).

======================================================================
PART 2 — FMV CONFIDENCE (maximize HIGH/MED on the clean canonical set)
======================================================================
F1 — Finish the fossil sweep (in progress, no action) + UN-PARK A2 and L4 when ready:
  - A2 ask-corroboration (biggest reachable lever): when >=3 sales/30d AND sales WAP/median within ~20-25% of `edition_offers.low_ask`, raise one confidence step (LOW->MED, MED->HIGH with strong sample); diverge => stay LOW. `low_ask` is a FLOOR — corroborate/flag only, NEVER clamp (false-positives on lowball asks, e.g. `218:7826`).
  - L4 held-first reprice: one-shot recompute over `seeded_wallets.is_active` editions so tracked wallets fully resolve immediately instead of waiting for the cursor.

F2 — Cohort/comparable estimate for the NO_DATA tail (TS ~3,898 minus dupe noise, AllDay ~523). Estimate price from sibling editions (same set+tier+circulation-band, or player+set), shown as an explicit low-confidence "estimated / from N comparables" basis — NOT HIGH/MED. Shrinks NO_DATA without faking confidence. CAUTION: an earlier naive cohort attempt was rejected as too dispersed (CLAUDE.md) — validate per-cohort dispersion (CV) before shipping; only emit an estimate when the cohort is tight enough, else keep honest NO_DATA.

F3 — Throughput / no re-staleness: confirm fmv-recalc's cursor laps the full canonical edition set within a bounded window (days), so nothing re-fossilizes; pairs with operator K3 (cron dial-back). Add a tripwire if any canonical edition's latest snapshot ages past the sweep period.

F4 — Presentation (L5): every portfolio/dashboard/insights FMV tile shows the basis + honest confidence — "$X · N sales (30d), ask $Y" / "estimated from N comparables" / "no market data yet". Mirrors the squeeze-check tool's honesty.

F5 — Measurement: `v_tracked_wallet_fmv_confidence` (held) + live artifact `rpc-tracked-fmv-confidence`; consider a global twin view. Target: HIGH+MED maximized on canonical editions, NO_DATA reduced to only the genuinely-never-traded, every value accurate.

======================================================================
PART 3 — REMAINING AUDIT CODE ITEMS (independent of FMV)
======================================================================
B1 — sniper `app/(collections)/[collection]/sniper/page.tsx` ~1566: table `minWidth:980` overflows tablets — `minWidth:"100%"` or gate behind >=md.
B2 — market `app/(collections)/[collection]/market/page.tsx` ~689/714: fixed cell minWidth 110/180 — drop/responsive under 640px.
B3 — analytics horizontal overflow (`app/analytics` + dashboard children): find the widest child, wrap in `overflow-x-auto`; verify no h-scroll at 390/768px.
B4 — Flowty-proxy teardown (do NOT just delete): 4 live routes still call it (`allday`/`golazos`/`topshot`/`listing-cache`, 3 throw on non-OK). Remove the Flowty legs from those routes + retire their cron-job.org entries, THEN delete `supabase/functions/flowty-proxy`. Grep `flowty-proxy` + `api2.flowty.io` to confirm zero callers before deleting.

======================================================================
PART 4 — OPERATOR (Trevor, no code; N1 DONE)
======================================================================
- K3 — dial "RPC FMV Recalc Force Stale" cron `3,13,23,33,43,53` -> `8,28,48`.
- K4 — confirm/prune cron-schedule.md entries not seen live 48h (classify-acquisitions-multicollection, lock-check-batch, run-insider-detectors).
- Glance: confirm `topshot-listing-cache` resumed (was stalled ~84 min around 23:42–01:06 UTC).

======================================================================
SUGGESTED SEQUENCE
======================================================================
1. DQ1 (dupe merge) + DQ2 (on-chain reconcile + circulation/tier backfill) — raises the ceiling and cleans the denominator; biggest structural win.
2. F1 (un-park A2 + L4) once the fossil sweep reads clean — maximizes HIGH/MED on the cleaned set.
3. F2 (cohort estimate) to shrink the honest NO_DATA tail; F4 (basis UI) so confidence reads as trustworthy.
4. B1–B4 (audit code) any time, independent.
5. DQ3, F3, F5, operator items as capacity allows.

Per-item: validate before/after on `v_tracked_wallet_fmv_confidence` + `v_fmv_sanity_flags` + named editions; everything independently `git revert`-able; DQ migrations are destructive (merge/retire) — follow the rpc-migration checklist (verify rowcounts, re-point before retire, no bulk-delete).
