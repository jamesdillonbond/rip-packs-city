# Full platform audit — 2026-06-22 (Cowork)

Scope: backend/DB/security health, visual QA of editions/packs/sets/teams across all 5 collections, a packs deep-dive, and an FMV/Pack-EV parity assessment for NFL All Day + Disney Pinnacle. Read-only audit; nothing in this doc was shipped (the actionable fixes are route/.tsx + reviewed pricing logic → see `handoff-2026-06-22-audit-fixes.md`). Two candidate live DB ships were investigated and **correctly rejected** after verification (see §6).

## TL;DR

Platform health is **green** — security 0/0/0/0 on the authoritative checks, trust-health 9/9 ok, no stalled pipelines, no Sentry fire, current prod READY. The site renders accurately and wallet→username resolution works. The audit surfaced **6 real issues**, none of which are outages:

1. **Pinnacle has no working per-item page** — `/pinnacle/moment/[id]` 404s for every id (HIGH, route fix).
2. **Legacy-edition images are broken site-wide** — ~9,058 TS editions (and the oldest AllDay set) point at a dead `assets.nbatopshot.com/editions/` CDN path; 10–15 broken tiles on every Series-1-heavy pack/set/team page (HIGH-visibility, component/data fix).
3. **Pack opened/unopened counts exist for only 14 of ~5,200 packs** — the (excellent) "Packs Content Remaining" panel is absent for 99.7% of packs (HIGH for the packs ask, edge-function fix).
4. **AllDay "Holding Pack" distributions show garbage** — $999,999 price / $900,000 EV / 3% coverage on 17 dists (MED, data-hygiene + display fix).
5. **AllDay FMV is leaving money on the table** — 617 NO_DATA editions have a live floor ask that isn't surfaced as ASK_ONLY (the exact thing TS does) (MED, reviewed pricing logic).
6. **Pinnacle confidence labels are inconsistent** — 675/684 NO_DATA renders carry a price (should be ASK_ONLY) (LOW, writer fix).

The packs UI, when it has data, is genuinely best-in-class. The parity gap with TS is real but mostly **data-gated** (AllDay serials, Pinnacle's render model), not wiring.

---

## 1. Backend / DB / security health — GREEN

| Check | Result |
|---|---|
| `check_public_security_invariants()` | `[]` (no RLS-off + anon-write holes) |
| `check_secdef_anon_execute_violations()` | `[]` |
| `detect_stalled_pipelines()` / `get_pipeline_alerts()` | `[]` / `[]` |
| `v_rpc_trust_health` | 9/9 legs **ok** (fmv_sanity 0, pinnacle_ask 0.2h, pinnacle_fmv 18h, ts_uuid_dupes 0/200, unmapped backlog 24/100) |
| RLS-off base tables | **0** |
| Pipeline fails (24h) | 5, all transient/known (evm-transfers Base-429 ×3, check-alerts timeout ×1 @07:16Z, wallet-backfill-ufc Flow-429 ×1) |
| Sentry unresolved | **1** — `NEXTJS-1Q` "router state header could not be parsed" on the gated `/packs` route, 1 user / 1 event, known-transient |
| Vercel | current prod `75ee62f` **READY**, **0 ERROR** deploys (the CANCELED ones are docs-only commits, expected) |
| DB size | 5,142 MB (healthy) |

### Security (the user's explicit ask)
Authoritative checks are clean. Two defense-in-depth notes, **neither a live vulnerability**:

- **482 anon-write grants on RLS-on base tables.** Supabase's default grants `anon` INSERT/UPDATE/DELETE broadly; RLS is the actual gate, and `check_public_security_invariants()` confirms zero RLS-off+anon-write combinations. For top-tier posture, REVOKE anon DML on tables that don't need it — but this must be **targeted**, not bulk: `email_subscribers`, `outbound_clicks`, `portfolio_snapshots`, `support_conversations` intentionally allow anon INSERT (CLAUDE.md "Deferred hardening"). Recommendation, not an urgent fix.
- **30 anon-exec SECDEF functions** — all intentional public-page/concierge read RPCs; the blessed violation check is `[]`, so none are write-capable-and-anon-exposed.

`get_advisors(security)` output overflowed the tool limit (124 KB); per the documented pattern I used direct catalog SQL (the `rpc-security-drift` approach) instead.

---

## 2. Visual QA — editions / packs / sets / teams

Browser-verified across all 5 collections (logged-in session). Data was cross-checked against the DB; images checked via `naturalWidth===0`.

**Editions — strong template, one collection broken.** Cooper Flagg (TS, `243:8274`) is exemplary: FMV **$4,231 HIGH** matches DB exactly, parallel printings (Standard/Galactic/Omega with per-printing FMV + mint), FMV-history chart (30/90/365d), recent sales, special serials, "Featured in Insights" cross-links (54% squeeze, 8% below FMV, #1 sold 3.1× the field). **Wallet→username resolution works** — recent-sales rows render @thedailydile, @CardSaint, @JJLSmith, etc., with unresolved wallets correctly falling back to truncated `0x…`. Verified working on TS (Cooper Flagg, LeBron Series-1, Luka), AllDay (Saquon $510 LOW, Mahomes), UFC (Andre Muniz), Golazos (Griezmann — RARE, Mint 490, Atlético).
  - **BUG — Pinnacle `/pinnacle/moment/[id]` 404s for every id** (tested the catalog edition_id `2156` and a real minted moment NFT id `111050675472028`; both hit the branded "BINGO BANGO BONGO" 404). Pinnacle has no browsable per-item detail surface — its `pages` registry has no `edition`/`set` either. This is the single biggest per-item gap.
  - Minor: on the edition Special-Serials widget, the #1 owner shows truncated `0xc579…9f95` while the **same wallet** resolves to `@JJLSmith` in Recent Sales — username resolution isn't applied in the special-serials owner cell.
  - Note: the FMV/floor/ask stat block is client-fetched ("SCANNING THE MARKETPLACE…") and resolves a beat after the server-rendered hero — fine, but consider rendering the DB FMV immediately and only spinning the live-ask sub-fields.

**Sets — good.** Metallic Gold LE (1,191 editions / 454,057 mint / $41,519 FMV total / $34,801 floor), Tier Mix bar, editions grid. AllDay Base / TS Holo Icon render with **0 broken images**. Older sets carry broken tiles (see §3).

**Teams — rich hubs.** Lakers page: Team Checklist, Top Editions, Market Activity, "Sets featuring…", Squeeze & Scarcity, Roster, live game context ("Playoffs · Last: vs OKC"), accurate stats (575 editions / $63,999 FMV / 3,146 30d sales). Celtics ($29,065 top), Chiefs all render.

**Image-load summary** (the cross-cutting issue): newer sets clean (Holo Icon 0, AllDay Base 0, Chiefs 2/120); older sets/teams 10–15 broken (TS Base Set 10/107, Celtics 11/104, Lakers 15/103, AllDay Genesis 12/105). See §3.

---

## 3. Packs deep-dive (the explicit request)

**When the data exists, the packs experience is excellent.** Dist 5822 ("2025 WNBA Playoffs Round 1: Parallel Chase", one of the 14 packs with counts) shows exactly what the user is asking for, done well:
- **"Packs Content Remaining"**: a donut (3.5% unopened · 640 / 18,292 packs) with per-tier depletion bars (Legendary 0/59, Rare 6/291, Common 1,917/54,526).
- **Pull Odds by Tier** with honest methodology ("≈ chance of at least one card of that tier across 3 slots, from the live remaining pool… assumes independent slots").
- **Top Chases** (highest-FMV pulls, card art loading), **What's Inside** grid (FMV priced 100%, tier/floor/hit%/weight per card), **Sales History** ("traced via opened packs — partial coverage that grows over time").
- Honest EV caveats: "EV inflated by survivor bias (96% depleted) — treat as a ceiling." This is best-in-class.

**The problem: that panel is absent for 99.7% of packs.**
- `pack_distributions.total_minted/total_opened/total_sealed/depletion_pct` are **100% empty** (0 of 1,968 TS, 0 of 3,052 AllDay, 0 of 224 Golazos).
- The real counts live in `metadata` JSON (`total_pack_count`/`total_unopened`/`remaining_by_tier`), populated by `compute-topshot-pack-ev` v20 — but only for **14 of 1,968 TS packs (0.7%)** and **zero** AllDay/Golazos. So every other pack page just has no opened/unopened display.
- `pack_rips` (169,322 rows) captures recent on-chain opens but per-dist coverage is far too thin to substitute (dist 5822 = 4 traced opens vs ~17,652 actual) — so the fix is making the on-chain pack-supply query in the EV compute succeed for more dists, **not** a DB rollup. (This is why I did not ship a "traced opens" view — it would show misleadingly tiny numbers.)

**Other pack findings:**
- **Legacy pack "What's Inside" = wall of broken images.** Dist 468 ("2020 NBA Finals Series 1") had **15 of 30 images broken** — every moment tile (LeBron, Tyler Herro, Alex Caruso…) showed only the player-name alt text on an empty box. Same root cause as §2/§3 image breakage.
- **AllDay "Holding Pack" garbage.** Dist 5730 ("NFL Pack Hold - Genesis"): **Pack Price $999,999 · Gross EV $900,000 · FMV Coverage 3%**, empty hero montage. 17 such "Hold/Holding" dists carry EV (max $900,000). These aren't real consumer packs and look broken even with the "EV is a floor · 3% cov" caveat.
- The page degrades gracefully in other respects — state-aware CTA ("Buy on Top Shot" vs "Buy on Secondary Market"), honest "EV computed against [SECONDARY: $2,199]", "No traced sales yet for this pack" empty states. The hero pack-art box is frequently empty/black (the montage fallback when `image_url` is missing).

---

## 4. FMV & Pack-EV parity: NFL All Day & Disney Pinnacle

### Current state (latest-per-edition, live)
| | Editions | HIGH+MED | % | ASK_ONLY | NO_DATA |
|---|---|---|---|---|---|
| **Top Shot** | 17,316 | 4,353 | **25%** | 1,579 | 3,339 |
| **NFL All Day** | 6,191 | 903 | **14.6%** | **26** | 2,271 |
| **Pinnacle** (renders) | 2,266 priced 1,983 | 228 HIGH / 536 MED | — | n/a | 684 (675 carry a price) |

### What's portable, and what's gated
- **AllDay ASK_ONLY from live floor asks — the cleanest FMV win.** AllDay surfaces only **26** ASK_ONLY editions vs TS's 1,579, yet **617 of AllDay's 2,271 NO_DATA editions have a live floor ask** in `allday_edition_floor_ask`. TS already does exactly this (`fmv-recalc` Step 5b: ASK_ONLY at `low_ask × 0.90` from `badge_editions`). Porting it converts 617 "no data" editions into a usable price. **Pricing logic → must be reviewed + pass the mandatory LiveToken-validation gate before ship** (AllDay floor asks include troll asks, same as the Golazos $9,000 Estrellas asks — needs an outlier guard). Handoff item.
- **AllDay Pack EV is already live** (contradicts the "inert" assumption) — `compute-allday-pack-ev` ran 381 ok times, last 04:07Z, 521 dists priced. The work here is **hygiene** (drop the holding packs, §3) not new compute.
- **AllDay serial-FMV + special-serials — data-gated, not buildable now.** `allday_moment_serials` has only **64 rows** and `special_serial_holders` is **empty (0 rows)** — so there is no pre-computed AllDay special-serial ownership to surface (a prior assessment was over-optimistic here). The AllDay serial backfill must drain first, then `compute_serial_fmv_multipliers('<allday_uuid>')` can be fit and validated against LiveToken. Document + revisit.
- **Pinnacle is a separate render-keyed model by design** — FMV is already decent (1,983/2,266 priced, 228 HIGH), and the squeeze analog (`pinnacle_scarcity_board`) already exists (Pinnacle has no lock/burn mechanic, so true squeeze is not portable). The Pinnacle gaps are (a) the per-item page 404 (§2) and (b) the NO_DATA-with-price label inconsistency (§1/§6). Pinnacle has no serial axis, so serial-FMV/special-serials are N/A.

**Net:** the parity ceiling for AllDay/Pinnacle is mostly **data depth + a couple of route/writer fixes**, not missing infrastructure. The two highest-leverage parity moves are the AllDay ASK_ONLY port (617 editions, reviewed) and giving Pinnacle a working detail page.

---

## 5. Prioritized action list → see the handoff

| # | Issue | Type | Priority |
|---|---|---|---|
| 1 | Legacy-edition broken images (~9,058 TS + oldest AllDay) | component/data | **HIGH** |
| 2 | Pinnacle per-item page 404s | route | **HIGH** |
| 3 | Pack opened/unopened counts only on 14 packs | edge-function | **HIGH** |
| 4 | AllDay holding-pack garbage ($999,999/$900K) | data-hygiene + display | MED |
| 5 | AllDay ASK_ONLY from floor asks (617 editions) | reviewed pricing logic | MED |
| 6 | Pinnacle NO_DATA-with-price → ASK_ONLY label | writer | LOW |
| 7 | Special-serials owner username resolution | .tsx | LOW |
| 8 | Targeted anon-DML REVOKE (defense-in-depth) | DB security | LOW |

Full implementation detail, exact files, and revert paths: **`docs/handoff-2026-06-22-audit-fixes.md`**.

---

*Audit performed read-only against prod (`bxcqstmqfzmuolpuynti`, Vercel `75ee62f`). Health snapshot: security 0/0/0/0, trust 9/9, DB 5,142 MB, Sentry 1 known-transient.*
