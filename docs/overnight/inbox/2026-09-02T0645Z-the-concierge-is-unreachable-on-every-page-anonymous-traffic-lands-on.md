# The concierge is unreachable on every page anonymous traffic actually lands on — and signing in makes it 8× more restrictive

Measured 2026-09-02 06:45Z (DB clock). Sample-dated: every number below is a
measurement, not a standing fact — re-measure before requoting.

Scope: `app/api/support-chat/**`, `components/SupportChat*.tsx`,
`lib/concierge/**`, `lib/alerts/concierge-bridge.ts`, plus `support_conversations`,
`funnel_events`, `usage_events`, `feature_quotas`.

---

## The headline

The concierge is a 4,209-line route with **33 tools** and it is answering
**zero real questions**. Real (`is_smoke_test = false`) conversations:

| window | real conversations | real sessions | smoke rows |
|---|---|---|---|
| week of 2026-08-31 | 0 | 0 | 154 |
| week of 2026-08-24 | 0 | 0 | 694 |
| week of 2026-08-17 | 1 | 1 | 568 |
| week of 2026-08-10 | 3 | 1 | 560 |

**55 real conversations all-time**, and reading the transcripts, nearly all of
them are Trevor — `tg:1755958876` (the sentinel chat) plus one dashboard
session. The last real user turn was **2026-08-16**.

⚠ Do NOT read this as "the bot is broken." It is healthy — see
`dont-write-off-a-tool-on-untested-say-so`. The problem is upstream of quality:
**almost nobody can reach it, and the ones who sign in get throttled first.**

Two things follow, and they are the whole report:

1. It is not mounted on any page an anonymous visitor arrives on.
2. Signing in *reduces* your concierge allowance from 40/hr to 5/day.

---

## 1. Distribution — the widget is mounted on the wrong pages

`SupportChatConnected` is mounted in exactly ten places:

```
app/(analytics)/analytics/layout.tsx      app/dashboard/DashboardClient.tsx
app/(collections)/layout.tsx              app/my-teams/layout.tsx
app/admin/feedback/AdminFeedbackClient    app/pinnacle/moment/[id]/page.tsx
app/alerts/AlertsClient.tsx               app/rewards/page.tsx
app/dashboard/api-keys/ApiKeysClient.tsx  app/special-serial-owners/…Client.tsx
```

It is **absent** from `app/layout.tsx`, from `app/insights/layout.tsx` and all
30 `/insights/*` boards, from the home page, `/blog`, `/about`,
`/edition/[id]`, and `/early-access`.

Those are the surfaces the traffic is on. `funnel_events`, last 30 days,
`bot_ua is not true`:

| event | distinct sessions |
|---|---|
| `collection_view` | 16,762 |
| `insights_view` | **2,704** |
| `home_view` | **227** |

⚠ The 16,762 figure deserves suspicion: events/session ≈ 1.00 across the whole
table, which is a crawler signature, and only 34 sessions ever pasted a wallet.
Do not quote it as human volume. The `insights_view` number is the one that
matters for this finding, and 2,704 sessions in 30 days had **no way to ask a
question** — no launcher on the page at all.

**Fix:** mount `SupportChatConnected` in `app/insights/layout.tsx` (one line,
covers all 30 boards) and in the root layout or home page. `pageContext` already
derives from `usePathname()`, so an insights board would identify itself to the
prompt for free.

**Second-order:** `ExplainButton` (dispatches the `rpc-concierge-ask` event the
chat listens for) exists and is wired into only **two** components —
`CollectionMomentTable` and `PortfolioSummary`. That is the highest-intent entry
point in the product (a user pointing at a specific row and asking "why?") and
it is on two surfaces. Putting it on insights board rows and edition pages is
cheap and converts far better than a floating bubble.

---

## 2. The quota is inverted — signing in makes the bot 8× stingier

From `route.ts` around L3749–3790, verified against `feature_quotas`:

- **Anonymous** (no `userWallet`): durable per-IP limiter,
  `bump_concierge_ip_rate(ip, 40, 3600)` → **40 messages/hour**, no daily cap.
- **Signed-in, free plan**: skips the IP limiter entirely
  (`if (!userWallet && !trustedBot)`), and instead hits
  `checkFeatureQuota(wallet, "concierge_messages")` → `feature_quotas` row
  `plan='free'` → **`daily_limit = 5`**.

So a signed-in free user is cut off on their **sixth message of the day**, while
a logged-out stranger gets forty an hour. Whatever this was calibrated for, at
0–3 real conversations/day it is a paywall on the one surface we most want
people to try, and it lands against the `no-paywall-until-traction` gate.

**Fix:** one UPDATE on `feature_quotas` (free `concierge_messages` → 40 or 50,
matching the anonymous allowance). Revert path: set it back to 5. No code
change. The per-IP backstop and the credit exposure it protects are unaffected
because signed-in users are a bounded, known set.

Abuse control otherwise checks out — the per-IP limiter is durable
(`concierge_ip_rate`, RLS-on, SECURITY DEFINER, fails open), and the
per-session in-memory Map is correctly described in its own comment as
"trivially defeated," which is why the IP backstop exists. **Nothing to fix
there.**

---

## 3. No prompt caching — the largest cost and latency lever in the route

There is **no `cache_control` anywhere** in `app/api/support-chat/route.ts`.
Every Anthropic call resends the entire static prefix:

- `TOOLS` array (L193–660): **45,323 characters**
- `buildSystemPrompt` (L663–930): **39,712 characters** of source

That prefix is resent on **every iteration**, and the loop runs up to
`MAX_ITERATIONS = 5` per user message. A three-tool answer therefore pays for
~20k tokens of identical preamble three to four times.

**Fix:** a `cache_control: { type: "ephemeral" }` breakpoint at the end of the
`tools` array and at the end of the static head of the system prompt. Cached
reads are a fraction of the input price and time-to-first-token drops
materially. This is the rare change that improves latency *and* cuts spend, so
it sits inside the `cost-flat-infra` gate rather than against it.

⚠ Ordering constraint: anything that varies per request (wallet, page context,
signed-in label) must sit **after** the breakpoint, or the cache never hits.
Check `buildSystemPrompt` composes static-first before wiring this.

---

## 4. Public boards the bot cannot read — six, but only four are boards

`get_insight_board`'s `boardMap` (L3154) covers 11 boards; `get_ecosystem_stat`
covers 4 more; `get_top_sales` / `get_market_movers` / `get_rookies` /
`get_premiums` cover 5. There are **29** routes under
`app/api/public/insights/`. Unreachable by any tool, with 30-day non-bot
sessions:

| board | sessions |
|---|---|
| `/insights/tc-report` | 126 |
| `/insights/rookie-board` | 81 |
| `/insights/panini-squeeze` | 72 |
| `/insights/candy-mlb` | 67 |
| `/insights/squeeze-check` | 63 |
| `/insights/pack-drops` | 61 |
| **total** | **470** |

⚠ `get_rookies` hits `/api/public/insights/rookies`, which is a **different
endpoint and a different source** from `/insights/rookie-board`
(`topshot_2025_rookie_index` vs `topshot_rookie_edition_board`) — do not assume
the name covers it.

⛔ **Two of those six are NOT boards, and adding them to `boardMap` would have
shipped two entries that 400 on every call.** `tc-report` and `squeeze-check`
both **require** a `?wallet=` param and return
`{"error":"wallet param is required"}` at HTTP 400 without one — they are wallet
tools wearing a board's URL. Check for a required param before adding a path.
- `squeeze-check` → `get_wallet_squeeze_exposure`, which is **exactly what
  `check_wallet_squeeze` already calls**. Nothing to add; it was never missing.
- `tc-report` → `get_wallet_tc_report`, the composite "Top Collector Report"
  (cross-collection rollup, squeeze, 2025 rookie cohort, WNBA S7, closest set
  completions, 90-day acquisitions). Genuinely unreachable, and the single
  highest-traffic gap of the six — but it needs its own wallet-scoped tool.

**Fix:** four entries in `boardMap` (`rookie_board`, `panini_squeeze`,
`candy_mlb`, `pack_drops`) plus the matching enum/description words, and a new
`get_collector_report` tool for tc-report. `fetchPublicInsight` is already
generic; no new plumbing for the four. Note the
system prompt at L909 already *links* several of these boards while the tools
cannot *read* them — the bot can point you at `/insights/tc-report` and then
cannot tell you what is on it.

---

## 5. `get_set_completion_cost` still can't answer the question a user actually asked

2026-07-12, real transcript (id 4821 / 4822), asked twice and failed twice:

> "What is the cheapest set for me to complete right now?"
> → *"the set completion tool requires a specific set name — I can't query
> across all sets at once to rank them by completion cost."*

Still true today: `required: ["setName", "walletAddress"]`. A collector does not
know which set is cheapest — that is the entire question. This wants a mode that
ranks the wallet's in-progress sets by cost-to-complete, the same shape
`get_challenges` already has (it ranks by `netEv` with no set name required).

**Already fixed, do not re-report:** the other two gaps from those July
transcripts both shipped — `check_wallet_squeeze` now returns
`buckets.<name>.fmv_usd` per bucket, and `search_live_deals` now takes
`setName`. Both were logged via `log_feature_request` and marked `shipped`
2026-07-11. The feedback loop works.

---

## 6. Instrumentation — we cannot tell "nobody opens it" from "everyone bounces"

`components/SupportChat.tsx` fires exactly **one** telemetry call:
`track("chat-message-sent")` at L404. There is no event for opening the
launcher, clicking a quick-suggestion pill, or abandoning without sending.

`usage_events`, last 60 days: `page-view` 2,989, `sniper-filter-applied` 108,
`search-executed` 36, `concierge_messages` 3, and **zero** `chat-message-sent`
rows — consistent with the zero real conversations, so this is not evidence of a
dropped beacon (the floating-promise bug in `/api/telemetry` was fixed
2026-08-27 with `after()`).

But it means that after the widget goes on the insights boards, we will have no
way to distinguish *the bubble is invisible* from *people open it and can't
think of a question*. Those need opposite fixes.

**Fix (do it before, not after, the mount):** `track("concierge_opened")` in the
`isOpen` effect, `track("concierge_suggestion_clicked", { suggestion })` on the
pill handler, and a `concierge_closed_without_send` on close when
`messages.length` is still at the greeting. Three one-line calls, additive,
no schema change (`usage_events.feature_name` is free-text).

---

## 7. `stop_reason === "max_tokens"` is an unhandled branch

The loop (L3950–4047) handles `end_turn` and `tool_use` explicitly; **everything
else falls into a bare `else`** that returns whatever text accumulated as the
final answer. With `max_tokens: 1024` (~4,000 characters), a truncated reply is
returned mid-sentence with no marker and no continuation call.

⚠ **This has never fired.** Across all 5,643 rows in `support_conversations`,
the longest `bot_response` is **2,107 characters** and p95 is **687**. Zero rows
land in the 3,600–4,200 band. So this is an unhandled branch, not an observed
defect — and the case that would hit it is exactly the one the bot is good at
(a ten-row markdown table of top sales, which already measured 2,107 chars).

**Fix:** detect `max_tokens` and either continue the turn or append an honest
"cut this off, ask for the rest" line. Cheap insurance; do not present it as a
live bug.

Same shape one level up: exhausting `MAX_ITERATIONS = 5` leaves `finalResponse`
empty and falls through to *"That query was too complex for me to handle in
time"* — which is indistinguishable in the data from a genuine timeout. Setting
`category` differently for the two would make the smoke suite able to see it.

---

## 8. Smaller items, verified

- **Transcript is lost on refresh.** `sessionStorage` holds the session id
  (L34), but `messages` is plain `useState([])` — reload and the panel is empty
  while `support_conversations` still has every turn. The `/api/support-chat/context`
  route is already DB-only and cheap (no LLM call); returning the last N turns
  from it on open is a small, contained win.
- **History is capped at 10 turns** (`effectiveHistory.slice(-10)`, L3888).
  Reasonable, but with caching in place the cap could relax cheaply.
- **Discord plain DMs still never reach the app** — Interactions webhooks
  deliver only `PING` / `APPLICATION_COMMAND`; `/ask` is the only path. This is
  architectural, needs an always-on gateway process, and is a product/cost
  decision, not a fix. Documented in `docs/reference/concierge.md`; the alert-DM
  mitigation shipped 2026-08-15. **Do not re-diagnose this.**

---

## Suggested order

| # | Item | Effort | Why first |
|---|---|---|---|
| 1 | Widen free `concierge_messages` quota 5 → 40 | one UPDATE | Signing in currently punishes the user; nothing to deploy |
| 2 | Add the three telemetry events | ~10 lines | Must land *before* the mount or the mount is unmeasurable |
| 3 | Mount on `app/insights/layout.tsx` + home | ~2 lines | 2,931 sessions/30d gain a launcher |
| 4 | Prompt caching breakpoints | ~5 lines + prompt reordering | Cuts spend and latency together |
| 5 | Four boards into `boardMap` + `get_collector_report` | ~12 lines + one tool | 470 sessions/30d of surfaces the bot can't read |
| 6 | `max_tokens` branch | ~10 lines | Unhandled, not yet observed |
| 7 | Cross-set "cheapest to complete" mode | real work | The one measured user ask still unanswered |

Items 1–6 are all additive and independently revertible. Item 3 touches a
layout `.tsx`, so it needs the normal handoff path rather than a Cowork ship.
