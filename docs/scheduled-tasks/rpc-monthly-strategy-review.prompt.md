# RPC monthly strategy review — scheduled-task prompt (source of truth)

Scheduled task `trig_01J7M3Qv6XoiB3u8kvQWhdJB` ("Rpc monthly strategy review", 11:00 AM PT on the 1st). Device-bound (folders `C:\Users\TDill\rip-packs-city` + `…\Rip Packs City`): edit here first, then push everything below the line with `update_trigger` from a Cowork session linked to the laptop, and read it back.

2026-10-18 (~10:20 PM PT, Cowork cloud linked to the laptop): first repo copy, applied live ("prompt re-signed by Claude Desktop (Windows)"). Corrected against CLAUDE.md: the paid-tier gate is 100 WAU (was 50; Trevor 09-25), the canonical roadmap is the one CLAUDE.md names (was `roadmap-2026-08-03.md`), internal accounts are excluded from traction counts, users are named by username, and the read-only + confidence-is-internal product rules are stated.

<!-- paste everything below this line -->

Monthly Rip Packs City strategy + traction review. READ-ONLY — produce a concise review for Trevor (the founder); do not ship anything. RPC is committed intelligence-first and is pre-traction; no paid tier is shown or considered anywhere until 100 weekly active users (Trevor, 2026-09-25 — it was 50 before) — do NOT propose monetization (Pro paywall / public launch) before that bar, and do NOT draft promo (tweets/Reddit/DMs) unless Trevor explicitly asks. Report all times in Pacific. In any user/activity figures, refer to users by username, never by wallet address or raw user id.

Use the Supabase MCP (project bxcqstmqfzmuolpuynti) and the connected repo C:\Users\TDill\rip-packs-city.

1. Traction (the 100-WAU gate). Run get_rpc_traction_snapshot() if it exists, else query: weekly active / signups trend (users + allow_list), support_conversations with is_smoke_test IS NOT TRUE (real concierge volume), email_subscribers total, outbound_clicks (last 30d), funnel_events by type. Exclude internal_accounts from every traction/campaign count. Compare to ~last month; the headline metric is the trend toward 100 WAU, so flag a sharp move, not the absolute level.
2. Funnel. funnel_events grouped by event_type (home / share / insights views, wallet-paste) — where anon users enter and drop off.
3. Shipped this month. Skim git log --since='1 month ago' --oneline + docs/overnight/ledger.md for what shipped; note which /insights surfaces + features landed.
4. Roadmap. Read CLAUDE.md "Prioritized next actions", then the files it points to for current open priorities: the canonical forward plan it names (docs/strategy/roadmap-2026-10-17.md as of 2026-10-18 — follow CLAUDE.md if it names a newer one), docs/reference/roadmap-status.md (dated status + accuracy measurements) and the OPEN items in docs/reference/known-issues.md.
5. Competitive glance. Web-search for notable NBA Top Shot / Flow / sports-digital-collectibles moves in the last month that affect RPC's positioning (new native features, marketplace changes, competitor tools). Keep it brief and factual.

Product rules to respect in any recommendation: RPC is read-only (no cart, trading or gifting); FMV confidence is internal only and never shown to users (Trevor, 2026-10-18).

Write a tight review: Traction (metrics + trend vs last month), Funnel (entry + drop-off), Shipped this month, Competitive notes, Recommended next 1–3 builds (grounded in intelligence-first + the distribution bottleneck, and the roadmap's thesis that accuracy is the gate). Be honest about the pre-traction reality — a small but growing number is the goal.
