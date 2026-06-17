# Handoff 2026-06-16 — Omni-channel alerts + SoldPacks bot

Plain text on purpose (no code fences) so it pastes cleanly from an iPhone into Claude Code. Claude Code's direct file inspection wins over this doc and over project_knowledge_search on any disagreement — adapt to the actual file shape.

## Context

Goal: LiveToken-style deal/FMV alerts delivered to a user's preferred channel (email / Telegram / Discord), plus a "SoldPacks" bot (DM the bot a wallet, get pack sale history). Trevor approved building all channels.

Cowork already shipped the entire DB foundation LIVE on Supabase project bxcqstmqfzmuolpuynti (4 additive migrations, verified end-to-end: link -> subscribe -> dispatch -> claim -> send, all PASS; security 0 violations, RLS on, all RPCs service_role-only). This handoff is the CODE half Cowork cannot push: server routes, the /alerts UI, the two bot webhooks, the per-channel senders, the dispatch cron, and the SoldPacks command.

Nothing in this handoff ships until you build + deploy it. The DB objects are inert until called (0 subscriptions, 0 channels, 0 deliveries today). Safe to land incrementally — do Items 1-4 first (email-only deal alerts, end to end) to prove the loop, then bots.

## DB contract already live (build against this — do NOT recreate)

Tables (all RLS-on, service_role only; owner_key = the RPC user's auth uid as text, i.e. the value requireUser() resolves):

- notification_channels — one row per (owner_key, channel). Columns: id, owner_key, channel ('email'|'telegram'|'discord'), channel_user_id (email addr | telegram chat_id | discord user id; null until claimed), channel_username, verified bool, link_code, link_code_expires_at, created_at, verified_at, last_used_at. Unique (owner_key, channel); unique (channel, channel_user_id) where not null; unique link_code where not null.
- alert_subscriptions — channel-agnostic deal-feed prefs. Columns: id, owner_key, label, channels text[] (default {email}), collection_ids uuid[] (null=all active), min_discount numeric (default 25), max_price, min_price, tiers text[], player_names text[], set_names text[], team_names text[], min_serial int, max_serial int, require_jersey_serial bool, require_last_mint bool, require_never_sold bool, require_low_ask bool, badges text[], cadence ('instant'|'daily'|'weekly'), active bool, created_at, updated_at, last_run_at.
- alert_deliveries — transactional outbox. Columns: id, owner_key, channel, channel_user_id, alert_kind ('deal'|'fmv'|'pack_digest'), subject_key, dedup_bucket, payload jsonb, status ('pending'|'sending'|'sent'|'failed'|'skipped'), attempts, created_at, sent_at, last_error. Unique (owner_key, channel, alert_kind, subject_key, dedup_bucket) = the dedup guard.

RPCs (call via the service-role client only — they are REVOKEd from anon/authenticated):

- create_channel_link_code(p_owner_key text, p_channel text, p_channel_user_id text default null) -> jsonb {ok, channel, code, expires_at}. Registers/refreshes a pending link, returns a one-time 8-char code (15-min TTL). For email pass the address as p_channel_user_id; for telegram/discord leave null.
- claim_channel_link(p_channel text, p_channel_user_id text, p_channel_username text, p_code text) -> jsonb {ok, owner_key, channel} or {error}. The bot (or email-verify route) calls this to bind the platform identity and mark verified.
- resolve_channel_owner(p_channel text, p_channel_user_id text) -> jsonb {linked bool, owner_key?}. Inbound bot message -> which user. Touches last_used_at.
- get_owner_channel_targets(p_owner_key text, p_channel text default null) -> jsonb array of verified {channel, channel_user_id, channel_username}.
- build_deal_alerts_for_subscription(p_subscription_id uuid) -> jsonb {deals_count, deals[], ...}. Matches the live cross_collection_deals_board (TS + Pinnacle, FMV-anchored) against the sub's filters. Use this for the UI "preview" too. Applies now: collection, min_discount, min_price, max_price, tiers, player_names, set_names. See "Serial-level data gap" below for the rest.
- dispatch_due_deal_alerts(p_max int default 1000) -> jsonb {subscriptions_scanned, enqueued}. Scans active subs, matches deals, enqueues one alert_deliveries row per deal x linked+verified channel (deduped by day). Cron calls this.
- dispatch_triggered_fmv_alerts(p_max int default 200) -> jsonb {scanned, enqueued}. Evaluates per-edition fmv_alerts (the existing table the dormant /api/alerts route writes), enqueues triggered ones, stamps last_triggered_at (6h dedup). Cron calls this. (This replaces the legacy check_triggered_fmv_alerts + mark_alerts_triggered pair, which had a uuid[]-vs-bigint type bug — do not use the legacy pair.)
- claim_pending_deliveries(p_channel text, p_max int default 50) -> jsonb {channel, count, deliveries[]}. Atomically claims pending rows for a channel (FOR UPDATE SKIP LOCKED -> status 'sending'); a per-channel sender drains this.
- mark_delivery_sent(p_id uuid) / mark_delivery_failed(p_id uuid, p_error text). Senders call after each send. failed re-queues to pending until attempts>=5, then 'failed'.

Deal payload shape (alert_deliveries.payload for alert_kind='deal'): { subscription_id, label, deal: { external_id, name, player_name, set_name, tier, collection_slug, collection_name, circulation_count, fmv_usd, confidence, low_ask, discount_pct, discount_usd, detail_url, thumbnail_url, ask_updated_at } }. detail_url is a site-relative path (e.g. /nba-top-shot/edition/247%3A8464) — prefix with https://www.rippackscity.com for the message link.

FMV payload shape (alert_kind='fmv'): { alert_id, edition_key, player_name, set_name, alert_type, threshold, current_fmv, lowest_ask, confidence }.

## Existing code to reuse (verified present)

- lib/supabase.ts — exports supabaseAdmin (service-role client). Use it for every RPC call here. Server-only.
- lib/rewards.ts — the canonical "service-role wrapper over SECDEF RPCs" pattern. Mirror it for a new lib/alerts.ts.
- app/api/alerts/route.ts — ALREADY EXISTS: GET/POST/PATCH/DELETE for per-edition fmv_alerts (owner_key-keyed, service role, has Telegram refs). Keep it for per-edition alerts; ADD the deal-subscription + channel-link routes alongside (Item 1). Do not rewrite it blindly.
- lib/emails/welcome-email.ts — the Resend send pattern (RESEND_API_KEY). Mirror for the email sender.
- Telegram send pattern already exists in app/api/sentinel/route.ts + app/api/check-alerts/route.ts (sentinel bot). Reuse the fetch-to-Bot-API shape, but with the NEW user-facing bot token (see env).
- app/api/profile/saved-wallets/route.ts + saved_wallets table (user_id, wallet_addr) — for SoldPacks linked-wallet resolution.
- proxy.ts — site lockdown. Bot webhooks + the email-verify GET must be added to isPublicPath (Item 9).

## Item 1 — Server routes: deal subscriptions + channel linking (do first)

New routes (service-role, owner_key from requireUser()):

- app/api/alerts/subscriptions/route.ts — GET (list this user's alert_subscriptions), POST (create/update: insert or update by id; only ever set owner_key = the session user, never from the body), DELETE (by id, scoped to owner_key), PATCH (toggle active). Validate channels[] subset of {email,telegram,discord}; numbers non-negative. On read, also return build_deal_alerts_for_subscription(id) as a live "you'd get N deals right now" preview.
- app/api/alerts/channels/route.ts — GET (list this user's notification_channels: channel, verified, channel_username, masked target), POST (start a link: body {channel}; call create_channel_link_code(owner_key, channel[, email]) and return the code + bot deep links), DELETE (unlink a channel).
- app/api/alerts/channels/verify-email/route.ts — GET ?code=...&email=... -> calls claim_channel_link('email', email, null, code) and renders a confirm page. This is the link the verification email points at (must be public — Item 9).

Security invariant (carry the rewards-program rule): the client never supplies its own owner_key and never names another user's id. owner_key is always requireUser() server-side. The subscription body carries only filter prefs.

Revert: delete the new route files. git revert the commit.

## Item 2 — /alerts UI page (mirror the LiveToken "Create a New Alert" form)

New: app/alerts/page.tsx (client) + app/alerts/layout.tsx (metadata-only server layout), auth-gated (NOT in isPublicPath), brand tokens (var(--rpc-red), var(--font-display), var(--font-mono)), dashboard-chrome pattern. Reference the screenshot Trevor sent.

Form fields (map 1:1 to alert_subscriptions columns):
- Players multiselect -> player_names[]; Sets multiselect -> set_names[]; Teams multiselect -> team_names[].
- Min price / Max price -> min_price / max_price. Min serial / Max serial -> min_serial / max_serial.
- Min discount % -> min_discount (this is RPC's core lever vs LiveToken; default 25).
- Checkboxes: Jersey Serial -> require_jersey_serial; Last Mint -> require_last_mint; Never Sold -> require_never_sold; Low Ask -> require_low_ask.
- Badge/tier checkboxes (LiveToken's TS/RY/RM/RP/CY/CR/CCR) -> badges[]. Map each chip to RPC's badge vocabulary (badge_taxonomy / play_tags) — confirm the slug set before wiring; do not invent slugs.
- Collections (TS / Pinnacle today; the board is TS+Pinnacle) -> collection_ids[].
- Delivery channels: Email / Telegram / Discord checkboxes -> channels[]. Each shows linked/not-linked state from /api/alerts/channels; "not linked" -> inline "Link Telegram/Discord" that pops the code + bot deep link.
- Cadence: Instant / Daily / Weekly -> cadence.
- Live preview panel: call the subscription preview (build_deal_alerts_for_subscription) so the user sees matching deals before saving — LiveToken's "don't create an overwhelming number of notifications" guidance, made concrete.

Note in the UI: serial-range, jersey, last-mint, never-sold are saved but only enforce once the live per-serial listing feed lands (Item: serial gap). Show them as "applies to live listings" rather than silently ignoring — honesty-first.

Revert: delete app/alerts/*. git revert.

## Item 3 — Dispatcher cron

New: app/api/cron/alerts-dispatch/route.ts. Auth: Bearer INGEST_SECRET_TOKEN (match the other cron routes). Body of work, fire-and-forget under next/server after() if >10s: call supabaseAdmin.rpc('dispatch_due_deal_alerts', { p_max: 1000 }) then supabaseAdmin.rpc('dispatch_triggered_fmv_alerts', { p_max: 200 }); log to pipeline_runs (pipeline='alerts-dispatch', ok, extra={enqueued_deal, enqueued_fmv}) per the repo's log_pipeline_run pattern. maxDuration 60.

Cron-job.org entry (www domain, off the :00 rush — see the rpc-cron-ops skill): every 15 min, GET/POST https://www.rippackscity.com/api/cron/alerts-dispatch with Authorization: Bearer <INGEST_SECRET_TOKEN>. Keep it 30s-safe (it just calls 2 RPCs + returns 202).

Revert: delete the route + disable the cron entry.

## Item 4 — Per-channel senders

New: app/api/cron/alerts-send/route.ts (one route that handles all channels via ?channel=, OR three sibling routes). For each channel: rows = supabaseAdmin.rpc('claim_pending_deliveries', { p_channel, p_max: 50 }); for each delivery, format + send; on success mark_delivery_sent(id), on throw mark_delivery_failed(id, err). Group deal rows per user for a single digest message where it reads better (esp. email). After() wrap, log pipeline_runs.

- Email: Resend (RESEND_API_KEY), mirror lib/emails/welcome-email.ts. From noreply@rippackscity.com. Subject e.g. "3 new Top Shot deals match your alert". Include an unsubscribe/manage link to /alerts.
- Telegram: POST https://api.telegram.org/bot<TELEGRAM_USER_BOT_TOKEN>/sendMessage { chat_id: channel_user_id, text, parse_mode:'HTML', disable_web_page_preview:false }. One message per deal or a compact list; link https://www.rippackscity.com + detail_url.
- Discord: POST the user-DM via the bot — create a DM channel (POST /users/@me/channels { recipient_id: channel_user_id }) then POST /channels/{id}/messages with an embed (title=player+set, fields: ask, FMV, discount%, url). Auth header Authorization: Bot <DISCORD_BOT_TOKEN>.

Cron-job.org: every 5 min per channel (or one entry hitting alerts-send that loops channels), www domain, Bearer INGEST_SECRET_TOKEN, staggered off :00 and off the alerts-dispatch slot.

Revert: delete route(s) + disable cron entries. Pending deliveries simply sit unsent.

## Item 5 — Telegram bot webhook (net-new)

New: app/api/bots/telegram/route.ts (public — Item 9). Telegram webhook mode (no always-on process). Set the webhook once: GET https://api.telegram.org/bot<TELEGRAM_USER_BOT_TOKEN>/setWebhook?url=https://www.rippackscity.com/api/bots/telegram&secret_token=<TELEGRAM_WEBHOOK_SECRET>. On each POST, verify header X-Telegram-Bot-Api-Secret-Token == TELEGRAM_WEBHOOK_SECRET, then parse the update.

Commands:
- /start <code> or /link <code> -> claim_channel_link('telegram', String(message.from.id), message.from.username, code); reply success/failure.
- /soldpacks <wallet> -> Item 7 (or, if no wallet given, resolve_channel_owner('telegram', from.id) -> saved_wallets to find their wallet).
- /unlink -> deactivate their telegram channel row.
- /help -> usage.

Use a NEW user-facing bot (e.g. @rippackscity_bot), NOT the @rpc_sentinel_bot ops bot. Reply via sendMessage.

Revert: delete the route; deleteWebhook on the bot.

## Item 6 — Discord bot (net-new; the top-of-funnel play)

New: app/api/bots/discord/route.ts (public — Item 9). Discord Interactions endpoint (serverless; no gateway socket needed for slash commands). MUST verify the Ed25519 signature on every request using headers X-Signature-Ed25519 + X-Signature-Timestamp against DISCORD_PUBLIC_KEY (use tweetnacl: nacl.sign.detached.verify(Buffer.from(timestamp+rawBody), Buffer.from(sig,'hex'), Buffer.from(DISCORD_PUBLIC_KEY,'hex'))). Respond to type=1 (PING) with {type:1}. Read the RAW body for verification before JSON.parse.

Slash commands (register once via PUT https://discord.com/api/v10/applications/<DISCORD_APPLICATION_ID>/commands with Authorization: Bot <DISCORD_BOT_TOKEN>):
- /link code:<code> -> claim_channel_link('discord', interaction.member.user.id (or interaction.user.id in DMs), username, code).
- /soldpacks wallet:<addr> -> Item 7. (Defer the heavy query: reply type=5 deferred, then PATCH the original response via the webhook with the result.)
- /alerts -> reply with a link to https://www.rippackscity.com/alerts to manage subscriptions.

For delivery DMs the sender (Item 4) uses the bot token to open a DM channel — that works as long as the user shares a server with the bot or has DMs open; the /link flow is how we capture their id.

Env: DISCORD_PUBLIC_KEY, DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID. Revert: delete the route; the registered commands can be left or DELETEd.

## Item 7 — SoldPacks command (shared by both bots)

New: lib/alerts/soldpacks.ts (or fold into lib/alerts.ts). Given a wallet (pasted, or resolved from the linked identity via resolve_channel_owner -> saved_wallets.wallet_addr), call supabaseAdmin.rpc('get_wallet_pack_summary', { p_wallet }) and supabaseAdmin.rpc('get_wallet_pack_history', { p_wallet, p_status: 'sold', p_limit: 25 }). Both already exist and return rich JSON (totals: packs_sold, secondary_proceeds_usd, net_pl_usd, by_collection; history: per-pack status/flipped/sold + realized_pl_usd). Format a compact reply: "You've sold N packs for $X (net P/L $Y). Recent: <pack_name> sold $Z (+$P)...". This is pure read — no new DB needed. Accept a bare wallet for unlinked users so the bot works without an account (best top-of-funnel).

Revert: delete the helper + the command branches.

## Item 8 — Concierge omni-channel (optional, phase 2)

The existing AI concierge (app/api/support-chat/route.ts, 5 tools) can answer bot DMs that aren't slash commands: in each bot webhook, if the message isn't a command, forward text to a thin wrapper over the support-chat handler (resolve owner via resolve_channel_owner for context) and return the reply. This makes the SoldPacks bot a full concierge by DM. Gate behind an env flag; ship after Items 1-7 are stable.

## Item 9 — proxy.ts public paths

Add to isPublicPath (GET/POST as noted), since bots + email-verify must be reachable unauthed (they verify their own signatures/codes): /api/bots/telegram, /api/bots/discord, /api/alerts/channels/verify-email. Do NOT make /api/alerts/subscriptions or /api/alerts/channels public — those are user-authed. /alerts (the page) stays auth-gated.

Revert: remove the isPublicPath entries.

## Env vars to add (Vercel — write via PowerShell Invoke-WebRequest per CLAUDE.md)

TELEGRAM_USER_BOT_TOKEN (new user-facing bot, distinct from the sentinel ops bot), TELEGRAM_WEBHOOK_SECRET, DISCORD_PUBLIC_KEY, DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID. Existing + reused: RESEND_API_KEY, INGEST_SECRET_TOKEN, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL.

## Serial-level data gap (the one honest limitation)

The deal source cross_collection_deals_board is EDITION-level (low_ask = cheapest serial per edition). LiveToken's per-serial criteria — min/max serial, Jersey Serial, Last Mint (perfect serial), Never Sold — need a per-serial live listing feed, which RPC currently has thinly (cached_listings = ~113 rows post-Flowty; cart_eligible_listings carries serial_number but is Flowty-era). These columns are SAVED on alert_subscriptions so the UI captures intent and nothing is lost, but build_deal_alerts_for_subscription does NOT yet enforce them. To activate: (a) stand up a per-serial Top Shot listing feed (the topshot-listing-cache path + badge_editions.low_ask exist as seeds), then (b) add a serial-level matcher (likely a sibling RPC reading listings, joined to editions for jersey_number/last-mint/zero-sale flags). Never-sold = fmv confidence NO_DATA with a live ask — a separate query from the discount board. Flag this to Trevor as the next data-side task; do not silently pretend these filters work.

## Guardrails (repeat every handoff)

- Direct to main. No feature branches, no PRs. If a claude/* branch is pre-checked-out, switch to main first.
- Commit via PowerShell git (Git Bash git commit can silently no-op). Re-verify: git rev-list --count origin/main..HEAD == 0 after push.
- curl fails silently in Git Bash for Vercel REST — use PowerShell Invoke-WebRequest. Vercel redeploy via POST v13/deployments with gitSource ref=main.
- Vercel Pro maxDuration hard cap is 800s — higher sends the deploy to ERROR invisibly.
- CRLF: full-file writes or findIndex on split lines, never naive string-replace patches.
- npx tsc --noEmit must be clean before deploy. Type the Supabase client as any in routes (repo convention).
- After deploy: confirm the Vercel deploy reaches READY; smoke the loop — create a sub on /alerts, link a Telegram identity, run /api/cron/alerts-dispatch, run alerts-send, confirm a message arrives and alert_deliveries.status flips to 'sent'.

## Revert paths for the live DB (if the whole feature is pulled)

Each migration is additive and independently reversible:
- audit_20260616_notification_channels: DROP FUNCTION create_channel_link_code(text,text,text), claim_channel_link(text,text,text,text), resolve_channel_owner(text,text), get_owner_channel_targets(text,text); DROP TABLE notification_channels.
- audit_20260616_alert_subscriptions: DROP FUNCTION build_deal_alerts_for_subscription(uuid); DROP TABLE alert_subscriptions.
- audit_20260616_alert_deliveries_and_dispatchers: DROP FUNCTION dispatch_due_deal_alerts(int), dispatch_triggered_fmv_alerts(int), claim_pending_deliveries(text,int), mark_delivery_sent(uuid), mark_delivery_failed(uuid,text); DROP TABLE alert_deliveries.
- audit_20260616_alert_subscriptions_livetoken_criteria: ALTER TABLE alert_subscriptions DROP COLUMN player_names, set_names, team_names, min_price, min_serial, max_serial, require_jersey_serial, require_last_mint, require_never_sold, require_low_ask, badges; (and re-CREATE the prior build_deal_alerts_for_subscription body without the player/set/min_price filters — prior body in this session's migration history).
The tables are empty and unread by any live surface until the routes above exist, so leaving them in place is zero-risk.

## Expected end state

Items 1-4 on main, Vercel READY: a user creates a deal alert on /alerts, links email, and gets a matching-deals email within the dispatch+send window — email-only deal alerts live end to end. Items 5-7: Telegram + Discord linking + delivery + the SoldPacks DM command. Log the 4 shipped migrations (with the revert paths above) into docs/overnight/ledger.md and the CLAUDE.md Recent sessions block — Cowork did not edit the ledger (truncation risk) so that logging is on this CC pass.
