# Handoff — Trophy Case polish batch (2026-07-12)

**Status: SHIPPED & LIVE.** Cowork prepared this handoff (sandbox git was down that session, so the two `.tsx` changes couldn't be pushed from there). Claude Code picked it up and shipped it. This file is the shipped record.

- **Code commit:** `8c25de8` — `feat(trophy-case): slab + picker polish — drop pinwheel, sharpen TS stills, canonical serial badges`
- **Deploy:** `dpl_CCKPdojvFbJrGhpj1z16XjF7rirC` — READY, live on www.rippackscity.com
- **Ledger:** logged in [docs/overnight/ledger.md](overnight/ledger.md) (2026-07-12 CC entry) with revert path.
- **Branch:** direct to `main` per CLAUDE.md (overrides the harness `claude/trophy-case-polish-frontend-9edkp6` branch instruction); no PR.

## DB half — already live before this (Cowork, verified)

- `audit_20260712_add_jersey_number_to_top_owned_moments` + `audit_20260712_fix_top_owned_moments_jersey_cast_and_anon_revoke`.
- The trophy-picker RPC `public.get_user_top_owned_moments(uuid,int,text,uuid)` now returns an extra `jersey_number integer` column (from `editions.jersey_number`, cast smallint→int).
- ACL verified `{postgres, authenticated, service_role}` — anon NOT granted (the SECDEF guard only blocks authenticated cross-user, so anon EXECUTE would let anyone enumerate any user's moments; explicitly revoked after Supabase default-privileges silently re-granted anon on the fresh function).
- Re-verified live at ship time: RPC returns `jersey_number` (e.g. Clingan #1/1 jersey 23, LeBron #56/99 jersey 6). The `/api/profile/top-moments` route passes RPC rows straight through, so the column reaches the client with no route change.

## Frontend changes shipped

### `components/TrophySlab.tsx`
1. **Removed the pinwheel "block diamond"** (Trevor: "unnecessary") — deleted the left-column usage in `SlabLabel` and the now-orphaned `PinwheelMark` component (0 remaining refs repo-wide).
2. **Mobile legibility** — the metallic `SlabLabel` container went from fixed `height: 84` + `overflow: hidden` (which clipped the set-name line when a 2-line player name pushed content past 84px) to `minHeight: 84`. Bumped the three sub-8px label fonts: player-name 11→12, team 7→8, set-line 6→8 (the 6px set line was effectively unreadable). Removing the pinwheel column also widens the text column, reducing name wrap.
3. **Sharper Top Shot stills** — new module helper `hiResThumb()` rewrites `assets.nbatopshot.com` media `width=…`→`640` (many stills are baked at `width=180`, which upscales blurry into the ~280px+ slab screen). Wired into the `SlabScreen` video poster and image `src`. Other hosts (AllDay already 512, the Pinnacle/Golazos proxies) pass through unchanged. The `<video src>` is left alone — video isn't the blur path.

### `components/profile/TrophyPickerModal.tsx`
1. **Canonical special-serial badges** — deleted the `inferBadges` heuristic (the `≤99` low-serial ⭐, plus the 🏀/🎓 inference) and now render `@/components/collection/SerialBadge` (official `#1` / jersey-match / perfect-mint art via `SpecialSerialGlyph`). `SerialBadge` returns `null` for non-special serials, so ordinary moments (e.g. `#9/10`) show no badge. `SpecialSerialGlyph.platformOf` accepts the long-form `collection_slug`, so TS/AllDay badge art resolves; other collections get the RPC-brand monoline glyphs.
2. **Alignment rework of `MomentRow`** — FMV right-aligned into its own price column (prices line up down the list), thumbnail top-aligned to the player name, tier/serial chips kept clip-proof.
3. Added `jersey_number?: number | null` to the `PickerMoment` interface and passed it into `SerialBadge`.

## Verification (end-to-end, to the environment ceiling)
- `npx tsc --noEmit` clean for the whole app (only pre-existing `__tests__` vitest-dep errors remain, unrelated to this change).
- Vercel build compiled all routes incl. `/profile/[username]`; deploy READY and aliased to production.
- RPC `get_user_top_owned_moments` verified live returning `jersey_number`.
- Production `/api/profile/trophy-slabs?username=jamesdillonbond` returns 200 with 6 slabs; the 3 Top Shot stills are `?width=180` (exactly what `hiResThumb` upgrades to 640), AllDay `width=512` and Golazos `.png` pass through unchanged, and slab 1 (Clingan #1 of circ 1) is a #1-and-perfect-mint that exercises the new `SerialBadge` art.
- **Not reachable from this environment:** a pixel-level browser screenshot of the rendered case / pin-modal — the env network policy 403s all direct egress to `www.rippackscity.com` (a local headless Chromium hits the same wall), and the pin modal is auth-gated. `web_fetch_vercel_url` (server-side on Vercel) is the only channel that reaches the site.

## Revert
- Code: `git revert 8c25de8` (safe on its own — the DB column is additive, so the RPC stays backward-compatible; the picker just reverts to the old ⭐).
- DB half (Cowork's): revert lives with `audit_20260712_add_jersey_number_to_top_owned_moments` / `_fix_top_owned_moments_jersey_cast_and_anon_revoke`.

## Rebase note
This landed on top of yesterday's Trophy Case drag-to-reorder + auto-arrange work (`440d384`). No overlap: the reorder work lives in `ProfileClient` + slab drag handlers; this batch touches `SlabLabel` / `SlabScreen` / the picker `MomentRow`.
