# All Day 7-d published FMV/sale ratio 0.882–0.899 — just under the 0.90 action line the 11-04 steer set

- **Source:** daytime health monitor 2026-11-07 ~04:09Z (quiet window — positive control io_wait=0 / active=2, NOT a spell); `fmv_sales_backtest('nfl_all_day', 7)` and `(…, 30)`; focus.md STEER 2026-11-04 10:40 PM PT ("All Day price ratio — re-read after 11-07").
- **What the steer said:** the published 7-d median ratio read 0.900 on 11-04 because sub-$1 sales stepped $0.16–0.17 → $0.22 (11-03) / $0.25 (11-04); 30-d read 1.000. "Act only if the 7-d ratio is still < 0.90 once that step is inside the comps window."
- **11-07 read (the step is now ~3–4 d into the 7-d window):**
  - 7-d `published` ALL = **0.899** (n=3,731); `last3_median_30d` ALL = 0.882 (n=3,419).
  - Tier split (7-d published): LOW **0.773** (n=869) is the driver; MEDIUM 0.895; HIGH 0.960; ASK_ONLY 1.000.
  - 30-d `published` ALL = **1.000**; 30-d LOW = 1.000.
- **Risk read:** LOW / benign. The condition the steer set to "act" is now technically met (7-d ALL 0.899 < 0.90), but it is a hair under, the 30-d is a clean 1.000, and LOW is the tier dragging it — consistent with (a) the 11-04 `allday_low_haircut_075` deliberately pricing no-sale LOW editions at 0.75×floor (by-design conservatism) and (b) the sub-$1 step still only partway through the 7-d window. No trust arm is breaching (fmv_sanity_flags 0, edition_integrity 30 < 250, topshot/allday fmv_stale all ok). Reads like a short-window artifact that mean-reverts, not a writer defect.
- **Suggested action (night pass):** re-derive `fmv_sales_backtest('nfl_all_day',7)` with the 11-03/04 step fully in-window and decide per the steer — most likely ACCEPT (the 30-d 1.000 + the intended LOW haircut explain the sub-0.90), else name the specific writer lever. Do NOT widen or change a haircut off this single marginal read. Not a spell symptom — stable multi-day aggregate taken in a quiet window.
