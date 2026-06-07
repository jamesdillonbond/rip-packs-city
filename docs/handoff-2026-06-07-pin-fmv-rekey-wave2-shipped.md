# PIN-FMV-REKEY Wave 2 — SHIPPED (2026-06-07, Claude Code)

Per-render FMV reader cutover for the Pinnacle entity/team surfaces. DB-only
(Supabase migrations via MCP; these functions are called by API routes through
the service role, so the change is **live in production immediately** — no Vercel
deploy). Executes [docs/handoff-2026-06-07-pin-fmv-rekey-waves-2-3.md](handoff-2026-06-07-pin-fmv-rekey-waves-2-3.md) Wave 2.

## Keying decision (Trevor delegated "do what's best long-term")

**Representative render + additive range.** On the legacy SET-level grain
(`pinnacle_editions.id` == `pinnacle_catalog.legacy_edition_key`; one key fans
out to many character renders — avg 5.5 priced, max 26, 55% with a ≥2× spread),
the FMV slot now resolves to the **most-liquid render** (max `fmv_sales_count_30d`,
tie-break highest `fmv_usd`) — a real per-render number, never a blend — plus
additive `fmv_min` / `fmv_max` / `render_count` so surfaces can show the spread.

Why this over a range-only or per-render-row swap: shape-safe (scalar `fmv_usd`
preserved → zero frontend breakage; existing sorts/thresholds keep working),
honest (a real trading number, with the spread disclosed), and a foundation the
frontend can progressively adopt. Proof: `PAS-OEV1-INCR:Digital Display:1`
(Incredibles) renders span $15.98–$1,796.44 → page now shows representative
$86.51 (sold today) + range, instead of one blended figure.

## Keystone helper (new)

`public.get_pinnacle_edition_fmv_collapsed(p_legacy_edition_key text)` — SQL,
STABLE, SECURITY DEFINER, search_path=public. Returns one row (or zero → NULL
fmv via LEFT JOIN LATERAL): `fmv_usd, confidence(text), wap_usd, floor_usd,
computed_at, sales_count_30d, sales_count_7d, days_since_sale, fmv_min, fmv_max,
render_count`. Maps from `pinnacle_catalog`: floor_usd←floor_ask,
wap_usd←fmv_wap_usd. Granted anon/authenticated/service_role. All 13 migrated
functions call it via `LEFT JOIN LATERAL ... fmv ON true`, so the collapse logic
lives in ONE verifiable place.

## Migrated (13) — migrations `audit_*_pin_fmv_rekey_wave2_<fn>`

Detail (source swap; FMV totals now sum representative renders):
`get_set_detail`, `get_player_detail`, `get_series_detail`, `get_team_detail`.
Lists (source swap + per-row `fmv_min/fmv_max/render_count` exposed via to_jsonb):
`get_set_editions`, `get_player_editions`, `get_series_editions`,
`get_team_top_editions`.
Team aggregate/checklist (source swap): `get_team_players`, `get_team_checklist`,
`get_team_checklist_progress`.
Single-edition / moment (source swap + range in the `fmv` object): `get_edition_detail`,
`get_moment_detail`. For these two the retired Flowty-era ask fields
(`flowty_ask`/`cross_market_ask`/`listing_count`/`offer_count`) have no per-render
source → NULL; `pinnacle_ask` ← catalog `floor_ask` (the live floor); `get_moment_detail`
also swapped its `v_similar` inline FMV subquery and tags `algo_version='pinnacle-render-collapse'`.

## NOT migrated — intentional

`get_edition_fmv_history` reads a **time series** (daily DISTINCT ON over
`computed_at`). `pinnacle_catalog` is single-point (no per-render history), so it
**stays on legacy `pinnacle_fmv_snapshots`** per the handoff. This is the reason
the legacy table can't be fully retired yet — a per-render history table is a
prerequisite (future enhancement). The legacy writer (`pinnacle_fmv_recalc_all`
via pinnacle-sync) keeps running, so history keeps accumulating and this function
keeps working.

## Verification (live)

- `get_set_detail` (Disney Princess Vol.1) → fmv_total_usd populated.
- `get_edition_detail` (Hercules Brushed Silver) → fmv object with render_count 6,
  range fields present, ask fields NULL as designed.
- High-spread proof (Incredibles Digital Display) → representative $86.51,
  fmv_min $15.98, fmv_max $1,796.44, render_count 9.
- Grants intact on helper (anon/authenticated/service_role) and `get_set_detail`
  (service_role; unchanged by CREATE OR REPLACE). No signature changes → all grants preserved.

## Deferred (post-eyeball)

1. **Frontend range display** (route/.tsx): surface `fmv_min`/`fmv_max`/`render_count`
   as "FMV $X (range $a–$b · N renders)" on the Pinnacle edition/set/list surfaces.
   Additive — the scalar is already live+correct, so this is polish, not a fix.
2. **Wave 3** (analytics fns + routes) — gated on Trevor eyeballing Wave 2.
3. **Retirement** — blocked on a per-render history table (for `get_edition_fmv_history`).

## Revert

DROP `get_pinnacle_edition_fmv_collapsed(text)` and restore each of the 13
functions to its pre-Wave-2 body (the legacy `pinnacle_fmv_snapshots` LATERAL).
Prior bodies are in Supabase migration history immediately before each
`audit_*_pin_fmv_rekey_wave2_<fn>` migration. No data was modified (read-path only).
