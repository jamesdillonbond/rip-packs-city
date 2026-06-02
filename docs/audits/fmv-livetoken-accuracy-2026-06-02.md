# FMV accuracy audit vs LiveToken — 2026-06-02

Seeded-wallet FMV cross-check against LiveToken (serial-adjusted market FMV). Goal: verify RPC FMV accuracy on the moments real users hold, and improve confidence. **Status: wallet 1 of 10 done (Trevor 0xbd94cade097e50ac); method proven + reusable; remaining 9 resumable.** No FMV values were written this session — see "Why no writes" below.

---

## The reusable LiveToken extraction method (proven this session)

LiveToken portfolio data is the cleanest cross-source because it keys on **setID:playID = RPC `editions.external_id`** exactly (no fuzzy player/serial matching).

1. Trevor is logged into LiveToken; `https://livetoken.co/myaccount?address=<hex_no_0x>&mode=portfolio` loads any wallet's portfolio (public by address).
2. The page is a Bootstrap-Vue app. The portfolio API is `GET /api/topshot/portfolio/<wallet>?page=N&sortOrder=<ENUM>&sc=true&useCS2bForSorting=true` (auth = in-memory token the app refreshes; a bare fetch with the stale localStorage `id_token` returns `authResult:6`, so call it through the app, not directly).
3. Sort enum lives on the sort component: `FMV_DESC` = "Sort by FMV (highest)" (others: AcquiredDate_DESC/ASC, FMV_ASC, AcquiredPrice_DESC/ASC, Gain_DESC). Page size 100; Trevor = 14,448 moments / 145 pages.
4. Cleanest pull: install a `fetch`+`XMLHttpRequest` interceptor that stashes `/api/topshot/portfolio/` responses to `window.__cap`, then invoke the Vue sort handler `comp.onChangedSort({label:'Sort by FMV (highest)', sort:'FMV_DESC'})` on the portfolio sort component (the one whose `$data.sortOrder.label` matches "acquired"). The app refetches with its own valid auth → captured.
5. Response shape: `{ portfolio:{ moments:[...], valueFMV, numMoments }, paginationResult:{pages,perPage} }`. Each moment has `setID, playID, serialNumber, circulationCount, valueFMV, valueFMV2, numSales, liquidityRating, name, setName, isRookie*`.
6. Join `setID:playID` → RPC `editions.external_id` (collection_id = TS `95f28a17-…`), compare to latest `fmv_snapshots` per edition.

**Caveat:** LiveToken `valueFMV` is serial-adjusted to the held serial; RPC FMV is edition-level. So expect modest gaps from serial premium on very low/high serials. Gross divergence (>30%) is real mispricing, not serial effect.

This is now encoded as the `rpc-fmv-audit` skill (source: `docs/cowork-skills/rpc-fmv-audit/SKILL.md`).

---

## Wallet 1 — Trevor (0xbd94cade097e50ac), top 100 by value: RPC vs LiveToken

Ranked by |divergence|. Positive % = RPC higher than LiveToken (over-priced); negative = RPC lower (under-priced).

### RPC over-prices (STALE/LOW snapshots stuck far above market)
| Edition | Player / Set | RPC | conf | LiveToken | RPC vs LT |
|---|---|---|---|---|---|
| 166:5978 | Wembanyama · Metallic Gold LE | $949.67 | STALE | $113.11 | **+740%** |
| 223:7518 | VJ Edgecombe · Origins | $1,104.15 | LOW | $265.06 | **+317%** |
| 201:7039 | Kyrie Irving · Run It Back Origins | $381.56 | ASK_ONLY | $146.30 | +161% |
| 233:7726 | Kon Knueppel · Metallic Gold LE | $495.00 | LOW | $227.78 | +117% |
| 166:6772 | SGA · Metallic Gold LE | $490.50 | ASK_ONLY | $299.75 | +64% |

### RPC under-prices (LOW confidence, far below market)
| Edition | Player / Set | RPC | conf | LiveToken | RPC vs LT |
|---|---|---|---|---|---|
| 53:2698 | Nurkić · Holo Icon | $33.00 | LOW | $298.75 | **−89%** |
| 175:6093 | Clingan · Freshman Gems | $16.15 | LOW | $140.98 | −89% |
| 167:6640 | Jalen Duren · Metallic Silver | $27.50 | LOW | $219.80 | −87% |
| 201:7031 | Lillard · RIB Origins | $20.50 | LOW | $161.38 | −87% |
| 173:6455 | Clingan · Denied! | $29.33 | LOW | $211.15 | −86% |
| (…~10 more in the −50% to −85% range, mostly LOW Rookie Revelation / Run It Back) | | | | | |

### RPC NO_DATA on the most valuable moments (confidence-gap)
| Edition | Player / Set | circ | RPC | LiveToken |
|---|---|---|---|---|
| 100:3345 | LeBron · The Anthology: LeBron | 99 | NO_DATA | **$2,499.52** |
| 165:6563 | Kevin Durant · Supernova | 10 | NO_DATA | $1,789.24 |
| 121:4255 | Lillard · RIB Legacies 2014-19 | 28 | NO_DATA | $1,276.73 |
| 103:3775 | Steph Curry · Top Shot 50 | 99 | NO_DATA | $587.00 |
| 215:7363 / 205:7137 / 201:7040 / 205:7135 | RIB / Phantom Threads | 75–229 | NO_DATA | $115–231 |

### RPC accurate (within ±15%, mostly ASK_ONLY) — the good news
LeBron MGLE 5:133 +12%, Wemby MGLE 134:5039 +16%, Zion Holo 4:127 +13%, James Harden Holo 4:82 +17%, Stephon Castle RR 185:6531 +1%, LeBron Base 2:133 −1%, Billy Cunningham 211:7876 −1%, Damian Lillard Cosmic 8:145 −5%, Caitlin Clark MGLE 148:5637 −7%, Steph Base 2:147 −19%. ASK_ONLY is reasonably calibrated for ~half the sample, with a slight systematic over-tilt.

---

## Platform-wide scope (TS, displayable editions only — `thumbnail_url IS NOT NULL`)

| confidence | circ≤60 | 61–150 | 151–1000 | >1000 | total |
|---|---|---|---|---|---|
| LOW | 255 | 311 | 2,127 | 3,551 | **6,244** |
| NO_DATA | 243 | 166 | 172 | 330 | **911** |
| ASK_ONLY | 225 | 123 | 197 | 176 | 721 |
| MEDIUM | 11 | 3 | 107 | 434 | 555 |
| HIGH | 1 | 4 | 54 | 170 | 229 |
| STALE | 36 | 29 | 50 | 44 | 159 |

**Key corrections / findings:**
- The headline "NO_DATA 4,625" is inflated by ~3,700 thumbnail-less inert/dupe rows. **Real displayable NO_DATA ≈ 911**, of which **~409 are low-circ (≤150)** — the valuable misses (KD Supernova class).
- **LOW is the dominant bucket (6,244 ≈ 71% of priced displayable editions)** and the cross-check proves it is unreliable in BOTH directions (−89% to +317%). This is the core FMV-quality problem, not NO_DATA.
- **STALE (159) is small but can be catastrophic** (Wemby MGLE +740%): a stale snapshot's $ value is shown at face value and badly misleads portfolio totals.
- HIGH+MEDIUM = 784 (~9% of displayable priced editions). Coverage is thin but that's a throughput problem already tracked.

---

## Recommendations (all LOGIC changes → Claude Code handoff, not live data patches)

1. **STALE display safety (159 editions, highest-trust-damage):** stop showing a STALE snapshot's stale $ at face value. Either suppress the number ("stale — no recent sales") or decay it toward the current ask. Wemby MGLE showing $949 for a ~$113 moment is the worst case.
2. **NO_DATA low-circ gap (~409 editions):** low-circ high-value editions are NO_DATA because `fmv-recalc` only uses 30d sales + fresh asks. Extend the sales lookback for `circulation_count <= 150` (e.g. 90–180d, SALES_ONLY/STALE confidence) or add an ask source. This recovers the KD Supernova / LeBron Anthology class.
3. **LOW reliability (6,244 — the big one):** thin-sales WAP is the platform's core FMV weakness. Levers: serial-residual modeling (already partially in `lib/fmv-confidence.ts`), wider comp windows, or ask-anchoring LOW editions that have a fresh `badge_editions.low_ask`.
4. **ASK_ONLY multiplier tune:** ask×0.90 runs slightly high vs LiveToken sales-based FMV on low-liquidity editions; consider a liquidity-adjusted discount (ask×0.80–0.85 when `numSales` is thin).
5. **Adopt LiveToken as a periodic QA validation feed** for high-value editions (the `rpc-fmv-audit` skill enables a repeatable cross-check; could run from the nightly pass on a rotating wallet set).

## Why no FMV values were written this session
Per the FMV patch-restraint rule: one-time DB data fixes are fine, but importing a third-party (LiveToken) serial-adjusted value as an RPC edition snapshot would (a) clobber the canonical `fmv-recalc` 1.7.0 snapshot under "latest-wins," (b) go stale immediately (unmaintained), and (c) is really a pricing-LOGIC change. The fixes above belong in the recalc pipeline, reviewed — not as ad-hoc clobbering writes. The cross-check is the deliverable; the logic handoff is the fix.

---

## Resumable worklist — 10 wallets (Trevor done)

Method per wallet: navigate `?address=<hex>&mode=portfolio` → FMV_DESC → capture `portfolio.moments` → join setID:playID to RPC. ~4 browser calls + 1 SQL join each.

| # | wallet | label | TS moments | cached FMV | status |
|---|---|---|---|---|---|
| 1 | 0xbd94cade097e50ac | Trevor (founder) | 18,437 | $77,967 | **DONE** |
| 2 | 0x8bc1c0249e2ebb3e | alxo | 34,654 | $239,258 | pending |
| 3 | 0x11859edcf2f53edd | mbl267 (Mike Levy) | 2,629 | $253,944 | pending |
| 4 | 0xad89a78a11e36d68 | scottyj111 | 14,030 | $57,545 | pending |
| 5 | 0xf77bf547fccf6656 | Rigged | 37,783 | $76,100 | pending |
| 6 | 0x623412c649a42fdf | arielremer | 5,051 | $74,133 | pending |
| 7 | 0x7e1a7dbe10882e17 | selanne8kariya9 | 4,272 | $24,668 | pending |
| 8 | 0xf6a7c01b3ab1e048 | wjf | 2,160 | $42,429 | pending |
| 9 | 0xb5053ef95e702657 | RipPacksCity | 226 | $548 | pending |
| 10 | 0xa3d67b29e104e701 | samwise222 | 427 | $643 | pending |

Next-tier wallets if extending beyond 10: tomwagmi, VinceCarterLast, Juiceshack, miaflsurf, stephenlaywon, vaultopolis (all active phase-1 invitees).
