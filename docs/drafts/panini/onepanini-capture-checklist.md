# Panini `/onepanini` request capture — the one step that unblocks the feed

Goal: capture the exact request the Panini Blockchain SPA sends to `POST nft.paniniamerica.net/onepanini`
(headers + body) for the call that returns **per-edition circulation** ("minted X of N"). That's the only piece
missing — CryptoSlam is ruled out (it doesn't index the WC2026 Prizm set), and `/onepanini` is bot-walled (HTTP 426)
to anonymous traffic, so it must be replayed from a real logged-in request shape via the `panini-proxy` worker.

Takes ~2 minutes while logged into your Panini account.

## Steps

1. Log into **nft.paniniamerica.net** (your Panini Blockchain account).
2. Open **DevTools → Network** tab. In the filter box, type `onepanini`.
3. Browse to a **2026 Prizm World Cup** card or the marketplace view for that set — anything that loads per-card
   data (a card detail page showing "#X / N", or the marketplace list filtered to the set). Each such page fires
   one or more `POST /onepanini` calls.
4. In the Network list, click the `onepanini` request whose **Response** contains edition + **circulation /
   minted-count** data (not the ones for nav/menus). If several fire, the right one returns card editions with a
   total-minted / numbered field.
5. Copy three things from that request (right-click → Copy → "Copy as cURL" grabs all of it at once, or copy each):
   - **Request Headers** — all of them. We care about the static app headers (e.g. `x-...-app-version`,
     `client-id`, `content-type`, `apollographql-...`). 
   - **Request Payload / body** — the full body (the GraphQL query + variables, or whatever it sends). If it looks
     encoded, copy it raw.
   - **a sample Response** — so we know the JSON shape to map into `PaniniRawEdition`.

## What to send back

Paste the **request headers**, the **request body**, and a **sample response** for that edition/circulation call.

⚠️ Security: do NOT paste the actual value of any auth/session token. If a header is clearly a session token
(e.g. `authorization: Bearer …`, a long cookie/JWT), just tell me **which header it is** — we wire the live token
through your login + the proxy secret, never hard-coded. Everything else (the static app headers + the query body)
is what we need verbatim.

## Then (no further input from you)

With that capture, the wiring is fast:
- Fill `UPSTREAM_HEADERS` in `docs/drafts/panini/panini-proxy/index.js` with the static headers, deploy `panini-proxy`.
- Fill the query body + response parser in `lib/chains/panini/feed.ts` (onepanini mode).
- Fill the real `parallel`/`set` label → canonical maps in `lib/chains/panini/normalize.ts` (the §4 hardening —
  now we'll know the actual strings the feed uses).
- Run `POST /api/ingest/panini-editions` once → verify `panini_editions` counts reconcile against the community
  tracker (FOTL-ripped ≈ 54% as of 2026-06-24), then proceed through the G2→G8 runbook.
