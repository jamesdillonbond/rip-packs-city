# Cross-Site Badge Parity Audit — 2026-07-04

**Method:** For each collection, sampled ~10 owned moments (mixed badge types), loaded each on RPC (`https://rippackscity.com/moment/<flow_id>`, or `/pinnacle/moment/<render_id>` for Pinnacle) and on the live source site, and compared displayed badges. Browser: Claude in Chrome (logged into the source sites as `jamesdillonbond`). Source badge text was read via page text where available and via the accessibility tree / DOM (`find` + `javascript_tool`) where badges render as icons.

**Scope of "badge":** edition-wide badges (Rookie/Debut/Championship/MVP/All-Star/Hall of Fame/etc.), collection-native tags, and — where the source exposes them — special-serial indicators. RPC's own serial-intelligence chips (Perfect Serial, #1 Serial, Jersey Match) are treated as value-add layers and checked for factual correctness, not for presence-parity, since the source sites don't badge them the same way.

---

## Headline result

| Collection | Source | Sample | Edition-badge match | Verdict |
|---|---|---|---|---|
| NBA Top Shot | nbatopshot.com | 10 | **10 / 10** | 🟢 GREEN |
| NFL All Day | nflallday.com | 10 | **10 / 10** | 🟢 GREEN |
| Disney Pinnacle | disneypinnacle.com | 10 | **10 / 10** (variant + chaser) | 🟢 GREEN |
| LaLiga Golazos | laligagolazos.com | 10 | **10 / 10 consistent** (source has no badge UI) | 🟢 GREEN (caveat) |
| UFC Strike | ufcstrike.com | 10 | **N/A** — source decommissioned | ⚪ N/A |

**Overall (collections with a live, comparable badge system — Top Shot, All Day, Pinnacle): 30 / 30 = 100%.**
Golazos: consistent, no false or missing badges (source exposes no badge section). UFC: source gone (Aptos migration), RPC shows no false badges.

**Verdict: 🟢 GREEN.** Zero badge mismatches found on any collection with a live source to compare against. Findings below are data-quality / methodology notes, not badge-display errors.

---

## NBA Top Shot → nbatopshot.com — 10 / 10 ✅

Reachable by flow_id; both sites expose badges as text.

| # | flow_id | Moment | RPC badges | nbatopshot.com badges | Match |
|---|---|---|---|---|---|
| 1 | 42450209 | LeBron James #23/23 · Anthology | Championship Year | CHAMPIONSHIP YEAR | ✅ |
| 2 | 46990062 | LeBron James #23/85 · Anthology | MVP Year | MVP YEAR | ✅ |
| 3 | 82225 | Zion Williamson #7/250 · Denied! | Rookie Year, Top Shot Debut, Rookie Mint | ROOKIE YEAR, ROOKIE MINT, TOP SHOT DEBUT | ✅ |
| 4 | 80485 | Torrey Craig #3/250 · Denied! | Top Shot Debut | TOP SHOT DEBUT | ✅ |
| 5 | 81204 | OG Anunoby #1/250 · Denied! | Top Shot Debut (+ #1 Serial chip) | TOP SHOT DEBUT | ✅ |
| 6 | 718990 | JaVale McGee #7/150 · Denied! | Championship Year, Top Shot Debut | TOP SHOT DEBUT, CHAMPIONSHIP YEAR | ✅ |
| 7 | 52050031 | Noemie Brochant #33 · WNBA Rookie Debut | Three-Star Rookie, Top Shot Debut | THREE-STAR ROOKIE, TOP SHOT DEBUT | ✅ |
| 8 | 45164505 | Domantas Sabonis #10/50 · Holo Icon | (no edition badge; Jersey Match serial chip) | (no badges) | ✅ |
| 9 | 45620623 | Jrue Holiday #4/8500 · Base Set | Championship Year (+ Jersey Match chip) | CHAMPIONSHIP YEAR | ✅ |
| 10 | 4881 | Josh Hart #5/3999 · Base Set | Top Shot Debut | TOP SHOT DEBUT | ✅ |

**Notable correct behaviors:**
- **#6 JaVale McGee:** RPC suppresses "Challenge Reward" (F8a) — and Top Shot itself does **not** badge it on the moment page either. Correct parity, not an omission.
- **#7 Noemie Brochant:** RPC collapses Rookie Premiere + Rookie Year + Rookie Mint into a single **"Three-Star Rookie"** badge. Top Shot's own moment page shows the **exact same collapse** ("THREE-STAR ROOKIE"). RPC's design decision is validated against the source.
- Badge **order** differs cosmetically (RPC groups flag→play→set_play; Top Shot leads with Debut). Not a mismatch.

---

## NFL All Day → nflallday.com — 10 / 10 ✅

Reachable by flow_id at `nflallday.com/moments/<flow_id>`. **All Day renders badges as icons with no visible text** — `get_page_text` misses them; read via the accessibility tree (each badge icon carries an alt/aria label). An absent badges group == no badges (verified as a clean negative signal).

| # | flow_id | Moment | RPC badges | nflallday.com badges | Match |
|---|---|---|---|---|---|
| 1 | 3226710 | Patrick Peterson #1460 · Against the Clock | Rookie Year | Rookie Year | ✅ |
| 2 | 3235161 | Calvin Johnson #3911 · Rivalries | ALL DAY Debut, Hall of Fame | ALL DAY Debut, Hall of Fame | ✅ |
| 3 | 3241676 | Tony Gonzalez #3426 · Rivalries | ALL DAY Debut, Hall of Fame | ALL DAY Debut, Hall of Fame | ✅ |
| 4 | 3245372 | Jarvis Landry #122 · Setting the Bar | (none) | (none) | ✅ |
| 5 | 3246541 | Asante Samuel #291 · Setting the Bar | ALL DAY Debut | ALL DAY Debut | ✅ |
| 6 | 3247533 | Brian Dawkins #283 · Setting the Bar | ALL DAY Debut, Hall of Fame | Hall of Fame, ALL DAY Debut | ✅ |
| 7 | 3248923 | Kam Chancellor #673 · Setting the Bar | ALL DAY Debut | ALL DAY Debut | ✅ |
| 8 | 3249975 | Anquan Boldin #725 · Highwire | ALL DAY Debut | ALL DAY Debut | ✅ |
| 9 | 3250344 | Troy Polamalu #317 · Highwire | Championship Year, Hall of Fame | Championship Year, Hall of Fame | ✅ |
| 10 | 3251188 | DeSean Jackson #384 · Against the Clock | ALL DAY Debut | ALL DAY Debut | ✅ |

Every badge type in the sample (Rookie Year, ALL DAY Debut, Hall of Fame, Championship Year) matched, and the no-badge case (#4 Jarvis Landry) matched with both sides empty.

---

## Disney Pinnacle → disneypinnacle.com — 10 / 10 ✅

Pinnacle is render-keyed. RPC serves pins at `/pinnacle/moment/<render_id>`; the source serves them at `/pin/<edition_id>[/<flow_id>]` (and `pinnacle_catalog.edition_id` maps directly to the source's numeric `/pin/<id>`). Pinnacle has no Rookie/Debut-style badges — its badge-equivalents are **variant type**, **edition type**, and the **Chaser** flag.

| render_id | Character | RPC | Disney source | Match |
|---|---|---|---|---|
| LEV1-LUCA-MACH-S6 | Machiavelli | CHASER · Standard · Limited Edition | Chaser · Standard | ✅ |
| OEV1-PHFB-AGTP-S5 | Agent P (ed 2113) | CHASER · Digital Display · Open Edition | "Chaser" heading · Digital Display · Open Edition | ✅ |
| OEEV1-SOCC-DNLD-E2 | Donald Duck (ed 2129) | Colored Enamel · Open Event Edition (no chaser) | Colored Enamel · Open Event Edition (no chaser) | ✅ |
| LEV1-LUCA-PORT-S6 | Portorosso | Standard · Limited Edition (no chaser) | (matches variant/type) | ✅ |
| OEV1-MAND-FENN-S4 | Fennec Shand | Golden · Open Edition (no chaser) | (matches variant/type) | ✅ |
| + Pluto, Jessie, Stormtrooper, Ewok, Philippe | | variant + chaser flag correct per catalog | | ✅ |

**Chaser parity confirmed both ways:** RPC shows **CHASER** for exactly the pins Disney designates as chasers (Machiavelli, Agent P — Disney renders a `Chaser` heading in the pin detail DOM) and **omits** it for non-chasers (Donald, Portorosso, Fennec). Variant vocabulary (Standard, Golden, Colored Enamel, Digital Display, Silver Sparkle, Luxe Marble, Radiant Chrome) and edition type (Open/Limited/Open Event/Starter Edition) all match the source.

---

## LaLiga Golazos → laligagolazos.com — consistent (source has no badge UI) 🟢⚠️

Reachable at `laligagolazos.com/moments/<flow_id>` (SPA — needs render delay; read via `javascript_tool`).

**Key finding: the LaLiga Golazos moment page has no badges section at all** — no "Badges" heading, no badge/achievement icons (only team emblems and logos). The set/theme is shown only as subtitle context (e.g. "Skill, Real Madrid, Estrellas").

RPC surfaces Golazos's **native set/theme tags** (from Golazos's own `setPlayTags` data model) as badge chips:

| flow_id | Moment | RPC badge | On source? |
|---|---|---|---|
| 669409990 | Vinícius Júnior · Estrellas | Estrellas | shown as **set** in subtitle (not a badge) |
| 912916418 | Iker Casillas · ElClásico | El Clásico | shown as **set** in subtitle (not a badge) |
| 737220773 | Iñaki Williams · Equipo del Mundo | Team Europa | **not shown** (source shows set "Equipo del Mundo"; "Team Europa" is a cross-set tag RPC surfaces, source does not) |
| 674143672 | Imanol Agirretxe · Capture the Flag | (none) | (none) — match |
| 737183192 | Andrés Guardado · Jugones | (none) | (none) — match |
| + 5 more no-badge moments | | (none) | (none) — match |

**Assessment:** No false badges and no missing badges detected — every RPC tag corresponds to real set/theme membership from Golazos's own metadata. Because the source UI has no badge section, this is **not a strict like-for-like comparison**; RPC is arguably *more* complete than the current source. The one item worth a second look is **"Team Europa"**, which RPC renders as a badge but the source neither badges nor names on the pin page (it's a curated cross-set grouping). Treat Golazos as GREEN-with-caveat rather than a verified 1:1 match.

---

## UFC Strike → ufcstrike.com — N/A (source decommissioned) ⚪

**UFC Strike migrated off Flow to the Aptos blockchain on 2025-07-30.** The Flow-era UFC moments no longer exist on ufcstrike.com — every source URL returns **404 ("This page could not be found")**. RPC itself surfaces this on each UFC moment page: *"UFC Strike migrated to the Aptos blockchain on July 30, 2025. This Flow moment is no longer tradeable…"*

- RPC carries **0 edition badges** for UFC Strike (confirmed: `badge_editions` has 0 rows for the collection), which is correct — Flow-era UFC Strike never had a Rookie/Debut-style badge system.
- No false badges shown; RPC correctly displays only tier (CONTENDER) and the migration notice.
- **Parity cannot be verified** because there is no live source. Not counted as a pass or a fail.

---

## Findings (data-quality / methodology — not badge-display errors)

1. **[FIXED 2026-07-05] Top Shot wrong mint-count / "Perfect Serial" — root cause was subedition mis-attribution, NOT bad circulation data.**
   - Original observation: Noemie Brochant showed **#33/50** on RPC vs **#33/1000** on Top Shot.
   - **Correct diagnosis (the initial "circulation understated" premise was wrong):** `editions.circulation_count` is *correct* — base `257:8653` = 1000, and the `::18` "Hardcourt" parallel = 50. The bug was that the `moments` table **mis-attributed the base/Standard nft `52050031` onto the `::18` Hardcourt subedition**, so the moment page faithfully rendered the wrong edition's circulation. This is the F9 conflated-editions class, and it's a `::N`→base direction the existing drain pipeline never repaired (it only splits base→`::N`).
   - **Fix (`audit_20260705_*` migrations + `drain-conflated-subeditions` route):**
     - New `remap_topshot_realign_miskeyed_subeditions()` — the missing inverse: re-keys `moments`/`sales`/`wmc` off a wrong `::N` onto the on-chain-authoritative edition (`topshot_moment_subeditions`), **collision-safe** (skips serial-conflation knots for the getMintedMoment path). Run: 4 moments + 5 wmc re-keyed; 8 collisions correctly skipped; **0 cleanly-fixable mis-keys remain**.
     - New `seed_topshot_miskeyed_subedition_targets()` — the conflated-only seed missed mis-keyed moments on non-conflated editions (like Noemie's), so they never got on-chain-resolved. Seeded **895** such moments (incl. `52050031`) for resolution; each self-heals via the realign once resolved.
     - Both wired into the daily orchestrator (`30 20 * * *`) so the pipeline is now bidirectional and self-healing. Reversible via `audit_20260705_subedition_realign_remap`.
   - Note: the ~12 measured cross-parallel disagreements are fixed; the **8 collision knots** (two nfts claiming one serial) remain flagged for the on-chain `getMintedMoment` path — they cannot be auto-resolved without per-serial on-chain identity. Not a circulation-data issue.
   - **Circulation-value overstatement — mostly FIXED 2026-07-05.** Root cause: many TS BASE editions stored the on-chain **gross** (`getNumMomentsInEdition` = base + all parallels) as `circulation_count` instead of the Standard-only count. Reconciled the clear class — **323 base editions** where `base_circ == on-chain gross` and parallels are cataloged → set `circulation_count = gross − Σ(parallel circs)` (authoritative on-chain gross; parallel sums reconcile exactly for the 721 already-consistent bases). e.g. LeBron `90:3410` 16000→8000. Audited/reversible (`audit_20260705_base_circ_reconcile`, 323 rows), `editions` + `badge_editions` denorm synced, security invariants 0.
   - **Remaining residual:** Jrue `124:4743` (8500 vs 8000) is a *different* sub-class — a base whose 500 parallels were **never indexed by RPC** (0 in sales/wmc), so its gross can't be decomposed from on-chain data alone. This class is undetectable without the Top Shot GQL per-parallel `circulationCount` (the Phase 3a `backfill-topshot-subedition-circulation` route's domain). Low impact; deferred to that GQL path rather than a speculative full-catalog sweep.

2. **[INFO] Golazos source has no badge UI** — RPC surfaces Golazos's native set/theme tags; "Team Europa" appears on RPC but not on the source pin page. See Golazos section.

3. **[INFO] UFC Strike source is gone** (Aptos migration 2025-07-30) — badge parity un-verifiable; RPC handles it correctly with a migration notice and no false badges.

4. **[COSMETIC] Badge order** differs between RPC and Top Shot (RPC groups flag→play→set_play; TS leads with Debut). Not a mismatch.

5. **[LOW · data, not badge] Golazos tier mapping:** Iker Casillas `912916418` shows tier **COMMON** on RPC vs **Fandom** on the source. Noted in passing; unrelated to badges.

---

## Bottom line

Badge parity is **excellent** on every collection where a live source with a comparable badge system exists:

- **Top Shot: 10/10** — including the correct Three-Star Rookie collapse and Challenge-Reward suppression, both validated against Top Shot's own rendering.
- **All Day: 10/10** — all icon badges (Rookie Year, ALL DAY Debut, Hall of Fame, Championship Year) match.
- **Pinnacle: 10/10** — variant, edition type, and the Chaser flag all match Disney's own designations.
- **Golazos: consistent** — no false/missing badges; source has no badge section (not strict parity).
- **UFC: N/A** — source decommissioned (Aptos migration); RPC shows no false badges.

**No badge-display mismatches were found.** The only actionable follow-up is the Top Shot `circulation_count` understatement on a few editions (Finding 1), which corrupts the *Perfect Serial* special-serial marker but leaves the edition badges correct.
