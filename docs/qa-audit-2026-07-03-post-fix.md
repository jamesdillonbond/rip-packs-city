# QA Audit — 2026-07-03 (post-fix verification pass)

**Scope:** Live verification of https://rippackscity.com across all 5 collections, confirming today's bug batch landed cleanly and catching anything new/still-broken.
**Method:** Live-site browse (Chrome) of every collection's overview / sets / packs / market + targeted moment & edition detail pages chosen from the DB to exercise each fix (IPFS art, badges, LISTED collisions, dark-asset media), plus DB-side verification of the pipeline/data migrations. Prod deploy `bf63a414` promoted and serving.
**Verdict:** All 10 targeted fixes verified working. **1 real issue found** — a data-correctness bug in the newly-restored LISTED field (cross-collection bleed on ~12 TopShot moments). Everything else is clean. Platform health GREEN (trust 16/16, editions flat, no console errors on any page checked).

---

## ✅ Confirmed fixed

| # | Fix | Evidence |
|---|-----|----------|
| **Bug 2** | IPFS gateway art (ipfs.dapperlabs.com / cloudflare-ipfs.com) | Grayson Allen — Crunch Time (`179:6484`, art on `ipfs.dapperlabs.com`) renders on edition + moment pages. `proxy.ts` CSP has both hosts in `img-src` **and** `media-src` (lines 467–468); the asset request would 200 (already cached on revisit). No CSP-refusal in console. |
| **Bug 3** | Packs page performance (mv_pack_ev_latest matview) | TS packs — 500 of 1,996 (495 LIVE), full EV columns, ~2s. AllDay — 500 of 3,052 (363 LIVE), ~2s. Both well under 3s. |
| **Bug 4** | TopShot market 504s (Vercel spend throttle) | `/nba-top-shot/market` loads "50 of 500 listings" with full table in ~5s, no 504. |
| **Bug 6** | Sets page `[object Object]` | All 4 set-tracker pages load real trackers with cards: TS 245 sets, AllDay 363, Golazos 23, UFC 256. No `[object Object]`. |
| **Bug 8** | Badges render (labels where appropriate; art images intended) | **Moment page** — Kemba Walker shows "🅣 TOP SHOT DEBUT" (art icon + label); Baylor Scheierman shows "#1 SERIAL" chip. **Edition page** — Cooper Flagg shows 6 art-image badges. Per Trevor, the art-image badges are the intended design; every badge renders as *either* its art image or a text chip (never a blank/unlabeled void). Confirmed working. |
| **Bug 12** | Overview KPIs zeroing out | All 5 overviews show real numbers, none zeroed: TS 17,490 / 27% / $10,986; AllDay 6,191 / 14% / $298; Golazos 581 / 1% / $0; UFC 518 / 3% / $0; Pinnacle 499 / 55% / $2,296. AllDay visibly streamed KPIs in independently (Promise.allSettled resilience confirmed). |
| **Bug 13** | LISTED field from cached_listings_v2 | Field is live and correct for the normal case: non-colliding TopShot moment (Baylor Scheierman #1, `51872212`) → **LISTED —** (dash), as intended. *One correctness defect on collisions — see 🆕 below.* |
| badge tier casing | Normalized 6,035 rows | `badge_editions` has **0** rows with a non-uppercase `tier`. |
| LEGENDARY badge gap | 395 → 1 | 1,760 LEGENDARY `badge_editions` rows against 1,949 TS LEGENDARY editions — near-full coverage. |
| pinnacle-nft-resolver timeout | partial covering index | Latest run `ok=true` at **7.0s** (was timing out at 30s). |
| wmc-fmv-populate lock contention | FOR UPDATE SKIP LOCKED | Recent runs all `ok=true` (264ms–6.4s), no lock-contention failures. |

**Per-collection coverage**

| Collection | Overview | Sets | Packs | Detail page |
|---|---|---|---|---|
| NBA Top Shot | ✅ 17,490 / 27% / $10,986 | ✅ 245 sets | ✅ 1,996 dists ~2s | ✅ edition (Cooper Flagg, Grayson Allen) + moment (Kemba, Baylor) |
| NFL All Day | ✅ 6,191 / 14% / $298 | ✅ 363 sets | ✅ 3,052 dists ~2s | (moment pages n/a — AllDay serials not indexed as moments) |
| LaLiga Golazos | ✅ 581 / 1% / $0 | ✅ 23 sets | n/a (no packs tab) | ✅ edition (Frenkie de Jong — media renders) |
| UFC Strike | ✅ 518 / 3% / $0 (Aptos banner) | ✅ 256 sets | n/a | (overview + sets) |
| Disney Pinnacle | ✅ 499 / 55% / $2,296 | n/a (no sets tab) | n/a | ✅ render detail (Mickey Mouse Apex) |

**Health / other:** pipeline indicator LIVE/green on every collection (FMV age 3–19 min). `v_rpc_trust_health` = 16/16 ok. Editions flat (TS 17,490 / AllDay 6,191 / Golazos 581 / UFC 518). **No console errors** on any page checked (TS overview, TS sets, TS edition, Golazos edition). 404s render a clean branded soft-404 ("BINGO BANGO BONGO"). Pinnacle detail shows a $500k troll floor-ask honestly as "LIVE LOWEST LISTING" while LATEST FMV stays NO_DATA — troll ask not polluting FMV (`pinnacle_fmv_impossible_flags = 0`).

---

## 🆕 Issue found

### Cross-collection LISTED bleed on the moment page (NEW — introduced by today's Bug 13 fix) — **MEDIUM**

**What:** On a TopShot serial's moment page the **Listed** field can show a price belonging to a *different collection*.
**Repro:** `https://www.rippackscity.com/moment/374612` (Kemba Walker #1680/1927, a TopShot moment) shows **Listed $4.00** — but that $4.00 is the **AllDay** Josh Allen — Base listing (`cached_listings_v2.flow_id = 374612`). TopShot has no rows in `cached_listings_v2`; the value bleeds in. (Contrast: the non-colliding Baylor Scheierman #1 correctly shows a dash.)
**Root cause:** `fetchActiveListingAsk()` in `app/moment/[id]/page.tsx` (lines 400–421) queries `cached_listings_v2` filtered **only** by `flow_id` (+ `completed_at IS NULL`), with no `collection_id`/`edition_id` scope. The code comment assumes "Top Shot moments have no rows in this table," but Flow `nft_id`s are unique only **per contract**, so a TS moment's `nft_id` collides with an AllDay/Golazos listing's `flow_id`.
**Blast radius:** 12 TopShot moments currently show a false LISTED from a colliding active AllDay/Golazos listing (measured live). Small and fluctuating, but it's a wrong number on a user-facing price field. Low-value amounts.
**Secondary note:** the fix's intended *positive* case ("AllDay moments show the ask") does not actually fire — AllDay/Golazos serials aren't indexed in the `moments` table, so their `/moment/<flow_id>` pages 404 ("Moment Not Found"). So today the LISTED field only ever renders a value on the (wrong) collision path.
**Fix (near one-liner):** thread the moment's `collection_id` (available at the call site as `r.collection_id`, line ~754) into `fetchActiveListingAsk` and add `.eq("collection_id", collectionId)`. That immediately kills the bleed (colliding TS moments correctly revert to a dash). Separately decide whether AllDay/Golazos serial listings should surface here at all (would need those serials routable as moment pages) — otherwise the field is TS-only-and-always-dash, which is honest.

---

## Minor observations (no action needed)

- **Golazos "Hero_Black" media looks blank until you zoom.** The `assets.laligagolazos.com` hero PNG returns 200 and renders a proper 3D card (Frenkie de Jong #21, FC Barcelona) — it just has a black background that blends into the dark page. Not a bug.
- **Bare `/moment/<numeric>` is TopShot-first.** `/moment/374612` resolves the TS moment; an AllDay serial with the same `flow_id` isn't reachable that way. Same non-unique-`nft_id` root cause as the issue above. Entity/edition pages (keyed on `collection` + `external_id`) are unaffected.
- **AllDay/Golazos/UFC $0 24h volume** on overview is real (low-volume / UFC migrated to Aptos 2025-07-30 with the correct historical banner), not a Bug-12 regression — editions + FMV-confidence KPIs are non-zero.
- **Mobile:** attempted at 390px width, but this audit harness captures screenshots at a fixed desktop width, so mobile reflow could not be conclusively verified here — recommend a quick manual phone spot-check.

---

## Recommended follow-up
1. Scope `fetchActiveListingAsk` by `collection_id` to kill the cross-collection LISTED bleed (small, high-confidence fix). Decide whether the AllDay/Golazos positive path is worth wiring, or leave LISTED as TS-only-dash.

*Read-only audit — no code changed. The one real issue is flagged as a separate task.*
