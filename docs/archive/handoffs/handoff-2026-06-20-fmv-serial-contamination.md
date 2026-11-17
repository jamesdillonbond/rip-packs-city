# RPC Claude Code handoff — base FMV is contaminated by low-serial premium sales (FMV > low ask) (2026-06-20)

> SECONDARY / DOWNSTREAM. Do handoff-2026-06-20-fmv-parallel-conflation.md FIRST. The bigger root cause of the Traore FMV-over-ask case is PARALLEL CONFLATION (multiple parallels of one play collapsed onto a single setID:playID edition). This serial-normalization is a real refinement but applies WITHIN a parallel, AFTER parallels are split — applying it first would only MASK the conflation. Some of the "low-serial premium sales" below were actually a different (more valuable) parallel's moments, not low serials of the same parallel.

This is central FMV pricing logic → REVIEWED change (per the fmv-pipeline-patch-restraint rule). Diagnosis below is measured, not assumed. Trevor flagged it from a deal alert: Nolan Traore "Metallic Gold LE" showed FMV $45.83 with a $23 low ask — a fake "deal."

## The problem (proven)

The base/edition FMV (algo 1.7.0, a recency-weighted WAP in app/api/fmv-recalc + lib/fmv-confidence.ts) averages ALL serials' sale prices together — including low-serial sales that carry a large collector premium. That inflates the edition FMV above what a typical serial actually trades for (and above the floor ask).

Nolan Traore "Metallic Gold LE" (edition_id a6ec315c-91c0-4e17-a61b-27fd1935d0da, external_id 233:8121, RARE, circ 164), last 120 days:
- Typical serials (>20): n=41, MEDIAN $23.00, avg $21.82 — this equals the $23 low ask.
- Low serials (<=20): n=21, MEDIAN $39.00, avg $40.10 — the premium.
- The three most-recent sales were low serials (#6 $59, #6 $46, #3 $73), so the recency-weighted WAP landed at $45.83 — ~2x the typical-serial floor.
- Sanity check: his Origins edition (same player, same RARE tier, same circ 164, same $23 ask) reads FMV $28 — far less contaminated because fewer recent low-serial premium sales. Same-edition serial premium is the only thing that differs.

## It is systemic, not a one-off

TS editions that have BOTH a low_ask and a sales-based FMV (HIGH/MED/LOW): 6,478. Of those:
- FMV > low_ask: 3,621 (56%)
- FMV > 1.25x low_ask: 2,532 (39%)
- FMV > 1.5x low_ask: 1,958 (30%)

In an efficient market FMV should sit near the floor ask for most editions, with genuine deals (ask < FMV) the minority. The MAJORITY reading above ask is systematic upward bias — consistent with the serial-premium contamination proven above (plus some legitimate falling-market deals and some troll/stale asks, which are NOT the bulk). This directly produces fake "deals" on the deal board + in the omni-channel alerts.

## The fix — make the base FMV serial-aware (compute it on TYPICAL serials)

The correct structure (and what the multi-factor serial-FMV work is already building): base FMV = the value of a TYPICAL serial; the low-serial premium is a SEPARATE layer (serial_fmv_power_model / the multi-factor model). The base writer just needs to stop averaging premium serials into the typical floor.

In the 1.7.0 WAP computation, EXCLUDE special/premium-serial sales from the base average:
- exclude serial = 1 (#1)
- exclude serial = circulation_count (perfect / last-mint)
- exclude serial = the edition's jersey number (editions.jersey_number)
- exclude "low" serials below a threshold — e.g. serial <= GREATEST(low_floor_abs, ceil(circulation_count * low_serial_pct)). Start with low_serial_pct ~0.10 and low_floor_abs ~15, then TUNE: after the change, the base FMV for an edition should land near its typical-serial median (and near the floor ask for liquid editions). For Traore Metallic Gold LE that yields ~$23, matching the ask.

Now that serial_number is populated on ~all sales (including the offer-fill backfill we just completed), the writer can filter by serial cleanly. Keep the existing recency-weighting + outlier filtering ON TOP of the serial filter (so the base WAP is recency-weighted typical-serial sales).

Edge cases to handle:
- Very low circulation (e.g. circ <= 25, like Ultimates/Legendaries): excluding serials <= 10-15% may leave too few sales. Fall back to "exclude only #1/jersey/perfect" (don't drop the low-serial band) when the typical-serial sample would be too thin, or widen the window. Don't let the filter push a real edition to NO_DATA.
- Don't double-count: a serial can be #1 AND low — exclude once.

DO NOT just hard-cap FMV at the low ask (FMV = min(fmv, low_ask)). That masks the root cause and breaks on troll/stale asks — a $1 troll listing would crater a real edition's FMV. The serial-normalized base is the correct fix; the ask is a sanity reference, not a ceiling.

## Cascade / verify

- This fixes the deal board (cross_collection_deals_board) and the omni-channel deal alerts automatically: once base FMV ~= the typical floor, the fake "deals" (ask == floor mislabeled as a discount vs an inflated FMV) disappear. Re-check the deal board after deploy.
- Verify: re-run the over-ask scan (the systemic query above) — the over-ask count should drop sharply (toward genuine deals + troll asks only). Spot-check Traore Metallic Gold LE: base FMV should land ~$23. Confirm no mass regression to NO_DATA (the low-circ fallback above guards this).
- The low-serial premium for specific low serials is then surfaced via the serial_fmv layer (SERIAL_FMV_PUBLIC), which is the right place for it — keep that intact.

## Files
- app/api/fmv-recalc/route.ts — the 1.7.0 base WAP write path (the sales select + the WAP/median computation).
- lib/fmv-confidence.ts — the confidence/escalation logic (the serial-residual gate here is about DISPERSION for HIGH; this change is about the base CENTRAL value, separate but related — the same serial column feeds both).

## Guardrails
Direct-to-main, no PRs; PowerShell git, verify git rev-list --count origin/main..HEAD = 0; tsc clean. FMV writes are delete-then-insert, collection_id NOT NULL, never upsert (CLAUDE.md). After: re-verify a sample of editions' base FMV against their typical-serial median + floor ask before considering it done; this is a reviewed pricing change — validate before trusting.
