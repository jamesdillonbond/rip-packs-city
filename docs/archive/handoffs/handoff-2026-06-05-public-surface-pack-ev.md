# Handoff — Public surface accuracy: Pack Reality "top EV" board (2026-06-05, Claude Code)

First finding of a public-intelligence-surface accuracy sweep (the free, no-signup `/insights` growth surfaces). Develop on `main`, push, smoke. Use the `rpc-insights-qa` skill checklist.

## Finding: the public Pack Reality "top EV" board is misleading
`topshot_pack_reality_top_ev` (powers `/insights/pack-reality` "top EV") — live audit of the 87 ranked packs:
- **73/87 (84%) snapshots are stale >24h** — oldest **44 days** old.
- **73/87 (84%) are >=90% depleted** — e.g. dist 5257 "First Round Rewind: Chance Hit" is 99% depleted with **2 pullable editions left**, yet the board shows a 06-03 `gross_ev=$1,170` on a $17 pack (**69x**). Real current EV ~$2.
- **29/87 (33%) show value_ratio >5x** (max **71.7x**); 24/87 have **<40% FMV coverage**.
- Not a DQ regression: the dupe merge did NOT orphan `pack_drop_pool` (all 80 rows of dist 5257 still join; 0 orphans). The EV values are simply stale (pre-FMV-fix, pre-depletion) and the board doesn't filter.

This directly contradicts the hub's own promise ("Honest pack ranker with a confidence flag on every +EV claim") and shows a new visitor "$17 pack -> 69x EV" on packs that are 99% sold out at weeks-old fossil prices. High brand/trust cost on a growth-facing page.

## Fix (three parts)
1. **Filter the board to live, rippable, adequately-covered, fresh packs.** In the `topshot_pack_reality_top_ev` view (or the route that reads it), exclude: `depletion_pct >= 90` (can't meaningfully rip), `snapshotted_at < now() - interval '48 hours'` (stale), and either exclude or clearly down-rank `fmv_coverage_pct < 40` (unreliable EV). Verify the board still has enough rows to be useful (if not, the recompute in #2 must land first).
2. **Fix pack-EV recompute coverage.** 84% stale (up to 44 days) means `compute-topshot-pack-ev` / the `topshot_pack_ev_targets` queue isn't reaching these packs — the known queue-coverage issue (CLAUDE.md "queue poison"). Ensure every board-eligible pack recomputes on a bounded cadence; add a freshness tripwire.
3. **Cap/flag implausible ratios (rank, not price).** Per the research note ("don't promote 200x EV ratios at face value — weighted-EV artifacts"), don't surface a raw 69x as a headline. Use the existing `high_variance` flag to caveat, and/or cap the displayed ratio with a "high variance / low coverage" badge so the number reads as honest.

Validate: re-query `topshot_pack_reality_top_ev` after — 0 packs >24h stale, 0 at >=90% depletion, max value_ratio sane (<~10x or clearly badged). Spot-check `/insights/pack-reality` renders fresh, plausible packs. Revert: `git revert` (view change) — fully reversible.

## Public-surface sweep — still to verify (next)
- **Squeeze board** (`topshot_squeeze_board`, `/insights/squeeze`): now that circulation is cleaner (DQ2 backfill), confirm no impossible squeeze (locked+burned > circulation) and no bad-circulation editions leaking in.
- **Deals / Sniper** (`topshot_deals_vs_fmv`, `/insights/deals`, overview "Top 5 Sniper Deals"): confirm the fossil fix killed the fake "deals" (commons with FMV >> ask); the audit's $0-ask / inflated-discount items should be gone.
- **Rookies / first-mint / set-squeeze / pinnacle-scarcity**: spot-check freshness + that no dupe/NULL-metadata editions leak in.
- **OG cards + canonical + drill-downs** per the `rpc-insights-qa` checklist on any surface touched.

---

## Sweep results (2026-06-05, Cowork) — only Pack-EV is broken
Verified the other public surfaces; all HEALTHY (the FMV + circulation cleanup propagated to everything that reads live data):
- **Deals / Sniper** (`topshot_deals_vs_fmv`): healthy — top deals are plausible RARE/LE editions (Embiid Metallic Gold $27 FMV vs $10 ask, Luka $70 vs $28), MEDIUM confidence, fresh asks (05:40), 56–63% discounts. The old fake-deal pattern (commons w/ fossil FMV vs ~$0 ask) is gone.
- **Squeeze board** (`topshot_squeeze_board`): healthy — squeeze math exact ((locked+burned)/circ), circulation accurate post-DQ2, FMV accurate, no impossible values (squeeze ≤100, buyable ≥0).
- **Rookies index** (`topshot_2025_rookie_index`): healthy — real cohort stats, plausible values.

**Conclusion: the pack-EV board (above) is the only public-surface accuracy gap.** Pattern: live-FMV-reading surfaces are all accurate; only the surface that caches its own pre-computed EV snapshots is stale. The fix is the three-part item above (filter fresh/rippable/covered + recompute coverage + badge variance).
