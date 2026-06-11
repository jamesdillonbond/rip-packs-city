# Proposal (review-gated): ASK_ONLY sanity cap — kill the troll-ask tail without biasing the bulk

Status: READY FOR REVIEW (Trevor or a reviewed CC session). Pricing-logic change — deliberately NOT shipped unilaterally per the fmv-pipeline-patch-restraint rule, even with blanket best-judgment authority, because the data argues against the originally-memoed fix.

Evidence (LiveToken crosscheck, 989 matched rows, 2026-06-10, table audit_lt_matches):
- ASK_ONLY population n=199: median rpc/lt ratio 1.11, p90 2.50, severe-high (>4x) = 6.
- The memoed recommendation ("realization ~0.75, cut the multiplier") would move the MEDIAN to ~0.93 — fixing 6 rows by underpricing ~190. Rejected on the data.
- The actual failure mode is a LONE fantasy ask inheriting through ask*0.90 (worst case: edition 8:110 Devin Booker LEGENDARY, rpc $6,750 ASK_ONLY vs LiveToken $1,460, ratio 4.62).

Proposed change (single concept, multiple writer touchpoints):
ASK_ONLY price = LEAST( ask * 0.90, CAP ) where CAP = k * set_recent_sales_median for the edition's set+tier cohort (suggest k=3, mirroring the existing 3x-median conventions in fmv-recalc), falling back to k * tier-wide median when the set cohort has <5 sales in 90d, and to UNCAPPED only when no cohort baseline exists (then consider keeping NO_DATA instead — a lone ask with zero cohort context is the troll signature; cf. the ts-nodata-troll-asks rule: never auto-promote zero-sale editions on a single ask).
Writers that stamp ASK_ONLY (verify the list at implementation time; known: fmv-recalc Step 5b badge_editions.low_ask path; drain_fmv_cold_tail ASK_ONLY fallback (DB fn); allday-gql-v1 lowestPrice path). Apply the cap consistently or document why a writer is exempt.
Acceptance: re-run the LT comparison on the ASK_ONLY cohort — median stays ~1.0-1.1, severe-high count drops 6 -> ~0, severe-low does not grow.
Revert: per-writer (git revert / CREATE OR REPLACE prior fn body).

Companion decisions recorded 2026-06-11 (Trevor delegated best-judgment):
- PIN-FMV-REKEY-WAVES 2/3: stays parked for an interactive Trevor session; recommendation = wave 2 on lowest-traffic surfaces first.
- PACKVIZ-GRID: stays parked (pre-traction polish).
- audit_lt_matches: KEEP (hardened, ~1MB) as evidence for the per-serial program; revisit at the 06-16 dependency digest.
