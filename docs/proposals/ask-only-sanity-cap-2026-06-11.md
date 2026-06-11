# Proposal (review-gated): ASK_ONLY sanity cap — kill the troll-ask tail without biasing the bulk

Status: **DECIDED — DO NOT SHIP THE CAP (2026-06-11, CC review, Trevor in the loop).** The cap mechanism is disproven by its own acceptance test, and the investigation it triggered found the real root cause is upstream: a TopShot **sales-ingest gap** concentrated in ASK_ONLY. See "Review verdict" below. The cap section is preserved as the original proposal for the record.

---

## Review verdict (2026-06-11)

**1. Premises confirmed** against live `audit_lt_matches`: ASK_ONLY n=199, median rpc/lt 1.113, p90 2.504, severe-high(>4x)=6, severe-low(<0.25)=0. ✓

**2. The literal cap (k=3 × set+tier median) FAILS its own acceptance test** on the matched cohort:
- median 1.113 → **0.559** (over-corrects)
- severe-high 6 → 2 (fixes only 4 of 6)
- severe-low 0 → **54** (creates 54 under-priced rows)
- 124 of 199 capped (62%)
Reason: ASK_ONLY editions are *selected* for illiquidity — they're the rarer/low-serial parallels whose true value sits well above the set median. A set-median cap guts legitimate premium editions. Own-history anchoring also fails: 139/199 have no sales at all in our data, and `fmv > 3×own-max-sale` = **0 rows** (the asks aren't absurd by the editions' own records).

**3. The "troll-ask" framing is mostly wrong.** The 6 severe-high split into two stories:
- **Booker Cosmic 8:110** (the proposal's headline worst-case): own sales median **$2,214**, max **$8,422**, last sale 2026-04-19. RPC's ~$6,750 (ask×0.9) is *defensible*; LiveToken's $994–1,460 is the low estimate. Capping it would INTRODUCE error and conflicts with the deliberate `dampenGrailSpike` high-tier-spread carve-out (memory: fmv-grail-spike-and-ask-precedence-guards — "don't lower the 3× serial gate").
- **Ewing 205:7136 / Grant 103:3792 / etc.**: real editions with real trades **our `sales` pipeline never captured** (LiveToken tracks them; Trevor personally bought Grant ×2 at $67/$79 — recorded in `moment_acquisitions`, absent from `sales`).

**4. Root cause = a sales-ingest gap, concentrated in ASK_ONLY.** Across the 989-row LiveToken crosscheck, the share of editions LiveToken values but for which we have **zero sales**:
- ASK_ONLY: **115/169 (68%)**  · LOW: 1/413 (0%) · MEDIUM 0/145 · HIGH 0/47 · STALE 1/20.
So editions whose sales we captured price LOW/MEDIUM/HIGH correctly; **ASK_ONLY is, to first approximation, the bucket of editions whose sales we failed to ingest.** Live TS ASK_ONLY: 785/1005 (78%) have 0 sales in our DB.

**Recommended follow-up (NOT auto-shipped — FMV-feeding pipeline change, needs Trevor's direction):** close the sales gap so these editions price off real WAP instead of falling back to ask×0.9.
- Quick win: ~**134** live TS ASK_ONLY editions already have a recorded `moment_acquisitions` marketplace buy_price (243 have some acquisition record) that was never promoted into `sales` (they arrived via `browser_backfill`/`livetoken_activity`, not the on-chain indexer). A guarded promotion of those would reprice them. Decide source-confidence first.
- Fuller fix: a per-edition historical sales backfill from the TS marketplace GQL (`searchMarketplaceTransactions`) and/or the LiveToken activity feed for the ASK_ONLY population, since our `sales` history is shallow for illiquid editions while LiveToken's is deep.
- Until then, ASK_ONLY honestly labels these as ask-derived — no number is fabricated; the label IS the mitigation.

Original (now-superseded) proposal follows.

---

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
