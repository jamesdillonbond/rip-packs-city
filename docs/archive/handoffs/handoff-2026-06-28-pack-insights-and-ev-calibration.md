# Handoff — Pack insights surface, edition provenance, EV-calibration adoption + AllDay verdict (2026-06-28, Cowork)

All the DB surfaces below are **live** (security_invoker views, SELECT-only). This handoff is the route/`.tsx` work Cowork can't push, plus one product decision and the AllDay investigation result. Direct-to-`main`, no branches/PRs.

> Claude Code's direct file inspection wins over this doc on any disagreement — adapt to the actual file shape.

---

## Item 1 — `/insights/pack-reality` public surface (NEW) — highest value

The EV reality-check is genuinely novel content no Flow competitor has: **"Top Shot's own model says this pack is worth $46; it actually pulls $4."** The data view is live and ready.

**Backing view:** `v_topshot_pack_realized_ev` (live, security_invoker, anon SELECT). Per TS dist with `n_opens ≥ 10`: `modeled_gross_ev`, `realized_mean/median/p10/p90`, `realized_to_modeled_ratio`, `calibration_weight`, `calibrated_ev`, `n_opens`, `title`, `retail_price_usd`, `price_source`. ~200 dists qualify.

**Build:** a public `/insights/pack-reality` route (mirror the existing `/insights/*` surfaces — squeeze, pack-sniper, etc.). Suggested cuts:
- "Most over-modeled packs" — `ORDER BY realized_to_modeled_ratio ASC` (model says rich, reality says poor — e.g. Phantom Threads $46→$4).
- "Most under-modeled" — `ratio DESC` (sleepers the model undervalues — e.g. Fast Break dist 7800 $0.94→$11.96 realized).
- "On-model" band (ratio ~1) as a credibility anchor.
- Per-row drill-down to the pack/dist page.

**Follow the `rpc-insights-qa` checklist before deploy:** backing view is already security_invoker + anon-SELECT (verified); add the route to `sitemap.ts`; add an OG card via a new `/api/og/pack-reality` (mirror existing `/api/og/*` — the `/share` lesson: use a route handler, not `opengraph-image.tsx`); param-stripped canonical; freshness chip from `max(snapshotted_at)`; no hardcoded `#E03A2F` (use tokens); drill-down links into the edition/pack corpus. Smoke the route + OG after deploy.

**Verify:** `curl -s https://www.rippackscity.com/insights/pack-reality | grep -c modeled` > 0; OG 1200×630; sitemap contains the line. **Revert:** `git revert`.

---

## Item 2 — Edition-page pack provenance (NEW view live)

`v_topshot_edition_pull_provenance` (live, security_invoker): per TS edition — `pack_pulls_observed`, `distinct_packs`, `observed_pull_share_pct` (vs circulation), `first_pull_at`/`last_pull_at`, plus `player_name`/`set_name`/`tier`/`circulation_count`. Answers "what % of this edition's circulation came from packs."

**Build:** on the edition page (`app/(collections)/[collection]/edition/[slug]/page.tsx`), add a small "Pack provenance" stat for TS editions: `SELECT pack_pulls_observed, observed_pull_share_pct FROM v_topshot_edition_pull_provenance WHERE edition_id = <id>`. **Caveats to honor in copy:** window-bounded (~Apr 2026 →, so it underestimates older editions — label "observed since Apr 2026"), and it undercounts ~42% because the `moments` table doesn't resolve every pulled NFT (a separate moments-coverage gap). Show it as a directional "pack-distributed" signal, not a precise fraction. **Revert:** `git revert`.

---

## Item 3 — Adopt calibrated pack EV on the packs page (product decision + wiring)

Calibration is currently display-only. A promotion-ready surface is now live: **`v_topshot_pack_ev_calibrated`** (security_invoker, anon SELECT) — per TS dist: `modeled_gross_ev`/`modeled_net_ev` (raw, unchanged), `calibrated_gross_ev`/`calibrated_net_ev`/`calibrated_margin_pct`, `calibration_applied` (bool), `n_opens`, `calibration_weight`. Where `n_opens ≥ 10` it blends modeled toward realized (CC's `weight = LEAST(0.85, n_opens/(n_opens+40))`); otherwise it falls back to modeled. **It does NOT overwrite `pack_ev_latest.gross_ev`**, so `v_topshot_pack_realized_ev`'s reality-check keeps comparing realized vs *raw* modeled — no circularity, which is the prerequisite CC flagged. Built/satisfied.

Examples (live): Phantom Threads modeled net -$1.92 → **calibrated -$35.83**; on-model 6452 $14.54 → $14.69 (unchanged); 7800 -$2.06 → **+$6.92** (model under-counted).

**Decision (Trevor):** show calibrated EV as *the* pack EV on the packs page / `pack_table_rows` consumers, or keep modeled as primary with calibrated as a secondary "reality-adjusted" line. If adopting: have the packs page read `calibrated_net_ev`/`calibrated_margin_pct` from `v_topshot_pack_ev_calibrated` (fall back to modeled where `calibration_applied=false` — already baked into the view), and keep a "modeled vs reality-adjusted" toggle/label so it's transparent. Don't write calibrated values back into `pack_ev_latest`. **Revert:** `git revert` (the view stays; it's inert until a consumer reads it).

---

## Item 4 — Optional: enrich the "Observed pack lifecycle" strip

The strip (already shipped, reads `v_topshot_pack_lifecycle`) can add `realized_pull_value_usd`, `avg_realized_value_per_pack`, and `minted_true` — they're columns on the same view. The core supply numbers (minted/opened/sealed/depletion) now show via `pack_table_rows` automatically (see the durability handoff §5), so this is polish, not a gap.

---

## Item 5 — Multi-collection (AllDay / Golazos / Pinnacle / UFC) — INVESTIGATED, not buildable now

I checked whether the lifecycle extends beyond Top Shot. It does not, and here's the data so it's not re-investigated:

| Collection | pack_rips | pack_purchases | EV-supply dists |
|---|---|---|---|
| NBA Top Shot | 190,445 | 219,782 | 1,179 |
| NFL All Day | **0** | 1,878 | 521 |
| LaLiga Golazos | 0 | 0 | 0 |
| Disney Pinnacle | 0 | 0 | 0 |
| UFC Strike | 0 | 0 | 0 |

Top Shot is the only collection with pack-**open** (rip) data, which is what drives opened/pulled/realized. AllDay has supply-only (sealed/depletion already in `pack_ev_latest`, 521 dists) but **0 opens ingested** (and no dist `uuid`s, so no `getPackListing` backfill path), because the `pack-events-ingest` worker only ingests TS pack opens and AllDay ended primary pack sales. Golazos/Pinnacle/UFC have no pack ingestion at all. **Verdict: not worth building** — it would require new pack-open event ingestion for historical/secondary collections. If AllDay pack-reality ever matters, the smallest step is adding AllDay pack-open (rip) ingestion to the worker; everything downstream (views, attribution, dashboard) would then generalize. Left as a documented non-goal.

---

## Guardrails
- Direct to `main`, no branches/PRs; PowerShell `git` commit (Git Bash `git commit` can silently no-op); re-verify push with `git rev-list --count origin/main..HEAD` → 0.
- Vercel REST via PowerShell `Invoke-WebRequest`; Pro `maxDuration` cap 800s.
- New public route → run `rpc-insights-qa` before deploy; confirm the backing views stay `security_invoker` + anon-SELECT (all four new views already are).

## DB revert reference (this session)
```
DROP VIEW public.v_topshot_pack_ev_calibrated;
DROP VIEW public.v_topshot_edition_pull_provenance;
-- pack_distributions write-through: re-run apply_topshot_supply without the UPDATE, and
-- (optional) reset the synced counters; topshot_pack_supply remains the source of truth.
```

## Expected end state
`/insights/pack-reality` live with OG + sitemap; edition pages show pack provenance; (if Trevor adopts) packs page shows reality-adjusted EV; AllDay documented as a non-goal pending pack-open ingestion.
