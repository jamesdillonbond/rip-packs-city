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
