# Handoff 2026-06-18 — Profile breakdown cards render gray (one-liner)

Plain text. Trivial follow-up flagged by CC during the owner-scoping ship.

## Bug

On the profile/dashboard Collection Breakdown cards, every collection accent renders the gray DEFAULT_COLOR instead of its brand color.

Root cause: app/api/profile/collection-breakdown/route.ts — the COLLECTION_COLOR map (top of file) is keyed with HYPHENATED slugs:
  "nba-top-shot", "nfl-all-day", "laliga-golazos" / "la-liga-golazos", "disney-pinnacle"
but the color is looked up with slugMap.get(c.collection_id), where slugMap is built from collections.slug — which is UNDERSCORED (nba_top_shot, nfl_all_day, laliga_golazos, disney_pinnacle, ufc_strike). So COLLECTION_COLOR[slug] always misses → DEFAULT_COLOR.

## Fix (pick one)

(a) Re-key COLLECTION_COLOR with the underscored slugs to match collections.slug:
  "nba_top_shot": "#E03A2F", "nfl_all_day": "#10B981", "laliga_golazos": "#FBBF24", "disney_pinnacle": "#8B5CF6", "ufc_strike": <pick a brand accent>
(b) Or normalize at the lookup: COLLECTION_COLOR[(slugMap.get(c.collection_id) ?? "").replace(/_/g, "-")] ?? DEFAULT_COLOR.

Note ufc_strike currently has no entry at all — add one while you're in there so UFC isn't gray either.

## Revert / verify

Revert: git revert. Verify: the breakdown cards show TS red / AllDay green / Golazos amber / Pinnacle purple / UFC accent instead of gray.

Guardrails: main only; PowerShell git; route-only, no DB change.
