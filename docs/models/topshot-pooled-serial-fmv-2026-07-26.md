# Top Shot pooled multi-factor special-serial FMV model (2026-07-26)

Implements **Item 5** of `docs/archive/handoffs/handoff-2026-06-19-ts-sales-completeness-and-serial-fmv.md`
(spec §6 of `docs/strategy/topshot-sales-completeness-and-serial-fmv-2026-06-19.md`, evidence
`docs/audits/special-serial-fmv-factor-analysis-2026-06-19.md`). The sales-completeness backfill drained
(#1 sales ~1,086 → ~4,000 canonical), which was the data gate on this build.

## What it is

A **pooled hedonic regression** on the special-serial premium, fit **offline in Python** (ridge = partial
pooling), coefficients written to DB tables, applied at read time in SQL. Target:

```
y = ln(premium) = ln(sale_price / base_fmv)          base_fmv = edition's latest HIGH/MEDIUM FMV
y ~ intercept + b_log_fmv·ln(fmv) + b_log_circ·ln(circ)
    + tier (fixed) + bucket_perfect (fixed) + bucket×tier
    + set[pooled, ridge]
```

**At read time this collapses to a *per-edition* power law** `est = k_edition · fmv^b_log_fmv`, where
`k_edition = exp(intercept + b_log_circ·ln(circ) + tier + bucket/interaction + set_effect)`. So the read path
is a handful of indexed lookups and is **always fresh** — fmv/circ/tier are read live; only the learned
multipliers are stored.

### Why set-only (player AND badge evaluated, not seeded)

The 06-19 factor analysis flagged `set` as the dominant, honestly-sampled factor and `player` as
real-but-noisy (median ~2 sales/player). Under proper shrinkage, **player added no out-of-sample value beyond
set** (rolling-CV `no-player` scored marginally *better*), and `set` already absorbs most player/premium
signal. So the shipped model is set-only. The `serial_fmv_pooled_player_effect` table exists (empty) and the
read path already reads it, so player can be activated later by seeding it — no schema change.

**Badge (the factor Trevor named) was also tested empirically and does not help.** A bulk per-edition badge
signal *is* available (`badge_editions.play_tags` / `set_play_tags` — rookie / Top Shot Debut / championship
flags), which the 06-19 analysis lacked. Adding those flags to the fit made it *worse* out-of-sample
(set+badge rolling-CV 0.601 vs set-only 0.592); badge-only was 0.677. Rookie/debut/championship moments cluster
into distinct **sets**, so the set effect already carries the badge premium — a real answer to "why not badges",
not an omission.

`series`, `team`, and `parallel(play)` were dropped per the factor analysis (negligible / overfit at current N).

### Recency weighting (v1.1.0)

The offline fit is **recency-weighted** with a 180-day half-life (`w = 0.5^(age_days/180)`) — recent trading
regime is more predictive of near-future prices. This improved the rolling CV on both axes: **med-APE
0.592 → 0.575** and **mean-APE 6.73 → 5.49** (far fewer wild high estimates, which matters for public trust).
Structure, gate, and the 71 sets are unchanged; only the learned coefficients differ (`algo_version`
`pooled-1.0.0-set` → `pooled-1.1.0-set-recency`). Shorter half-lives (120d) scored marginally better still but
sit at the grid edge; 180d is the robust, non-overfit choice.

## Validation (why it shipped)

Rolling **5-fold forward-chaining time CV**, both the pooled model and the incumbent power-law refit per fold
(fair — the live power-law coefficients would otherwise leak the test period):

| | med-APE | notes |
|---|---|---|
| **pooled (set, gate≥6, recency-weighted)** | **~0.575** | wins COMMON & RARE (the ~85% bulk); provides FANDOM-#1 coverage power-law drops; mean-APE 5.49 |
| power-law (incumbent) | ~0.69 | |

~14% lower median error, broader coverage. High mean-APE is actual-side noise (occasional cheap wash sales of
#1s), bounded by the premium clamp. Per-cell, pooled is roughly tied/slightly behind only on thin LEGENDARY
(n≈14–25) — which the support gate routes to power-law anyway.

## How it's wired

- Tables (service_role-only, RLS on, anon/authenticated revoked):
  `serial_fmv_pooled_model` (global coeffs + params + `is_active` kill-switch),
  `serial_fmv_pooled_set_effect` (71 sets, support≥6), `serial_fmv_pooled_player_effect` (empty).
  Migration `20260726010000_audit_20260726_topshot_pooled_serial_fmv_model`.
- `serial_fmv_estimate` — new **canonical 8-arg** `(cid, serial, circ, tier, fmv, confidence, jersey_number,
  edition_id)` resolves **pooled → jersey → power-law → grid**; the 6-arg / 7-arg-integer(jersey) /
  7-arg-uuid(edition_id) overloads all delegate to it. Pooled fires only when `p_edition_id` is passed, the
  model is `is_active`, and the edition's set has training support ≥ `gate_min_support` (=6); else the exact
  prior behavior. Migration `20260726011000_...`.
- **Activated on** the underpriced-serials deal board (`topshot_serial_board_candidates` →
  `/api/public/insights/underpriced-serials`), migration `20260726012000_...`.

### Read-path contract

Pooled returns `basis:"pooled_model"` plus `set_support` / `player_support` / `algo_version`; all existing
fields (`estimate_usd`, `multiplier`, `serial_bucket`, `circ_band`, `label`) are preserved so every consumer
keeps working. Kill-switch: `UPDATE serial_fmv_pooled_model SET is_active=false;`.

## Consumer cutovers — DONE (2026-07-26)

Every consumer now passes `edition_id`, so the pooled model reaches all serial-estimate surfaces (verified
`basis: pooled_model` live where the set is supported; unresolved / non-TS editions fall through to the
unchanged power-law/grid path):

- `get_moment_detail` (moment page) — `, v_resolved.edition_id` (8-arg). Board↔moment now consistent
  (verified: moment 49949610 → `pooled_model`, v1.2.0, `jersey1_match:true`).
- `get_wallet_moments_with_fmv` — `, p.edition_id` (7-arg uuid).
- `get_trophy_slab_data` — `, e.id` (8-arg, keeps jersey).
- `get_user_top_owned_moments` — `, e.id` (7-arg uuid).
- `app/api/sniper-feed/route.ts` — batch-resolves each deal's edition uuid via `intEditionKey`
  (= `editions.external_id`) and passes `p_edition_id`; AllDay deals stay on power-law (no allday pooled model).

Migrations `20260726014000`–`20260726016000` (+ the four dated `..._get_*_pooled_edition_id` MCP migrations).

## Refit (offline, periodic)

A multivariate ridge fit cannot be reproduced in pure SQL (Postgres has no lstsq), so refit is an **offline
job**, not pg_cron. Because base_fmv is read live, the learned multipliers drift slowly — monthly-ish is fine.
Pipeline (see `scripts/serial-fmv-pooled/`): extract #1/perfect TS sales with a HIGH/MED base → `eval.py`
(fair CV vs power-law) → `export_setonly.py` (writes `model_setonly.json` + chunked seed SQL) → apply the
model row + `serial_fmv_pooled_set_effect` rows. Verify with a checksum (`count`, `sum(effect)`, `sum(support_n)`).
