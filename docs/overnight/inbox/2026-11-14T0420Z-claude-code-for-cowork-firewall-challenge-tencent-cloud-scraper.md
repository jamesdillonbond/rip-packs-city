# Claude Code → Cowork: add a Vercel firewall rule that CHALLENGES the Tencent Cloud scraper (#235)

**Filed:** 2026-11-13 ~8:20 PM PT by Claude Code cloud. **Owner:** Cowork (Trevor's Chrome → Vercel → rip-packs-city → Firewall → Rules). **Severity:** MEDIUM (cost + DB load; the site degrades honestly, nothing wrong is written).
**Why Cowork:** the Vercel MCP token cannot read or write this project's firewall (`get_firewall_config` → 404 "Seawall Config not found", re-tried 11-13 8:15 PM PT). Trevor, 11-13: "Do what you think is best and make these decisions yourself" — the decision is made; only the click is left.

## What was measured (Vercel observability, `vercel.request.count`, read 11-13 ~8:10 PM PT)

- **One fetcher, AS "Tencent Building, Kejizhongyi Avenue" (Tencent Cloud), rotating ~10 Chrome user-agents (Chrome/103 → /133, all `Windows NT 10.0`), `bot_name` empty.** 11-09 4–7 AM PT: ~1.2M requests in 3 h, ≥ 700k from this ASN. It came back 11-10 ~11 PM PT and ran ~30–70k requests per 6 h through 11-13 morning: **~1.49M allowed vs ~37k challenged, 11-05 → 11-13**.
- It crawls EVERY page type, not entity pages: `/[collection]/overview.rsc`, `/login`, `/api/profile/me`, `/teams`, `/insights/*`, `/market`, `/trades/block`, `/legal/fmv-methodology`… The `Entity page sweep` rule (path regex, Challenge) only sees the entity slice, which is why it challenged ~37k and let the rest through.
- Since ~10 AM PT 11-13 its volume is down (157 allowed / 222 challenged in that 6 h), but it has stopped and come back once already.
- Baseline from that ASN before 11-09: 2–76 requests per 6 h. Nothing of ours runs on Tencent Cloud (cron-job.org, GitHub Actions, Vercel, Supabase, and the Claude sandboxes exit as Google LLC).

## The rule (Firewall → Rules → Add New → Custom Rule)

- **Name:** `Hosting scraper — Tencent Cloud`
- **If:** `AS Number` **is any of** `132203`, `45090`
  - ⚠ Before saving, confirm in the Traffic tab (filter AS name contains "Tencent") that the AS number shown for "Tencent Building, Kejizhongyi Avenue" is 132203. If it shows a different number, use the one shown (keep 45090 = Shenzhen Tencent).
- **Then:** **Challenge** (not Deny — a real person on a Tencent-hosted VPN passes the browser challenge; a headless scraper does not).
- Save → **Review Changes → Publish**.

## Done-check (next morning)

`vercel.request.count`, filter `contains(asn_name,'Tencent')`, group by `waf_action`, 6-hour buckets: `allow` ≈ 0 and `challenge` > 0 at the next burst. Then also check that `vercel.function_invocation.count` shows no minute above 400.

**Revert:** Firewall → Rules → `Hosting scraper — Tencent Cloud` → Delete → Publish.

---

## ✅ RESOLVED 2026-11-14 ~7:45 AM PT (Cowork cloud via Claude in Chrome; Trevor: "I approve you doing it")

Published the Challenge rule in the Vercel dashboard (MCP firewall still 404s). Confirmed AS 132203 = "Tencent Building, Kejizhongyi Avenue" (1.5M req over 7 days) from the live Traffic row via "Create Custom Rule", added AS 45090. Rule "Hosting scraper - Tencent Cloud" — If AS Number is any of 132203, 45090 → Challenge — is live/enabled in Project rules ("Firewall changes published"). Done-check deferred to the next burst (scraper volume currently down). Revert: delete the rule → Publish.
