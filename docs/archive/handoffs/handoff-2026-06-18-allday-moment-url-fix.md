# Handoff 2026-06-18 — AllDay buy links 404 (one-line URL fix)

Plain text. CRITICAL follow-up: the AllDay deal buy links shipped in 64d4448 currently 404. Verified live this session.

## The bug

`lib/collections.ts` → MARKETPLACE_MOMENT_URL_TEMPLATES has the AllDay entry as SINGULAR /moment/:
  "nfl-all-day": (id) => `https://nflallday.com/moment/${id}`
But the real NFL All Day moment URL is PLURAL /moments/. So every AllDay "Buy on All Day" link (the ones 64d4448 just added via nativeBuyLink → marketplaceMomentUrl) resolves to a Page Not Found.

The original handoff said /moments/ (plural); the 64d4448 commit note "corrected" it to singular citing this template — but the template itself was the never-validated assumption. The handoff was right.

## Verified live (Chrome, this session)

- https://nflallday.com/moment/6839516  → 404 (singular; a KNOWN-owned moment, Stan Humphries #207)
- https://nflallday.com/moments/6839516 → LOADS ("Stan Humphries - Pass #207", listing $1.00) ✓
- https://nflallday.com/moments/2789792 → LOADS ("Michael Pittman Jr. - Reception #58, Locked In, RARE", $1 recent buy) — and 2789792 is a low_ask_nft_id straight off cross_collection_deals_board, so floor_flow_id IS the correct moment id; the data is right, only the URL path is wrong.

## Fix (one line)

In lib/collections.ts MARKETPLACE_MOMENT_URL_TEMPLATES change the AllDay template to plural:
  "nfl-all-day": (id) => `https://nflallday.com/moments/${id}`

Leave nba-top-shot as `https://nbatopshot.com/moment/${id}` — TS uses singular and has been live for days (couldn't Chrome-verify nbatopshot.com here — it's on the browser safety blocklist — but the URL is unchanged from before the 64d4448 refactor, so TS buy links are unaffected).

ALSO FIX laliga-golazos — CONFIRMED the same bug (verified live this session): https://laligagolazos.com/moment/668975014 → "Page Not Found"; https://laligagolazos.com/moments/668975014 → loads (Unai Simón, Talentos, #369/10000, owned by Jamesdillonbond). So change it to plural too:
  "laliga-golazos": (id) => `https://laligagolazos.com/moments/${id}`
No Golazos deals on the deal board today, but any current use of marketplaceMomentUrl('laliga-golazos') (e.g. entity/moment/sniper surfaces) 404s now, so fix it in the same commit.

Pattern (settled): the Dapper-family sites — NFL All Day + LaLiga Golazos — use PLURAL /moments/; only Top Shot uses SINGULAR /moment/ (nbatopshot.com, unchanged/correct). disney-pinnacle uses /pin/ (separate; Pinnacle deals carry no nft_id anyway).

## Revert / verify

Revert: change back to /moment/. Verify: https://nflallday.com/moments/<any AllDay low_ask_nft_id from the board> loads the moment; an AllDay deal alert's "Buy on All Day" link opens a real listing instead of 404.

Guardrails: main only; PowerShell git; route-only (lib/collections.ts), no DB change.

## End state

AllDay deal buy links resolve to the live nflallday.com/moments/<id> moment page (with its listing), delivering the actual value of Item 1.
