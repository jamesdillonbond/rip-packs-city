# Claude Code handoff — 2026-05-30 fourth pass (parallel)

Owner: Trevor. Written while you were handing the third pass off to
Claude Code. Pure-additive against the third-pass commit — should
merge cleanly however CC sequences the work.

## What this pass did

Built the two missing pages that the morning + third-pass commits left
as "data shipped, page TBD." Now Surfaces G and H have actual
user-visible pages, taking the public `/insights/` landing from 6 cards
to 8.

### Files added

- `app/insights/set-squeeze/page.tsx` + `layout.tsx` — Surface G page.
  Consumes `/api/public/insights/set-squeeze` (your morning commit
  `5b2f62f`). Series filter (S5/S6/S7/S8), tier filter, sort by avg
  squeeze or total buyable. Includes a footnote about "covered editions"
  honesty so users understand the per-set avg is a subset average where
  badge coverage is incomplete. Has an inline tip at the bottom pointing
  to `/insights/squeeze` for per-edition drill-down.

- `app/insights/pinnacle-scarcity/page.tsx` + `layout.tsx` — Surface H
  page. Consumes `/api/public/insights/pinnacle-scarcity` (this morning).
  Franchise filter (Pixar / Star Wars / Marvel / Walt Disney), chaser-
  only checkbox, sort by scarcity / mint / fmv. Surfaces chaser status
  as a chip next to the character name. Methodology explains the
  variant-relative scarcity metric (a Standard at 333 mint is 70%
  rarer than the average Standard, but a Digital Display at 333 mint
  is closer to its variant's own average).

### Files edited

- `app/insights/page.tsx` — landing card grid gets Surfaces G + H as
  Live cards (positioned between E and the squeeze-check tool).
  Lede updated: "Seven wedges + a tool to check your own wallet."

### Commit command (your call on whether to bundle with the third pass)

```powershell
cd C:\Users\TDill\rip-packs-city
del .git\index.lock 2>$null
git add app/insights/set-squeeze app/insights/pinnacle-scarcity app/insights/page.tsx docs/handoff-2026-05-30-fourth-pass.md
git commit -m "feat(insights): ship Surface G (set squeeze) + Surface H (Pinnacle scarcity) pages

Two new public surfaces, both backed by views + JSON routes that already
shipped (topshot_set_squeeze_board / pinnacle_scarcity_board, and their
respective /api/public/insights/* routes). Pure UI lifts mirroring the
squeeze board pattern.

- /insights/set-squeeze — drill-down companion to Surface A. Per-set
  squeeze, series + tier filters. Honest 'covered editions' footnote.
- /insights/pinnacle-scarcity — Pinnacle equivalent (no lock+burn;
  mint+variant+chaser instead). Franchise + chasers-only filters.

Landing grows from 6 to 8 cards. Lede: 'seven wedges + a tool'."
git push origin main
```

## Smoke after deploy

```
https://www.rippackscity.com/insights                        → 8 cards visible
https://www.rippackscity.com/insights/set-squeeze            → page renders w/ live data
https://www.rippackscity.com/insights/pinnacle-scarcity      → page renders w/ live data
https://www.rippackscity.com/insights/set-squeeze?sort=buyable → asc-buyable shows tightest by absolute count
https://www.rippackscity.com/insights/pinnacle-scarcity?chasers_only=true → 8 chaser rows
```

## What's left after this

- Public-side Week 1 launch surfaces are done (A, B, C, D, E, G, H +
  squeeze-check tool).
- TC report route exists at `/api/public/insights/tc-report` for your
  Week 3 outreach workflow — no public page (intentional, internal
  tool). Hit it with curl when you're ready.
- Item B leak fix is holding at ~46% reduction. B2 readiness gate
  validates clean. Hold for a dedicated session.
- Pack-EV / Got Game / V1 buyer_address all still honestly blocked.
