# Handoff 2026-06-13 — Personal transaction history (moments + packs)

New feature. A unified per-wallet transaction timeline. Scope (Trevor, 2026-06-13): **own-wallet first**, surfaced in the dashboard; the **any-wallet** version comes later inside the analytics area — so build the data layer wallet-agnostic and only the page is dashboard-gated for now. DB migration (new read RPC) + a new page → Cowork can ship the migration; the page is CC.

## Goal

One reverse-chronological timeline of everything that happened to a wallet's collection: packs bought, packs opened (with what was pulled), moments bought, moments sold. Today this data is split across surfaces (pack history at /dashboard/packs) and tables (moment_acquisitions, sales) with no unified view.

## Data sources (all exist)

- **Packs:** `get_wallet_pack_history(p_wallet, p_collection_slug, p_status, p_limit, p_offset)` already returns the per-pack timeline (purchase → open → flip/sell/held) with `event_kind`. Surfaced at /dashboard/packs via /api/wallet/pack-history.
- **Moments acquired:** `moment_acquisitions` — buys + pack pulls; `source_pack_rip_id` links a pull back to the pack it came from.
- **Moments sold:** `sales` (year-partitioned by sold_at) — the wallet as `seller_address` (sold) or `buyer_address` (bought on-chain). Buyer/seller now populated for on-chain + (draining) marketplace sales from this week's backfill.

## Build

### 1. Read RPC (DB migration — wallet-agnostic by design)

`get_wallet_transaction_history(p_wallet text, p_limit int, p_offset int, p_kind text DEFAULT NULL)` returning a unified, `occurred_at DESC` timeline. Each row: `occurred_at`, `kind` (`pack_buy` | `pack_open` | `moment_buy` | `moment_pull` | `moment_sell`), `collection_id`/slug, a display title (moment: player+set+serial via the editions denorm; pack: pack name/dist), `amount_usd`, `counterparty` (buyer/seller addr where known), and a deep link (`/moment/<id>` or the pack dist page). Implement as a UNION ALL across the four sources above, then order+paginate. Take `p_wallet` so the SAME RPC serves the dashboard (own wallet) and, later, /analytics/wallets/[address] (any wallet) — don't hardcode the session user.

Footguns to respect (from CLAUDE.md): two collection vocabularies (sales uses long-form `nba_top_shot`; resolve via `collection_id`); `sales` is partitioned — filter by a `sold_at` range, don't scan all years; PostgREST caps reads at 1000 → paginate; pack pulls appear in BOTH `pack_open` and `moment_pull` — decide the representation (recommend: show the `pack_open` as one row with its pulls nested/expandable, or tag `moment_pull` rows with the parent pack so they're not double-counted as separate "acquisitions"). SECDEF + service_role-only grant; REVOKE from anon/authenticated (per the SECDEF-anon-default footgun).

### 2. API route

`/api/wallet/transaction-history?wallet=...&kind=...&limit=...&offset=...` (GET) calling the RPC via the service-role client. For the dashboard MVP, resolve the wallet(s) from the session's saved wallets server-side (don't trust a client-supplied wallet for the user's own view); the route can still accept an explicit `wallet` param for the future analytics use, gated appropriately.

### 3. Page (CC)

A `/dashboard/history` view (or a "History" tab in the dashboard chrome) — auth-gated, brand tokens, the dashboard's existing client+metadata-layout pattern. Reverse-chron list with a kind filter (All / Packs / Buys / Sells / Pulls), pagination, each row linking to the moment/pack. Reuse the slab/tile + fmtUsd helpers where sensible. Empty state for wallets with no history.

### 4. Later (not now) — any-wallet in analytics

Once the MVP is solid, surface the same RPC in /analytics/wallets/[address] for any looked-up wallet. No new data work — the RPC already takes `p_wallet`. (Privacy note: this is all already-public on-chain data, consistent with the existing public profile / analytics surfaces.)

## Verify

- RPC: spot-check against a known wallet (e.g., Trevor's `0xbd94cade097e50ac`) — counts of pack buys/opens + moment buys/pulls/sells reconcile with the source tables; timeline ordered correctly; pulls not double-counted.
- `npx tsc --noEmit` clean; deploy READY; /dashboard/history renders the timeline for a signed-in user with saved wallets; anon → /login.

## Revert

Drop the page + route (git revert); `DROP FUNCTION public.get_wallet_transaction_history(...)`.

## Guardrails

- Commit directly to main, no branches/PRs; PowerShell git; re-verify push count 0.
- New SECDEF RPC: REVOKE EXECUTE from anon + authenticated, grant service_role only.
- Don't trust a client-supplied wallet for the user's *own* history view — resolve from the session.
- Claude Code's direct inspection wins — adapt to the real moment_acquisitions / sales / pack RPC shapes.

End state: a signed-in user sees one unified moments+packs transaction timeline at /dashboard/history, backed by a wallet-agnostic RPC that drops into the analytics area later for any-wallet lookups.
