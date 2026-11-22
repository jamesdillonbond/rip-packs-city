# Panini pack EV — where it stands and the plan (2026-11-22)

Trevor, 2026-11-22: "Do we have panini pack EV accurate and dialed in?" → fix pass (ledger 2026-11-22 ~9:15 AM PT) → "Keep going and digging and probing and come up with a strategy." All figures below are **dated samples (2026-11-22 ~9:30 AM PT)** — re-derive before quoting.

Companion: [panini-fmv-packev-methodology.md](panini-fmv-packev-methodology.md) (how card FMV is built), [collections/panini.md](collections/panini.md) (the live Panini roadmap).

---

## 0. Progress (dated — newest first)

**2026-11-22 ~12:40 PM PT — thread close-out** (Trevor: "Do what you think is best, and research the answers yourself … leaving nothing unresolved").
- ✅ **P2.9 decided and shipped** (`20261122203555`). Research first: C8's premise was stale. Since 11-12 every Panini LOW/MEDIUM/HIGH/STALE FMV reaching the cross-collection `fmv_snapshots` (edition pages, wallets, portfolio) is already capped at the lowest live ask by `fmv_snapshots_cap_panini_low_to_live_ask()` — its shadow read: within ±25 % of the next sale 11.8 → 30.3 %, ratio 2.17 → 1.40. The gap was four boards reading Panini's own UNcapped table as a VALUE (squeeze, player, nation, special serials): 483 of 5,285 WC editions (9.1 %) above a fresh ask, median 1.64×, sealed exposure overstated 6.9 %. **Rule: a VALUE is capped at the live ask everywhere; a DEAL is not** (a deal is an ask below FMV — capping would delete every deal by construction; `panini_deal_board_all` is unchanged and already also requires the ask to undercut recent sales). One helper, `panini_fmv_capped_at_live_ask()`, mirrors the trigger's ask exactly. Verified: squeeze exposure $680,616 → $633,468, the board now shows exactly the edition page's number (`_askcap`), squeeze refresh 726 ms, deals 1,583.
- ✅ **P2.7 closed.** The two "missing" Bad Eggs products were never missing — set **850147** (Introducing the Clans, 172 cards) and **850179** (New Yolk City, 273 cards) were registered and walked but unnamed, the same gap as 2130/850130 (found on Panini's own Entertainment grid in Trevor's Chrome; matched by mint caps). Also found **2123 = 2024 WNBA Rookie Royalty** (same tier structure as pack 1000). Named and linked (`20261122203835`): packs 1012/1013, 1053/1057/1061, 1000. Two newly priced by the existing guaranteed-contents model on real sales: New Yolk City Green (4 × Base Green #/49, 173 sales) $13.48 vs $13; Bronze (1 × #/45, 35 sales) $8.58 vs $18. The rest stay correctly withheld (mixed-pool contents or thin sales).
- Left as-is, on purpose: 2022 NFL Dilfer's Dimes (6 packs, 11–31 sealed each) and 2022 NRJ Music Awards (2 sealed) — no walked card set to link; not worth a runner change.
- **Nothing from this thread is open** except the dated backtest (scheduled task, 2026-12-06 1:23 PM PT), which decides whether any product moves to the tier model.

**2026-11-22 ~12:25 PM PT — follow-ups** (Trevor: "Do what you can").
- ✅ **Over-match gate applied** (`20261122201452`): 87 of 358 shadow packs over-match and no longer pass; 50 pass (was 95). None of WC/WNBA Hobby, FOTL or the special packs passes.
- ✅ **Rolling Stones + 2025 Bad Eggs packs linked now** (`20261122201616`, the value the route would write at its next pack capture): 1060/1063 → 2130, 979/990 → 850130. The board's note for them is now accurate — 979/1060 "contents aren't fixed slots", 990/1063 "not enough recorded sales" — all four correctly withheld. They join the shadow at its next :49 run.
- 🗓 A scheduled task runs the pull-ledger backtest on ~2026-12-06.

**2026-11-22 ~11:25 AM PT — P1 + P2 pass** (Trevor: "Work through all you can for p1 and p2").

| Item | State |
|---|---|
| P0.1 Moonbirds sales fix + key-shape watch | ✅ live (sales ingest accepts `packcard-a_b_c_d_e`; Sentinel warns on any unrecognised key shape) |
| P0.2 tier-coverage gate + "at least $X" | ✅ live — Moonbirds (Legendary 5/24) and WC Stickers (Epic 406/1,920) read "at least" |
| P0.3 pull ledger | ✅ live since 11-22 (`panini_edition_supply_obs`, job :54). **Backtest not yet measurable:** ~1 reading per card so far. Re-read ~2026-12-06. |
| **P1.4 tier-composition model** | 🟡 **built as a SHADOW, not published** — `panini_pack_ev_tier_shadow` / `refresh_panini_pack_ev_tier_shadow()` hourly at :49; 63 products, 358 packs, ~52 s/run. Gate: validation (below) **and** the pull-ledger backtest. |
| P1.5 special single-parallel packs | 🟡 in the shadow, matched by Panini's per-tier serial range (`min_end_seq..max_end_seq`); several over-match (see below) |
| P1.6 FOTL slots | 🟡 in the shadow (1039 design $110 vs cost $114; 1055 $47.52 vs $55) but their Epic tier over-matches → the 90 %-indexed withhold stays |
| P2.7 link Bad Eggs / Rolling Stones | ✅ closed 12:40 PM PT (see the close-out above). Earlier state: 🟡 **half done** — set 2130 = 2026 Prizm The Rolling Stones, set 850130 = 2025 Prizm Bad Eggs (evidence: mint caps vs each product's serial ranges) named in `panini_products`, so the next ingest run links packs 979, 990, 1060, 1063. **Bad Eggs "Introducing the Clans" and "New Yolk City" have no set id** — the runner's Entertainment grid has never reported their cards; needs a runner-side look. |
| P2.8 older products | 🟡 in the shadow; 3 packs pass validation with a single live pack (Hoops 772 $6.03 vs $8 cost; 2022-23 Prizm Bball 791 $9.90 vs $27; 2022 WC Prizm 755 $21.15 vs $18) — **not published**, see "what the shadow taught" |
| P2.9 pricing rule (cap FMV at ask everywhere) | ✅ decided 12:35 PM PT — values capped everywhere, deals not (see the close-out above) |

**What building the tier model taught (11-22, measured):**
1. **A per-parallel slope model is unstable.** `log p = b_q + k_q·player` fitted slopes of ~6.8 on rare parallels and over-predicted held-out cards 2.3–5.8× (pooled, 5-fold). Rejected.
2. **A decile-binned model never extrapolates past an observed price** (a missing card is priced at the catalogued mean of its parallel within its player's decile). 5-fold holdout, pooled pred/obs, WC Stickers: Silver 1.03 · Blue 1.03 · Red 0.79 · Black 0.86 · Gold 0.67 · Green 0.58; Moonbirds: every parallel 0.94–1.15. **Complete tiers pass ±10 %; rare tiers run 14–42 % LOW with wide fold swings** (a few star cards carry each tier's mean). Shipped as the shadow's engine.
3. **"As designed" ≠ "what's left in the packs".** Panini's `rarity_distribution` is the MINTED mix. The remaining pool is bounded by supply: `packs_remaining × cards − catalogued still_in_packs` is the only room left for uncatalogued cards. Moonbirds: that room is ~3 cards, so its true EV is at most ~$66 (floor $57.22, shadow remaining $60.43) even though the design-mix EV is $104 — most Legendaries are already pulled. Stickers: shadow remaining $7.59, design $9.43 (floor $6.75). **The pull ledger decides which view predicts pulls; until then neither is published.**
4. **A tier's serial range is necessary but not sufficient.** Hobby, FOTL-exclusive and insert parallels share caps: WC Hobby Epic matches 3,071 catalogued cards vs Panini's 1,982 distinct; special pack 1051 values at $651 on a $220 cost. Such packs must never pass the gate — the "over-match" gate is written (`claude/patches/2026-11-22-panini-pack-ev-pool/…overmatch_gate.sql` in the project) but **not applied**: its approval prompt was auto-cancelled twice. Applied 12:14 PM PT on the third attempt (`20261122201452`).
5. **A >2× published-vs-tier gap was a matching bug, not a pricing bug** (Serie A 1041 $6.26 vs $37.67 → $8.74 after the serial-range fix; the rest is median vs mean).

**Next (in order):** at ~12-06 build the backtest on the pull ledger (realized pull mix per tier vs `rarity_distribution` vs remaining; realized value per opened pack vs shadow and published) · find the two missing Bad Eggs set ids on the runner · decide P2.9.

---

## 1. Where it stands

| Measure | Value |
|---|---|
| Live Panini pack listings | 375 (32 with an EV) |
| Packs opened, last 30 days | **88,042** — 84,685 of them on a pack with an EV (96 %) |
| …of which WC Stickers (1058) | 83,993 |
| Opened **excluding Stickers** | **4,049 — only 692 priced (17 %)** |
| Packs with any opens in 30 days | 81 |

The headline coverage is one product. Outside WC Stickers, five of every six packs collectors actually opened had no EV.

**Where the openings are (30 days, excluding Stickers):** WNBA Hobby 575 (priced) · WNBA White Sparkle 1062 468 · WNBA FOTL 1055 409 · 2022-23 Prizm Basketball 398 · Hoops 196 · NFL Draft Emoji 174 · Bad Eggs 149 · 2025 Prizm Football 145 · 2021 Select Football 139 · WC White Sparkle 1043 135 · Mosaic Football 127 · WC FOTL 104 · Rolling Stones 101 + 73. Sealed-dollar rankings are useless here (asks like $455,000 for one pack); **openings are the demand signal.**

## 2. What the probes found — the constraints, in order of how much they cost

### C1. The catalogue only sees a card once someone lists it — and the rare tiers are the ones nobody has listed
Panini publishes, per pack, its own composition (`panini_pack_state.raw → pack_config_info.rarity_distribution`: tier, share of cards, distinct cards, cards minted, serial cap). Against that, our catalogue (`panini_editions`) holds:

| Product | Distinct cards (Panini) | Catalogued | Share |
|---|---|---|---|
| 2021-22 Select Basketball | 3,916 | 426 | 11 % |
| 2021 Select Football | 4,880 | 651 | 13 % |
| 2022 Mosaic Football | 4,922 | 556 | 11 % |
| 2022-23 Prizm Basketball | 4,037 | 1,276 | 32 % |
| 2022 Hoops | 3,752 | 1,381 | 37 % |
| 2021 NFL Prizm | 3,238 | 1,583 | 49 % |
| 2026 WC Prizm | 6,570 | 5,355 | 82 % |
| 2026 WNBA Prizm | 2,310 | 2,019 | 87 % |

And the gap is not random. **WC Stickers by tier:** Common 926/960 catalogued, Uncommon 954/960, Ultra Rare 550/960, **Epic 406/1,920**, **Legendary (1/1) 80/960 — none of them still in packs.** The remaining-pool model's supply check (0.975) passed because cheap cards dominate the card count; it is blind to which *tiers* are missing.

**Consequence:** a remaining-pool EV is biased **low** wherever the rare tiers are under-catalogued. Stickers: pool EV **$6.75**; Panini's tier shares × catalogued per-tier prices give **~$12** (Common 60 % × $1.12, Uncommon 32.2 % × $1.03, Ultra Rare 5.9 % × $3.77, Epic 1.8 % × $59.49, Legendary 0.12 % × $126). The truth is between: the catalogued Epics skew to stars (median $5.50 vs mean $59.49), and the missing 1/1s are not worth $0. **The published $6.75 is a floor, not an estimate.** The same bias applies, smaller, to the WC and WNBA product models (82–87 % catalogued).

### C2. Panini's published composition is listing-independent — and nothing uses it
Sealed packs are random draws, so the expected composition of a remaining pack equals the published tier shares (cards minted per tier ÷ total; verified: Stickers 480,960 / 801,600 = 60.0 % = the published Common share). That turns the problem from "find every card" into "**price each tier**", which needs a representative price per tier, not a complete catalogue.

### C3. Sales capture holes look like thin markets
`panini_sales_ingest` accepted only `<card>__<serial>_<cap>` keys. Moonbirds (850178) keys its sales `packcard-850178_104_7_7_10` (single underscore), so **every Moonbirds sale was dropped** — 0 rows while 1,160 of its serials carry a last sale. Its FMVs still read MEDIUM (fed from serial last sales), which is how the pool model's sale-backed gate surfaced it. Only 850178 uses this shape (850180, 850179, 2130 all use `__`). **Fix written and verified, not applied** (blocked by the session's safety gate because it backfills 1,160 rows into production): `claude/patches/2026-11-22-panini-pack-ev-pool/20261122173500_…accepts_single_underscore_card_keys.sql` in the project. Nothing alarms on `offered ≠ valid` in that function's return.

### C4. New non-sports products are not linked at all
Bad Eggs (1053, 1061) and The Rolling Stones (1060, 1063) have `product_set_id = NULL` in `panini_pack_state` and no `panini_products` row — no cards, no sales, no prices. 348 packs opened in ~2 weeks. Runner-side (the grid enumerates by sport tab; these may have none).

### C5. Special single-parallel packs of modeled products
WNBA White Sparkle (1062, 468 opened, one /8 card), WC White Sparkle (1043), WC Animal Print (1051): each is one parallel. Today they fall to the guaranteed-slot model and fail its sale-count gate. Their cards were also, until today, inside the Hobby pools (fixed 11-22).

### C6. FOTL exclusive slots are under-indexed
WC FOTL 730 / 1,296 exclusive cards indexed, WNBA FOTL 1,780 / 2,161 → both withheld (90 % rule). This is C1 for one slot; the tier model (C2) is the way out.

### C7. No ground truth for pack EV
We never observe a pull, so no pack-EV number has ever been backtested. Card FMV has out-of-sample backtests; pack EV has only internal consistency checks (three methods agreeing on WC Hobby $61–63 today).

### C8. Card prices above the cheapest listing
FMV 1.4.x caps only LOW prices at the live ask; 38 % of the Stickers pool was priced above its own ask (median 2×). Pack EV now caps at the ask; edition FMV does not. A pricing-rule decision for Trevor.

> **Correction (11-22 PM):** the premise was stale — `fmv_snapshots` has capped every Panini sale tier at the live ask since 11-12; only `panini_fmv_snapshots` (Panini's own table) is uncapped. Resolved in §0: values capped everywhere, deals not.

## 3. Principles (unchanged, restated)
- **Accuracy is the gate.** A withheld EV beats a wrong one; a floor is labelled a floor.
- **Typical pull leads**; a positive mean edge is never the headline (page already does this).
- **Every published number names its evidence** — tier coverage, sale backing, supply cover — and is gated on it.
- **One engine, not one model per product.** Today: a WC view, a WNBA sales model, a guaranteed-slot view and a pool model. Each new product has meant a new model.

## 4. The plan

### P0 — this week (small, unblock and stop understating)
1. **Apply the Moonbirds sales fix** (C3) — written and verified; needs approval to write 1,160 seed rows. Then add a watch: `panini_sales_ingest` `offered − valid` > 0 for 3 runs → alert, so the next key shape is caught in hours, not weeks.
2. **Tier-coverage gate + "floor" label on the pool model.** For each Panini tier with ≥ 1 % of cards or ≥ 10 % of tier value, require catalogued coverage ≥ 50 % of its distinct cards, else publish the EV as "at least $X" (floor) instead of an estimate. Stickers today becomes "at least $6.75".
3. **Start the pull ledger** (C7). **Written and guard-tested, not applied** (blocked by the session's safety gate, same as P0.1): `claude/patches/2026-11-22-panini-pack-ev-pool/20261122174500_audit_20261122_panini_edition_supply_obs_pull_ledger.sql` in the project — one table, one hourly function, revert in its header. A daily snapshot table — `panini_edition_supply_daily(edition, day, still_in_packs, pulled_count)` and `panini_pack_supply_daily(pack, day, packs_remaining)` — one pg_cron job, a few MB/day. Day-over-day drops in `still_in_packs` are realized pulls; valued at the next week's sales they give **realized value per opened pack**. Two to four weeks of Stickers alone (~3,000 opens/day) is a statistically strong first backtest. Nothing else here creates ground truth.

### P1 — next 1–2 weeks (one engine)
4. **Tier-composition model** (C1/C2/C6). For every pack with a `rarity_distribution`: EV = cards/pack × Σ_tier share × E[value | tier]. E[value | tier] from a **player × parallel price model** — the WNBA sales model's `log(price) = player effect + parallel effect` (`refresh_panini_pack_ev_sales_model`), generalized to every product: the complete Common tiers pin each player, the sold parallels pin each tier, and an uncatalogued Epic is priced as *that player × that parallel* instead of as the average catalogued Epic (which is star-biased). Cap at live ask; typical pull by simulation over the tier mix.
   - **Validate before publishing:** on WC Prizm, WNBA and Stickers it must agree with today's models where their catalogue is complete (Common/Uncommon tiers within ±10 %), and with the pull ledger once 2 weeks exist (|EV − realized mean| ≤ 15 % over ≥ 500 opened packs).
   - Replaces `panini_pack_ev_model` (WC), the WNBA sales model and the pool model; the guaranteed-slot model stays for fixed single-card packs.
5. **Special single-parallel packs** (C5): the tier model with the pack's own one-tier `rarity_distribution` (1062, 1043, 1051 already carry it).
6. **FOTL slots** (C6): price the exclusive slot from its tier share and the player × parallel model instead of from indexed cards; lift the 90 %-indexed withhold only when the backtest supports it.

### P2 — catalogue reach and the long tail
7. **Link the unlinked products** (C4): runner maps Bad Eggs / Rolling Stones packs to their set ids and walks their cards (runner + `panini_products` rows).
8. **Older products** (2021–23 Select / Mosaic / Prizm / Hoops, 11–49 % catalogued): the tier model makes them modelable without a full catalogue *if* each tier has enough sold cards to fit its parallel effect; publish per pack only when it does.
9. **Pricing rule decision** (C8): cap edition FMV at the live ask on every tier, or keep it pack-EV-only.

### Success measures (re-read monthly)
- Share of **opened packs excluding Stickers** with a published EV: **17 % → 70 %**.
- Pull-ledger backtest: realized mean per opened pack within ±15 % of published EV on every product with ≥ 500 opens.
- Zero products where a published EV and the tier-weighted estimate differ by > 2× without a label.

## 5. Decisions for Trevor
1. Approve the Moonbirds sales fix (writes 1,160 seed rows; revert in its header).
2. Floor label vs withhold for packs whose rare tiers are under-catalogued (recommendation: floor label — the typical pull is robust; the mean is what is understated).
3. Pricing rule C8: cap edition FMV at the live ask everywhere? → **Decided 11-22 under Trevor's delegation: values yes, deals no** (§0).
4. Green-light P0.3 (pull ledger) and P1.4 (tier model) — the two items that change what we can claim.
