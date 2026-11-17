# Handoff — Panini price-capture outage (silent, blocking the launch gate)

**Date:** 2026-08-05 (PT) · **Author:** Claude Code (interactive health sweep) · **Ships nothing** — this is a decision-ready operator brief. The fix lives on the residential Panini runner + the SPA it scrapes, which this sandbox cannot reach or test. Panini is pre-launch and its ingest is explicitly off-limits to autonomous shipping, so this is written for Trevor / an operator-driven runner session, not a code push.

---

## TL;DR

Since **2026-07-29**, the Panini ingest has captured **ZERO sale prices** — 8 straight days, ~44,963 serials, all price-less, and still dry today (08-05). This is **upstream**, not our parsing: `mapping_shortfall = 0` every day (we faithfully map whatever arrives; the priced fields simply stopped arriving). The runner code is unchanged since Jul 31, and the outage began before that, so **Panini changed what their `getPskuTotalCardsList` serial payload returns** — the catalog/pricing fields now come back JSON `null`.

**Why it's urgent and easy to miss:** the roadmap's Panini launch gate tracks "share of serials carrying a recorded price" as a coverage figure. That numerator has been **frozen since 07-29** while the denominator grew by ~45k, so the ratio's decline (≈17% → ≈7%) reads like "inventory added faster than prices" when it is actually a total upstream outage. **A launch gate set on that ratio currently cannot be met by any amount of RPC-side work.**

---

## Live evidence (confirmed 2026-08-05, `v_panini_serial_sale_field_supply`)

| capture day | serials captured | serials w/ price | % supplied | mapping_shortfall |
|---|---:|---:|---:|---:|
| 2026-07-25 | 525 | 239 | 45.52% | 0 |
| 2026-07-26 | 1,315 | 494 | 37.57% | 0 |
| 2026-07-27 | 2,542 | 335 | 13.18% | 0 |
| 2026-07-28 | 4,257 | 46 | 1.08% | 0 |
| **2026-07-29** | 4,906 | **0** | **0.00%** | 0 |
| 2026-07-30 | 4,344 | 0 | 0.00% | 0 |
| 2026-07-31 → 08-05 | 5,346 / 2,009 / 9,451 / 8,239 / 8,865 | **0** each | 0.00% | 0 |

Monotonic decay 45% → 0 over four days, then a hard floor at 0. Not a sleeping-box gap (a sleeping runner writes no rows at all; these days all have thousands of captures). The `panini_sale_price_capture_dry_days` trust-health arm is **BREACHED at 7** (breach_at 3) and correctly attributes the loss to upstream.

## What actually changed (root cause)

The runner ([scripts/ingest-panini-runner.mjs](../scripts/ingest-panini-runner.mjs)) enriches each card by navigating to `/marketplace-details/<psku>.html`, which fires two `/onepanini` GraphQL ops:
- **`getCardMarketStats`** → the `cards` rows (line ~221).
- **`getPskuTotalCardsList`** → the per-**serial** product rows (line ~224) — **this is the DTO that carries `brought_at_price` / `brought_at_time`** and the catalog fields.

Comparing serial payloads captured before vs after the switch, **sixteen fields flipped fully-populated → 100% null together** (athlete, cardset, rarity, sport_name, year, image_url, inventory_count, burned_count, burnt_percent, burnable_count, collection, genesis_year, pan_video_link, auto_accept, **brought_at_price, brought_at_time**) while **`token_id` and `my_public_wallet` flipped null → 100% populated**, and daily serial volume jumped ~1.3k → ~9k. That signature — catalog/pricing fields dropping out as wallet/token fields appear — means the `getPskuTotalCardsList` response is now returning a **wallet/inventory-shaped projection** of each serial instead of the catalog-detail projection, sharing one DTO. Panini either changed the op's default field-set, gated pricing behind different auth/variables, or split pricing into a separate op.

**Blast radius is wider than sale price:** across the switch, serial `price_usd` null went 30.9% → 77.4% and `last_sale_usd` 76.7% → 99.1% — so **ASK prices are being lost too**. `panini_preserve_sale_fields` protects only `last_sale_usd`/`last_sale_at`, not the rest.

## The fix (operator-driven, ~30 min on the residential box)

The runner already has the capture harness for exactly this — no code change needed to diagnose:

1. **Re-capture the current op.** Run the runner in discovery-hold mode on the logged-in residential Chrome:
   `PANINI_HEADLESS=false PANINI_DISCOVERY_HOLD_MIN=10 PANINI_OPS_CAPTURE_FILE=panini-ops-20260805.jsonl node scripts/ingest-panini-runner.mjs`
   Then in the window open **one card detail page** (`/marketplace-details/<psku>.html`) and, if you own any WC cards, **one owned-card / wallet view**. Every `/onepanini` request body + response lands in the ops file.
2. **Compare the `getPskuTotalCardsList` request+response** in that file against the field list above. Determine which case you're in:
   - **(a) Fields still exist, wrong selection** — the GraphQL query the SPA now sends dropped `brought_at_price` et al. from its selection set, or added a variable (e.g. `context: wallet`). → repoint the runner's detail navigation / add the missing fields to the intercepted op, or hit the catalog projection explicitly.
   - **(b) Pricing moved to a new op** — a separate `/onepanini` operation now carries price. → add that op to the per-card walk (mirror the `getCardMarketStats` interception at line ~221) and map its fields.
3. **Repair the runner** per the case, run one full pass, and confirm `pct_supplied` climbs back above 0 for today's `capture_day`. The trust-health arm self-clears the moment upstream resumes.

## What NOT to do

- **Do NOT raise the sentinel `breach_at`** for `panini_sale_price_capture_dry_days` — it would only defer the next crossing and hide a real outage. The arm is doing its job; it reads BREACH because the finding is open.
- **Do NOT set / keep a Panini launch gate on the "% serials with a recorded price" ratio while this is dry** — the numerator is frozen upstream, so the metric is measuring Panini's outage, not our coverage. Gate on price capture being restored first.
- **Do NOT "fix" this from the cloud sandbox** — `/onepanini` is bot-walled (HTTP 426) off the residential box; only the logged-in Windows runner can capture the current op.

## Grounding (verified live this session, 2026-08-05 PT)
- `v_panini_serial_sale_field_supply`: 0 priced serials 07-29 → 08-05, `mapping_shortfall` 0 throughout (table above).
- Runner detail path read in full: `getCardMarketStats` (cards) + `getPskuTotalCardsList` (serials) at `scripts/ingest-panini-runner.mjs:221,224`; per-card detail walk at `:333-364`; ops-capture harness at `:274-295` (`PANINI_OPS_CAPTURE_FILE` / `PANINI_DISCOVERY_HOLD_MIN`).
- Runner file mtime Jul 31; outage onset 07-27 → complete 07-29 (predates the last edit) ⇒ upstream, not a repo regression.
- Field-flip signature + wider ASK-price blast radius: from the `panini_sale_price_capture_dry_days` trust-health arm's diagnosis, cross-checked against the live supply view.
- API contract reference: [docs/drafts/panini/panini-api-contract.md](drafts/panini/panini-api-contract.md) (`brought_at_price`/`brought_at_time` on the serial DTO).
