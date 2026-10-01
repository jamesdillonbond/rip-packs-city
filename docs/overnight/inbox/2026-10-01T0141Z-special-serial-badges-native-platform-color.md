# Special-serial badges should use each platform's NATIVE colour, not RPC gold

**Filed by Claude Code (web), 2026-09-30 ~6:41 PM PT, at Trevor's direction. Handed to Cowork because it needs a live browser on nbatopshot.com, and this sandbox's egress proxy blocks that host (both `curl` and WebFetch return 403 / EGRESS_BLOCKED).**

## The ask

- **Collector feedback:** webz_80, in Discord at 2:50 PM PT on 09-30, after the #10153 fix shipped: *"can see the badges already. minor quibble, but i do prefer the special serial badge being blue like it is on TS. but if you're actively trying to differentiate from TS i get it"*.
- **Trevor's decision:** *"It should be its native color."* This is about matching each platform, not about differentiating RPC from Top Shot.

## Where gold is today

`GOLD_HEX = "#F59E0B"` in `lib/badges/glyphs.ts:60`. Every special-serial surface uses it:

- `components/TrophySlab.tsx` uses gold in two places:
  - the serial chip, ~line 546 (`background: GOLD_HEX` when `specials.length > 0`);
  - `SpecialMarks`, ~line 712 (a gold chip behind each `SpecialSerialGlyph`).
- `app/api/profile/trophy-case/pdf/route.tsx`: lines ~593, ~635 and ~698.
  - ⚠ Line 698 also uses `GOLD_HEX` as the **1-of-1 slab accent**. That is a separate meaning; leave it gold.
- `lib/og/trophy-marks.ts:124` calls `officialSpecialSerialArt(cat, collection, GOLD_HEX)`.
- `app/api/og/profile/[username]/route.tsx:1120` and `app/api/og/trophy-case/[username]/route.tsx:469` colour the special-serial detail text gold.
- `specialGlyphDataUri()` in `lib/badges/glyphs.ts` is documented as "Always gold".
- Other surfaces (moment page, edition page, sniper, special-serial-owners board, collection SerialBadge) render `SpecialSerialGlyph` with `currentColor`. So their colour is whatever the surrounding pill is. Check each one.

## What "native" means per collection

| Collection | Native special-serial look | Change |
|---|---|---|
| NBA Top Shot | Blue pill: the v2 Special Serials section on nbatopshot.com and dapper.market/nba. The glyphs are already exact copies (`components/SpecialSerialGlyph.tsx`, `currentColor`). | **Sample the exact blue live**, e.g. from moment 2149353 (#1/12000) on nbatopshot.com. Read the pill's background, glyph colour and text colour. Use those, never a guess. |
| NFL All Day | Official full-colour badgesV3 art (`first-serial` / `player-number` / `perfect-serial`), already served through `/api/badge-image?src=allday`. | Drop the gold chip behind the art. Sample the chip/pill treatment on nflallday.com for the serial number itself. |
| Golazos / UFC / Pinnacle / Panini / Candy | No platform special-serial badge (07-11 ledger: no upstream art). | Keep RPC gold. There is no native colour to match. |

## Suggested shape

- Add a per-collection special-serial colour resolver beside `GOLD_HEX` in `lib/badges/glyphs.ts` (zero imports, satori-safe hex only).
- Route the trophy slab, PDF and OG cards through it, keyed by `collection_slug`.
- Keep `GOLD_HEX` for the 1-of-1 accent and as the fallback.

**Tests:** `__tests__/trophy-case-pdf-image.test.ts:206` pins `GOLD_HEX === "#F59E0B"`. `__tests__/og-cards-use-official-badge-art.test.ts` and `__tests__/og-share-cards-draw-moment-badges.test.ts` pass `GOLD_HEX` into the art. **Re-pin** these per collection; do not delete them. Run `grep -rl GOLD_HEX __tests__` before pushing.

**Verify before calling it done:**
- Grep the deployed chunk for the new hex. A CSS-only change can reach READY without being in the bundle.
- Check webz_80's trophy case (`/profile/webz_80/trophy-case`) in the rendered DOM: Top Shot specials should be blue.
- Check one All Day #1 shows the official art with no gold chip behind it.

**Risk:** low. Presentational only; no data, pricing or auth involved. Not on the night pass's off-limits list.

---

## ✅ Disposition — SHIPPED by Claude Code (Windows box), 2026-09-30 ~8:15 PM PT

This box could reach both platforms, so it was not left for Cowork. Colours were **sampled live** with installed Chrome (computed styles plus the class strings):

- **NBA Top Shot**, nbatopshot.com/moment/2149353 (#1/12000):
  - pill `border-[#2752ED]`;
  - glyph segment `bg-[#2752ED]` with a white glyph;
  - serial segment `bg-[#2752ED]/25`, white text;
  - glow `#5677F180`.
- **NFL All Day**, nflallday.com/moments/9597415 (#1/2500):
  - pill `border-[#7A4DE1]` on `bg-card` (#212127), with no fill;
  - glow rgba(122,77,225,0.75);
  - the glyph is All Day's own gradient art (white → #EB22E2 → #7A4DE1). RPC already serves that art.

**Shipped:**
- `specialSerialStyle(collection)` in `lib/badges/official-art.ts`:
  - Top Shot: blue chip and marks; `#5677F1` for text on dark cards.
  - All Day: dark pill with a purple ring; purple accent.
  - Everything else: RPC gold.
- It is wired into:
  - `TrophySlab`: the serial chip and the marks;
  - the trophy-case PDF: the serial hero and per-platform glyph icons. The 1-of-1 slab accent stays gold, as asked;
  - both OG cards: the serial accent, and the Top Shot glyph tint via `trophy-marks`.
- Tests:
  - re-pinned `api-og-share-cards-no-false-zero` (the Top Shot #1 medal is blue, and gold is now asserted ABSENT) and the `trophyDetail` shape;
  - new: `lib-badges-special-serial-style` and 3 slab colour cases.
  - Planted defect (Top Shot → gold) turned 3 suites red.

**Checked, not changed:** the moment page, edition page, sniper chips, owners board and collection `SerialBadge` draw `SpecialSerialGlyph` in `currentColor` inside RPC's own coloured pills (purple, teal, red). None of them is gold, so none was in the gold list this decision covered.
