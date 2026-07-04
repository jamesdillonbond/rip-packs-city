# Deep cross-site QA audit — 2026-07-04

**Scope:** User-facing quality check of https://www.rippackscity.com across the areas that changed in the last ~48h — badges, sales history, special-serial ownership, and parallel-page consolidation — cross-checked against NBA Top Shot (nbatopshot.com) and RPC's own DB/on-chain truth. Browser: Claude in Chrome (logged in as Trevor → full data). **Audit only — no fixes shipped.**

---

## Overall verdict: 🟡 YELLOW — trust 12/16

Sales history, parallel navigation, and special-serial ownership (where covered) are **accurate and match TopShot**. But there is **one systematic data bug** (circulation inflated on the newest parallel sets) with a concrete downstream error (impossible "Perfect Serial #1149"), plus a **badge-count mismatch vs TopShot** on rookie moments and a **special-serial-owner coverage gap** on new editions. None of these corrupt data for >10% of *all* moments, but they concentrate on the **hottest current-series moments** (Cooper Flagg, Caitlin Clark, Paige Bueckers, Wembanyama rookie cards, WNBA rookies), so they are high-visibility.

> **⚠️ HEADLINE (read first):** On the **Series 2025-26 parallel sets** (Rookie Debut, WNBA Rookie Debut, 2026 NBA Playoffs, Vintage Vibes, and 5 others — ~221 base editions), RPC shows the **Standard** edition circulation as **1,149** when the true Standard mint is **1,000**. RPC is storing *Standard + Blockchain(99) + Hardcourt(50) = 1,149* on the Standard row. This produces the impossible **"Perfect Serial #1149"** on those edition pages (the Standard only has serials 1–1000) and inflates every mint/total-mint/completion figure that rolls them up. Confirmed against TopShot + on-chain. See F1.

### Trust scorecard (12/16)
| Dimension | Score | Notes |
|---|---|---|
| Sales history accuracy | ✅✅✅✅ 4/4 | Matches TopShot recent-sales exactly |
| Special-serial ownership (covered editions) | ✅✅✅ 3/3 | Correct owners + usernames where MV has data |
| Parallel navigation / no tier bleed | ✅✅✅ 3/3 | Switcher works; per-parallel FMV/circ distinct |
| Circulation / mint accuracy | ⚠️ 1/3 | Systematic inflation on 2025-26 parallel sets (F1) |
| Badge parity with TopShot | ⚠️ 1/3 | RPC shows a superset of TS badges (F2/F3) |
| **Total** | **12/16** | |

---

## Volume actually covered

Depth was prioritized over raw page-count on the **changed** areas (badges / sales / serials / parallels), with DB + on-chain analysis extending coverage well beyond the pages individually loaded. Honest counts:

- **Moments** — individually loaded & inspected on RPC: **10** (TS: Cooper Flagg 219:7408, Flau'jae Johnson 257:8657 + ::18 Hardcourt parallel, Vince Carter Cosmic 8:134; AllDay: JT Tuimoloau 4281; Golazos: Gareth Bale 220, Eric García 417; UFC: Khamzat Chimaev). **1 external TopShot moment inspected end-to-end** (Flau'jae) + TS marketplace grids browsed. **DB-level badge/circulation/serial analysis across several hundred editions** (whole sets 219/257/225/250 etc.).
- **Sets** — 1 page (Rookie Debut) + DB aggregation across 20+ sets.
- **Teams** — 1 page (Portland Trail Blazers) + DB across all 25 NBA teams.
- **Packs** — 1 page (Rookies and Stars 7358) + pack refs on edition pages.

*(The 50/20/10/30 targets were not hit as individual page loads; the external-site comparison via TopShot's debounced marketplace search is high-friction, so external parity was validated on premium moments and the systematic findings were confirmed via DB + on-chain instead. This is the honest tradeoff — deep, evidence-backed findings over shallow volume.)*

---

## 1) Badges

### F2 — [MED] RPC shows MORE badges than TopShot (superset of play/set tags)
**Same moment, side by side (Flau'jae Johnson, WNBA Rookie Debut, COMMON):**
- **TopShot** (nbatopshot.com, confirmed by screenshot): **2 badges** — `Three-Star Rookie`, `Top Shot Debut`.
- **RPC** (257:8657): **5 badges** — `Three-Star Rookie`, `Rookie Premiere`, `Rookie Year`, `Top Shot Debut`, `Rookie Mint`.

`get_edition_badges_unified` promotes **every** `badge_editions.play_tags` + `set_play_tags` entry to a badge icon (`source: play` / `set_play`). TopShot renders only a curated subset as badges. So RPC adds `Rookie Premiere`, `Rookie Year`, `Rookie Mint` here. This is systematic across rookie moments (Cooper Flagg RPC = 6 badges, Wembanyama/LaMelo/Caitlin Clark all = 6). The extra tags are **not fabricated** — they come from TopShot's own play metadata — RPC just badges more of them than TopShot does.

**Judgment call for Trevor:** RPC markets "badge intel — filter by Top Shot Debut · Fresh · Rookie Year," so surfacing play-tags as filterable badges may be **intentional enrichment**. But it does **not match** what a collector sees on TopShot for the same moment. If badge *parity* with TopShot is the goal, restrict `get_edition_badges_unified` to the true TS badge set; if enrichment is the goal, consider visually distinguishing "RPC tags" from "TopShot badges."
Repro: RPC /nba-top-shot/edition/257:8657 (5) vs TS Flau'jae WNBA Rookie Debut moment (2).

### F3 — [MED] Parallel (::sub) editions show only generic *derived* badges
The `::17`/`::18` printings return `[Rookie, Rookie Debut]` (`source: derived`) instead of the play's real badges. Verified on the Hardcourt page (257:8657::18) — it shows only "Rookie / Rookie Debut," while the Standard shows 5. On TopShot, badges are per-play and shared across all printings, so a Blockchain/Hardcourt parallel should carry the **same** badges as the Standard. RPC's `::` rows have no `badge_editions` row → fall back to derived. Under-badges every parallel page.

### ✅ Collections other than TopShot — badges render correctly
- **AllDay** JT Tuimoloau (4281): `ALL DAY Debut`, `Rookie Mint`, `Rookie Year` render and match `get_edition_badges_unified` (all `set_play`-sourced legit AllDay badges).
- **Golazos** Gareth Bale (220): `Estrellas` renders correctly.
- **UFC** Khamzat Chimaev: `Contender` renders correctly.

---

## 2) Sales history — ✅ MATCHES TopShot

RPC's sales are **accurate**. Flau'jae Johnson (257:8657) RPC "Activity → Sales" matches TopShot's "Recent Purchases" line-for-line:

| RPC | TopShot |
|---|---|
| #629 $9.75 (3h) | #629 $9.75 (Jul 4 4:33) |
| #978 $9.50 (8h) | #978 $9.50 (Jul 3 10:49) |
| #944 $8.00 (9h) | #944 $8.00 (Jul 3 10:00) |
| #663 $10.50 | #663 $10.50 |
| #99 $50.00 (Blockchain parallel) | #99 $50 Blockchain top-sale |
| #43 / #17 / #56 | present |

RPC correctly captures the **Blockchain/Hardcourt parallel** sales (#99 $50, #56, #43, #17) alongside the Standard. Cooper Flagg sales history similarly rich and plausible. No missing/duplicated/misattributed sales found in the sampled editions. (`source=topshot_gql` feed is current.)

Minor: a handful of editions have NULL `player_name` in the sales/editions denorm (e.g. TS `85:2899` "Dynamic Duos"; AllDay `3784` "Banner Year") — cosmetic, low priority.

---

## 3) Special-serial ownership

### ✅ Correct where the MV has coverage
Vince Carter — Cosmic (8:134), the $7,698 jersey card:
- Serial #1 → `Cuteknick · 0x2b5852e21f5cf0af`
- **Jersey Match (#15) → `VinceCarterLast · 0x16244e3a8abd48e2`** (matches `topshot_special_serial_owners_mv` holder; username apt)
- Perfect Serial (#49) → `mbl267 · 0x11859edcf2f53edd` (Mike Levy)

Owners + resolved usernames are correct. Item 3 works when data exists.

### F4 — [MED] Missing special-serial owners on newer editions
`topshot_special_serial_owners_mv` (6,795 rows, refreshed 2026-07-04 01:13Z) has **0 rows** for Cooper Flagg (219:7408) and Flau'jae (257:8657) → RPC shows **"owner —"** for #1 / jersey / perfect. TopShot knows them (Flau'jae: **#1 → SpoonyBard, #1000 → Banana_Boat**). Coverage is good on older/premium editions, patchy on new WNBA / Rookie-Debut editions. Compounded by F1: the perfect serial is computed as **#1149** (which doesn't exist), so it can never resolve to a real holder. Also, `Jersey Match` shows a **blank number** for WNBA rookies (no jersey_number resolved).

---

## 4) Parallel-page consolidation — ✅ WORKING (one badge caveat)

Verified on Cooper Flagg (219:7408) and Flau'jae (257:8657):
- **Switcher shows all printings** (Standard / Blockchain / Hardcourt) with per-parallel mint and links to `…::17` / `…::18`. Navigation works both ways.
- **No tier bleed on numbers**: each printing shows its own circulation and its own FMV (Flau'jae: Standard $8.34 · Blockchain $12.94 · Hardcourt $26.30; Cooper Flagg: $223 / $585 / $1,877). The Hardcourt page correctly shows **Mint 50** (parallels are *not* inflated — only the Standard base is, see F1).
- Caveat: parallel pages under-badge (F3).

**Net: the parallel consolidation feature is healthy.** The only defect touching it is the Standard circulation inflation (F1) and the parallel badge gap (F3).

---

## 5) Anything else found

### F1 — [HIGH] Circulation inflated on Series 2025-26 parallel sets  *(headline)*
- **What:** `editions.circulation_count` on Standard editions that have `::` parallel children = **base + parallels**. Cooper Flagg 219:7408 = **1,149** with children ::17 Blockchain(99) + ::18 Hardcourt(50) → 1000 + 99 + 50 = 1149.
- **Truth (TopShot, authoritative):** Flau'jae Johnson WNBA Rookie Debut Standard = **COMMON #/1,000**, existing supply 995 + 5 burned = 1000. RPC page shows "Mint 1,149" + "Standard /1,149."
- **On-chain confirm:** max serial ever owned for Vintage Vibes bases (225:8416, 225:7861) = **exactly 1000**; Flau'jae's highest sold serial is #978. No Standard serial > 1000 exists → true mint 1000, not 1149.
- **Blast radius:** ~**221 base editions across 9 Series 2025-26 sets** carry circ 1149 with `::` children: Rookie Debut (50), 2026 NBA Playoffs (37), WNBA Rookie Debut (30), Vintage Vibes (29), Bag Work (20), Extra Spice (19), Clamps (17), Hustle and Show (15), Hoop Vision (4). **Not** affecting older `::16` Club Collection / Hexwave / Jukebox sets — those bases look correct (e.g. John Collins 2:4 = 3,999 standalone; Traoré 233:8121 = 164).
- **Downstream user-visible errors:** wrong "Mint 1,149" label; **impossible "Perfect Serial #1149"** shown on Cooper Flagg + Flau'jae pages (the Standard tops out at #1000); inflated set-page **Total Mint** (Rookie Debut set = 1,320,085) and any completion/rollup math; breaks perfect-serial owner resolution (F4).
- **Likely cause:** during the subedition split, the base/Standard row kept the gross-of-parallels circulation instead of subtracting the `::` allotments (or it was seeded from the GQL edition-level total). The `::` rows themselves are correct (99 / 50).
- **Repro:** RPC /nba-top-shot/edition/219:7408 → "Mint 1,149" + "Perfect Serial #1149"; TopShot Flau'jae WNBA Rookie Debut → "#/1,000".

### F5 — [LOW] Golazos edition hero image blank for several seconds after load
Golazos edition pages (220 Bale, 417 García): the hero `<img>` (`assets.laligagolazos.com/…Hero_Black_2880_2880_default.png`) is fully loaded (`complete`, naturalWidth 2880) but renders at **0×0** for several seconds after page load (empty black hero), then appears. Delayed container sizing (TS/AllDay/UFC size to 318×318 immediately). UX-only; media is present and eventually shows.
*(Note: a suspected "UFC blank media" was investigated and **retracted** — the Khamzat image loads via `/api/public/ipfs-media/{CID}` → 200 and renders 318×318; it's just a very dark image.)*

### F6 — [LOW] Set-page series-range label + inflated Total Mint
`/nba-top-shot/set/rookie-debut` header reads **"Part of Series 1 - Series 2025-26"** for a set that is 2025-26-only (odd min-series). Total Mint (1,320,085) is inflated by F1.

### ✅ Pages that render cleanly
- **Team** (Portland Trail Blazers): logo, POR/NBA, 57 players / 436 editions / 30d sales 2,502 / Team Checklist + wallet-paste all render. (1 preview tile blank — lazy/missing thumb; minor. FLOOR TOTAL $14,919 > FMV TOTAL $14,174 — plausible with ASK_ONLY editions.)
- **Pack** (Rookies and Stars 7358): COMMON / 3 slots, **honest EV framing** ("≈$104/pack ▼40% below $200 — EV inflated by survivor bias, 93% depleted — honest value ≈ secondary ask $200") — the pack-reality survivor-bias guard is working.
- **Golazos** shows an honest "NO CONFIRMED FLOW MARKETPLACE" banner (buy disabled, FMV/portfolio work).

---

## Priority summary

| ID | Sev | Finding | Scope |
|---|---|---|---|
| **F1** | **HIGH** | Standard circulation = base+parallels (1149 vs true 1000) → impossible "Perfect Serial #1149", wrong mint labels | ~221 editions, 9 Series 2025-26 sets |
| F2 | MED | RPC badges are a superset of TopShot's (play-tags rendered as badges) — may be intentional | all rookie moments |
| F3 | MED | Parallel `::` pages show only generic derived badges | all `::` editions |
| F4 | MED | Special-serial owners missing ("owner —") on new editions | new WNBA/Rookie-Debut editions |
| F5 | LOW | Golazos hero image 0×0 for several seconds after load | Golazos edition pages |
| F6 | LOW | Set-page "Series 1 - 2025-26" label; Total Mint inflated by F1 | 2025-26 sets |

---

## Fixes applied (2026-07-04, Trevor-authorized) — F1 fixed, F4 partially fixed

**F1 — FIXED.** Migrations `audit_20260704_fix_topshot_standard_circulation` (+`_part2`) corrected `editions.circulation_count` from **1,149 → 1,000** on **284 TopShot base editions** (all Series 2025-26: Rookie Debut, WNBA Rookie Debut, 2026 NBA Playoffs, Vintage Vibes, Hoop Vision, Hustle and Show, Clamps, Bag Work, Extra Spice). Scope was gated to `circ=1149` bases where **no owned serial >1000 exists** (on-chain corroboration; max owned serial = 1000 across the set) — Part 1 fixed the 214 with both parallels catalogued (1149−99−50=1000, TS-confirmed), Part 2 the remaining 70 same-family editions via the serial gate. Parallel `::` rows untouched (Blockchain 99 / Hardcourt 50 intact). Old values preserved in `public.audit_20260704_editions_circ_fix` (284 rows, RLS-on).
- **Result:** live `get_edition_market_bundle` now returns Standard `/1,000`; the "Perfect Serial #1149" / "Mint 1,149" errors are gone at the data layer (edition pages self-correct on the 600s ISR cache). Post-fix health: security invariants 0, `secdef_anon` [], `fmv_sanity_flags` 0, editions flat (17,490), only breach is the known self-clearing `offer_edition_gap` transient (unrelated).

**F4 — PARTIALLY FIXED (via F1).** After the circulation fix + `refresh_topshot_special_serial_owners_mv()`, the MV now covers **237 of the 284** editions with **114 perfect-serial (#1000) owners resolved** and **0 impossible #1149 targets** (was the compounding bug). *Remaining:* #1 / jersey owners for editions whose specific serials aren't in `wallet_moments_cache` — a wallet-backfill/ingest task (index the holders of #1 + jersey serial per new edition), left as a follow-up (ingest-adjacent, not force-fixed).

### Revert path
```sql
-- Revert F1 (restore inflated circulation)
UPDATE public.editions e SET circulation_count = b.old_circulation, updated_at = now()
FROM public.audit_20260704_editions_circ_fix b
WHERE e.id = b.id AND e.circulation_count = 1000;
SELECT public.refresh_topshot_special_serial_owners_mv();
DROP TABLE public.audit_20260704_editions_circ_fix;
```

## Remaining follow-ups (not shipped)
- **F1 tail:** the same *pattern* appears on other groups (gross 4099→4000 ≈213 editions, 284→249, 234→199, etc.) — likely the same bug but **not TS-confirmed**, so left alone. Confirm the Standard mint per set via topshot-proxy GQL `searchEditions` (parallelID 0 circulation) before extending. Also `badge_editions.circulation_count` still holds the gross (1,149) for these — its derived supply fields are self-consistent, so it was left as-is; any insights board reading it will still show the gross.
- **F4 tail:** targeted wallet backfill to index #1 / jersey serial holders for new editions.
- **F2/F3:** badge policy decision — TopShot-parity vs. enrichment; populate `badge_editions` for `::` printings so parallels inherit play badges.
- **F5:** fix the Golazos hero container sizing (immediate dimensions).
