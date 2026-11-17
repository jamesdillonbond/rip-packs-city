# Handoff — RPC Rewards program (app code) — 2026-06-04

PLAIN TEXT BY DESIGN (iPhone copy-paste). No triple-backticks anywhere. Full files for the security-critical pieces; precise specs for the large UI pages.

Claude Code's direct file inspection wins over this doc and over project_knowledge_search on any disagreement — adapt to the actual file shape. If a claude/* branch is pre-checked-out, switch to main first.

================================================================
CONTEXT
================================================================
The off-chain points economy is an acquisition/retention feature (NOT the tabled paywall). Strategy doc: docs/strategy/rpc-rewards-program-2026-06-04.md.

ALREADY SHIPPED LIVE by Cowork this session (DB only — verified):
- audit_20260604_rewards_core_tables — points_rules, points_ledger, shop_items, redemptions, raffle_entries. RLS ON all five; anon/authenticated SELECT-only (no write path); service_role full.
- audit_20260604_rewards_mutation_functions — award_points / redeem_shop_item / admin_adjust_points / get_rewards_summary (all SECURITY DEFINER, EXECUTE granted to service_role only, revoked from PUBLIC/anon/authenticated). Plus rewards_tier(int) helper.
- audit_20260604_rewards_owner_audit_views — v_rewards_economy, v_rewards_user_balances (security_invoker=on, service_role only).
- audit_20260604_rewards_seed_rules_and_shop — 9 starter earn rules + 5 example shop items (all editable).
- Owner dashboard: Cowork artifact rpc-rewards-console (live audit view). No code in repo.

Verified post-ship: RLS on=true x5; anon/authenticated = SELECT only; the 4 functions EXECUTE = postgres,service_role only; check_secdef_anon_execute_violations()=[]; smoke test (award/cap/redeem/insufficient/two-number) passed inside a rolled-back tx, 0 rows persisted.

THIS HANDOFF covers the app code Cowork cannot push (no git creds): the /rewards page, the server-validated earn/redeem endpoints, the earn hooks in existing routes, and the in-app admin console.

THE ONE SECURITY RULE THAT MUST NOT BE BROKEN: the client never supplies its own user_id and the client never tells the server how many points to grant. The server resolves the authenticated user id from the Supabase session, and points are only ever moved by calling the DB functions (award_points / redeem_shop_item / admin_adjust_points) through the service-role client. There is no "add points" endpoint that takes an amount. Earning is always a server-side side effect of a server-verified action.

================================================================
ITEM 1 (P0, security-critical) — server helper: lib/rewards.ts  [NEW FILE]
================================================================
Use the project's EXISTING service-role Supabase client (the one other /api routes use — typed as any, service-role key, persistSession:false). Do NOT create an anon client here, and never import this file into a "use client" component.

FILE: lib/rewards.ts

import { getServiceClient } from "@/lib/supabase-server"   // <- use the actual existing server/service-role helper in this repo; adapt the import

export async function awardPoints(userId: string, actionKey: string, ref?: string) {
  if (!userId) return null
  const sb: any = getServiceClient()
  const { data, error } = await sb.rpc("award_points", { p_user_id: userId, p_action_key: actionKey, p_ref: ref ?? null })
  if (error) { console.log("award_points err", actionKey, error.message); return null }
  return data   // jsonb: { awarded, points, status, spendable, tier, ... } or { awarded:false, skipped }
}

export async function redeemItem(userId: string, itemId: number) {
  if (!userId) return { redeemed: false, error: "unauthorized" }
  const sb: any = getServiceClient()
  const { data, error } = await sb.rpc("redeem_shop_item", { p_user_id: userId, p_item_id: itemId })
  if (error) { console.log("redeem err", error.message); return { redeemed: false, error: "server_error" } }
  return data
}

export async function getRewardsSummary(userId: string) {
  if (!userId) return null
  const sb: any = getServiceClient()
  const { data } = await sb.rpc("get_rewards_summary", { p_user_id: userId })
  return data   // { spendable, status, tier, lifetime_earned, lifetime_spent }
}

export async function adminAdjust(userId: string, delta: number, statusDelta: number, reason: string, admin = "owner") {
  const sb: any = getServiceClient()
  const { data, error } = await sb.rpc("admin_adjust_points", { p_user_id: userId, p_delta: delta, p_status_delta: statusDelta, p_reason: reason, p_admin: admin })
  if (error) return { ok: false, error: error.message }
  return data
}

Revert: delete lib/rewards.ts.

================================================================
ITEM 2 (P0, security-critical) — redeem endpoint: app/api/rewards/redeem/route.ts  [NEW FILE]
================================================================
The user id comes from the SESSION, never the body. Resolve it the same way proxy.ts does (Supabase getUser() against the request cookies); user.id is the uuid that keys the rewards tables.

FILE: app/api/rewards/redeem/route.ts

import { NextResponse } from "next/server"
import { redeemItem } from "@/lib/rewards"
import { getAuthedUserId } from "@/lib/auth-server"   // <- existing helper that returns the Supabase user id from the request session; adapt to the real one

export async function POST(req: Request) {
  const userId = await getAuthedUserId()              // SERVER-resolved. Do NOT read user_id from the body.
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  const body = await req.json().catch(() => ({}))
  const itemId = Number(body?.itemId)
  if (!Number.isInteger(itemId)) return NextResponse.json({ error: "bad_item" }, { status: 400 })
  const result = await redeemItem(userId, itemId)     // user id from session; item id from client is safe (the fn re-validates balance/stock/limits/tier/verified-wallet)
  return NextResponse.json(result, { status: result?.redeemed ? 200 : 400 })
}

If there is no ready getAuthedUserId helper: inside the route, build a Supabase server client from the request cookies (the same createServerClient pattern proxy.ts / the auth routes use), call auth.getUser(), and take user.id. The point is the id is derived from the verified session, not from request input.

Revert: delete app/api/rewards/redeem/route.ts.

================================================================
ITEM 3 (P0) — summary endpoint + daily earn: app/api/rewards/summary/route.ts  [NEW FILE]
================================================================
Returns everything the /rewards page needs, and doubles as the daily_visit earn hook (safe: the rule caps to 1/day with a 20h cooldown, so repeat calls are no-ops).

FILE: app/api/rewards/summary/route.ts

import { NextResponse } from "next/server"
import { awardPoints, getRewardsSummary } from "@/lib/rewards"
import { getAuthedUserId } from "@/lib/auth-server"
import { getServiceClient } from "@/lib/supabase-server"

export async function GET() {
  const userId = await getAuthedUserId()
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  await awardPoints(userId, "daily_visit")            // capped/cooldowned server-side; safe to call every load
  const sb: any = getServiceClient()
  const [summary, rules, shop, redemptions] = await Promise.all([
    getRewardsSummary(userId),
    sb.from("points_rules").select("action_key,label,points,daily_cap,per_user_limit").eq("active", true).order("points", { ascending: false }),
    sb.from("shop_items").select("id,sku,name,description,type,cost_credits,stock,min_status,requires_verified_wallet,image_url,metadata").eq("active", true).order("cost_credits"),
    sb.from("redemptions").select("id,shop_item_id,cost_credits,status,requested_at").eq("user_id", userId).order("requested_at", { ascending: false }).limit(50),
  ])
  return NextResponse.json({
    summary,
    rules: rules.data ?? [],
    shop: shop.data ?? [],
    redemptions: redemptions.data ?? [],
  })
}

Revert: delete app/api/rewards/summary/route.ts.

================================================================
ITEM 4 (P1) — user page: app/rewards/page.tsx  [NEW FILE]
================================================================
Top-level route (sibling of app/analytics, app/dashboard), behind the normal auth funnel — do NOT add it to the public-path allowlist in proxy.ts (it must require login). Build to RPC brand tokens (app/rpc-tokens.css: var(--rpc-red) #E03A2F, var(--font-display) Barlow Condensed, var(--font-mono) Share Tech Mono — never hardcode the literals). The (collections) layout owns the header/nav/ticker; a top-level page like this must NOT add its own standalone header (mirror how app/analytics or app/dashboard handle chrome).

Structure (server component fetching, client child for interactivity — match the repo's existing pattern):
- HERO: current tier + status points (status bar to next tier), and Credits (spendable) balance. Two-number system: status only goes up (sets tier), Credits is what the shop spends.
- EARN: list active points_rules (label + points). Most earns fire automatically as side effects (wallet link, profile, daily visit, scouting). Show which are done vs available where you can tell.
- SHOP: grid of active shop_items. Each card: name, type chip, cost in Credits, stock, and any gates (lock icon if requires_verified_wallet, "needs <tier>" if min_status>0). "Redeem" button -> POST /api/rewards/redeem { itemId }. On success, decrement displayed balance + show "pending — we'll send it to your wallet". Disable when spendable < cost, or gate not met.
- HISTORY: the user's redemptions list (status pending/fulfilled) from the summary payload.
Data source: GET /api/rewards/summary (Item 3). All numbers are server-authoritative; the client only displays them and posts itemId.

Revert: delete app/rewards/page.tsx (and any app/rewards/RewardsClient.tsx you add).

================================================================
ITEM 5 (P1) — earn hooks in EXISTING routes  [EDITS — verify each file, place the call, don't restructure]
================================================================
Add one awardPoints(...) call at the success point of each verified action. Fire-and-forget (await it but ignore the result; the DB enforces caps/limits, so duplicates are harmless). Import { awardPoints } from "@/lib/rewards".

5a. app/api/auth/fcl-verify/route.ts — this is where wallet ownership is proven and saved_wallets.verified_at is set. AFTER the verify succeeds and the user id is known: await awardPoints(userId, "link_wallet"). If the verify carries a referrer (referral link), also: await awardPoints(referrerUserId, "referral_verified", userId) — only when the referee is newly verified, so a referral can't be farmed by re-verifying.

5b. app/api/profile/teams/route.ts — after a favorite team is saved: await awardPoints(userId, "set_favorite_team").

5c. app/api/profile/first-run-tour/route.ts (or app/api/profile/bio/route.ts where first_run_completed_at / profile completion is recorded): await awardPoints(userId, "complete_profile").

5d. (optional) wire scout_wallet / add_watchlist_item / view_squeeze_board where those actions complete server-side, if you want those earns live in v1. They are capped per day in points_rules. Skip if the action has no server route to hook.

For each: the user id must be the server-known id for that request, never a body field. These are net-additive lines; revert by removing the awardPoints calls (git revert the commit).

================================================================
ITEM 6 (P2) — admin console: app/admin/rewards/page.tsx + app/api/admin/rewards/route.ts  [NEW FILES]
================================================================
Trevor already has the live read-only audit view (Cowork artifact rpc-rewards-console). This in-app console adds the ACTIONS. Gate with RPC_ADMIN_TOKEN exactly like app/admin/flowty-analytics/page.tsx + the app/api/admin/* routes (mirror that auth pattern; do not invent a new one). Service-role only; never expose these to anon/authenticated.

app/api/admin/rewards/route.ts — POST { action, ... } with Authorization: Bearer RPC_ADMIN_TOKEN:
- action "fulfill": { redemptionId, tx?, note? } -> update redemptions set status='fulfilled', fulfilled_at=now(), fulfilled_by='owner', fulfillment = jsonb_build_object('tx',tx,'note',note). (Send the actual prize first — manual transfer for v1.)
- action "cancel_refund": { redemptionId } -> set status='refunded' AND call adminAdjust(user_id, +cost_credits, 0, 'refund:redemption:<id>') so the credits go back. (Do both in the route.)
- action "adjust": { userId, delta, statusDelta, reason } -> adminAdjust(...). Owner comp/correction/seed.
- action "toggle_item": { itemId, active } / "toggle_rule": { actionKey, active } / "upsert_item"/"upsert_rule" for editing the catalog + earn config.
- GET: return v_rewards_economy + v_rewards_user_balances + pending redemptions for the page (same queries as the artifact).

app/admin/rewards/page.tsx — token-gated UI: economy summary, pending-redemption queue with a Fulfill button per row, a manual adjust form (user, delta, status delta, reason), and shop/rule toggles. Mirror app/admin/flowty-analytics/page.tsx layout + sign-in gate.

Revert: delete both files.

================================================================
PROXY / ROUTING CHECK (verify, likely no change)
================================================================
- /rewards must REQUIRE auth -> it must NOT be added to isPublicPath() in proxy.ts. Default (non-public) behavior is correct.
- /api/rewards/* is hit by authed users -> authed requests already pass the proxy after the allowlist check; do not add it to the public bypass.
- /admin/rewards + /api/admin/rewards -> covered by the existing /admin and /api/admin public-bypass entries (which are themselves RPC_ADMIN_TOKEN-gated internally). Confirm app/api/admin/rewards is reached (it should be, like the other app/api/admin/* routes).
Only touch proxy.ts if a route 302s to /login when it shouldn't, or vice versa.

================================================================
GUARDRAILS (repeat every handoff)
================================================================
- Direct to main. No branches, no PRs (CLAUDE.md non-negotiable). If a claude/* branch is checked out, switch to main first.
- Commit via PowerShell git on Windows (Git Bash git commit can silently no-op). After push: git rev-list --count origin/main..HEAD must be 0.
- curl fails silently in Git Bash for Vercel REST — use PowerShell Invoke-WebRequest.
- Vercel Pro maxDuration hard cap is 800s — higher sends the deploy to ERROR invisibly.
- CRLF: no string-replace patching on Windows — full-file writes (these are new files, so write whole).
- Supabase client in routes typed as any (per CLAUDE.md) to avoid TS errors.
- generateMetadata cannot be exported from a "use client" component; useSearchParams needs a Suspense wrapper.

================================================================
VERIFICATION (after deploy)
================================================================
- npx tsc --noEmit clean.
- Vercel deploy reaches READY (poll get_deployment).
- Logged in: load /rewards -> daily_visit grants 25 once; reload -> no double-grant (cooldown). The Cowork artifact rpc-rewards-console should then show 1 participant + the daily_visit ledger row.
- Redeem the 400-credit cosmetic with <400 credits -> blocked "insufficient_credits"; with >=400 -> redemption appears pending in the artifact + in HISTORY, Credits drop 400, tier/status unchanged (two-number invariant).
- As a normal (anon or authenticated) user, confirm there is NO route that writes points: there is no award endpoint taking an amount, and /api/rewards/redeem ignores any user_id in the body.

================================================================
DB REVERT (full teardown — only if abandoning the feature)
================================================================
Run as one migration (reverse order). Net-new tables, nothing else depends on them:
DROP VIEW IF EXISTS public.v_rewards_user_balances, public.v_rewards_economy;
DROP FUNCTION IF EXISTS public.award_points(uuid,text,text);
DROP FUNCTION IF EXISTS public.redeem_shop_item(uuid,bigint);
DROP FUNCTION IF EXISTS public.admin_adjust_points(uuid,int,int,text,text);
DROP FUNCTION IF EXISTS public.get_rewards_summary(uuid);
DROP TABLE IF EXISTS public.raffle_entries, public.redemptions, public.points_ledger, public.shop_items, public.points_rules CASCADE;
DROP FUNCTION IF EXISTS public.rewards_tier(int);
(seed rows drop with the tables.)

================================================================
ADD TO LEDGER + CLAUDE.md (do this from Claude Code, NOT Cowork — the mount truncates docs/overnight/ledger.md)
================================================================
Ledger line: Rewards program — DB shipped live 2026-06-04 (4 audit_20260604_rewards_* migrations: core tables, mutation fns, owner views, seed). App code handoff: docs/handoff-2026-06-04-rewards-program.md. Off-chain points, RLS-locked (no anon/authenticated write path), owner artifact rpc-rewards-console. Revert: see handoff DB teardown.

================================================================
END STATE
================================================================
After CC ships: one commit on main, Vercel READY, /rewards live behind auth, earns firing from wallet-verify + profile + daily visit, redemptions landing as pending for manual fulfillment, and the rpc-rewards-console artifact showing live economy + ledger. Points remain un-tweakable by users (server-only mutation path). Prizes stay bootstrap-cheap (Pro time, cosmetics, raffle, a few Commons) until the loop is proven and a Flow/Top Shot partner deal funds bigger prizes.
