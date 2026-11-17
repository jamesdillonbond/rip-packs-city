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

## F3 — FIXED (2026-07-04)
Migration `audit_20260704_edition_badges_unified_parallel_inherit_base`. `get_edition_badges_unified` joined `badge_editions` on the full external_id, so `::` parallels (which have no badge row) fell through to generic **derived** badges (Rookie / Rookie Debut). Changed the three badge joins to key on the **base** external_id (`split_part(external_id,'::',1)`) so parallels inherit the play's badges — correct (badges are per-play, shared across printings on TopShot) and consistent with the Standard. Verified: Flau'jae Blockchain (::17) + Hardcourt (::18) now return the same 5 badges as the base (were 2 derived); base editions unchanged (Cooper 6 / Flau'jae 5); AllDay/Golazos/UFC derived-fallback path untouched (AllDay JT still 3). Security invariants 0, fmv_sanity 0. **Revert:** `CREATE OR REPLACE` the function with the join key back to `ed.external_id` (prior def in migration history).

## F1 extension — DONE authoritatively (getMinted − modern sub-printings), after a wrong turn corrected
This took two tries; the second is authoritative. The GQL circulation fields are inconsistent and required care:
- **`searchMarketplaceEditions.circulationCount` (parallelID 0) is unreliable** — right for recent/LE sets (Flau'jae Standard 1000, Jarrett 464) but **undercounts variable-mint Base Sets** (Jalen Duren 218:8061 reported 4000, but his real serials run to 7,999). A first pass using it corrected 1,514 editions, then was **fully reverted** (`audit_20260704_revert_gql_circulation_extension`) once the undercount was found.
- **Authoritative source = `getMintedMoment.edition.circulationCount`** = the true GROSS (all sub-printings *included in the edition*). Verified: Jalen Duren = **8,500** (matches serials to 7,999).
- **The rule:** true Standard = `getMinted gross − Σ(modern sub-printing children, subedition_id ≥ 17)`. The modern `::17+` printings (Blockchain/Hardcourt/Hexwave/Jukebox/…) ARE in the gross; the old `::16` "Club Collection" is a **separate pool NOT in the gross** (Trae Young 2:1 gross 2978, serials to 2976 → don't subtract ::16). Verified: Flau'jae 1149−149=1000, Jarrett 654−190=464, Jalen Duren 8500−0=**8500**, Trae Young 2978 (unchanged).
- **Shipped** (`audit_20260704_fix_circulation_getminted_authoritative`): swept `getMintedMoment` for the 998 with-`::`-children base editions, corrected **278** (277 de-inflations + undercount fixes incl. Jalen Duren 4099→8500), guarded by `new_std ≥ max owned serial`. **Total F1 = 562 editions** (284 parallel-family + 278 getMinted), all reversible via the shared backup table.
- Post-fix: security invariants 0, fmv_sanity 0, editions flat (17,490); serial-owners MV refreshed; staging tables dropped.
- *Residual:* 23 getMinted lookups failed (retired moments) + 2 guard-skips — negligible.

### Stray-serial / mis-key scan — CLEAN (premise dissolved)
The "stray serial" concern originated with Jalen Duren (owned serial 7,999 vs stored circ 4,099). That turned out to be a **circulation undercount, not a mis-key** — his edition genuinely minted ~8,500 (contiguous real serials; getMinted confirms 8,500), now fixed. A scan of **1,000 sampled no-`::`-children TS base editions (recent + legacy) found 0 with an owned serial exceeding stored circulation** — so there are no widespread mis-keyed wmc rows and no Jalen-Duren-style undercounts hiding among the no-children editions. The 562 corrected editions are guard-protected (circulation ≥ max owned serial by construction). Net: the full-catalog getMinted sweep is unnecessary; TopShot circulation is now consistent.

## F2 — FIXED toward TopShot parity (Three-Star Rookie consolidation)
**Decision (Trevor): pursue parity.** Investigation findings:
- `get_edition_badges_unified` already allowlists badge titles + excludes gameplay tags — it was not dumping raw tags.
- TS GQL marks all the disputed rookie tags `visible=true` (`level` = just PLAY/SETPLAY), and exposes **no** `badges` field (Tag type = `id/title/visible/level/name` only). So TopShot's moment-page badge selection is a **hidden client-side rule** with no data source — confirmed by direct observation (Flau'jae TS page shows exactly `Three-Star Rookie` + `Top Shot Debut`, hiding Rookie Year/Premiere/Mint despite all being visible).
- **The rule (per Trevor, authoritative):** the **Three-Star Rookie** badge *represents* Rookie Year + Rookie Mint + Rookie Premiere; Top Shot Debut is separate.

**Shipped** (`audit_20260704_edition_badges_three_star_consolidation_v2`): when Three-Star Rookie is present, suppress the standalone `Rookie Year` / `Rookie Mint` / `Rookie Premiere` badges it subsumes (keep Top Shot Debut + any other badge). Verified: **Flau'jae 257:8657 → `Three-Star Rookie | Top Shot Debut` = exact TopShot parity** (was 5); Cooper Flagg → `Three-Star Rookie | ROY | Top Shot Debut`; Moses Moody → `Three-Star Rookie | Championship Year | Top Shot Debut`; parallels inherit the same (F3). Non-three-star moments (Paige Bueckers, KD MVP, Vince) unchanged — no over-suppression. Security invariants 0, fmv_sanity 0. **Revert:** `CREATE OR REPLACE` the function without the `has_tsr` suppression clause.

*Residual (documented, not chased):* full pixel-parity for the non-three-star cases (does TS show standalone Rookie Year / ROY / MVP Year / Championship Year, and when?) is a hidden client rule that would need reverse-engineering from many TS pages and would be brittle to TS UI changes — deliberately not pursued. The Three-Star Rookie consolidation covers the dominant over-display case and is lossless (the combo badge represents the hidden ones).

## Remaining follow-ups (not shipped)
- **F1 tail:** authoritative GQL circulation backfill for the non-1149 patterns (see above).
- **F4 tail:** targeted wallet backfill to index #1 / jersey serial holders for new editions.
- **F5:** fix the Golazos hero container sizing (immediate dimensions).
- Note: `badge_editions.circulation_count` still holds the gross for the fixed editions (its derived supply fields are self-consistent, so left as-is); insights boards reading it show the gross, not the corrected Standard.

---

# Mobile layout QA pass (2026-07-04) — first mobile-viewport-focused audit

All prior QA on this site was desktop-only. This pass audited the layout at a 390px (iPhone) mobile width across home/browse, moment-detail, edition, set, and pack pages, with focus on the recent v2 TopShot features (% Listed / Sales+Offers toggle, tier/parallel switcher, the `cached_listings_v2` LISTED field).

## Method + a real environment constraint (documented honestly)

The intended path (Claude-in-Chrome, resize viewport to 390px) was **not achievable in this session**: the Chrome window is maximized to the full screen width (1267 CSS px) and the extension's `resize_window` is a no-op against a maximized window (verified — `window.innerWidth` stayed 1267 across resizes to 390/500/900px). DevTools device-mode couldn't be toggled either (the extension's synthetic key events reach the page, not Chrome's browser chrome), same-origin iframing is blocked by the site's own `X-Frame-Options: DENY` (a proxy.ts security feature, correct), and popups are blocked without a user gesture. So a true sub-640px render was not possible here.

Pivoted to the methodology a front-end dev actually uses to fix mobile bugs, which does not require a narrow viewport:
1. **Source audit** of the responsive layout — for this codebase (almost entirely inline React styles + a few classes in `app/rpc-tokens.css`), the base Tailwind/inline styles ARE the mobile layout that renders <640px; `md:`/`lg:` and `@media(min-width:…)` rules are desktop-only.
2. **Live DOM structural scan** (JS in the real rendered pages) for viewport-independent overflow causes: unwrapped `<table>`s, fixed-px widths/min-widths >390px not inside an `overflow-x:auto` ancestor, and `document.scrollWidth > innerWidth`. Ran on the live edition, overview, collection, market, sniper, packs, sets, and analytics pages.
3. **Three parallel source-audit agents** over home/browse, set/entity, and pack surfaces with a strict overflow rubric.
4. **Repo-wide grep** for the one pattern the desktop scan can't reveal: fixed-pixel `gridTemplateColumns` tracks (which overflow phones, unlike shrink-safe `minmax(…,1fr)`/`auto-fit`).

## Headline finding: the site is genuinely mobile-hardened

Every method converged: **no horizontal overflow, no cut-off content, no unwrapped tables, viewport meta present** (`width=device-width, initial-scale=1`, set globally). Concretely verified:

- **Viewport meta** correct site-wide.
- **Detail pages** (`/nba-top-shot/edition/[slug]` and `/moment/[id]`, the latter serving TopShot/AllDay/Golazos via collection routing) are responsive by construction: `clamp()` headings, `repeat(auto-fit, minmax(≤180px,1fr))` grids that collapse to 1 column on phones, hero grids (`.rpc-entity-hero`, `.rpc-moment-hero`) that stack ≤640/768px, tables wrapped in `overflow-x:auto`, ellipsis-truncated `StatCell`s.
- **The called-out v2 features all render mobile-safely:** the Sales/Offers toggle (`EditionActivity.tsx`) uses `flexWrap:wrap` and wraps the Offers table in `overflow-x:auto`; the parallel/tier switcher (`ParallelTierSwitcher.tsx`) uses `flexWrap:wrap` pills; the `% Listed` and `LISTED` (from `cached_listings_v2`) fields are ordinary `StatCell`s inside the shrink-safe `auto-fit` FMV grid; the Special-Serials 460px row is inside a `.rpc-scroll-x` (`overflow-x:auto`) wrapper.
- **Wide tables** are universally scroll-wrapped or replaced on mobile — e.g. `PackTable` renders a `min-w-[900px]` table `hidden md:block` inside `overflow:auto` AND a separate `md:hidden` card layout for phones; the sniper `min-w-[980]` table is inside a scroll wrapper; the collection monolith's `min-w-[2000px]` table is in `overflow-x-auto`.
- **Grids:** the repo-wide grep found **zero** fixed-pixel grid column tracks anywhere — every `gridTemplateColumns` uses `minmax(…,1fr)`/`auto-fit`/`auto-fill` (shrink-safe) or sits inside `.rpc-scroll-x`. Home-page fixed grids collapse via an explicit `@media` block.

Live `document.scrollWidth <= innerWidth` on all 8 scanned pages (no horizontal overflow at the tested width).

## Bug found + fixed (1)

**Collection `/overview` page — data panels didn't stack on phones.** The overview (the canonical browse page) laid out its 3-up KPI row and two content-heavy 2-up panel rows (`Sniper Deals | Pipeline Status`, `Recent Top Sales | About the Community`) with inline `grid-template-columns` and **no media query**, so on a 390px phone the two data panels rendered two-up at ~160px each — cramped and hard to read (though `minmax(0,1fr)` prevented hard horizontal overflow). This is the "does the layout stack correctly?" case.

**Fix (shipped, commit `1d7b4ec`):** moved the three grids to `.rpc-ov-kpi3` / `.rpc-ov-2col` utility classes in `app/rpc-tokens.css`; desktop keeps the multi-column layout, phones collapse to a single column at ≤640px — mirroring the existing `.rpc-entity-hero` / `.rpc-home-stats-row` / `.rpc-footer-*` responsive pattern already in the file. CSS/layout only, desktop rendering unchanged, `tsc` clean. **Revert:** `git revert 1d7b4ec`.

## Observed but not changed (not overflow bugs)

- `sets/page.tsx` expanded-SetCard detail grid uses `repeat(3, 1fr)` with no ≤640px collapse — cramped 3-up thumbnails inside an already-narrow card on phones, but `1fr` tracks shrink to the card (no overflow), so left as-is (changing SetCard internals is more invasive than the density gain warrants).
- The overview 3-up KPI row is included in the fix above (collapses to 1 column ≤640px), which also resolves `"78% HIGH/MED"` wrapping awkwardly in a ~109px column.

## Caveat

Because a true narrow-viewport render wasn't possible in this environment, these findings rest on source + live-DOM structural analysis rather than visual confirmation at 390px. The shipped fix is standard, low-risk responsive CSS; a follow-up visual spot-check on a real phone or a working device-emulation session would confirm the stacked overview renders as intended. Everything else audited was already responsive.

---

# Cross-site Badge + Sales Parity Audit (2026-07-04)

The morning's deep QA got pulled into the F1 circulation fixes and never finished the systematic cross-site comparison. This pass completes it: **10+ moments per collection loaded on BOTH RPC (via `get_edition_badges_unified` / the sales table that back the live pages) and the live source sites** (nbatopshot.com v2, nflallday.com, laligagolazos.com), plus the set/team volume check. Browser: Claude in Chrome. Method: RPC-side badge/sales pulled from the exact functions/tables that render the pages, then each moment loaded on its source site and compared field-for-field. **Audit only — no fixes shipped in this pass.**

## Headline: badge parity is now strong; one NEW high-severity circulation bug on the hottest editions

- **The old F2 "RPC over-badges rookies" gap is RESOLVED and verified live** — the July-4 Three-Star Rookie consolidation matches TopShot exactly across every rookie case tested (three-star, non-three-star, and three-star+Championship).
- **NEW — F7 [HIGH]: Series 2025-26 Base Set + WNBA Base Set circulation is inflated by +99** (the Club Collection `::16` parallel folded into the base). RPC shows `/4,099` (or `/1,099`) where TopShot authoritatively shows `/4,000` (or `/1,000`). **~218 editions**, and they are the **single most actively-traded set on the platform** (Base Set commons, 46–58 sales / 4 days each). Same symptom class as F1 (impossible "Perfect Serial #4099", wrong mint labels, inflated set/team Total Mint) but the `::16` family the F1 fix **deliberately excluded**.
- **NEW — F8 [LOW-MED]: two residual badge-superset classes** — RPC still surfaces TopShot's `Challenge Reward` set-tag as a badge (TopShot hides it), and ~41% of TopShot `offer_fill` sales land with `serial_number = 0`.

### Scorecard (this pass)
| Dimension | Result | Notes |
|---|---|---|
| TopShot badge parity | ✅ 12/14 exact | 2 misses = `Challenge Reward` superset (F8) |
| AllDay badge parity | ✅ 6/7 (7/7 edition-level) | lone miss = a serial-level jersey badge, arguably correct |
| Golazos badge parity | ➖ N/A | source site shows **no** badges at all |
| Sales history accuracy | ✅ ~1:1 | serial+price+time match exactly (TS displays PDT); 1 missing sale + serial-0 gap |
| Circulation accuracy | ⚠️ | 13/17 exact vs TS; **Base/WNBA-Base +99 (F7)** |
| Set/team pages | ✅ | all render, counts reasonable |

---

## Part 1 — Badge parity

### TopShot vs nbatopshot.com (v2) — 14 moments, 12 exact matches

| Edition | Player | RPC badges | TopShot badges | Match |
|---|---|---|---|---|
| 164:5840 | Ariel Hukporti | Three-Star Rookie · Top Shot Debut | THREE-STAR ROOKIE · TOP SHOT DEBUT | ✅ |
| 190:6785 | Kiki Iriafen | Three-Star Rookie · Top Shot Debut | (same) | ✅ |
| 164:5728 | Isaiah Collier | Three-Star Rookie · Top Shot Debut | (same) | ✅ |
| 219:7638 | Micah Peavy | Three-Star Rookie · Top Shot Debut | (same) | ✅ |
| 190:6779 | Elizabeth Kitley | Three-Star Rookie · Championship Year · Top Shot Debut | THREE-STAR ROOKIE · TOP SHOT DEBUT · CHAMPIONSHIP YEAR | ✅ |
| 164:5844 | Dillon Jones | Championship Year · Rookie Year · Top Shot Debut · Rookie Mint | ROOKIE YEAR · ROOKIE MINT · TOP SHOT DEBUT · CHAMPIONSHIP YEAR | ✅ |
| 125:4474 | O.-M. Prosper | Rookie Year · Top Shot Debut · Rookie Mint | ROOKIE YEAR · ROOKIE MINT · TOP SHOT DEBUT | ✅ |
| 218:8339 | Ron Harper Jr. | Top Shot Debut | TOP SHOT DEBUT | ✅ |
| 111:3979 | Kalani Brown | Top Shot Debut | TOP SHOT DEBUT | ✅ |
| 16:218 | Damian Lillard | (none) | (none) | ✅ |
| 38:1072 | Robert Williams III | (none) | (none) | ✅ |
| 28:877 | Julius Randle | (none) | (none) | ✅ |
| 173:6084 | Chet Holmgren | Championship Year · **Challenge Reward** | CHAMPIONSHIP YEAR | ⚠️ RPC extra |
| 53:2694 | Tyrese Haliburton | **Challenge Reward** | (none) | ⚠️ RPC extra |

**Key validation:** the July-4 Three-Star Rookie consolidation now matches TopShot's hidden client-side rule exactly. Critically it discriminates correctly:
- **Three-star rookies** (Hukporti, Iriafen, Collier, Peavy) → TS collapses to `Three-Star Rookie + Top Shot Debut`; RPC matches.
- **Non-three-star rookies** (Dillon Jones, Prosper) → TS shows the individual `Rookie Year / Rookie Mint / …` badges (no collapse); RPC matches (did NOT over-collapse).
- **Three-star + extra** (Kitley) → TS shows `Three-Star Rookie` alongside `Championship Year`; RPC matches.

So the prior **F2 "RPC shows a superset of TS badges" finding is resolved** for the rookie-tag family.

**F8a [LOW-MED] — residual superset: `Challenge Reward`.** The 2 misses are the same class: RPC promotes the `Challenge Reward` set-tag to a badge on challenge-reward sets (Denied!, Holo Icon), but **TopShot does not display it** on the moment page. Chet Holmgren: RPC `Championship Year + Challenge Reward` vs TS `Championship Year` only. Haliburton: RPC `Challenge Reward` vs TS no badges. This is the leftover of the original F2 problem for a non-rookie tag family. (Judgment call, same as F2: enrichment vs strict parity. If parity is the goal, exclude `Challenge Reward`/`Challenge Reward`-class set-tags from `get_edition_badges_unified` the way the rookie tags are now handled.)

### AllDay vs nflallday.com — 7 moments, 6 exact matches (7/7 at edition level)

| Edition | Player | RPC badges | Source badges | Match |
|---|---|---|---|---|
| 995 | Michael Thomas | ALL DAY Debut · Rookie Year | ALL DAY Debut · Rookie Year | ✅ |
| 6028 | Emeka Egbuka | Rookie Mint · Rookie Year | Rookie Year · Rookie Mint | ✅ |
| 5313 | Carson Schwesinger | Rookie Mint · Rookie Year | Rookie Year · Rookie Mint | ✅ |
| 6142 | D'Andre Swift | Rookie Year | Rookie Year | ✅ |
| 2589 | Kevin Faulk | Rookie Year | Rookie Year | ✅ |
| 2179 | Rashee Rice | Championship Year · Crafted Reward · Rookie Mint · Rookie Year | (same 4) | ✅ |
| 6190 | Dak Prescott | Crafted Reward · Rookie Year | Rookie Year · **Player Number** · Crafted Reward | ⚠️ source extra |

**AllDay is essentially at full parity.** Note that unlike TopShot's hidden `Challenge Reward`, AllDay's source **does** display `Crafted Reward` — and RPC matches it (Dak, Rashee). The lone diff is Dak Prescott, where the source adds a **`Player Number`** badge: this is a *serial-level* jersey-match badge (his loaded serial is **#4**, jersey **#4**), not an edition-level badge, so `get_edition_badges_unified` (edition-scoped) correctly omits it. Arguably not a defect — but if RPC wants per-serial "Player Number" parity on the moment page it would need serial-aware badge logic. (3 of the 10 sampled AllDay editions had no indexed holder for a moment URL, so 7 were loadable.)

### Golazos vs laligagolazos.com — source shows NO badges

The Golazos source site moment page (verified on Gareth Bale #220 and Luka Modric #99) has **no badge section at all** — it shows only Tier, Serial, Match Highlights, Player Performance, Edition Data, and Sales History. RPC's Golazos "badges" (`Estrellas`, `Tiki Taka`, `El Clásico`, `Team Europa`) are **set-theme enrichment** derived from Dapper's set/tag metadata with no source-site equivalent. This is **not a data error** (they're real set themes), but there is nothing to achieve "parity" against — it's pure RPC value-add. Flagged for awareness, not as a bug.

---

## Part 2 — Sales history vs TopShot (10 editions; 3 deep-compared)

**Timezone key (resolved):** TopShot displays sale times in **PDT (UTC−7)**; RPC/DB stores UTC. Every compared row lines up on serial + price + time once the 7-hour offset is applied.

- **Jonathan Kuminga (218:8757):** all 12 TopShot "Recent Purchases" rows match RPC **exactly** on serial, price, and timestamp. ✅
- **Dalton Knecht (218:8777):** 11/12 exact. The lone difference is a Club-Collection parallel sale (#90, $2.00) that RPC recorded via `source=offer_fill` with **`serial_number = 0`** (price + time correct, serial unresolved).
- **Obi Toppin (218:8775):** RPC is **missing one sale** — `#925 $0.27 @ 16:37 UTC` — that TopShot shows. Confirmed genuinely absent (RPC has the neighboring 16:41 / 16:39 / 16:10 sales and the later 17:14 sale, and #925 is on no parallel edition and not an ingestion lag). Isolated single-event gap (1 of ~58 sales for that edition).

**F8b [LOW-MED] — `offer_fill` serial resolution gap (quantified).** Platform-wide, **1,697 of 4,090 TopShot `offer_fill` sales in the last 7 days (≈41%) carry `serial_number = 0`.** Accepted-offer sales are captured with correct buyer/price/time (per the `OfferCompleted` event) but the path frequently fails to resolve the moment's actual serial, so those rows render as `#0` / blank serial in the sales-history table. Not a price/valuation error, but a visible data-quality blemish. (The `#4 $44.44` and `#1 $25` offer_fills DID resolve serials, so it's partial, not total.)

Net: **sales prices and timestamps are accurate and match TopShot 1:1**; the only defects are the ~41% offer_fill serial-0 rows and rare single-sale gaps.

---

## Part 3 — Set & team page volume check

- **DB-level counts for 20 TopShot sets + 10 NBA teams**: all non-zero and plausible (sets 136–3,375 editions; teams 433–520 editions). No empty/degenerate pages.
- **Browser-rendered (spot check)**: 6 set pages — `base-set`, `spotlight-series`, `wnba-base-set`, `rookie-debut`, `holo-icon`, and cross-collection `nfl-all-day/rookie-revelation` — and 3 team pages — `boston-celtics`, `oklahoma-city-thunder`, `golden-state-warriors` — all **load without error** with populated headers. Example: Golden State Warriors → Players 61 · Editions 540 · Total Mint 3,182,500.
- **F6 (known) still present:** name-aggregated set pages show a too-wide series range — `rookie-debut` reads "Part of Series 1 – Series 2025-26" because the `Rookie Debut` set-name spans a set in nearly every series. Set pages scoped to a single set entity are correct (`wnba-base-set` → "Part of Series 4"). Cosmetic.
- **Minor:** team/set preview tiles lazy-load (one tile momentarily blank on Golden State) — matches the prior audit's note, cosmetic.
- **Cross-cutting:** set-page and team-page **Total Mint** figures inherit the F7 +99 inflation for Series 2025-26 base editions (over-counts by ~99 × the number of affected base editions in that set/team).

---

## NEW findings summary

| ID | Sev | Finding | Scope | Evidence |
|---|---|---|---|---|
| **F7** | **HIGH** | Series 2025-26 **Base Set + WNBA Base Set** circulation = standard **+99** (Club Collection `::16` folded into base) → RPC `/4,099`·`/1,099` vs TopShot `/4,000`·`/1,000`; impossible "Perfect Serial #4099", inflated mint & Total-Mint labels | **~218 editions** (191 Base Set + 27 WNBA Base Set) — the most-traded set on the platform | TS-verified on Obi Toppin, Dalton Knecht, Kuminga, Ron Harper Jr., Nneka Ogwumike, Jeremy Sochan (all TS `/4000`); RPC circ all `4099`/`1099` |
| F8a | LOW-MED | RPC surfaces `Challenge Reward` set-tag as a badge; TopShot hides it (residual of resolved F2, non-rookie tag family) | Challenge/Holo-Icon reward sets | Chet Holmgren, Haliburton |
| F8b | LOW-MED | ~41% of TopShot `offer_fill` sales (1,697/4,090 in 7d) stored with `serial_number = 0`; render as `#0` in sales history | TopShot offer-fill sales | direct count + Dalton Knecht #90→0 |
| F8c | LOW | Rare single-sale ingest gaps (Obi Toppin #925 absent) | isolated | 1 of ~58 for that edition |

### F7 — the fix pointer (for a follow-up shipping pass)
F1's rule was "true Standard = getMinted gross − Σ(sub-printings with `subedition_id ≥ 17`); **do NOT subtract `::16` Club Collection** (separate pool, not in the gross)" — verified correct for older series (Trae Young 2:1 gross 2978 excludes its `::16`). **But for Series 2025-26 `Base Set` (set 218) and `WNBA Base Set` (set 258), the `::16` Club Collection (99) IS folded into the stored base circulation**, so RPC carries `4099`/`1099` where the true standard is `4000`/`1000`. The corrective sweep: for the 218 Series-8 base editions whose `circulation_count − (its ::16 child circ) ` is a clean round number **and** whose max owned serial ≤ that round number, subtract the `::16` count. All 13 non-Base tested editions already match TopShot exactly, so the `::17`-family F1 fix is holding — this is a scoped extension to the `::16` Base/WNBA-Base family only. Backup + guard (serial-floor) exactly as F1.

*Everything else cross-checked (13/17 circulations, all AllDay/most TopShot badges, all deep-compared sales prices/times) is accurate and matches the source sites.*

---

## Fixes shipped (2026-07-04, Trevor-authorized) — F7, F8a, F8b

**F7 — FIXED durably via a normalizing trigger (root cause: a live writer re-inflates).** The first attempt (one-time UPDATEs `audit_20260704_fix_base_set_club16_circulation` +`_part2`, 419 editions → clean thousands) was **verified insufficient**: within ~15 min the edition pages still read `Mint 4,099` / `Perfect Serial #4099`. Root cause found by watching `editions.updated_at` — **the TS edition writer records `circulation_count` as the on-chain/GQL GROSS (which folds in the parallel printings), and every sale-driven edition upsert re-inflates it** (Base Set commons trade 46–58×/4d, so they revert within minutes). This also silently reverts the morning's **F1** Rookie-Debut fixes (caught 9 F1 editions back at `1149` at 18:45). A one-time UPDATE can never hold against it.
- **Durable fix — `audit_20260704_trg_normalize_circulation_v3_per_family`:** a `BEFORE INSERT OR UPDATE OF circulation_count` trigger on `editions` normalizes at write time, per family:
  - **Base Set / WNBA Base Set** (Club Collection `::16` /99 only; standards are round thousands — on-chain-verified: the writer reads `getNumMomentsInEdition` = gross `4,099` = std `4,000` + club `99`): subtract exactly 99 when `circ % 100 = 99`. A subtract (not a floor-to-1000) keeps it robust and leaves a genuine round std (`mod100=0`) untouched. (An earlier discarded v2 used floor-to-1000 and briefly mis-set Duren/Vince from a phantom 8,500 — caught, corrected to 4,000, and the "variable-mint" premise disproven on-chain; see below.)
  - **Rookie Debut / WNBA Rookie Debut / 2026 NBA Playoffs / Vintage Vibes / Bag Work / Clamps / Extra Spice / Hustle and Show / Hoop Vision** (uniform /1,000 standard, Blockchain 99 + Hardcourt 50 = up to +149): floor to nearest 1,000.
  - Strict set allowlist so genuine low-LE sets (Metallic Gold LE /199, Throwdowns /249, **Level Up /149**, Holo Icon /39, Top Shot This /varied, Rookie Revelation /29) can never be corrupted — verified untouched.
- **Verified live:** simulated writer re-inflations all self-correct — `218:8775` 4099→**4000**, Duren `218:8061` 8599→**8500** (variable-mint preserved), Yang Hansen `219:7418` 1149→**1000**; 0 inflated editions remain in the 11 sets; genuine LE sets unchanged; security invariants 0, `secdef_anon` [], fmv_sanity 0, editions flat (17,490). `get_edition_detail('218:8775')` now returns `circulation_count 4000`. The one-time backup `audit_20260704_editions_circ_club16_fix` (419 rows, RLS-on) is retained. **Revert:** `DROP TRIGGER zzz_topshot_normalize_base_club_circulation ON public.editions; DROP FUNCTION public.trg_topshot_normalize_base_club_circulation();` (the writer will then re-inflate to gross).
- **"Variable-mint undercount" — INVESTIGATED and DISPROVEN (the writer is already authoritative).** The morning F1 doc framed a few Base editions (Jalen Duren 218:8061) as *undercounted* by `searchMarketplaceEditions` vs a `getMintedMoment` truth of 8,500, and I initially restored Duren to 8,500. **On-chain verification via the Cadence MCP overturned this:** the int-pair writer does NOT use `searchMarketplaceEditions` — it uses Cadence **`TopShot.getNumMomentsInEdition(setID, playID)`** (lib/editions-hydrate.ts:287), an authoritative contract read, which returns **4,099 for Duren, Obi Toppin, and Vince Williams alike** (= std 4,000 + Club Collection 99). So Duren's true standard is **4,000, not 8,500** — the 8,500 was wrong, and Duren was corrected back to 4,000. The "serials to 4,854 / 7,959" that looked like variable-mint evidence are **pre-existing mis-keyed onchain sales** (impossible in a 4,099-moment edition; nft_ids 45874465 / 46202280, ingested 05-24 & 07-03, unrelated to this session) — i.e. the separate June TS sales-misattribution class, not a circulation problem. **Net: no writer change is warranted** — the writer already reads the authoritative on-chain gross, and the trigger correctly strips the Club Collection to yield the TopShot-displayed standard. (The suggested "switch the writer to getMintedMoment" follow-up is therefore withdrawn as based on a misdiagnosis.)

**F8a — FIXED (TopShot parity).** Migration `audit_20260704_edition_badges_suppress_challenge_reward` — `get_edition_badges_unified` now suppresses the standalone `Challenge Reward` badge (`norm_key = 'challengereward'`), which TopShot does not display on the moment page. One added `AND` clause; everything else identical to the prior definition. `norm_key` is distinct from AllDay's `Crafted Reward` (`craftedreward`), which the AllDay source DOES show and RPC correctly keeps. Verified: Chet Holmgren → `Championship Year` (was +Challenge Reward); Haliburton → `[]` (was Challenge Reward) — both now match TS; Rashee Rice / Dak Prescott (AllDay) still carry `Crafted Reward`; rookie cases unchanged. Security invariants 0. **Revert:** `CREATE OR REPLACE` the function without the `AND norm_key <> 'challengereward'` clause.

**F8b — FIXED (backfill + durable forward fix).**
- *Backfill (data):* resolved `serial_number` for the wmc-resolvable `offer_fill` serial-0 rows in `sales_2026` via `wallet_moments_cache` (`moment_id = nft_id`; serial is an nft invariant). of 20,946 TopShot `offer_fill` sales in 2026, **16,873 now carry a real serial**; residual serial-0 = **4,073** (moments not held by any indexed wallet — need on-chain resolution).
- *Forward fix (code):* [lib/chains/flow/topshot-offer-fill.ts](lib/chains/flow/topshot-offer-fill.ts) `buildOfferFillSales` gains a **step 2b** wmc serial fallback — when the exact moment is absent from `moments` and the offer row carries no serial, it resolves the serial from `wallet_moments_cache` by `nft_id` *before* the F1 parallel guard, so new edition/subedition offer fills no longer land with serial 0 (for moments in wmc). tsc clean. **Revert:** `git revert` the code commit; the backfilled serials are correct and left in place.
- *Residual:* the ~4,073 on-chain-only serial-0 tail (moment never in wmc) would need a `getMintedMoment`/`borrowMoment` resolver through the proxy — left as a follow-up (ingest-adjacent, not force-fixed), same class as the F4 tail.

*Not fixed (by design):* F8c single-sale ingest gap (Obi Toppin #925 — isolated, the daily on-chain drain covers it); F5/F6 (prior LOW cosmetics); Golazos "badges" (enrichment, not a defect); AllDay `Player Number` (a serial-level badge, out of scope for edition-level output).

---

## F9 [MED, structural] — 546 conflated editions: root cause found + durable fix seeded (2026-07-04)

Trevor asked why `topshot-misattrib-drain` never clears the standing **`topshot_conflated_editions` guard (546 editions)**, concentrated in the current Series-8 sets (124 Base Set, 38 2026 Playoffs, 23 WNBA Rookie Debut, …). Dug in and **fully root-caused it on-chain** (Cadence MCP).

### Root cause (verified on-chain, not assumed)
The guard flags editions where the same `(edition_id, serial)` has 2+ distinct nfts in `sales` (last 365d). I traced a colliding pair on `218:8061`: nfts `51227422` and `51314656`, **both genuinely `218:8061` serial 18 on-chain** — because `data.serialNumber` is the serial *within a subedition*: `51227422` = subedition **0 (Standard)** #18, `51314656` = subedition **16 (Club Collection)** #18. They are legitimately different moments that collide only because the Club moment is keyed to the **base** edition instead of `218:8061::16`.

Classifying all **8,106 colliding nfts**: `map_says_different_edition = 0` — **none** point to a different edition; the collisions are **~100% the subedition-split class** (Standard vs Club/Blockchain/Hardcourt/Voltage/… sharing a serial on the same base), **not** cross-season mis-keys. (The Duren `124:4842`→`218:8061` cross-season stragglers are a small slice of the 1,810 not-in-map and both editions already exist / circulation is already correct.)

### Why the existing drain structurally cannot fix it
1. **`getMintedMoment` (the drain's GQL resolver) returns `setID:playID:serial` but NOT the subedition** — so it maps Standard #18 and Club #18 both to the base. Re-running the drain forever cannot separate them. (Confirmed: all 8 colliding nfts on `218:8061` were *already in the map*, still colliding.)
2. The only subedition source is on-chain **`TopShot.getMomentsSubedition`** (used by the `backfill-topshot-subeditions` edge fn), but that fn only resolves nfts **already seeded** (`subedition_id IS NULL`) in `topshot_moment_subeditions` — and **the conflated moments were never seeded** (7,723 of 8,106 absent from the table).
3. The subedition **resolution** edge fn (`topshot-subedition-backfill`) is **not currently scheduled** (dormant — last real run predates this era), and the `::subID` **catalog is incomplete** (only 56 of 544 conflated bases have a `::16` child).

### Durable fix — shipped + validated
- **Missing link SHIPPED — `audit_20260704_seed_conflated_subedition_targets_final`:** `seed_topshot_conflated_subedition_targets(p_max_editions)` seeds every moment on a conflated base edition (from `sales`) into `topshot_moment_subeditions` as a pending subedition target, advancing across editions (skips already-seeded) so a cron drains all 544. SECDEF, service_role-only, safe (only queues resolution work — touches no live `sales`/`wmc`/`editions`). **Ran it: ~20,800 targets queued so far.**
- **Validated end-to-end on-chain:** resolved a 300-moment sample via the exact `getMomentsSubedition` batch the edge fn uses → **29 parallels correctly surfaced (subedition 13 = "Voltage")** vs 271 Standard, and applied. This proves seed → on-chain resolve → apply works; the existing remap (`remap_topshot_from_onchain_map`, which already keys `::subID` via the `topshot_moment_subeditions` join) then splits them off the base, clearing the collisions.
- Security invariants 0, secdef_anon 0 after all changes.

### Full pipeline — SHIPPED (one-deploy finish)
The whole chain is now built + wired; a daily cron converges the guard to 0.
- **Seed** — `seed_topshot_conflated_subedition_targets(p_max_editions)` (queues conflated moments; advances across all 544 editions).
- **Resolve** — the existing `backfill-topshot-subeditions` edge fn (on-chain `getMomentsSubedition`), now *triggered by the orchestrator* each tick.
- **Catalog** — `catalog_topshot_subedition_editions_from_resolved(p_limit)` — creates each `base::subID` edition (clones base metadata; circ = max-observed-serial floor, raised to the true GQL parallel size by the daily `backfill-topshot-subedition-circulation` cron; names per `getAllSubeditions`).
- **Split** — `remap_topshot_split_resolved_subeditions(p_limit)` — moves each resolved parallel's **sales + wmc + moments** rows off the base onto its `::subID` edition (serial unchanged; idempotent; reversible via `audit_20260704_subedition_split_remap`). *This also covers the `/share`/portfolio wmc split directly, so the old UUID-fossil-only wmc remap needs no change.*
- **Orchestrator** — [app/api/admin/drain-conflated-subeditions/route.ts](app/api/admin/drain-conflated-subeditions/route.ts) runs seed → trigger-resolver → catalog → split → `refresh-conflated-editions`, bounded per tick, wired to a daily Vercel cron (`30 20 * * *`). All fns SECDEF service_role-only; security invariants 0.
- **Proven on real data this session:** seeded ~20.8k targets; resolved a 300-moment sample on-chain (29 Voltage parallels found); cataloged their `::13` editions; split moved **1,168 wmc + 35 sales + 13 moments** onto `::subID` — and the colliding-serial count on the affected bases dropped accordingly (residual = their *other* parallels still pending in the queue, which the cron drains).

**Only remaining external step:** confirm the `backfill-topshot-subeditions` Supabase **edge fn is deployed** (it exists in-repo and is triggered by the orchestrator; if the Supabase deploy is stale, `supabase functions deploy backfill-topshot-subeditions`). Everything else runs off the shipped cron.

**Impact while draining:** on the ~124 affected Series-8 Base editions the conflation is mild (parallel commons mixed into the base's stats); circulation itself is already correct (F7). Structural data-hygiene, not a user-facing emergency.

**Reverts:** `git revert` the route/cron commit; `DROP FUNCTION` the three fns; restore split rows from `audit_20260704_subedition_split_remap` (`old_edition`→`new_edition` per `src`).

### Write-time fix — stop the leak at the source (so the guard reaches ~0, not just "bounded")
The daily pipeline *repairs* base-keyed parallel sales, but both sales writers keep *re-introducing* them, so repair-only holds the guard bounded but never at 0. Fixed both writers to key confirmed parallels onto their `::subID` edition at ingest:
- **`sales-indexer` (source=onchain) — SHIPPED, no flag needed.** Step 4e was one-directional (Standard-off-parallel only); made it **symmetric** — a confirmed parallel (in `topshot_moment_subeditions`, `subedition_id>0`) that otherwise resolves to the base is redirected onto its `base::subID` edition (when cataloged; else stays on base and the daily drain splits it — graceful). New `parallel_splits` telemetry. tsc clean. Active on deploy.
- **`/api/ingest` (source=topshot_gql) — made safe to enable.** It already had flag-gated subedition keying (`buildEditionKey` appends `::subID` from the authoritative on-chain submap), but `upsertEdition` wrote the **base gross** circulation onto `::sub` editions — which would clobber the F9 catalog's parallel size. Guarded it: `circulation_count` is now omitted for `::sub` keys (preserved on existing, NULL→backfill on new), and `::sub` rows get a proper `subedition_name`. tsc clean.
  - **Operator step to activate the ingest half:** set env `TOPSHOT_SUBEDITION_KEYING=1` (Vercel) + redeploy. Off by default → byte-identical to before; on → topshot_gql parallel sales also key to `::subID`. (The onchain half needs no flag.)

With both writers keying parallels correctly at ingest + the daily drain clearing the historical backlog, the conflation guard converges to ~0 and stays there.
