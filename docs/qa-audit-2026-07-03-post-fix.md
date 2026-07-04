# QA Audit — 2026-07-03 (post-fix verification pass)

**Scope:** Live verification of https://rippackscity.com across all 5 collections, confirming today's bug batch landed cleanly and catching anything new/still-broken.
**Method:** Live-site browse (Chrome) of every collection's overview / sets / packs + targeted moment & edition detail pages chosen from the DB to exercise each fix, plus DB-side verification of the pipeline/data migrations. Prod deploy `bf63a414` promoted and serving.
**Verdict:** All 10 targeted fixes verified working. **2 real issues found** — one a regression newly introduced by today's Bug 13 fix (cross-collection LISTED bleed), one an incomplete surface for Bug 8 (edition-page badges still icon-only). Both flagged for separate tasks. Platform health GREEN (trust 16/16, security baseline clean, editions flat).

---

## ✅ Confirmed fixed

| # | Fix | Evidence |
|---|-----|----------|
| **Bug 2** | IPFS gateway art (ipfs.dapperlabs.com / cloudflare-ipfs.com) | Grayson Allen — Crunch Time (`179:6484`, art on `ipfs.dapperlabs.com`) renders on both edition + moment pages. `proxy.ts` CSP has `ipfs.dapperlabs.com` + `cloudflare-ipfs.com` in **both** `img-src` and `media-src` (lines 467–468). No CSP-refusal in console. |
| **Bug 3** | Packs page performance (mv_pack_ev_latest matview) | TS packs — 500 of 1,996 distributions (495 LIVE), full EV columns, ~2s. AllDay — 500 of 3,052 (363 LIVE), ~2s. Both well under 3s. |
| **Bug 4** | TopShot market 504s (Vercel spend throttle) | `/nba-top-shot/market` loads "50 of 500 listings" with full table in ~5s, no 504. |
| **Bug 6** | Sets page `[object Object]` | All 4 set-tracker pages load real trackers with cards: TS 245 sets, AllDay 363, Golazos 23, UFC 256. No `[object Object]`. |
| **Bug 8** | Text-labeled badge chips | **Moment page** (`/moment/[id]`) ✅ renders each badge as a text chip with the official art as a 14px inline icon prefix (e.g. Kemba Walker → "🅣 TOP SHOT DEBUT"). *See ⚠️ #2 — the edition page surface was missed.* |
| **Bug 12** | Overview KPIs zeroing out | All 5 overviews show real numbers, none zeroed: TS 17,490 / 27% / $10,986; AllDay 6,191 / 14% / $298; Golazos 581 / 1% / $0; UFC 518 / 3% / $0; Pinnacle 499 / 55% / $2,296. AllDay visibly streamed KPIs in independently (Promise.allSettled resilience confirmed). |
| **Bug 13** | LISTED field from cached_listings_v2 | Mechanic works — the field reads `cached_listings_v2` and renders a price (Kemba Walker moment showed a live `$4.00`). *But see 🆕 #1 — it's keyed without a collection scope, causing cross-collection bleed.* |
| badge tier casing | Normalized 6,035 rows | `badge_editions` has **0** rows with a non-uppercase `tier`. |
| LEGENDARY badge gap | 395 → 1 | 1,760 LEGENDARY `badge_editions` rows against 1,949 TS LEGENDARY editions — near-full coverage restored. |
| pinnacle-nft-resolver timeout | partial covering index | Latest run `ok=true` at **7.0s** (was timing out at 30s). |
| wmc-fmv-populate lock contention | FOR UPDATE SKIP LOCKED | Recent runs all `ok=true` (264ms–6.4s), no lock-contention failures. |

**Pipeline / health status:** Overview pipeline indicator LIVE / green on every collection (FMV data age 3–19 min). `v_rpc_trust_health` = **16/16 ok**, no breaches. Editions flat (TS 17,490 / AllDay 6,191 / Golazos 581 / UFC 518). No console errors on TS overview, TS sets, or edition pages. Pinnacle detail (Mickey Mouse Apex) renders correctly — a $500k troll floor-ask is shown honestly as "LIVE LOWEST LISTING" while LATEST FMV stays NO_DATA (troll ask not polluting FMV).

---

## ⚠️ / 🆕 Issues found

### 🆕 1. Cross-collection LISTED bleed on the moment page (NEW — introduced by today's Bug 13 fix) — **MEDIUM**

**What:** On a TopShot serial's moment page the **Listed** field shows a wrong price belonging to a *different collection*.
**Repro:** `https://www.rippackscity.com/moment/374612` (Kemba Walker #1680/1927, a TopShot moment) displays **Listed $4.00** — but that $4.00 is the **AllDay** Josh Allen — Base listing (`cached_listings_v2.flow_id = 374612`). TopShot has no rows in `cached_listings_v2`; the value bleeds in.
**Root cause:** `fetchActiveListingAsk()` in `app/moment/[id]/page.tsx` (lines 400–421) queries `cached_listings_v2` filtered **only** by `flow_id` (+ `completed_at IS NULL`), with no `collection_id`/`edition_id` scope. The comment there assumes "Top Shot moments have no rows in this table," but Flow `nft_id`s are unique only **per contract**, so a TS moment's `nft_id` collides with an AllDay/Golazos listing's `flow_id`.
**Blast radius:** 12 TopShot moments currently show a false LISTED from a colliding active AllDay/Golazos listing (measured live). Fluctuates with listings. Low-value amounts, single field, serial-page only — but it's a wrong number on a user-facing price.
**Fix (near one-liner):** thread the moment's `collection_id` (available at the call site as `r.collection_id`, line ~754) into `fetchActiveListingAsk` and add `.eq("collection_id", collectionId)`. Then re-confirm the *positive* AllDay path (an AllDay serial page showing its own ask) actually resolves — bare `/moment/<numeric>` currently resolves TS-first, so AllDay serials may need routing by moment uuid.

### ⚠️ 2. Bug 8 incomplete — edition-page badges still icon-only — **LOW/MEDIUM**

**What:** On the **edition** detail page (`/[collection]/edition/[slug]`), art-backed badges render as an unlabeled 24px icon (label only in the hover `title` tooltip); only art-less badges get a text chip. This is the exact pre-Bug-8 behavior — the fix (bf63a41 / 71b1e5b) reached `app/moment/[id]/page.tsx` and `components/BadgeRow.tsx` but **not** the edition page.
**Repro:** `https://www.rippackscity.com/nba-top-shot/edition/219%3A7408` (Cooper Flagg — Rookie Debut) shows 6 blank circular badge icons with no visible labels; the equivalent moment page shows readable chips.
**Root cause:** `app/(collections)/[collection]/edition/[slug]/page.tsx` lines 664–675 — `if (art) return <img …/>` (icon-only) else text chip.
**Note (per Trevor):** the badge **images are wanted** — the fix is to match the moment page (text label **with** the art as a small inline icon prefix), not to drop the art.
**Fix:** mirror the moment-page render block (lines 1178–1210): always render the label, art as a 14px inline prefix.

---

## Minor observations (no action needed / pre-existing)

- **Bare `/moment/<numeric>` is TS-first ambiguous.** `/moment/374612` resolves to the TopShot moment; the AllDay serial with the same `flow_id` is unreachable by that URL. Same non-unique-`nft_id` root cause as issue #1; entity/edition pages (which key on `collection` + `external_id`) are unaffected.
- **Pinnacle high troll floor-asks** ($500k / $30k / $9k) are real on-chain lowest listings, displayed honestly and *not* polluting FMV (LATEST FMV = NO_DATA). Working as intended; `pinnacle_fmv_impossible_flags = 0`.
- **Mobile:** attempted at 390px width, but this audit harness captures screenshots at a fixed desktop width, so mobile reflow could not be conclusively verified here — recommend a quick manual phone spot-check.
- **AllDay/Golazos/UFC $0 24h volume** on overview is real (low-volume / UFC migrated to Aptos 2025-07-30 with the correct historical banner), not a Bug-12 regression — editions + FMV-confidence KPIs are non-zero.

---

## Recommended follow-ups
1. Fix issue #1 (cross-collection LISTED scope) — small, high-confidence correctness fix; verify both the TS-dash and AllDay-price paths post-deploy.
2. Fix issue #2 (edition-page badge labels) — mirror the moment-page chip render, keep the art icon.

*Read-only audit — no code changed. Both issues flagged as separate tasks.*
