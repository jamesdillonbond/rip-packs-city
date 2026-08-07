# `owner_key` consumer map — prerequisite for the §6.4 `user_wallets` migration (2026-08-07, Claude Code)

Read-only enumeration. Roadmap `docs/strategy/roadmap-2026-08-03.md` §6.4 + §7 require every `owner_key` consumer be mapped, verified live, and the migration landed in reversible slices — *"not as one migration justified by a document."* This is that map. **Nothing was changed.**

> ⚠ Schema drift: several `owner_key`-bearing tables (`saved_wallets`, `portfolio_snapshots`, `alert_subscriptions`, `notification_channels`, `profile_achievements`, `support_conversations`, `watchlist_items`) have **no `CREATE TABLE` in `supabase/migrations/**`** (managed remotely / MCP-applied). Their `owner_key` semantics below are reconstructed from the functions/routes that touch them and should be confirmed against live `information_schema` before the migration writes to them. The canonical three-form model already lives at `lib/auth/owner-key-guard.ts:1-56`.

## The core defect (unchanged from the roadmap)
`owner_key` is **polymorphic and client-controlled** — it holds an auth UUID, a `profile_bio.username`, OR a `0x` Flow address depending on the table, with no server-side mapping table. `lib/auth/owner-key-guard.ts` (`requireOwnedKey`) is the *bridge* that stops the IDOR bleed; it is not the fixed model. A **fourth** shape exists that the roadmap's three-form description misses: **lowercased email** in `alert_deliveries` (cold signups have no `user_id`).

## (a) Tables carrying `owner_key`, and what each row actually holds

| Table | Stored form | Written by | Read by | Migration note |
|---|---|---|---|---|
| `watchlist` | **0x Flow address** | `/api/watchlist` POST/DELETE | `/api/watchlist` GET | `UNIQUE(owner_key, edition_**key**)` — migration `20260403000000` |
| `watchlist_items` | username or 0x | `/api/profile/watchlist` POST/DELETE | same GET | **distinct table** from `watchlist`; `UNIQUE(owner_key, edition_**id**)`; no repo migration — do not treat "the watchlist" as one slice |
| `fmv_alerts` | **auth UUID** (route forces `user.id`) | `/api/alerts` POST | `/api/alerts`; `dispatch_triggered_fmv_alerts`, `check_triggered_fmv_alerts` | already session-sourced |
| `portfolio_snapshots` | **auth UUID** | `/api/profile/portfolio-history` POST | same GET (public); `get_weekly_portfolio_movers` (`u.id::text = l.owner_key`) | GET is an unguarded public read (below) |
| `saved_wallets` | **0x Flow address** (post-resolution) | `save_user_wallet` RPC | guard bridge 2; `/api/wallet/profile`, `/api/portfolio/history` | the guard's 0x→user bridge reads `saved_wallets.wallet_addr` |
| `profile_bio` | **the resolution table** (username → user_id) | profile edit | guard, every `resolveUserId`, support-chat | migration declares `owner_key TEXT PRIMARY KEY` but **all live code queries `username`** — reconcile this drift |
| `profile_achievements` | **username** | edge fn `compute-achievements` | `/api/profile/achievements` GET; OG route | public showcase read |
| `alert_subscriptions` | **auth UUID** | `/api/alerts/subscriptions` | same; support-chat | already session-sourced |
| `notification_channels` | **auth UUID** | `/api/alerts/channels` | `resolve_channel_owner`, `get_owner_channel_targets`, telegram/discord bots | already session-sourced |
| `alert_deliveries` | **auth UUID OR lowercased email** (polymorphic *within one table*) | weekly-digest (`user_id`), signup-reminder (`email`), `dispatch_triggered_fmv_alerts` | `alreadySent()` in both cron routes | the email rows are the 4th shape — handle separately |
| `support_conversations` | **Top Shot username** (server-derived from verified email) | `/api/support-chat[/context/feedback]` | admin/feedback | client `ownerKey` is ignored; server wins |

## (b) Routes (path · method · R/W · value source · guarded?)
"Guarded" = `requireOwnedKey`. "session" = derives from `user.id`, ignores request. Full table in the enumeration below; the migration-relevant grouping:

- **Already session-only (safe end-state, minimal migration):** `/api/alerts` (GET/POST/PATCH/DELETE — forces `user.id`, never body), `/api/alerts/subscriptions`, `/api/alerts/channels`, all `/api/support-chat*` (server-derives from auth email). These are the model to copy.
- **Guarded but request-sourced** (the guard is the only thing between a request param and a service-role query — the exact rows §6.4 wants session-only): `/api/watchlist` (GET/POST/DELETE), `/api/profile/watchlist`, `/api/profile/portfolio-history` POST, `/api/wallet/save`, `/api/wallet/profile`, `/api/portfolio/history`, `/api/profile/export-csv`.
- **Resolve-then-verify reads** (public, resolve `?ownerKey`=username→user via `resolveUserId`): `/api/profile/{teams,top-movers,tier-breakdown,collection-breakdown,hero-moment,top-moments}`.
- **Cron / bot:** `/api/cron/weekly-digest` (`user_id`), `/api/cron/signup-reminder` (**email**), `/api/bots/{telegram,discord}` (resolve via `notification_channels`).

## (c) IDOR-shaped sites (owner_key from the request, not the session)
1. **Deliberately unguarded public reads** against a client-supplied key on a service-role client — the migration should decide whether these stay public: `/api/profile/portfolio-history` GET (exposes another user's portfolio total/count if their auth-UUID owner_key is known — documented carve-out, but it is a real read-by-request), `/api/profile/achievements` GET, `/api/og/profile/[username]`.
2. **Guarded-but-request-sourced** (list above) — safe today only because the guard bridges; these are the migration's primary targets.
3. **Vestigial client params** — call-sites that still *send* an owner_key the route now ignores; must be updated in the same slice or they send dead params: `app/dashboard/alerts/page.tsx`, `components/profile/PriceAlertsCard.tsx`, `components/collection/CollectionMomentTable.tsx` (→ `/api/alerts`). `components/alerts/WatchEditionButton.tsx` already omits it — the correct end-state.

## (d) Migration hazards to design around
- **Flow-EVM addresses won't match the guard's bridge.** The 0x→user resolution regex is Flow-only `/^0x[0-9a-fA-F]{16}$/`; a 40-hex Flow-EVM address fails it. The §6.4 model has a `flow_evm` `wallet_kind`, so the bridge/migration must handle both address widths.
- **Two watchlists, two key conventions** (`edition_key` vs `edition_id`) — separate slices.
- **The 4th shape (email in `alert_deliveries`)** has no `user_id` and cannot map to `user_wallets` — plan a separate path for cold-signup rows.
- **`profile_bio` migration-vs-live drift** (`owner_key` PK on paper, `username` in practice) must be reconciled first, since it is the resolution table everything else routes through.

## Suggested reversible slices (for Trevor to sequence — not executed)
1. Reconcile `profile_bio` schema drift + confirm all remote-only table shapes live.
2. Introduce `user_wallets` (empty) + backfill from `saved_wallets` (0x rows) and `auth.users` (UUID rows) — additive, no reads switched yet.
3. Convert the *already-session-only* routes to resolve `user_id` from `user_wallets` (lowest risk — no behavior change).
4. Convert the guarded-but-request-sourced writes (`watchlist`, `wallet/save`, `portfolio-history` POST) to session-only, updating the vestigial client senders in the same commit.
5. Decide the public-read carve-outs (portfolio-history/achievements/OG) explicitly.
6. Handle `alert_deliveries` email rows separately.

## Tests that pin current behavior (will need updating with the migration)
`__tests__/owner-key-guard.test.ts`, `api-watchlist.test.ts`, `api-wallet-save.test.ts`, `api-profile-watchlist.test.ts`, `api-profile-portfolio-history.test.ts`, `api-portfolio-history.test.ts`, `api-profile-export-csv.test.ts`, `api-alerts*.test.ts`, `auth-supabase-client.test.ts`; DB tests `supabase/tests/{save_user_wallet,resolve_channel_owner,get_owner_channel_targets,check_triggered_fmv_alerts,dispatch_triggered_fmv_alerts}.sql`.

---
*Full file:line citations for every row above are preserved in the enumeration this doc summarizes; re-run a scoped grep per slice before executing it, per §7 (verify each claimed consumer live, not from this document).*
