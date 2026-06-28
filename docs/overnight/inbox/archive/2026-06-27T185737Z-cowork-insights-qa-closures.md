# Cowork interactive — insights-QA closures (live/visual leg)

Source: interactive Cowork session, Chrome live QA against prod (anon). Closes the two
insights-QA items the 06-27 overnight pass QUEUED because its web_fetch was
provenance-blocked from the live/visual leg. Data/security/routing were already verified
by the pass; this is only the remaining HTTP/visual confirmation.

## CLOSE — NEW-COLLECTORS-INSIGHTS-QA  (live/visual leg PASS, no fixes)
/insights/new-collectors, anon, prod:
- API 200: summary(3) / spend(3) / gateway(30d+90d sets+players) / cohorts(back to 2022-03)
  + meta.coverage_note present.
- Page honest: leads with the DEBIASED new count (197) with first-seen (268) muted +
  "directional"; "active/returning/market-$ reliable" caveat shown; cohort table = 15
  months default + "show all to Mar 2022" with the "older-month cohort size undercounts,
  rises as backfill lands" caption + full methodology footer. The misleading 90d vs-prior
  delta is intentionally NOT displayed. Brand tokens correct.
- Sitemap entry + OG png already confirmed (CC ledger entry 2026-06-26).

## CLOSE — ROOKIE-BOARD-INSIGHTS-QA  (live/visual leg PASS, no fixes)
/insights/rookies, anon, prod:
- API 200: cohort_stats (61 rookies, GMV30d ~$139k) + 61 rows, current computed_at.
- Page clean: KPI header, sort toggles, per-row SQUEEZE/TROPHIES drill-downs with the
  TROPHIES chip correctly SUPPRESSED when no #1-mint history; honest em-dash for null
  max_mint_one_sale (not "$null"). Brand tokens correct.

Bookkeeping: both can be marked CLOSED in docs/overnight/ledger.md. (Cowork could not edit
the ledger directly — large-file mount truncation hazard — hence this inbox note.)
