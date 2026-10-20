# Concierge & alerts — feature roadmap (refreshed 2026-10-17, PT)
> Dated snapshot; re-derive any number before quoting. Canonical plan: [roadmap-2026-10-17.md](../roadmap-2026-10-17.md). Per-collection detail: [collections/](../collections/). Defects: [known-issues.md](../../reference/known-issues.md).

## What it is today

**The concierge** is `app/api/support-chat/route.ts` plus `SupportChat`, with ~42 tools as of the 10-03 pass. It is on the site, and on Telegram via `BOT_BRIDGE_SECRET`. The Discord asymmetry is permanent (concierge.md).

It explains data and never makes a call:
- `get_fmv` / `explain_fmv`, `explain_ui_field`, `check_wallet`, `get_market_cap`;
- `manage_watchlist` / `manage_alerts`;
- player and team resolvers (`resolve_player_name` / `resolve_team_name`, with `player_relations` for father/son pairs and renames);
- ESPN season stats on Top Shot and All Day player pages.

Since 10-14 a "?" control on the edition page's FMV tile and on the team checklist's cost-to-complete header opens it with that number as context.

**Alerts** are what real users use: all 4 signed-in outbound clicks in the 10-08 → 10-14 week, and the one real concierge conversation, came from them.
- **Deal alerts:** `dispatch_due_deal_alerts`, deduplicated per LISTING.
- **Per-edition FMV alerts:** `fmv_alerts`, armed and fired on the transition. The outbox is the only sender.
- `/alerts` and `/dashboard/alerts`. The concierge can create and remove alerts.

Live 10-17: `alerts-dispatch` 104/104 runs ok in 24 h; 14 `alert_deliveries` in 7 d; **`fmv_alerts` holds 0 rows** (the designed state for `fmv_scanned 0`).

**Email:**
- The welcome email is live and idempotent (`claim_welcome_email`, 10-11).
- **Digests are flag-off:** `WEEKLY_DIGEST_ENABLED` and `SEND_DIGEST_ENABLED` are unset, and neither route sends without `RPC_SENDER_POSTAL_ADDRESS` either (10-18; until then `send-digest` had no flag at all).
- The contact mailbox `rippackscity@gmail.com` is live everywhere (10-12).

## Shipped recently (since mid-September)

- **10-18 (Claude Code cloud):** `search_across_collections` reads All Day / Golazos edition floors from the on-chain index (`editions_matched` so "not listed" never reads as "not on RPC"), adds a **Candy MLB** arm (fresh-book rules from `get_edition_listings`, row-cap fails closed), and answers UFC as market-closed. `search_catalog_deals` and the `search_live_deals` fallback read `get_allday_market_editions_v3` / `get_golazos_catalog_deals` (`20261018205915`), one read per resolved label with an exact-label post-filter. Not verified end to end (the cloud sandbox cannot reach the site); verified at the DB / API layer and by 15 new tests with planted defects.

- **09-25 batch 62 (player identity):** names are not people. `resolve_player_name` and `resolve_team_name`, aliases, `player_relations`, `league_team_abbr` franchise folding. #139: every pair resolved against NBA.com and NFL.com.
- **10-03 (42 tools):**
  - The request boundary is bounded.
  - The bot checks before it logs.
  - The returning-tester greeting names what shipped.
  - `get_market_cap`.
  - #164: the first real `fmv_alerts` row was written through the concierge.
  - The Telegram bridge was verified.
- **10-04:** R73's "opened" metric de-duplicated. The points programme switched OFF, with its "credits accrue" copy.
- **10-04 D26:** twin player rows merged, with aliases (OG/O.G. Anunoby, Claxton and others).
- **10-09/10:**
  - `explain_fmv` is scoped by collection (575 keys exist in two collections).
  - Concierge "remove my alert" is scoped by collection.
  - `/dashboard/alerts` stopped saving an All Day / Golazos / UFC / Candy alert as Top Shot.
  - #183: alerts read the edition's own live ask.
  - The "Perfect mints only" filter excludes 1-of-1s.
  - `/api/alerts` preview fixed.
  - `/api/send-digest` no longer mails a digest built from failed reads.
  - #176: rows are keyed by the session user.
- **10-11 (three passes):**
  - `check_wallet` no longer publishes zeros it never measured.
  - Escalation is limited to what RPC can act on.
  - Refused sends render as error bubbles.
  - Pills ask for data, never a buy/sell call (guarded).
  - "Trophy case" disambiguated.
- **10-14:**
  - The concierge stopped reciting the retired FMV 1.7.0 model (it had done so for 11 days).
  - Deal alerts fire once per listing, not at every UTC midnight (verified held 10-16).
  - FMV alerts fire on the transition; channel `both` delivers to both.
  - webz_80's four reports closed the loop by email.
- **10-17:** `pipeline-failure-alerts` (ops paging) reads the whole hour instead of its newest ~27 min. Its source is now in git.
- **10-19 (Claude Code cloud, one evening): the concierge covers Panini end to end.** Every tool was swept for what it does when a Panini page is the default scope. Fixed:
  - **Wrong claims:** the prompt said Panini had "no Collection analyzer, no Sniper", and `explain_fmv` printed "Floor price is $0.00" (no Panini snapshot carries a floor).
  - **Empty answers from tables with no Panini rows:** `search_live_deals` / `search_catalog_deals` (now the Sniper tab's snapshot), Panini `compare_pack_value` (now Panini's pack plane), `get_edition_listings` (now `panini_market_board`), `search_across_collections` (Panini was filtered out; now `paniniFloorReader`).
  - **Substitutions:** `check_wallet` / `find_quirky_serials` / `analyze_wallet_holdings` resolved a Panini name as a Top Shot username (another person's wallet); `get_premiums` answered with Top Shot's boards on every collection.
  - **Refusals of answerable questions:** `get_top_sales` refused Panini although its board has served Panini since 10-10.
  - **New reads:** `get_insight_board` boards `panini_pack_market` (with a `rip_verdict`; never "+EV" unless the simulated P(pull ≥ cost) ≥ 50 %) and `panini_premiums`.
  - **Honest refusals:** the team tools say Panini has no team data (0 of 36,511 editions carry one).
- **10-19: Panini price alerts.** The edition page's Watch control was hidden on Panini because `edition_live_ask` (the dispatcher's ask) had no Panini source; it now reads `panini_market_board` (`20261020031908`), and the same evening the function's All Day / Candy arms were made ~5× cheaper (`20261020041750`). Detail and revert paths: ledger 10-19, [panini.md](../collections/panini.md).

## Open issues

- **C2 CAN-SPAM postal address: blocked on Trevor.** Every commercial email needs a valid physical postal address. Until a shared footer carries one, digests and any marketing send stay flag-off (platform review 10-11, M10).
- **R73: discoverability, not answers.** 3 non-automated `concierge_opened` events in the last 7 d (10-17 read). The ~10-28 watch: under ~1 real open a week on the fixed instrument means placement is still the problem.
- **`support_conversations` alone cannot tell "nobody asked" from "it broke."** It held 231 rows in 7 d, mostly smoke probes. Read `usage_events` (`concierge_opened`, `chat-message-sent`) and the daily smoke results together.
- **Player identity is maintained by hand** (player-identity.md §Maintenance): new father/son pairs, renames, and historic team labels. ESPN gaps leave 29 Top Shot identities unkeyed. Dee Brown and Courtney Williams (×2) are ambiguous.
- **#8:** `sync-nba-projections` is still a permanently-red arm. ESPN is dead behind the proxy.

## Next — prioritized

**Now**
1. **Close R73's 2-week watch on ~10-28.** Read real opens from the edition-FMV "?" and the checklist "?". Why: it decides whether to move the entry point or leave it. Falsifier: ≥ 1 real open a week, in which case leave placement alone and review the answers instead.
2. 📏 **Pre-checked 2026-10-18 ~9:50 AM PT:** the 2025 draft class already resolves to ONE player each via `resolve_player_name` (Cooper Flagg 21 editions, Dylan Harper 22, VJ Edgecombe 24, Ace Bailey 16, Kon Knueppel 21; Paige Bueckers 26), because they have Series 8 editions — Series 9 starts from clean identities. The falsifier below still applies to genuinely new names on 10-20.
   - (original item) **Series 2026-27 player identity (from 10-20).** New Series 9 players and rookies resolve through `resolve_player_name`. Autograph status IS a field since 2026-10-19: edition rows carry `autographed` (true / false = Atlas-verified unsigned / null = not checked; `lib/concierge/edition-metadata.ts`). Partner-athlete status still has no field, so the concierge must not claim it. Falsifier: a Series 9 player whose name does not resolve, or who has two rows.

**Next**
3. ✅ **Gate SHIPPED 10-18 ~2:29 PM PT (Claude Code cloud) — and it closed a real hole: `/api/send-digest` had NO enable flag.** Anything holding the bearer token mailed every verified subscriber a commercial digest with no postal address. Both digest routes now send only when their own flag (`WEEKLY_DIGEST_ENABLED` / `SEND_DIGEST_ENABLED`) is `"1"` **and** `RPC_SENDER_POSTAL_ADDRESS` is set; the footer then carries the address (`commercialSenderLine()` in `lib/emails/sender-identity.ts`). The address is never defaulted. **Turning digests on = Trevor's address in that env var + one flag** (and the accuracy gate). Unsubscribe links were already in both.
   - (original item) **Digest readiness behind the flag:** shared footer, unsubscribe, and the postal address slot. Ship it dark, so turning digests on later is a one-flag change. Gate: Trevor supplies the address (C2), and the accuracy gate is passed before any send.
4. ✅ **MEASURED 2026-10-18 ~8:50 AM PT (Claude Code cloud): no frozen-market alert path exists today, so nothing to build.** `cross_collection_deals_board` holds **0** Golazos and **0** Candy rows (it requires HIGH/MEDIUM confidence, which neither frozen market has). `edition_current_ask` holds **0** Candy asks and **496** Golazos asks: the price-only path can see Golazos, but those are the state-verified open storefront book (the 10-17 on-chain probe settled that the venue is idle, not invisible), and `ask_is_alertable` exempts that book because rows leave it when a listing closes. `alert_deliveries` for either collection in 30 days: **0** (5 subscriptions estate-wide). **Re-open if** a Golazos/Candy edition enters the deals board, or Candy gains asks (OpenSea key, #58): then the delivery must carry "no indexed sales since <date>".
   - (original item) **Alert coverage for frozen markets.** An alert on a Candy or Golazos edition must say its market has no indexed sales, never fire on a stale ask. Falsifier: a delivery with an ask older than its source's last good read.

**Later**
5. **Concierge answers for the official Yearbook / Squad Goals scoring**, only once Trevor supplies it. RPC will not publish its own rank as Top Shot's.

- ⚠ **Publishing a collection is not done until every concierge tool has been checked against it** (10-19 lesson; checklist in [concierge.md](../../reference/concierge.md), end). Panini was published 09-25 and sat three weeks with half the tools answering from tables that hold no Panini rows.

## Decisions on record (do not re-litigate)

- **RPC is READ-ONLY** (concierge rule 1). The bot never offers a buy, sell, trade, cart or gift, and never makes buy/sell calls. There are two exceptions only, both admin-only: giveaway delivery, and the swap TEST.
- **A name is not a person; a team label is not a franchise** (09-25). The league's spelling is an ALIAS, never a rename. Accent-collapsed canonical slugs stay.
- **Telegram was retired as a requirement** (R77, 10-13).
- **Points programme OFF** (10-04, Trevor).
- **No paid tier, billing, or "paying user" copy anywhere** (escalation scope, 10-11). No paid tier until 100 WAU.
- **No outreach** (Trevor). Digests stay off until C2 is resolved.
- **Deal-alert zero_yield lanes and the Lillard Archive filter stay** (declined 09-25).

## Where the detail lives

- [concierge.md](../../reference/concierge.md): rules, read-only exceptions, every dated pass, tool contracts.
- [player-identity.md](../../reference/player-identity.md): resolvers, the ESPN feed, maintenance.
- [platform-review-security-marketing-seo-compliance-2026-10-11.md](../../audits/platform-review-security-marketing-seo-compliance-2026-10-11.md): C2 and M10.
- Code: `app/api/cron/weekly-digest/route.ts` (the flag), `lib/emails/sender-identity.ts`, `lib/alerts.ts`.
- Register: #8, #139, #164, #176, #183 in [known-issues.md](../../reference/known-issues.md); R73, R77 in [deep-audit-register.md](../../audits/deep-audit-register.md).
