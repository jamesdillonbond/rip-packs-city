# Claude Code handoff — 2026-05-30 fifth pass

Owner: Trevor. Built while you were handing the fourth pass off to CC.
Pure-additive — no overlap with the prior commits.

## What this pass did

1. **OG cards for the three newest surfaces** (Surface G, Surface H,
   squeeze-check tool). Each renders 1200×630 via next/og and pulls 2-3
   live rows from the corresponding JSON route for data-rich previews.
2. **Wallet-squeeze concierge integration** — the Week 2 launch-plan
   item I deferred earlier this morning. Both the tool registration AND
   the handler this time, so it actually answers when called.

### Files added (3 OG cards)

- `app/api/og/insights/set-squeeze/route.tsx` — Surface G card. Shows
  top-3 most-squeezed TS sets (WNBA Squad Goals 76%, 2023 NBA Playoffs
  76%, Metallic Gold LE 74%) with tier color + buyable vs circulation.
- `app/api/og/insights/pinnacle-scarcity/route.tsx` — Surface H card.
  Shows top-3 by scarcity vs variant + the `CHASER` chip when present.
- `app/api/og/insights/squeeze-check/route.tsx` — squeeze-check tool
  card. Static (no live data — wallet-specific), leads with the
  "paste your wallet" hook + the 4-bucket visual.

### Files edited (3 layouts + 1 concierge route)

- `app/insights/set-squeeze/layout.tsx` — wires the OG image into
  openGraph + twitter metadata.
- `app/insights/pinnacle-scarcity/layout.tsx` — same.
- `app/insights/squeeze-check/layout.tsx` — same.
- `app/api/support-chat/route.ts` — adds:
  - **Tool registration** `check_wallet_squeeze` after
    `search_across_collections`. Accepts a wallet OR a TS username.
  - **Tool handler** in the same place. Mirrors the username-resolution
    ladder from `check_wallet`, then calls
    `get_wallet_squeeze_exposure` RPC and returns the structured jsonb
    summary. Graceful `username_not_resolved` + `empty` branches.
  - **System prompt update** — adds `check_wallet_squeeze` to the
    concierge tool list with the trigger phrasing ("how locked is my
    bag", "what's my exposure", "what's liquid in my bag").

## Commit command

If you're bundling this with the fourth-pass commit, you can extend
that one's `git add`. If you're shipping it separately:

```powershell
cd C:\Users\TDill\rip-packs-city
del .git\index.lock 2>$null
git add app/api/og/insights app/insights/set-squeeze/layout.tsx app/insights/pinnacle-scarcity/layout.tsx app/insights/squeeze-check/layout.tsx app/api/support-chat/route.ts docs/handoff-2026-05-30-fifth-pass.md
git commit -m "feat(insights): OG cards for G/H/squeeze-check + concierge wallet-squeeze tool

Three new OG cards (next/og, 1200x630) for Surfaces G, H, and the
squeeze-check tool. G and H pull live top-3 rows; squeeze-check is
static since it's wallet-specific. Layouts updated to point openGraph
+ twitter at the new images.

Concierge: tool registration + handler for check_wallet_squeeze, the
Week 2 launch-plan 'paste your wallet, see what's actually liquid in
your bag' demo. Mirrors check_wallet's username-resolution ladder so
the bot accepts a wallet OR a TS username, then calls
get_wallet_squeeze_exposure (RPC shipped this morning) and returns
the structured exposure summary. System prompt updated."
git push origin main
```

## Smoke after deploy

```
https://www.rippackscity.com/api/og/insights/set-squeeze        → image/png, ~70-90 KB
https://www.rippackscity.com/api/og/insights/pinnacle-scarcity  → image/png
https://www.rippackscity.com/api/og/insights/squeeze-check      → image/png

# Twitter / iMessage preview cache busts on each new commit:
# https://cards-dev.twitter.com/validator can re-fetch.

# Concierge tool: ask the bot something like "how locked is my bag,
# 0xbd94cade097e50ac" — should call check_wallet_squeeze and report
# 92% liquid with the top 3-5 squeezed editions.
```

## Health snapshot (15:00ish UTC)

- Item B leak rate: 3/1h, 790/24h. 46% reduction holding.
- Cached_listings_v2 close-out: 0 expired-but-open. Holding clean.
- Squeeze board: 755 rows, 0 over-100%.
- Cross-collection cohort: 143 wallets stable.
- `get_pipeline_alerts()`: no active alerts.
- TS NULL-tier: 1,470 (was 1,492 — naturally drifting lower with
  the fmv-recalc sweep populating new editions).

## What's still in the queue

- TC report page UI — RPC + route both shipped; no page yet
  (intentional — internal tool).
- Pinnacle squeeze-check tool variant — would need a Pinnacle-scoped
  wallet RPC. Defer.
- Item B2 — held for dedicated session; readiness gate validated.
- TS V1 buyer_address resolution — long-tail blocker, not autonomous.
