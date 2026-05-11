# Telemetry coverage gap — diagnostic, not a fix

**Date:** 2026-05-11
**Pipeline affected:** `/api/telemetry` (writer) + `usage_events` table (sink) + `lib/telemetry/track.ts` (client beacon)
**Reported symptom:** Only 3 distinct wallet addresses registering telemetry over the past 7 days, despite 9 signed-in auth users.

---

## Numbers (live, 2026-05-11)

| Metric | Value |
|---|---|
| `auth.users.last_sign_in_at > NOW() - 7d` | **9** |
| `allow_list.status = 'active'` total | 13 |
| Distinct `usage_events.wallet_address` over 7d | **3** |
| Distinct `usage_events.wallet_address` over 30d | **3** |

Cross-reference between the two:

| Signed-in 7d users | Have allow_list wallet | Produced telemetry | No telemetry |
|---|---|---|---|
| 9 | **9** | **3** | **6** |

So all 9 signed-in users *have* a resolvable wallet_address in allow_list — the same address `/api/telemetry` resolves into the `wallet_address` column. Yet 6 of them never fire a beacon.

## Hypothesis triage

The original task posed three candidate causes:

### (a) Client hook isn't mounted on most pages — **partial, but not the gap**

`components/TelemetryPageView.tsx` is mounted in `app/layout.tsx` (root layout), so every server-rendered page through the App Router fires a `page-view` beacon on mount. Universal coverage by construction. The current `track()` callsites surface:

| Event | Callsite | Coverage scope |
|---|---|---|
| `page-view` | `components/TelemetryPageView.tsx:24` | **Universal** — every route in `app/(...)` |
| `search-executed` | `app/(collections)/[collection]/collection/page.tsx:1068` | Per-collection search box |
| `sniper-filter-applied` | `app/(collections)/[collection]/sniper/page.tsx:598` | Sniper filter UI |
| `chat-message-sent` | `components/SupportChat.tsx:288` | Concierge chat input |
| `trophy-modal-open` | `components/profile/{TrophyPickerModal,ViewTrophyModal}.tsx` | Profile trophy modals |
| `cart-add` / `cart-remove` | `lib/cart/CartContext.tsx:210,224,236` | Cart drawer |
| `market-overview-view` | `components/MarketSummary.tsx:71` | Dashboard market widgets |

Page-view IS universal. So the "client hook isn't mounted" theory only applies for *non-page-view event types*. Real surface gaps (no telemetry firing):

- `/pricing`, `/about`, `/signup` (the proxy-just-unlocked surfaces)
- `/profile/[username]` (public profile)
- `/pack/[slug]` (pack pages)
- `/dashboard/alerts`, `/dashboard/notifications`, `/dashboard/trade-hub` (new surfaces)
- `/admin/*` (intentional — admin tools)
- `/api/*` server-side ops (intentional — no client)

All of these still get the `page-view` beacon via the layout, so they *do* register the signed-in user as having "visited the site." Discrete events for actions on these surfaces (alert created, pricing CTA clicked, profile shared) are absent — that's a feature-engagement gap, not a distinct-count gap.

### (b) `wallet_address` is missing on most rows — **definitively false**

Distribution check over 7d events:

| Feature | Events | `0x...` wallet | `user:<uuid>` fallback | `anon` |
|---|---|---|---|---|
| page-view | 28 | **28** | 0 | 0 |
| search-executed | 17 | 17 | 0 | 0 |
| sniper-filter-applied | 2 | 2 | 0 | 0 |
| chat-message-sent | 1 | 1 | 0 | 0 |
| concierge_messages | 1 | 1 | 0 | 0 |

Every row has a real `0x...` wallet. The `user:<uuid>` and `anon` fallback paths in `app/api/telemetry/route.ts:66-78` are not currently exercised on production. The wallet-resolution logic works correctly — for signed-in users who actually hit a tracked surface, `allow_list.wallet_addr` resolves cleanly via case-insensitive email match.

### (c) Route silently failing on a subset — **unlikely, not ruled out**

`/api/telemetry` returns 204 unconditionally and swallows all errors at the boundary so it doesn't surface as a 5xx. A persistent client→server failure would still produce *some* rows from the working clients, but we'd see telemetry that doesn't match what users were actually doing. Today's data doesn't show that pattern: every signed-in user who produced telemetry produced multiple beacon types, consistent with a working pipe.

A subtle subset-failure would show as: certain feature names totally missing, while others tick along normally. Today's data is the inverse — feature mix looks right for the 3 active users, just no events from the 6 dormant ones.

## Actual gap: dormant signups, not coverage

The 6 users who signed in without firing telemetry have not actually used the product in 7 days. The most likely chain:

1. Trevor / prewarm-drain sent a magic link.
2. User clicked through, landed at `/auth/confirm` → `setSession` → server-redirect to `/dashboard` (or wherever `next=` pointed).
3. **Either the redirect target threw before TelemetryPageView mounted**, OR
4. **The user closed the tab before the beacon flushed via `sendBeacon`** (350ms debounce + 5s interval), OR
5. **The user never even reached step 2** — the magic link was opened, the session cookie was set, but they never made a follow-on request.

Steps 4 and 5 are observationally indistinguishable today because we don't have an `auth-session-started` beacon firing at the moment the cookie lands. We do have a `last_sign_in_at` from `auth.users` for those 6, but no follow-on click.

Three of the dormant signups match the cohort flagged in `331d5eb` (`feat(admin): resend-welcome route for dormant allow-listed users`) — `siiksicsix@gmail.com`, `mike@flowty.io`, `ryotaabe@gmail.com`. The pattern is "first-touch never converted to product engagement", not "product is broken."

## Recommendations (deferred per task — no commits)

Two complementary changes if/when we want to close the gap:

1. **Add `auth-session-started` beacon.** Fire a one-shot `track("auth-session-started", {via: "magic-link"})` from `/auth/confirm` immediately after `setSession` succeeds, before the redirect. This converts step 2 above into an observable event, so the cohort that *does* land on the confirm page but never reaches `/dashboard` becomes visible. The 6 dormant users in today's data would either start showing up (good — they completed sign-in but bounced) or stay invisible (bad — they never clicked the magic link, only refreshed the prewarm queue).

2. **Add per-action beacons on the high-intent surfaces** that just shipped and are unlikely to ever fire `page-view`-derived signal alone:
   - `/pricing` → `pricing-cta-clicked` on the Stripe Subscribe button (lets us measure conversion-funnel halt).
   - `/dashboard/alerts` → `alert-created` (already gated by quota; useful to compare against `check_feature_quota` rejection rate).
   - `/dashboard/notifications` → `email-preferences-saved`.
   - `/dashboard/trade-hub` → `wishlist-added`, `offer-listed`.

Neither change is in scope here — this audit doc is the request. The fix lands in a future commit.

## Files inventoried during this audit

- [app/api/telemetry/route.ts](../../app/api/telemetry/route.ts) — server-side beacon endpoint, wallet resolution chain.
- [lib/telemetry/track.ts](../../lib/telemetry/track.ts) — client helper with sendBeacon + keepalive-fetch fallback + 350ms debounce.
- [components/TelemetryPageView.tsx](../../components/TelemetryPageView.tsx) — universal page-view beacon mounted in root layout.
- [app/layout.tsx](../../app/layout.tsx) — confirms the universal mount.
- 8 callsites of `track(...)` (table above).

## Recovery / followups

- The fix is NOT this commit — this is investigation only per the task. The recommendations above are the proposed direction.
- The dormant-cohort theory can be confirmed without code changes: re-run the cross-reference query in 14 days. If the 6 dormant users are still at zero telemetry then, they're the resend-welcome cohort, not a telemetry pipeline bug.
- If the 14-day check shows more users with `auth.users.last_sign_in_at` increments but still no usage_events, that flips the diagnosis back toward causes (a) or (c) and warrants an `auth-session-started` instrumentation pass first to distinguish.
