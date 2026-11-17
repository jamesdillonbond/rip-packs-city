# Stage-B catalog inputs — pre-staged + 3 refinements (2026-06-20, read-only)

Read-only prep for the Stage-B catalog step (the 1,374 `::` parallel editions), run off the now-complete `topshot_moment_subeditions` resolution table. Confirms scope and corrects two assumptions in the catalog plan before the dedicated session runs.

## Scope confirmed
- Distinct (base_external_id, subedition_id) combos = **2,115** = 741 standards + **1,374 parallel editions to catalog** — matches CC's 1,374 exactly.
- Sanity: avg per-parallel max-serial ≈ 177, max ≈ 4,000 — sane mint sizes, not garbage.

## REFINEMENT 1 (important) — per-parallel circulation must come from ON-CHAIN, not wmc/sales max-serial
The plan says "per-parallel circ via max-serial." But our max-serial is a LOWER BOUND — we only see held (wmc) or traded (sales) moments, not the full mint. Evidence on Traoré 233:8121: Standard wmc max-serial = **128**, but the base edition's recorded `circulation_count` = **164**. So max-serial understates true circulation (Standard 128 held vs 164 minted; Hexwave wmc-max 24; Jukebox wmc-max 9 — all floors).
- Source each parallel's `circulation_count` from ON-CHAIN: the SubeditionAdmin / TopShot subedition mint count (numberMinted per subedition), the same on-chain layer that gave us `getMomentsSubedition`. Use our max-serial only as a sanity floor (true circ must be ≥ it).
- Do NOT assume the base edition's existing `circulation_count` (164 here) is the STANDARD parallel's true count without confirming on-chain — it may be a conflated/legacy value. Understating circ would skew squeeze %, rarity, and the serial-FMV model.

## REFINEMENT 2 — subedition NAMES live in code, not a DB table
Only `topshot_moment_subeditions` exists (no subedition-name catalog table). The `subedition_id → name` mapping (19=Hexwave, 20=Jukebox, … the 22-name set) is the `PARALLEL_IDS` code constant (lib/.../market-scope.ts per the Phase-0 discovery). The catalog must source `subedition_name` from that constant — either join it at catalog time or seed a small `topshot_subedition_names` lookup from it. Don't expect a DB name source.

## REFINEMENT 3 — 65 parallel combos have no wmc serial
65 of the 1,374 parallel (base, subedition) combos have NO wmc serial (only traded-not-held or sparse moments). For per-parallel art/serial/circ on those, fall back to sales serials and/or on-chain — don't drop them from the catalog.

## Net
Catalog scope (1,374) is confirmed and the resolution layer is sound. The one plan change: pull per-parallel `circulation_count` from on-chain (authoritative numberMinted), not from our held/traded max-serial — with max-serial as a floor check. Names come from the `PARALLEL_IDS` code constant. Per-parallel art is `TopShotIPFSResolver.getCIDs(setID, playID, subeditionID)` per the existing plan. After catalog+remap, recompute per-parallel FMV via the canonical `fmv-recalc` (the hard rule), then verify the acceptance gates (Traoré Standard ≈ $23 — already pre-validated at $23.00 median against resolution-attributed sales).
